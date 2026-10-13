import { useRef, useState } from 'react';
import { post } from './api';
import { duration } from './format';
import type { Session } from './types';
import { useCloseOutside } from './useCloseOutside';

const ERROR_SHOW_MS = 4000;
/** The "Sure? Kill" button goes back to "Kill" after this time. */
const CONFIRM_MS = 4000;

function statusLabel(session: Session, elapsed: string): string {
  switch (session.status) {
    case 'working':
      return `Working · ${elapsed}`;
    case 'your_turn':
      return `Your turn · ${elapsed}`;
    case 'needs_permission':
      // Exact from hooks. Without hooks a guess from JSONL: a long tool run looks the same. statusSince is the tool start.
      if (session.exact) return `Needs permission${session.permissionTool ? `: ${session.permissionTool}` : ''} · ${elapsed}`;
      return `Waiting? (tool running ${elapsed})`;
    case 'idle':
      return `Idle · ${elapsed}`;
  }
}

interface Props {
  session: Session;
  now: number;
  onDetails: (id: string) => void;
}

const SOURCE_LABEL: Record<Session['source'], string | null> = {
  terminal: 'Terminal',
  desktop: 'Desktop app',
  vscode: 'VS Code',
  sdk: 'Agent SDK',
  other: null,
};

export function SessionCard({ session, now, onDetails }: Props) {
  const elapsed = duration(now - session.statusSince);
  const percent = Math.min(100, Math.round((session.contextTokens / session.contextLimit) * 100));
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low';
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useCloseOutside(menuRef, menuOpen, () => setMenuOpen(false));

  function showError(text: string) {
    setError(text);
    setTimeout(() => setError(null), ERROR_SHOW_MS);
  }

  async function focus() {
    const res = await fetch(`/api/sessions/${session.id}/focus`, { method: 'POST' }).catch(() => null);
    if (res?.ok) return;
    const body = await res?.json().catch(() => null);
    showError(body?.error ?? 'Could not focus the terminal');
  }

  return (
    <article className={`card ${session.status}${session.status === 'needs_permission' && session.exact ? ' exact' : ''}`} onClick={focus} title="Open the terminal of this session">
      <div className="top">
        <span className="title">{session.title ?? session.project}</span>
        <span className={`badge ${session.status}`}>{statusLabel(session, elapsed)}</span>
        {/* A click in the menu must not open the terminal. */}
        <div className="card-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="details-button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-label="Actions"
            title="Details, Hide, Kill"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="card-menu-panel">
              <button
                type="button"
                className="details-button"
                title="Show messages, tool calls and sub-agents"
                onClick={() => {
                  setMenuOpen(false);
                  onDetails(session.id);
                }}
              >
                Details
              </button>
              <button
                type="button"
                className="details-button"
                title="Hide this session. It moves to Recently closed. New activity shows it again."
                onClick={async () => {
                  setMenuOpen(false);
                  const err = await post(`/api/sessions/${session.id}/hide`);
                  if (err) showError(err);
                }}
              >
                Hide
              </button>
              {/* Only Terminal sessions: in the desktop app the process can be the app itself. */}
              {session.source === 'terminal' && (
                <button
                  type="button"
                  className={`details-button${confirmKill ? ' confirm' : ''}`}
                  title={
                    confirmKill
                      ? `Click again to stop the claude process${session.status === 'working' ? '. It is working now.' : '.'}`
                      : 'Stop the claude process and hide this session. The Terminal tab stays open.'
                  }
                  onClick={async () => {
                    if (!confirmKill) {
                      setConfirmKill(true);
                      setTimeout(() => setConfirmKill(false), CONFIRM_MS);
                      return;
                    }
                    setConfirmKill(false);
                    setMenuOpen(false);
                    const err = await post(`/api/sessions/${session.id}/kill`);
                    if (err) showError(err);
                  }}
                >
                  {confirmKill ? (session.status === 'working' ? 'Working! Kill?' : 'Sure? Kill') : 'Kill'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="meta">
        {SOURCE_LABEL[session.source] && <span className={`source ${session.source}`}>{SOURCE_LABEL[session.source]}</span>}
        {session.title && <span className="project">{session.project}</span>}
        {session.branch && <span className="branch">{session.branch}</span>}
      </div>
      <p className="message">{session.lastMessage || <em>No message yet</em>}</p>
      <div className="context" title={`${session.contextTokens.toLocaleString()} / ${session.contextLimit.toLocaleString()} tokens`}>
        <div className="bar">
          <div className={`fill ${level}`} style={{ width: `${percent}%` }} />
        </div>
        <span>
          {Math.round(session.contextTokens / 1000)}k / {session.contextLimit / 1000}k · {percent}%
        </span>
      </div>
      {session.error && (
        <div className="session-error" title={session.error.text}>
          {session.error.kind === 'api' ? 'API error' : `Tool error${session.error.tool ? ` (${session.error.tool})` : ''}`}: {session.error.text}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </article>
  );
}
