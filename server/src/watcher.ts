import { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import chokidar from 'chokidar';
import { ignoredPath as ignored, PROJECTS_DIR } from './files.js';
import { Session, type HookEvent, type SessionView } from './session.js';
import { FileTail } from './tail.js';

/** Sessions with no write in this window are hidden. */
const ACTIVE_WINDOW_MS = 12 * 60 * 60_000;
/** On first sight of a file, read only this many bytes from its end. */
const START_BYTES = 64 * 1024;
const REFRESH_INTERVAL_MS = 2_000;
/** Hook events of sessions without a file yet. A new session sends hooks before its first line. */
const MAX_EARLY_HOOKS = 200;

/** Path parts relative to PROJECTS_DIR: [project, file] or [project, sessionId, 'subagents', file]. */
type Kind = { type: 'session'; id: string; projectDir: string } | { type: 'subagent'; sessionId: string } | null;

function classify(path: string): Kind {
  const parts = relative(PROJECTS_DIR, path).split(sep);
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) return { type: 'session', id: basename(parts[1], '.jsonl'), projectDir: parts[0] };
  if (parts.length === 4 && parts[2] === 'subagents' && parts[3].endsWith('.jsonl')) {
    return { type: 'subagent', sessionId: parts[1] };
  }
  return null;
}

interface Tracked {
  session: Session;
  tail: FileTail;
  /** Reads of one file run one after another. */
  queue: Promise<void>;
  /** The JSONL file. */
  path: string;
  /** True after a "remove" was sent because the session is hidden (closed). */
  hidden: boolean;
}

export interface SessionStore {
  on(event: 'upsert', fn: (view: SessionView) => void): this;
  on(event: 'remove', fn: (id: string) => void): this;
}

export class SessionStore extends EventEmitter {
  private tracked = new Map<string, Tracked>();
  /** Latest sub-agent write per session id. Kept apart, because a sub-agent file can appear before its session. */
  private subagentWrites = new Map<string, number>();
  private earlyHooks = new Map<string, { event: HookEvent; at: number }[]>();

  /** Hidden sessions (closed ones) are not sent. Set by the server. */
  hidden: (view: SessionView) => boolean = () => false;


  start(): void {
    chokidar
      .watch(PROJECTS_DIR, { ignored, alwaysStat: true, depth: 3 })
      .on('add', (path, stats) => this.onFile(path, stats))
      .on('change', (path, stats) => this.onFile(path, stats))
      .on('unlink', (path) => {
        const kind = classify(path);
        if (kind?.type === 'session') this.remove(kind.id);
      })
      .on('error', (err) => console.error('watcher error:', err));

    setInterval(() => this.refreshAll(), REFRESH_INTERVAL_MS);
  }

  views(): SessionView[] {
    return [...this.tracked.values()].map((t) => this.view(t)).filter((v) => !this.hidden(v));
  }

  /** The view of a tracked session, also when it is hidden. */
  get(sessionId: string): SessionView | null {
    const t = this.tracked.get(sessionId);
    return t ? this.view(t) : null;
  }

  /** The JSONL file of a tracked session. */
  pathOf(sessionId: string): string | null {
    return this.tracked.get(sessionId)?.path ?? null;
  }

  /** Call after the hidden rule changed (a session closed or opened again). Sends "remove" or "upsert". */
  syncHidden(): void {
    for (const t of this.tracked.values()) {
      if (this.hidden(this.view(t)) !== t.hidden) this.publish(t);
    }
  }

  /** Sends the card, or "remove" once if the session is hidden. */
  private publish(t: Tracked): void {
    const view = this.view(t);
    const hidden = this.hidden(view);
    if (!hidden) this.emit('upsert', view);
    else if (!t.hidden) this.emit('remove', view.id);
    t.hidden = hidden;
  }

  /** Sends the card again, for example when a run learns its session id. */
  resend(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (t) this.publish(t);
  }

  /** A hook event from Claude Code (POST /api/hooks). */
  applyHook(event: HookEvent): void {
    const at = Date.now();
    const t = this.tracked.get(event.session_id);
    if (!t) {
      if (this.earlyHooks.size >= MAX_EARLY_HOOKS) this.earlyHooks.delete(this.earlyHooks.keys().next().value!);
      this.earlyHooks.set(event.session_id, [...(this.earlyHooks.get(event.session_id) ?? []), { event, at }]);
      return;
    }
    t.session.applyHook(event, at);
    t.session.refresh(at);
    this.publish(t);
  }

  private view(t: Tracked): SessionView {
    return t.session.view();
  }

  private onFile(path: string, stats: Stats | undefined): void {
    const kind = classify(path);
    if (!kind || !stats) return;
    const now = Date.now();
    if (now - stats.mtimeMs > ACTIVE_WINDOW_MS) return;

    if (kind.type === 'subagent') {
      const last = Math.max(this.subagentWrites.get(kind.sessionId) ?? 0, stats.mtimeMs);
      this.subagentWrites.set(kind.sessionId, last);
      const t = this.tracked.get(kind.sessionId);
      if (t) {
        t.session.lastSubagentWrite = last;
        this.refresh(t, now);
      }
      return;
    }

    let t = this.tracked.get(kind.id);
    if (!t) {
      const session = new Session(kind.id, kind.projectDir);
      session.lastSubagentWrite = this.subagentWrites.get(kind.id) ?? 0;
      for (const { event, at } of this.earlyHooks.get(kind.id) ?? []) session.applyHook(event, at);
      this.earlyHooks.delete(kind.id);
      t = { session, tail: new FileTail(path, stats.size, START_BYTES), queue: Promise.resolve(), path, hidden: false };
      this.tracked.set(kind.id, t);
    }
    const tracked = t;
    tracked.queue = tracked.queue
      .then(async () => {
        const lines = await tracked.tail.readNewLines();
        for (const line of lines) tracked.session.applyLine(line);
        if (this.tracked.get(kind.id) !== tracked) return;
        const now = Date.now();
        // The file time can be new while the conversation is old (only metadata lines were added).
        if (now - tracked.session.view().lastActivity > ACTIVE_WINDOW_MS) return this.remove(kind.id);
        // Send the card even when the status did not change: the message or the context can change.
        tracked.session.refresh(now);
        this.publish(tracked);
      })
      .catch((err) => console.error(`read failed: ${path}:`, err));
  }

  private refreshAll(): void {
    const now = Date.now();
    for (const [id, t] of this.tracked) {
      if (now - t.session.view().lastActivity > ACTIVE_WINDOW_MS) this.remove(id);
      else this.refresh(t, now);
    }
  }

  private refresh(t: Tracked, now: number): void {
    if (t.session.refresh(now)) this.publish(t);
  }

  private remove(id: string): void {
    if (this.tracked.delete(id)) this.emit('remove', id);
  }
}
