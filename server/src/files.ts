import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
/** Where claude-dash keeps its own files. */
export const DASH_DIR = join(homedir(), '.claude-dash');

const SESSION_ID = /^[0-9a-f-]{36}$/;

/** The JSONL file of a session: ~/.claude/projects/<project>/<id>.jsonl. Null if not found. */
export async function findSessionFile(sessionId: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  for (const dir of await readdir(PROJECTS_DIR).catch(() => [])) {
    const path = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (await stat(path).then((s) => s.isFile(), () => false)) return path;
  }
  return null;
}

/** The last `bytes` of a file as lines. The first line is dropped if it was cut. */
export async function readTailLines(path: string, bytes: number): Promise<string[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.length > 0);
  } finally {
    await fh.close();
  }
}

/** For chokidar: skip everything except session files (<project>/<id>.jsonl) and sub-agent files. */
export function ignoredPath(path: string): boolean {
  const parts = relative(PROJECTS_DIR, path).split(sep);
  if (parts[0] === '' || parts.length === 1) return false; // root and project folders
  if (parts.length === 2) return !parts[1].endsWith('.jsonl') && !/^[0-9a-f-]{36}$/.test(parts[1]);
  if (parts.length === 3) return parts[2] !== 'subagents';
  return parts.length !== 4 || !parts[3].endsWith('.jsonl');
}
