import { useState } from 'react';
import { duration } from './format';
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

  async function focus() {
    const res = await fetch(`/api/sessions/${session.id}/focus`, { method: 'POST' }).catch(() => null);
    if (res?.ok) return;
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? 'Could not focus the terminal');
    setTimeout(() => setError(null), ERROR_SHOW_MS);
  }

  return (
    <article className={`card ${session.status}${session.status === 'needs_permission' && session.exact ? ' exact' : ''}`} onClick={focus} title="Open the terminal of this session">
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
