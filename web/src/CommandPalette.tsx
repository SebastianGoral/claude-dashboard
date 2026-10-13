import { useEffect, useMemo, useRef, useState } from 'react';
import { get } from './api';
import { ago } from './format';
import type { ClosedSession, HistoryItem, Session } from './types';

interface Item {
  id: string;
  title: string;
  project: string;
  branch: string | null;
  /** "live", "closed" or "history". */
  group: string;
  at: number;
}

const MAX_ITEMS = 50;

/** All words of the query must be in the title, project or branch. */
function matches(item: Item, words: string[]): boolean {
  const text = `${item.title} ${item.project} ${item.branch ?? ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Cmd+K (Ctrl+K): type to find a session, Enter opens its detail panel. */
export function CommandPalette({
  sessions,
  closed,
  onPick,
  onClose,
}: {
  sessions: Session[];
  closed: ClosedSession[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    get<HistoryItem[]>('/api/history').then(setHistory, () => undefined);
  }, []);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const all: Item[] = [];
    const add = (item: Item) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      all.push(item);
    };
    for (const s of sessions) add({ id: s.id, title: s.title ?? s.project, project: s.project, branch: s.branch, group: 'live', at: s.lastActivity });
    for (const c of closed) add({ id: c.id, title: c.title ?? c.project, project: c.project, branch: c.branch, group: 'closed', at: c.closedAt });
    for (const h of history) {
      add({ id: h.id, title: h.title ?? (h.firstPrompt || h.id.slice(0, 8)), project: h.project, branch: h.branch, group: 'history', at: h.lastActivity });
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((i) => matches(i, words)).slice(0, MAX_ITEMS);
  }, [sessions, closed, history, query]);

  useEffect(() => setIndex(0), [query]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && items[index]) {
      e.preventDefault();
      onPick(items[index].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Jump to a session" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Jump to a session…"
          aria-label="Session name, project or branch"
        />
        <ul>
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                className={i === index ? 'palette-item selected' : 'palette-item'}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(item.id)}
              >
                <span className="title">{item.title}</span>
                <span className="project">{item.project}</span>
                <span className={`palette-group ${item.group}`}>{item.group}</span>
                <span className="closed-time">{ago(item.at)}</span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="empty">No session found.</li>}
        </ul>
      </div>
    </div>
  );
}
