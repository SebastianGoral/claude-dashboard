import { useCallback, useEffect, useState } from 'react';
import { get, post } from './api';
import type { Worktree } from './types';

/** Why Remove can fail, or null for a clean worktree. */
const stateLabel = (w: Worktree): string | null =>
  w.sessionId ? 'live session' : w.changes === null ? 'folder gone' : w.changes === 0 ? null : `${w.changes} uncommitted file${w.changes === 1 ? '' : 's'}`;

/** Git worktrees under .claude/worktrees. Remove keeps the branch. Git refuses a worktree with changes. */
export function Worktrees() {
  const [items, setItems] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Worktree[]>('/api/worktrees')
      .then(setItems)
      .catch((err) => setError(String(err.message ?? err)));
  }, []);
  useEffect(load, [load]);

  async function remove(w: Worktree) {
    if (!confirm(`Remove the worktree ${w.path}? The branch ${w.branch ?? ''} stays.`)) return;
    setBusy(w.path);
    setError(await post('/api/worktrees/remove', { path: w.path }));
    setBusy(null);
    load();
  }

  return (
    <section className="history">
      <h2>
        Worktrees <span className="count">{items?.length ?? ''}</span>
      </h2>
      <p className="hint">Worktrees under .claude/worktrees. Remove keeps the branch. Git refuses a worktree with uncommitted files.</p>
      {error && <div className="error">{error}</div>}
      {!items && !error && <p className="empty">Loading…</p>}
      {items?.length === 0 && <p className="empty">No worktrees.</p>}
      <ul className="worktree-list">
        {items?.map((w) => (
          <li key={w.path}>
            <div className="history-item">
              <span className="history-head">
                <span className="title">{w.path.split('/').pop()}</span>
                <span className="project">{w.repo.split('/').pop()}</span>
                {w.branch && <span className="branch">{w.branch}</span>}
                {stateLabel(w) && <span className="closed-time">{stateLabel(w)}</span>}
              </span>
              <span className="history-snippet">{w.path}</span>
            </div>
            <button
              type="button"
              className="details-button"
              onClick={() => remove(w)}
              disabled={busy !== null || w.sessionId !== null}
              title={w.sessionId ? 'A live session runs here. Close it first.' : 'git worktree remove'}
            >
              {busy === w.path ? 'Removing…' : 'Remove'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
