import { execFile } from 'node:child_process';
import { rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { findProcess, isAlive, isSameProcess, type ProcessInfo } from './processes.js';

/** Cleanup: stop session processes, move session files to the Trash, list and remove git worktrees under .claude/worktrees. */

const run = promisify(execFile);
const TRASH = join(homedir(), '.Trash');
const WORKTREE_MARK = '/.claude/worktrees/';

const exists = (path: string) => stat(path).then(() => true, () => false);

/** Moves a file or folder to ~/.Trash. Adds a time to the name if the name is taken. */
async function moveToTrash(path: string): Promise<void> {
  const ext = extname(path);
  let target = join(TRASH, basename(path));
  if (await exists(target)) target = join(TRASH, `${basename(path, ext)} ${Date.now()}${ext}`);
  await rename(path, target);
}

/** Moves the session file and its folder (sub-agents, tool results) to the Trash. */
export async function trashSession(file: string): Promise<void> {
  const folder = join(dirname(file), basename(file, '.jsonl'));
  await moveToTrash(file);
  if (await exists(folder)) await moveToTrash(folder);
}

const KILL_WAIT_MS = 3000;

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/**
 * Stops the claude process of a Terminal session: SIGTERM, then SIGKILL after 3 s.
 * Only for entrypoint "cli". In the desktop app the process can be the app itself.
 * Returns an error text, or null when the process has ended.
 */
export async function killSession(sessionId: string): Promise<string | null> {
  const info = await findProcess(sessionId);
  if (info === null) return 'No running claude process for this session';
  if (info.entrypoint !== 'cli') return 'Kill works only for Terminal sessions';
  if (!(await isSameProcess(info))) return 'The pid now belongs to a different process';

  process.kill(info.pid, 'SIGTERM');
  if (await waitForExit(info.pid, KILL_WAIT_MS)) return null;
  process.kill(info.pid, 'SIGKILL');
  return (await waitForExit(info.pid, 1000)) ? null : 'The process does not stop';
}

export interface Worktree {
  path: string;
  /** The main repo folder. */
  repo: string;
  branch: string | null;
  /** Uncommitted and untracked files. Null if the folder is gone. */
  changes: number | null;
  /** The live session that runs in this worktree, or null. */
  sessionId: string | null;
}

const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 10_000 })).stdout;

/** The worktrees of one repo, only those under .claude/worktrees. */
async function worktreesOf(folder: string): Promise<Omit<Worktree, 'changes' | 'sessionId'>[]> {
  const out = await git(folder, 'worktree', 'list', '--porcelain').catch(() => '');
  const blocks = out.split('\n\n').filter(Boolean);
  // The first block is the main worktree.
  const repo = blocks[0]?.match(/^worktree (.+)$/m)?.[1];
  if (!repo) return [];
  return blocks.flatMap((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path?.includes(WORKTREE_MARK)) return [];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    return [{ path, repo, branch }];
  });
}

/**
 * All worktrees under .claude/worktrees of the given folders.
 * @param live Live processes by session id.
 */
export async function listWorktrees(folders: string[], live: Map<string, ProcessInfo>): Promise<Worktree[]> {
  const found = new Map<string, Omit<Worktree, 'changes' | 'sessionId'>>();
  for (const list of await Promise.all(folders.map(worktreesOf))) for (const w of list) found.set(w.path, w);
  return Promise.all(
    [...found.values()].map(async (w) => {
      const changes = (await exists(w.path))
        ? (await git(w.path, 'status', '--porcelain').catch(() => '')).split('\n').filter(Boolean).length
        : null;
      const sessionId = [...live.values()].find(({ cwd }) => cwd === w.path || cwd.startsWith(`${w.path}/`))?.sessionId ?? null;
      return { ...w, changes, sessionId };
    }),
  );
}

/** Removes a worktree. Git refuses if it has changes. The branch stays. A missing folder is pruned. */
export async function removeWorktree(w: Worktree): Promise<void> {
  if (w.changes === null) await git(w.repo, 'worktree', 'prune');
  else await git(w.repo, 'worktree', 'remove', w.path);
}
