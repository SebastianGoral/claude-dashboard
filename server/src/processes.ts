import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Running Claude Code processes. Claude Code writes one file per process: ~/.claude/sessions/<pid>.json.
 * A desktop app session also has entrypoint "claude-desktop" and hostSessionId "local_<id>".
 */

const run = promisify(execFile);
export const PROCESS_DIR = join(homedir(), '.claude', 'sessions');

export interface ProcessInfo {
  sessionId: string;
  pid: number;
  /** The working folder of the process, or '' if the file has none. */
  cwd: string;
  /** "cli", "claude-desktop", "claude-vscode", "sdk-…". */
  entrypoint: string | null;
  hostSessionId: string | null;
  /** Process start time, as `ps -o lstart=` prints it in UTC. */
  procStart: string | null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Throws if the process does not exist.
    return true;
  } catch {
    return false;
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** Live processes by session id. Unreadable files and dead pids are left out. */
export async function liveProcesses(dir = PROCESS_DIR): Promise<Map<string, ProcessInfo>> {
  const live = new Map<string, ProcessInfo>();
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const info = JSON.parse(await readFile(join(dir, file), 'utf8'));
      if (typeof info.sessionId !== 'string' || typeof info.pid !== 'number' || live.has(info.sessionId)) continue;
      if (!isAlive(info.pid)) continue;
      live.set(info.sessionId, {
        sessionId: info.sessionId,
        pid: info.pid,
        cwd: str(info.cwd) ?? '',
        entrypoint: str(info.entrypoint),
        hostSessionId: str(info.hostSessionId),
        procStart: str(info.procStart),
      });
    } catch {
      // Unreadable file: try the next one.
    }
  }
  return live;
}

/** The live process of a session, or null. */
export async function findProcess(sessionId: string, dir = PROCESS_DIR): Promise<ProcessInfo | null> {
  return (await liveProcesses(dir)).get(sessionId) ?? null;
}

/** False if macOS gave the pid of a dead process to a new program: the start times differ. */
export async function isSameProcess(info: ProcessInfo): Promise<boolean> {
  if (!info.procStart) return false;
  // Claude Code stores the start time in UTC, in the C locale format of ps.
  const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(info.pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).catch(() => ({ stdout: '' }));
  const norm = (text: string) => text.trim().replace(/\s+/g, ' ');
  return norm(stdout) === norm(info.procStart);
}
