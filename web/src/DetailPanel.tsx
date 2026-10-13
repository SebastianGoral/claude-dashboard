import { useEffect, useState } from 'react';
import { get, post } from './api';
import { clock, duration } from './format';
import type { Detail, Entry, Subagent } from './types';

/** Refresh while the panel is open: new lines and sub-agent changes are not in the SSE stream. */
const REFRESH_MS = 3000;

function EntryRow({ entry }: { entry: Entry }) {
  if (entry.kind !== 'tool') {
    return (
      <li className={`entry ${entry.kind}`}>
        <div className="entry-head">
          <span className="entry-kind">{entry.kind === 'user' ? 'You' : 'Claude'}</span>
          <span className="entry-time">{clock(entry.at)}</span>
        </div>
        <div className="entry-text">{entry.text}</div>
      </li>
    );
  }
  const status = entry.result === null ? 'running' : entry.isError ? 'error' : 'ok';
  return (
    <li className={`entry tool ${status}`}>
      <div className="entry-head">
        <span className="entry-kind">{entry.tool}</span>
        <span className="entry-input">{entry.input}</span>
        <span className="entry-time">
          {clock(entry.at)}
          {entry.doneAt !== null && entry.at > 0 && ` · ${duration(entry.doneAt - entry.at)}`}
        </span>
      </div>
      {entry.result !== null ? (
        <details>
          <summary>{entry.isError ? 'Error' : 'Result'}</summary>
          <pre>{entry.result || '(empty)'}</pre>
        </details>
      ) : (
        <div className="entry-running">running…</div>
      )}
    </li>
  );
}

function SubagentTree({ subagents }: { subagents: Subagent[] }) {
  if (subagents.length === 0) return null;
  const running = subagents.filter((s) => s.status === 'running').length;
  return (
    <section className="subagents">
      <h3>
        Sub-agents <span className="count">{running > 0 ? `${running} running · ` : ''}{subagents.length}</span>
      </h3>
      <ul>
        {subagents.map((s) => (
          <li key={s.id} className={`subagent ${s.status}`} style={{ paddingLeft: `${(s.depth - 1) * 16}px` }}>
            <span className="subagent-status">{s.status}</span>
            <span className="subagent-name" title={s.agentType}>
              {s.description}
            </span>
            {s.currentTool && (
              <span className="subagent-tool" title={s.currentInput ?? ''}>
                {s.currentTool}
                {s.currentInput ? `: ${s.currentInput}` : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DetailPanel({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      get<Detail>(`/api/sessions/${sessionId}/detail`)
        .then((d) => !stopped && (setDetail(d), setError(null)))
        .catch((err) => !stopped && setError(String(err.message ?? err)));
    setDetail(null);
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function focus() {
    setError(await post(`/api/sessions/${sessionId}/focus`));
  }

  // The newest entry first.
  const entries = detail ? [...detail.entries].reverse() : [];
  return (
    <aside className="detail" aria-label="Session detail">
      <div className="detail-head">
        <h2 title={title}>{title}</h2>
        <div className="actions">
          <button type="button" onClick={focus}>
            Open terminal
          </button>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!detail && !error && <p className="empty">Loading…</p>}
      {detail && <SubagentTree subagents={detail.subagents} />}
      {detail && (
        <ul className="entries">
          {entries.map((e, i) => (
            <EntryRow key={e.kind === 'tool' ? e.id : `${e.at}-${i}`} entry={e} />
          ))}
        </ul>
      )}
    </aside>
  );
}
