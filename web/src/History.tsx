import { useEffect, useState, type FormEvent } from 'react';
import { get } from './api';
import { ago, clock } from './format';
import type { HistoryItem, SearchResult } from './types';

const KIND_LABEL = { prompt: 'You', answer: 'Claude', tool: 'Tool', result: 'Result' } as const;
const PAGE = 100;

/** All old sessions, and a search over all of them. A click opens the detail panel. */
export function History({ onDetails }: { onDetails: (id: string) => void }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<HistoryItem[]>('/api/history')
      .then(setItems)
      .catch((err) => setError(String(err.message ?? err)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return setResult(null);
    setSearching(true);
    try {
      setResult(await get<SearchResult>(`/api/search?q=${encodeURIComponent(query.trim())}`));
      setError(null);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="history">
      <form className="search" onSubmit={submit}>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) setResult(null);
          }}
          placeholder="Search all sessions: messages, tool calls, file paths"
          aria-label="Search all sessions"
        />
        <button type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && <div className="error">{error}</div>}

      {result && (
        <>
          <p className="hint">
            {result.hits.length} hits in {result.filesScanned} sessions ({Math.round(result.bytesScanned / 1e6)} MB) in{' '}
            {(result.elapsedMs / 1000).toFixed(1)} s{result.truncated ? '. Stopped early: refine the search for more.' : ''}
          </p>
          <ul className="history-list">
            {result.hits.map((h, i) => (
              <li key={`${h.sessionId}-${i}`}>
                <button type="button" className="history-item" onClick={() => onDetails(h.sessionId)}>
                  <span className="history-head">
                    <span className="title">{h.title ?? h.project}</span>
                    <span className="project">{h.project}</span>
                    <span className="closed-time">{clock(h.at)}</span>
                  </span>
                  <span className="history-snippet">
                    <span className="tag">{h.tool ?? KIND_LABEL[h.kind]}</span> {h.snippet}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {!result && (
        <>
          {!items && !error && <p className="empty">Loading…</p>}
          {items && (
            <h2>
              All sessions <span className="count">{items.length}</span>
            </h2>
          )}
          <ul className="history-list">
            {items?.slice(0, shown).map((h) => (
              <li key={h.id}>
                <button type="button" className="history-item" onClick={() => onDetails(h.id)}>
                  <span className="history-head">
                    <span className="title">{h.title ?? (h.firstPrompt || h.id.slice(0, 8))}</span>
                    <span className="project">{h.project}</span>
                    {h.branch && <span className="branch">{h.branch}</span>}
                    <span className="closed-time">{ago(h.lastActivity)}</span>
                  </span>
                  {h.title && h.firstPrompt && <span className="history-snippet">{h.firstPrompt}</span>}
                </button>
              </li>
            ))}
          </ul>
          {items && items.length > shown && (
            <button type="button" onClick={() => setShown((n) => n + PAGE)}>
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
