import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DASH_DIR } from './files.js';
import { liveProcesses, type ProcessInfo } from './processes.js';
import type { SessionView } from './session.js';

/**
 * The live list: which sessions the dashboard shows, and "Recently closed".
 * A session closes when its Claude Code process ends (its ~/.claude/sessions/<pid>.json is gone or the
 * pid is dead), on the SessionEnd hook, or when the user hides it. Kept in ~/.claude-dash/closed.json.
 * A closed session with new activity after closedAt is open again.
 *
 * Input: session views (SessionStore), live processes (polled), hooks and user actions.
 * Output: "upsert" and "remove" for the shown sessions (sent once per change, so the tray count is right),
 * and "closed" with the closed list.
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

export interface LiveListOptions {
  /** Where the closed list is kept. */
  file?: string;
  liveProcesses?: () => Promise<Map<string, ProcessInfo>>;
  now?: () => number;
}

const FILE = join(DASH_DIR, 'closed.json');
const MAX_CLOSED = 50;
const KEEP_MS = 7 * 24 * 60 * 60_000;
const POLL_MS = 3_000;
const REOPEN_AFTER_MS = 10_000;

export interface LiveList {
  on(event: 'upsert', fn: (view: SessionView) => void): this;
  on(event: 'remove', fn: (id: string) => void): this;
  on(event: 'closed', fn: (list: ClosedSession[]) => void): this;
}

export class LiveList extends EventEmitter {
  /** The latest view of every tracked session, shown or not. */
  private all = new Map<string, SessionView>();
  /** Sessions for which "remove" was sent. */
  private removed = new Set<string>();
  private closed = new Map<string, ClosedSession>();
  /** Sessions seen with a live process. Only these can close by process end. */
  private open = new Set<string>();
  /** Sessions checked once for a process that ended while the dashboard was off. */
  private checked = new Set<string>();
  private startedAt: number;
  private file: string;
  private liveProcesses: () => Promise<Map<string, ProcessInfo>>;
  private now: () => number;

  constructor(options: LiveListOptions = {}) {
    super();
    this.file = options.file ?? FILE;
    this.liveProcesses = options.liveProcesses ?? (() => liveProcesses());
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Loads the closed list and starts the process poll. */
  async start(): Promise<void> {
    try {
      const list: ClosedSession[] = JSON.parse(await readFile(this.file, 'utf8'));
      for (const c of list) if (this.now() - c.closedAt < KEEP_MS) this.closed.set(c.id, c);
    } catch {
      // No file yet.
    }
    setInterval(() => void this.poll(), POLL_MS);
    await this.poll();
  }

  /** The shown sessions. */
  views(): SessionView[] {
    return [...this.all.values()].filter((v) => !this.isClosed(v));
  }

  closedList(): ClosedSession[] {
    return [...this.closed.values()].sort((a, b) => b.closedAt - a.closedAt);
  }

  /** A new view of a session (from SessionStore). New activity after a close opens the session again. */
  update(view: SessionView): void {
    this.all.set(view.id, view);
    const c = this.closed.get(view.id);
    if (c && view.lastActivity > c.closedAt) {
      // Only this session changes, and publish() below sends it.
      this.closed.delete(view.id);
      this.emit('closed', this.closedList());
      this.save();
    }
    this.publish(view);
  }

  /** SessionStore stopped tracking the session (file gone, or no activity for 12 h). */
  drop(id: string): void {
    if (!this.all.delete(id)) return;
    if (!this.removed.delete(id)) this.emit('remove', id);
  }

  /** The SessionEnd hook. */
  close(id: string): void {
    this.open.delete(id);
    this.add(id, false);
  }

  /** The user hides a session from the live list. New activity shows it again. Returns false if unknown. */
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

  /** The user resumed a closed session. Its process opens it again, also if it was hidden. */
  resumed(id: string): void {
    const c = this.closed.get(id);
    if (c?.hidden) {
      c.hidden = false;
      this.changed();
    }
  }

  /** Forgets a session, for example after its file was deleted. */
  forget(id: string): void {
    this.open.delete(id);
    if (this.closed.delete(id)) this.changed();
  }

  /** Checks the live processes. Public for tests; start() runs it every 3 s. */
  async poll(): Promise<void> {
    const live = await this.liveProcesses();
    for (const id of live.keys()) {
      this.open.add(id);
      const c = this.closed.get(id);
      // A resumed session (claude --resume) is open again, even before its first new line.
      // Not just after SessionEnd: the process still runs for a moment then.
      if (c && !c.hidden && this.now() - c.closedAt > REOPEN_AFTER_MS) {
        this.closed.delete(id);
        this.changed();
      }
    }
    for (const id of this.open) {
      if (!live.has(id)) this.close(id);
    }
    this.closeEnded(live);
  }

  /**
   * Closes sessions whose process ended while the dashboard was off. Once per session.
   * Only last activity before the start: a newer session (for example after /clear) can still miss its process file.
   * Only Terminal and desktop app sessions: other sources may write no process file.
   */
  private closeEnded(live: Map<string, ProcessInfo>): void {
    for (const view of this.all.values()) {
      if (this.checked.has(view.id)) continue;
      this.checked.add(view.id);
      const known = view.source === 'terminal' || view.source === 'desktop';
      if (known && view.lastActivity < this.startedAt && !live.has(view.id)) this.close(view.id);
    }
  }

  /** Closed and no activity since. */
  private isClosed(view: SessionView): boolean {
    const c = this.closed.get(view.id);
    return c !== undefined && view.lastActivity <= c.closedAt;
  }

  /** Sends the card, or "remove" once if the session is closed. */
  private publish(view: SessionView): void {
    if (!this.isClosed(view)) {
      this.removed.delete(view.id);
      this.emit('upsert', view);
    } else if (!this.removed.has(view.id)) {
      this.removed.add(view.id);
      this.emit('remove', view.id);
    }
  }

  private add(id: string, hidden: boolean): boolean {
    const view = this.all.get(id);
    if (!view || this.closed.has(id)) return false;
    const { title, project, branch, lastMessage, lastActivity } = view;
    this.closed.set(id, { id, title, project, branch, lastMessage, lastActivity, closedAt: Math.max(this.now(), lastActivity), hidden });
    while (this.closed.size > MAX_CLOSED) this.closed.delete(this.closedList().at(-1)!.id);
    this.changed();
    return true;
  }

  /** The closed list changed: send it, send the sessions whose visibility changed, and save it. */
  private changed(): void {
    this.emit('closed', this.closedList());
    for (const view of this.all.values()) {
      if (this.isClosed(view) !== this.removed.has(view.id)) this.publish(view);
    }
    this.save();
  }

  private save(): void {
    void mkdir(dirname(this.file), { recursive: true })
      .then(() => writeFile(this.file, JSON.stringify(this.closedList(), null, 2) + '\n'))
      .catch((err) => console.error('closed.json write failed:', err));
  }
}
