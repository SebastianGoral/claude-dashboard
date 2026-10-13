import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PROJECTS_DIR, readTailLines } from './files.js';
import { projectRoot } from './session.js';
import { pickTitle, readLine, shortInput, type Titles, type TranscriptLine } from './transcript.js';

/** History (all session files), search over them, and Markdown export. Plain Node streams over JSONL. */

export interface HistoryItem {
  id: string;
  title: string | null;
  project: string;
  /** The project folder path, or null if no line has a cwd. */
  folder: string | null;
  branch: string | null;
  firstPrompt: string;
  /** The file time, epoch milliseconds. */
  lastActivity: number;
  size: number;
}

export interface SearchHit {
  sessionId: string;
  title: string | null;
  project: string;
  at: number;
  /** Where the text matched. */
  kind: 'prompt' | 'answer' | 'tool' | 'result';
  tool: string | null;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  filesScanned: number;
  bytesScanned: number;
  elapsedMs: number;
  /** True if the search stopped at the hit limit or the time limit. */
  truncated: boolean;
}

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 64 * 1024;
const PREVIEW_CHARS = 160;
const SNIPPET_CHARS = 160;
const MAX_HITS = 200;
const MAX_HITS_PER_FILE = 5;
const SEARCH_TIME_LIMIT_MS = 15_000;
/** Log searches slower than this, so we know when plain streams are not enough. */
const SLOW_MS = 2_000;
const CONCURRENCY = 16;

interface SessionFile {
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** All top-level session files, the newest first. */
async function sessionFiles(): Promise<SessionFile[]> {
  const files: SessionFile[] = [];
  for (const dir of await readdir(PROJECTS_DIR).catch(() => [])) {
    const names = (await readdir(join(PROJECTS_DIR, dir)).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
    for (const name of names) {
      const path = join(PROJECTS_DIR, dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.size > 0) files.push({ id: basename(name, '.jsonl'), path, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readHead(path: string): Promise<string[]> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead === HEAD_BYTES) lines.pop(); // The last line can be cut.
    return lines;
  } finally {
    await fh.close();
  }
}

/** The folder where the session started: the first cwd in the file. Claude Code finds the session from there. Null if none. */
export async function sessionCwd(path: string): Promise<string | null> {
  for (const raw of await readHead(path)) {
    const cwd = readLine(raw)?.cwd;
    if (cwd) return cwd;
  }
  return null;
}

/** Runs fn on all items, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Title, project, branch and first prompt from the start and the end of the file. */
function summarize(file: SessionFile, head: string[], tail: string[]): HistoryItem {
  const titles: Titles = {};
  let cwd: string | null = null;
  let branch: string | null = null;
  let firstPrompt = '';
  for (const raw of [...head, ...tail]) {
    const line = readLine(raw);
    if (!line) continue;
    cwd ??= line.cwd;
    if (line.branch) branch = line.branch;
    if (line.title) titles[line.title.source] = line.title.text;
    else if (!firstPrompt && !line.sidechain && line.user?.prompt) firstPrompt = clip(line.user.prompt, PREVIEW_CHARS);
  }
  const folder = cwd ? projectRoot(cwd, basename(dirname(file.path))) : null;
  return {
    id: file.id,
    title: pickTitle(titles),
    project: folder ? basename(folder) : basename(dirname(file.path)),
    folder,
    branch,
    firstPrompt,
    lastActivity: file.mtimeMs,
    size: file.size,
  };
}

/** Summaries by path. A file is read again only when its size or time changes. */
const cache = new Map<string, { mtimeMs: number; size: number; item: HistoryItem }>();

export async function listHistory(): Promise<HistoryItem[]> {
  const files = await sessionFiles();
  return mapLimit(files, CONCURRENCY, async (file) => {
    const hit = cache.get(file.path);
    if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) return hit.item;
    const [head, tail] = await Promise.all([readHead(file.path), file.size > HEAD_BYTES ? readTailLines(file.path, TAIL_BYTES) : []]);
    const item = summarize(file, head, tail);
    cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, item });
    return item;
  });
}

export interface Folder {
  path: string;
  name: string;
  /** The newest session file time in this folder, or 0 for an added folder without sessions. */
  lastActivity: number;
}

/**
 * Project folders for new sessions: the folders of past sessions plus the folders the user added.
 * The newest first. Hidden folders and folders that no longer exist are left out.
 */
export async function listFolders(extra: string[], hidden: string[]): Promise<Folder[]> {
  const latest = new Map<string, number>();
  for (const item of await listHistory()) {
    if (item.folder) latest.set(item.folder, Math.max(latest.get(item.folder) ?? 0, item.lastActivity));
  }
  for (const path of extra) if (!latest.has(path)) latest.set(path, 0);
  for (const path of hidden) latest.delete(path);
  const folders = await mapLimit([...latest], CONCURRENCY, async ([path, lastActivity]) =>
    (await stat(path).catch(() => null))?.isDirectory() ? { path, name: basename(path), lastActivity } : null,
  );
  return folders.filter((f): f is Folder => f !== null).sort((a, b) => b.lastActivity - a.lastActivity);
}

/** The text of a line that can match, with its kind. One line can have several parts. */
function searchableParts({ user, assistant }: TranscriptLine): { kind: SearchHit['kind']; tool: string | null; text: string }[] {
  const parts: { kind: SearchHit['kind']; tool: string | null; text: string }[] = [];
  for (const text of user?.texts ?? []) parts.push({ kind: 'prompt', tool: null, text });
  for (const r of user?.toolResults ?? []) parts.push({ kind: 'result', tool: null, text: r.text });
  for (const text of assistant?.texts ?? []) parts.push({ kind: 'answer', tool: null, text });
  // Tool inputs hold the file paths, commands and patterns.
  for (const t of assistant?.toolUses ?? []) parts.push({ kind: 'tool', tool: t.name, text: `${shortInput(t.input)} ${JSON.stringify(t.input ?? {})}` });
  return parts;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_CHARS / 2);
  const flat = text.slice(start, start + SNIPPET_CHARS + length).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${flat}${start + SNIPPET_CHARS + length < text.length ? '…' : ''}`;
}

/** Case-insensitive text search over all sessions: prompts, answers, tool inputs (paths, commands) and results. */
export async function search(query: string): Promise<SearchResult> {
  const started = Date.now();
  const needle = query.trim().toLowerCase();
  const result: SearchResult = { hits: [], filesScanned: 0, bytesScanned: 0, elapsedMs: 0, truncated: false };
  if (needle.length < 2) return result;
  const items = new Map((await listHistory()).map((h) => [h.id, h]));

  for (const file of await sessionFiles()) {
    if (result.hits.length >= MAX_HITS || Date.now() - started > SEARCH_TIME_LIMIT_MS) {
      result.truncated = true;
      break;
    }
    result.filesScanned++;
    result.bytesScanned += file.size;
    const item = items.get(file.id);
    let inFile = 0;
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    for await (const raw of lines) {
      // Fast filter on the raw JSON line; most lines do not contain the text.
      if (!raw.toLowerCase().includes(needle)) continue;
      const line = readLine(raw);
      if (!line || line.sidechain) continue;
      for (const part of searchableParts(line)) {
        const index = part.text.toLowerCase().indexOf(needle);
        if (index === -1) continue;
        result.hits.push({
          sessionId: file.id,
          title: item?.title ?? null,
          project: item?.project ?? '',
          at: line.at || file.mtimeMs,
          kind: part.kind,
          tool: part.tool,
          snippet: snippet(part.text, index, needle.length),
        });
        inFile++;
        break;
      }
      if (inFile >= MAX_HITS_PER_FILE || result.hits.length >= MAX_HITS) {
        lines.close();
        break;
      }
    }
  }
  result.elapsedMs = Date.now() - started;
  if (result.elapsedMs > SLOW_MS) {
    console.warn(`search slow: "${query}" took ${result.elapsedMs} ms over ${result.filesScanned} files (${Math.round(result.bytesScanned / 1e6)} MB)`);
  }
  return result;
}
