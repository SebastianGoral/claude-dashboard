import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEntries, type Entry } from './detail.js';
import { PROJECTS_DIR, readTailLines, shortInput, textOf } from './files.js';

/** History (all session files), search over them, and Markdown export. Plain Node streams over JSONL. */

export interface HistoryItem {
  id: string;
  title: string | null;
  project: string;
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
  const titles: { custom?: string; agent?: string; ai?: string } = {};
  let cwd: string | null = null;
  let branch: string | null = null;
  let firstPrompt = '';
  for (const raw of [...head, ...tail]) {
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof line.cwd === 'string') cwd ??= line.cwd;
    if (typeof line.gitBranch === 'string' && line.gitBranch) branch = line.gitBranch;
    if (line.type === 'custom-title' && line.customTitle) titles.custom = line.customTitle;
    else if (line.type === 'agent-name' && line.agentName) titles.agent = line.agentName;
    else if (line.type === 'ai-title' && line.aiTitle) titles.ai = line.aiTitle;
    else if (!firstPrompt && line.type === 'user' && !line.isMeta && !line.isSidechain) {
      const text = textOf(line.message?.content).trim();
      if (text && !text.startsWith('<')) firstPrompt = clip(text, PREVIEW_CHARS);
    }
  }
  // A worktree under .claude/worktrees uses the name of its repo, as in session.ts.
  const worktree = cwd?.indexOf('/.claude/worktrees/') ?? -1;
  const project = cwd ? basename(worktree > 0 ? cwd.slice(0, worktree) : cwd) : basename(join(file.path, '..'));
  return {
    id: file.id,
    title: titles.custom || titles.agent || titles.ai || null,
    project,
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

/** The text of a line that can match, with its kind. One line can have several parts. */
function searchableParts(line: any): { kind: SearchHit['kind']; tool: string | null; text: string }[] {
  const content = line.message?.content;
  const parts: { kind: SearchHit['kind']; tool: string | null; text: string }[] = [];
  if (line.type === 'user' && !line.isMeta) {
    if (typeof content === 'string') parts.push({ kind: 'prompt', tool: null, text: content });
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') parts.push({ kind: 'prompt', tool: null, text: b.text ?? '' });
        if (b?.type === 'tool_result') parts.push({ kind: 'result', tool: null, text: textOf(b.content) || (typeof b.content === 'string' ? b.content : '') });
      }
    }
  } else if (line.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') parts.push({ kind: 'answer', tool: null, text: b.text ?? '' });
      // Tool inputs hold the file paths, commands and patterns.
      if (b?.type === 'tool_use') parts.push({ kind: 'tool', tool: b.name, text: `${shortInput(b.name, b.input)} ${JSON.stringify(b.input ?? {})}` });
    }
  }
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
      let line: any;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (line.isSidechain) continue;
      for (const part of searchableParts(line)) {
        const index = part.text.toLowerCase().indexOf(needle);
        if (index === -1) continue;
        result.hits.push({
          sessionId: file.id,
          title: item?.title ?? null,
          project: item?.project ?? '',
          at: Date.parse(line.timestamp) || file.mtimeMs,
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

/** All entries of a session file, read with a stream. */
async function readAllEntries(path: string): Promise<Entry[]> {
  const raw: string[] = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line) raw.push(line);
  return parseEntries(raw, { full: true });
}

const fence = (text: string) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
};

/** A Markdown document of the whole session: prompts, answers and tool calls with their results. */
export async function exportMarkdown(path: string, sessionId: string): Promise<{ name: string; markdown: string }> {
  const [entries, info, head, tail] = await Promise.all([readAllEntries(path), stat(path), readHead(path), readTailLines(path, TAIL_BYTES)]);
  const item = summarize({ id: sessionId, path, mtimeMs: info.mtimeMs, size: info.size }, head, tail);
  const title = item.title || item.firstPrompt.slice(0, 60) || sessionId;
  const time = (at: number) => (at ? new Date(at).toLocaleString() : '');
  const out = [
    `# ${title}`,
    '',
    `- Project: ${item.project}`,
    ...(item.branch ? [`- Branch: ${item.branch}`] : []),
    `- Session: ${sessionId}`,
    ...(entries[0] ? [`- Started: ${time(entries[0].at)}`] : []),
    `- Last activity: ${time(item.lastActivity)}`,
    '',
  ];
  for (const e of entries) {
    if (e.kind === 'user') out.push(`## You · ${time(e.at)}`, '', e.text, '');
    else if (e.kind === 'assistant') out.push(`## Claude · ${time(e.at)}`, '', e.text, '');
    else if (e.kind === 'tool') {
      out.push(`**${e.tool}** \`${e.input.replace(/`/g, "'")}\`${e.isError ? ' (error)' : ''}`, '');
      if (e.result) out.push('<details><summary>Result</summary>', '', fence(e.result), '', '</details>', '');
    }
  }
  const name = `${(item.title ?? item.project).replace(/[^\w.-]+/g, '-').slice(0, 60)}-${sessionId.slice(0, 8)}.md`;
  return { name, markdown: out.join('\n') };
}
