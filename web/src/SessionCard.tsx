import { useState } from 'react';
import { dollars, duration } from './format';
import type { Session } from './types';

const ERROR_SHOW_MS = 4000;

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
  /** US dollars, with sub-agents. Undefined while the cost is not known yet. */
  cost: number | undefined;
  onDetails: (id: string) => void;
}

const SOURCE_LABEL: Record<Session['source'], string | null> = {
  terminal: 'Terminal',
  desktop: 'Desktop app',
  vscode: 'VS Code',
  sdk: 'Agent SDK',
  other: null,
};

/** "Cache 3:12" while the prompt cache lives. Only when the session waits: while it works, each call renews it. */
function cacheLabel(session: Session, now: number): { text: string; expired: boolean } | null {
  if (!session.cacheExpiresAt || session.status === 'working' || session.status === 'needs_permission') return null;
  const left = session.cacheExpiresAt - now;
  if (left <= 0) return { text: 'Cache expired', expired: true };
  const s = Math.floor(left / 1000);
  const time = s >= 3600 ? '60:00' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return { text: `Cache ${time}`, expired: false };
}

export function SessionCard({ session, now, cost, onDetails }: Props) {
  const elapsed = duration(now - session.statusSince);
  const percent = Math.min(100, Math.round((session.contextTokens / session.contextLimit) * 100));
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low';
  const [error, setError] = useState<string | null>(null);
  const cache = cacheLabel(session, now);

  async function focus() {
    const res = await fetch(`/api/sessions/${session.id}/focus`, { method: 'POST' }).catch(() => null);
    if (res?.ok) return;
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? 'Could not focus the terminal');
    setTimeout(() => setError(null), ERROR_SHOW_MS);
  }

  return (
    <article className={`card ${session.status}${session.status === 'needs_permission' && session.exact ? ' exact' : ''}${session.run ? ' run-session' : ''}`} onClick={focus} title="Open the terminal of this session">
      <div className="top">
        <span className="title">{session.title ?? session.project}</span>
        <span className={`badge ${session.status}`}>{statusLabel(session, elapsed)}</span>
        <button
          type="button"
          className="details-button"
          title="Show messages, tool calls and sub-agents"
          onClick={(e) => {
            e.stopPropagation();
            onDetails(session.id);
          }}
        >
          Details
        </button>
      </div>
      <div className="meta">
        {session.run && <span className="tag">{session.run.kind === 'loop' ? 'Loop' : 'Workflow'}</span>}
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
        {cache && (
          <span className={cache.expired ? 'cache expired' : 'cache'} title="Time until the prompt cache expires (about). After that, the next message costs more.">
            {cache.text}
          </span>
        )}
        {cost !== undefined && <span className="cost" title="Cost of this session, with sub-agents (estimate from prices.ts)">{dollars(cost)}</span>}
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
