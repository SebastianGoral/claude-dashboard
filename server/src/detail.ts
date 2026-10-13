import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readTailLines } from './files.js';
import { readLine, shortInput, type TranscriptLine } from './transcript.js';

/** The detail panel of a session: recent messages and tool calls, and the sub-agents. */

export type Entry =
  | { kind: 'user' | 'assistant'; at: number; text: string }
  | { kind: 'tool'; at: number; id: string; tool: string; input: string; result: string | null; isError: boolean; doneAt: number | null };

export type SubagentStatus = 'running' | 'done' | 'stopped';

export interface Subagent {
  id: string;
  description: string;
  agentType: string;
  /** 1: started by the session, 2: started by a sub-agent, and so on. */
  depth: number;
  status: SubagentStatus;
  /** The tool that runs now, or null. */
  currentTool: string | null;
  currentInput: string | null;
  startedAt: number;
  lastActivity: number;
}

export interface Detail {
  id: string;
  entries: Entry[];
  subagents: Subagent[];
}

/** Read this much of the end of the file. Enough for the last ~100 entries of most sessions. */
const TAIL_BYTES = 768 * 1024;
const MAX_ENTRIES = 150;
const TEXT_CHARS = 2000;
const RESULT_CHARS = 500;
/** A sub-agent that did not finish and did not write for this long is shown as stopped. */
const SUBAGENT_STALE_MS = 10 * 60_000;
const SUBAGENT_TAIL_BYTES = 64 * 1024;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Turns JSONL lines into entries. Tool results are joined to their tool call.
 * Sidechain lines are skipped unless `sidechain`. Texts are clipped.
 */
export function parseEntries(lines: string[], { sidechain = false } = {}): Entry[] {
  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { kind: 'tool' }>>();
  for (const raw of lines) {
    const line = readLine(raw);
    if (!line || (line.sidechain && !sidechain)) continue;
    const { at, user, assistant } = line;
    if (user) {
      for (const r of user.toolResults) {
        const tool = tools.get(r.toolUseId);
        if (!tool) continue;
        tool.result = clip(r.text.trim(), RESULT_CHARS);
        tool.isError = r.isError;
        tool.doneAt = at;
      }
      if (user.prompt) entries.push({ kind: 'user', at, text: clip(user.prompt, TEXT_CHARS) });
    } else if (assistant) {
      for (const t of assistant.texts) if (t.trim()) entries.push({ kind: 'assistant', at, text: clip(t.trim(), TEXT_CHARS) });
      for (const t of assistant.toolUses) {
        const entry = { kind: 'tool' as const, at, id: t.id, tool: t.name, input: shortInput(t.input), result: null, isError: false, doneAt: null };
        tools.set(t.id, entry);
        entries.push(entry);
      }
    }
  }
  return entries;
}

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The sub-agents of a session: <project>/<session id>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json. */
async function readSubagents(sessionFile: string, sessionId: string, now: number): Promise<Subagent[]> {
  const dir = join(dirname(sessionFile), sessionId, 'subagents');
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^agent-[\w-]+\.jsonl$/.test(f));
  const list = await Promise.all(
    files.map(async (f): Promise<Subagent | null> => {
      const path = join(dir, f);
      const id = basename(f, '.jsonl').slice('agent-'.length);
      const [info, meta, lines] = await Promise.all([
        stat(path),
        readJson(join(dir, `agent-${id}.meta.json`)),
        readTailLines(path, SUBAGENT_TAIL_BYTES).catch(() => []),
      ]);
      const entries = parseEntries(lines, { sidechain: true });
      const first = (lines[0] && readLine(lines[0])?.at) || NaN;
      // Finished: the last assistant message ended the turn. Else the open tool call is the current tool.
      const turns = lines.map(readLine).filter((l): l is TranscriptLine => l !== null && (l.user !== null || l.assistant !== null));
      const finished = turns.at(-1)?.assistant?.stopReason === 'end_turn';
      const open = [...entries].reverse().find((e) => e.kind === 'tool' && e.result === null) as Extract<Entry, { kind: 'tool' }> | undefined;
      const status: SubagentStatus = finished ? 'done' : now - info.mtimeMs > SUBAGENT_STALE_MS ? 'stopped' : 'running';
      return {
        id,
        // No meta file: the first prompt of the sub-agent.
        description: meta?.description ?? (entries.find((e) => e.kind === 'user') as { text?: string } | undefined)?.text?.slice(0, 80) ?? id,
        agentType: meta?.agentType ?? 'agent',
        depth: Number(meta?.spawnDepth) || 1,
        status,
        currentTool: status === 'running' ? (open?.tool ?? null) : null,
        currentInput: status === 'running' ? (open?.input ?? null) : null,
        startedAt: Number.isFinite(first) ? first : info.birthtimeMs,
        lastActivity: info.mtimeMs,
      };
    }),
  );
  return list.filter((s): s is Subagent => s !== null).sort((a, b) => a.startedAt - b.startedAt);
}

export async function readDetail(sessionFile: string, sessionId: string): Promise<Detail> {
  const lines = await readTailLines(sessionFile, TAIL_BYTES);
  return {
    id: sessionId,
    entries: parseEntries(lines).slice(-MAX_ENTRIES),
    subagents: await readSubagents(sessionFile, sessionId, Date.now()),
  };
}
