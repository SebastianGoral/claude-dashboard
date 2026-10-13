import { createReadStream, type Stats } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import chokidar from 'chokidar';
import { ignoredPath as ignored, PROJECTS_DIR } from './files.js';
import { costOf } from './prices.js';
import { FileTail } from './tail.js';

/**
 * Cost per session and per day, from the usage of each assistant message in the JSONL files
 * (session files and sub-agent files). Reads each file fully once, then only the new lines.
 */

export interface CostView {
  /** Today's total over all sessions, in US dollars. Local time. */
  today: number;
  /** Cost per session id (the whole session, with its sub-agents). */
  sessions: Record<string, number>;
  /** Models without a price in prices.ts. Their cost is not counted. */
  unknownModels: string[];
}

/** Files without a write in this window are not read. Covers today and the 12 h list window. */
const WINDOW_MS = 36 * 60 * 60_000;
const EMIT_MS = 2_000;

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export interface UsageTracker {
  on(event: 'change', fn: (view: CostView) => void): this;
}

export class UsageTracker extends EventEmitter {
  private tails = new Map<string, { tail: FileTail | null; queue: Promise<void> }>();
  /** Claude Code writes one line per content block; all lines of a message share id and usage. */
  private seen = new Set<string>();
  private sessions = new Map<string, number>();
  private days = new Map<string, number>();
  private unknown = new Set<string>();
  private dirty = false;

  start(): void {
    chokidar
      .watch(PROJECTS_DIR, { ignored, alwaysStat: true, depth: 3 })
      .on('add', (path, stats) => this.onFile(path, stats))
      .on('change', (path, stats) => this.onFile(path, stats))
      .on('error', (err) => console.error('usage watcher error:', err));
    setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.emit('change', this.view());
    }, EMIT_MS);
  }

  view(): CostView {
    return {
      today: this.days.get(dayKey(Date.now())) ?? 0,
      sessions: Object.fromEntries(this.sessions),
      unknownModels: [...this.unknown],
    };
  }

  private onFile(path: string, stats: Stats | undefined): void {
    if (!path.endsWith('.jsonl') || !stats || Date.now() - stats.mtimeMs > WINDOW_MS) return;
    let t = this.tails.get(path);
    if (!t) {
      t = { tail: null, queue: Promise.resolve() };
      this.tails.set(path, t);
      const entry = t;
      // First sight: stream the whole file (it can be large), then tail from where the stream ended.
      entry.queue = this.readAll(path, stats.size).then(() => {
        entry.tail = new FileTail(path, stats.size, 0);
      });
    }
    const entry = t;
    entry.queue = entry.queue
      .then(async () => {
        for (const line of (await entry.tail?.readNewLines()) ?? []) this.applyLine(line);
      })
      .catch((err) => console.error(`usage read failed: ${path}:`, err));
  }

  private async readAll(path: string, size: number): Promise<void> {
    if (size === 0) return;
    const lines = createInterface({ input: createReadStream(path, { start: 0, end: size - 1 }), crlfDelay: Infinity });
    for await (const line of lines) this.applyLine(line);
  }

  private applyLine(raw: string): void {
    // Fast filter: most lines are not assistant messages with usage.
    if (!raw.includes('"usage"') || !raw.includes('"assistant"')) return;
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      return;
    }
    const message = line.message;
    if (line.type !== 'assistant' || !message?.usage || typeof message.model !== 'string' || message.model === '<synthetic>') return;
    const key = message.id ?? line.uuid;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const cost = costOf(message.model, message.usage);
    if (cost === null) {
      this.unknown.add(message.model);
      return;
    }
    if (typeof line.sessionId === 'string') this.sessions.set(line.sessionId, (this.sessions.get(line.sessionId) ?? 0) + cost);
    const at = Date.parse(line.timestamp);
    if (Number.isFinite(at)) {
      const day = dayKey(at);
      this.days.set(day, (this.days.get(day) ?? 0) + cost);
    }
    this.dirty = true;
  }
}
