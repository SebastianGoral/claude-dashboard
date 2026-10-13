import { useEffect, useRef, useState } from 'react';
import { playFinished, playNeedsYou } from './sounds';
import { isWaiting, type ClosedSession, type Session, type Settings } from './types';

const IN_DESKTOP_APP = navigator.userAgent.includes('Electron');

/** Keeps a Map in state. `set` adds or replaces one item. */
function useMap<T extends { id: string }>() {
  const [map, setMap] = useState<Map<string, T>>(new Map());
  return {
    map,
    reset: (list: T[]) => setMap(new Map(list.map((x) => [x.id, x]))),
    set: (item: T) => setMap((prev) => new Map(prev).set(item.id, item)),
    remove: (id: string) =>
      setMap((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      }),
  };
}

/**
 * The SSE stream of the server (GET /api/events): sessions, closed sessions and settings.
 * Plays a sound when a known session starts to wait for you. Not in the desktop app, and not while
 * the desktop app is connected: it sends a macOS notification with sound, so this would be a double alert.
 */
export function useEvents() {
  const sessions = useMap<Session>();
  const [settings, setSettings] = useState<Settings>({
    muted: false,
    newSessionApp: 'terminal',
    hiddenFolders: [],
    extraFolders: [],
    desktopConnected: false,
    hooksInstalled: false,
  });
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState<ClosedSession[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const statuses = new Map<string, Session>();
    const alert = (before: Session | undefined, s: Session) => {
      if (!before || before.status === s.status || !isWaiting(s)) return;
      const { muted, desktopConnected } = settingsRef.current;
      if (muted || desktopConnected || IN_DESKTOP_APP) return;
      if (s.status === 'needs_permission') playNeedsYou();
      else playFinished();
    };

    const events = new EventSource('/api/events');
    const on = <T,>(name: string, fn: (data: T) => void) => events.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    on<Session[]>('snapshot', (list) => {
      statuses.clear();
      for (const s of list) statuses.set(s.id, s);
      sessions.reset(list);
    });
    on<Session>('upsert', (s) => {
      alert(statuses.get(s.id), s);
      statuses.set(s.id, s);
      sessions.set(s);
    });
    on<string>('remove', (id) => {
      statuses.delete(id);
      sessions.remove(id);
    });
    on<Settings>('settings', setSettings);
    on<ClosedSession[]>('closed', setClosed);
    return () => events.close();
    // The setters of useMap are stable in behavior; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { sessions: sessions.map, settings, connected, closed };
}
