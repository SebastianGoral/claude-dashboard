import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readTailLines, shortInput, textOf } from './files.js';

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
 * Sidechain lines are skipped unless `sidechain`. Texts are clipped unless `full` (Markdown export).
 */
export function parseEntries(lines: string[], { sidechain = false, full = false } = {}): Entry[] {
  const text = (value: string, max: number) => (full ? value : clip(value, max));
  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { kind: 'tool' }>>();
  for (const raw of lines) {
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.isSidechain && !sidechain) continue;
    const at = Date.parse(line.timestamp) || 0;
    const content = line.message?.content;
    if (line.type === 'user' && !line.isMeta) {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const tool = tools.get(b.tool_use_id);
          if (!tool) continue;
          tool.result = text(textOf(b.content).trim() || (typeof b.content === 'string' ? b.content : ''), RESULT_CHARS);
          tool.isError = b.is_error === true;
          tool.doneAt = at;
        }
      }
      const prompt = textOf(content).trim();
      if (prompt && !prompt.startsWith('<')) entries.push({ kind: 'user', at, text: text(prompt, TEXT_CHARS) });
    } else if (line.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) entries.push({ kind: 'assistant', at, text: text(b.text.trim(), TEXT_CHARS) });
        if (b?.type === 'tool_use') {
          const entry = { kind: 'tool' as const, at, id: b.id, tool: b.name, input: shortInput(b.name, b.input), result: null, isError: false, doneAt: null };
          tools.set(b.id, entry);
          entries.push(entry);
        }
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
      const first = lines[0] ? Date.parse(JSON.parse(lines[0]).timestamp ?? '') : NaN;
      // Finished: the last assistant message ended the turn. Else the open tool call is the current tool.
      let finished = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const line = JSON.parse(lines[i]);
          if (line.type === 'assistant') {
            finished = line.message?.stop_reason === 'end_turn';
            break;
          }
          if (line.type === 'user') break;
        } catch {
          // A cut line: go on.
        }
      }
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
