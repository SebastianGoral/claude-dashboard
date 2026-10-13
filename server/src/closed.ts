import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DASH_DIR } from './files.js';
import type { SessionView } from './session.js';

/**
 * "Recently closed": sessions whose Claude Code process ended (its ~/.claude/sessions/<pid>.json
 * is gone or the pid is dead), or that sent the SessionEnd hook. Kept in ~/.claude-dash/closed.json.
 * A closed session with new activity after closedAt is open again.
 */

export interface ClosedSession {
  id: string;
  title: string | null;
  project: string;
  branch: string | null;
  lastMessage: string;
  lastActivity: number;
  closedAt: number;
  /** True if the user hid the session. A live process does not open it again, only new activity. */
  hidden?: boolean;
}

const FILE = join(DASH_DIR, 'closed.json');
const PROCESS_DIR = join(homedir(), '.claude', 'sessions');
const MAX_CLOSED = 50;
const KEEP_MS = 7 * 24 * 60 * 60_000;
const POLL_MS = 3_000;
const REOPEN_AFTER_MS = 10_000;

/** Live Claude Code processes: session id → cwd. */
export async function liveSessions(): Promise<Map<string, string>> {
  const live = new Map<string, string>();
  const files = (await readdir(PROCESS_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const info = JSON.parse(await readFile(join(PROCESS_DIR, file), 'utf8'));
      if (typeof info.sessionId !== 'string' || typeof info.pid !== 'number') continue;
      process.kill(info.pid, 0); // Throws if the process does not exist.
      live.set(info.sessionId, typeof info.cwd === 'string' ? info.cwd : '');
    } catch {
      // Unreadable file or dead process.
    }
  }
  return live;
}

export interface ClosedStore {
  on(event: 'change', fn: (list: ClosedSession[]) => void): this;
}

export class ClosedStore extends EventEmitter {
  private closed = new Map<string, ClosedSession>();
  /** Sessions seen with a live process. Only these can close by process end. */
  private open = new Set<string>();

  /** @param viewOf The current view of a session, or null. */
  constructor(private viewOf: (id: string) => SessionView | null) {
    super();
  }

  async start(): Promise<void> {
    try {
      const list: ClosedSession[] = JSON.parse(await readFile(FILE, 'utf8'));
      for (const c of list) if (Date.now() - c.closedAt < KEEP_MS) this.closed.set(c.id, c);
    } catch {
      // No file yet.
    }
    setInterval(() => void this.poll(), POLL_MS);
    await this.poll();
  }

  list(): ClosedSession[] {
    return [...this.closed.values()].sort((a, b) => b.closedAt - a.closedAt);
  }

  /** True if the session is closed and had no activity since. */
  isClosed(view: SessionView): boolean {
    const c = this.closed.get(view.id);
    return c !== undefined && view.lastActivity <= c.closedAt;
  }

  /** New activity after the close: the session is open again. */
  reopenIfActive(view: SessionView): void {
    const c = this.closed.get(view.id);
    if (c && view.lastActivity > c.closedAt) {
      this.closed.delete(view.id);
      this.changed();
    }
  }

  /** The SessionEnd hook. */
  close(id: string): void {
    this.open.delete(id);
    this.add(id, false);
  }

  /** The user hides a session from the live list. New activity shows it again. */
  hide(id: string): boolean {
    const c = this.closed.get(id);
    if (c) {
      c.hidden = true;
      this.changed();
      return true;
    }
    return this.add(id, true);
  }

  /** Shows a closed or hidden session in the live list again. */
  unhide(id: string): void {
    this.open.delete(id); // Else the next poll closes it again if its process ended.
    if (this.closed.delete(id)) this.changed();
  }

  /** Forgets a session, for example after its file was deleted. */
  forget(id: string): void {
    this.open.delete(id);
    if (this.closed.delete(id)) this.changed();
  }

  private add(id: string, hidden: boolean): boolean {
    const view = this.viewOf(id);
    if (!view || this.closed.has(id)) return false;
    const { title, project, branch, lastMessage, lastActivity } = view;
    this.closed.set(id, { id, title, project, branch, lastMessage, lastActivity, closedAt: Math.max(Date.now(), lastActivity), hidden });
    while (this.closed.size > MAX_CLOSED) this.closed.delete(this.list().at(-1)!.id);
    this.changed();
    return true;
  }

  private async poll(): Promise<void> {
    const live = await liveSessions();
    for (const id of live.keys()) {
      this.open.add(id);
      const c = this.closed.get(id);
      // A resumed session (claude --resume) is open again, even before its first new line.
      // Not just after SessionEnd: the process still runs for a moment then.
      if (c && !c.hidden && Date.now() - c.closedAt > REOPEN_AFTER_MS) {
        this.closed.delete(id);
        this.changed();
      }
    }
    for (const id of this.open) {
      if (!live.has(id)) this.close(id);
    }
  }

  private changed(): void {
    this.emit('change', this.list());
    void mkdir(DASH_DIR, { recursive: true })
      .then(() => writeFile(FILE, JSON.stringify(this.list(), null, 2) + '\n'))
      .catch((err) => console.error('closed.json write failed:', err));
  }
}
