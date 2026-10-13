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
}

const FILE = join(DASH_DIR, 'closed.json');
const PROCESS_DIR = join(homedir(), '.claude', 'sessions');
const MAX_CLOSED = 50;
const KEEP_MS = 7 * 24 * 60 * 60_000;
const POLL_MS = 3_000;
const REOPEN_AFTER_MS = 10_000;

/** Session ids with a live Claude Code process. */
async function liveSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const files = (await readdir(PROCESS_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const info = JSON.parse(await readFile(join(PROCESS_DIR, file), 'utf8'));
      if (typeof info.sessionId !== 'string' || typeof info.pid !== 'number') continue;
      process.kill(info.pid, 0); // Throws if the process does not exist.
      ids.add(info.sessionId);
    } catch {
      // Unreadable file or dead process.
    }
  }
  return ids;
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
    const view = this.viewOf(id);
    if (!view || this.closed.has(id)) return;
    const { title, project, branch, lastMessage, lastActivity } = view;
    this.closed.set(id, { id, title, project, branch, lastMessage, lastActivity, closedAt: Math.max(Date.now(), lastActivity) });
    while (this.closed.size > MAX_CLOSED) this.closed.delete(this.list().at(-1)!.id);
    this.changed();
  }

  private async poll(): Promise<void> {
    const live = await liveSessionIds();
    for (const id of live) {
      this.open.add(id);
      const c = this.closed.get(id);
      // A resumed session (claude --resume) is open again, even before its first new line.
      // Not just after SessionEnd: the process still runs for a moment then.
      if (c && Date.now() - c.closedAt > REOPEN_AFTER_MS) {
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
