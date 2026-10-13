import type { SessionView, Status } from '../../server/src/session.js';
import type { SettingsView } from '../../server/src/settings.js';

/** Same rule as isWaiting in web/src/types.ts: loop and workflow sessions never wait for you. */
const WAITING: ReadonlySet<Status> = new Set(['your_turn', 'needs_permission']);
const isWaiting = (view: SessionView) => !view.run && WAITING.has(view.status);
const RETRY_MS = 2_000;

export interface SessionListener {
  /** Number of sessions in your_turn or needs_permission. Called after every event. */
  onCount(count: number): void;
  /** A known session changed its status to your_turn or needs_permission. */
  onWaiting(view: SessionView): void;
  /** The shared settings changed (for example "muted"). */
  onSettings(settings: SettingsView): void;
}

/**
 * Reads the SSE stream of the server (GET /api/events) and reconnects on error.
 * A snapshot only resets the known statuses, so a start or a reconnect does not notify.
 * A session that appears for the first time does not notify either:
 * on startup the server sends the old sessions one by one as "upsert".
 */
export function watchSessions(url: string, listener: SessionListener): void {
  /** The last view of each session. */
  const views = new Map<string, SessionView>();

  const handle = (event: string, data: string) => {
    if (event === 'snapshot') {
      views.clear();
      for (const view of JSON.parse(data) as SessionView[]) views.set(view.id, view);
    } else if (event === 'upsert') {
      const view = JSON.parse(data) as SessionView;
      const before = views.get(view.id);
      views.set(view.id, view);
      if (before && before.status !== view.status && isWaiting(view)) listener.onWaiting(view);
    } else if (event === 'remove') {
      views.delete(JSON.parse(data) as string);
    } else if (event === 'settings') {
      listener.onSettings(JSON.parse(data) as SettingsView);
      return;
    } else {
      return;
    }
    let count = 0;
    for (const view of views.values()) if (isWaiting(view)) count++;
    listener.onCount(count);
  };

  void (async () => {
    for (;;) {
      try {
        await readStream(url, handle);
      } catch (err) {
        console.error('sse:', err);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  })();
}

/** Resolves when the stream ends. Calls handle once per event. */
async function readStream(url: string, handle: (event: string, data: string) => void): Promise<void> {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length > 0) handle(event, data.join('\n'));
    }
  }
}
