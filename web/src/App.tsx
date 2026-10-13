import { useCallback, useEffect, useState } from 'react';
import { post } from './api';
import { DetailPanel } from './DetailPanel';
import { ago } from './format';
import { History } from './History';
import { SessionCard } from './SessionCard';
import { unlockSound } from './sounds';
import { isWaiting, type ClosedSession, type Session, type Settings, type Status } from './types';
import { useEvents } from './useEvents';

const ORDER: Record<Status, number> = { your_turn: 0, needs_permission: 1, working: 2, idle: 3 };

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    if (ORDER[a.status] !== ORDER[b.status]) return ORDER[a.status] - ORDER[b.status];
    // Waiting sessions: the longest wait first. Others: the latest activity first.
    return isWaiting(a) ? a.statusSince - b.statusSince : b.lastActivity - a.lastActivity;
  });
}

interface Group {
  project: string;
  sessions: Session[];
}

/** Groups sessions by project. The project with the latest activity comes first. */
function groupByProject(sessions: Session[]): Group[] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) groups.set(s.project, [...(groups.get(s.project) ?? []), s]);
  const latest = (list: Session[]) => Math.max(...list.map((s) => s.lastActivity));
  return [...groups]
    .map(([project, list]) => ({ project, sessions: list }))
    .sort((a, b) => latest(b.sessions) - latest(a.sessions));
}

interface SectionProps {
  title: string;
  sessions: Session[];
  now: number;
  className?: string;
  onDetails: (id: string) => void;
}

function Section({ title, sessions, now, className, onDetails }: SectionProps) {
  return (
    <section className={className}>
      <h2>
        {title} <span className="count">{sessions.length}</span>
      </h2>
      <div className="grid">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} now={now} onDetails={onDetails} />
        ))}
      </div>
    </section>
  );
}

/** Sessions whose Claude Code process ended. Folded by default. */
function ClosedSection({ closed, onDetails }: { closed: ClosedSession[]; onDetails: (id: string) => void }) {
  if (closed.length === 0) return null;
  return (
    <details className="closed">
      <summary>
        <h2>
          Recently closed <span className="count">{closed.length}</span>
        </h2>
      </summary>
      <ul className="closed-list">
        {closed.map((c) => (
          <li key={c.id}>
            <button type="button" className="closed-item" onClick={() => onDetails(c.id)} title="Show messages and tool calls">
              <span className="title">{c.title ?? c.project}</span>
              <span className="project">{c.project}</span>
              {c.branch && <span className="branch">{c.branch}</span>}
              <span className="closed-time">closed {ago(c.closedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Mute and hooks. Both are server settings, so the web app and the desktop app share them. */
function HeaderToggles({ settings }: { settings: Settings }) {
  const [error, setError] = useState<string | null>(null);

  async function toggleHooks() {
    if (settings.hooksInstalled) {
      if (!confirm('Remove the claude-dash hooks from ~/.claude/settings.json?')) return;
      setError(await post('/api/hooks/remove'));
    } else {
      const text =
        'Add hooks to ~/.claude/settings.json? They send each Claude Code event to this dashboard, ' +
        'for an exact "needs permission" status. A backup is written first. New sessions use the hooks.';
      if (!confirm(text)) return;
      setError(await post('/api/hooks/install'));
    }
  }

  return (
    <>
      <button type="button" className="header-toggle" onClick={toggleHooks} title="Claude Code hooks give the exact status">
        Hooks: {settings.hooksInstalled ? 'on' : 'off'}
      </button>
      <button type="button" className="header-toggle" onClick={() => post('/api/settings', { muted: !settings.muted })}>
        Sound: {settings.muted ? 'off' : 'on'}
      </button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

export function App() {
  const { sessions, settings, connected, closed } = useEvents();
  const [detailId, setDetailId] = useState<string | null>(null);
  // "#history" opens the tucked-away History tab. The Live view is the default.
  const [tab, setTab] = useState<'live' | 'history'>(location.hash === '#history' ? 'history' : 'live');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const onHash = () => setTab(location.hash === '#history' ? 'history' : 'live');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Update the "time in status" labels every second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // The browser allows sound only after a click on the page.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockSound, { once: true });
    return () => window.removeEventListener('pointerdown', unlockSound);
  }, []);

  const list = sortSessions([...sessions.values()]);
  const waiting = list.filter(isWaiting);
  // Sessions that wait for you are in their own section at the top, not in the project groups.
  const groups = groupByProject(list.filter((s) => !isWaiting(s)));

  const closeDetail = useCallback(() => setDetailId(null), []);
  const detailTitle = (id: string) => {
    const s = sessions.get(id) ?? closed.find((c) => c.id === id);
    return s ? (s.title ?? s.project) : id.slice(0, 8);
  };

  useEffect(() => {
    document.title = waiting.length > 0 ? `(${waiting.length}) Dashboard` : 'Dashboard';
  }, [waiting.length]);

  return (
    <main>
      <header>
        <h1>Claude sessions</h1>
        <span className={connected ? 'conn ok' : 'conn'}>{connected ? 'live' : 'disconnected'}</span>
        <nav className="tabs">
          <a href="#" className={tab === 'live' ? 'active' : ''}>
            Live
          </a>
          <a href="#history" className={tab === 'history' ? 'active' : ''}>
            History
          </a>
        </nav>
        <div className="header-actions">
          <HeaderToggles settings={settings} />
        </div>
      </header>
      {tab === 'history' && <History onDetails={setDetailId} />}
      {tab === 'live' && (
        <>
          {list.length === 0 && <p className="empty">No active sessions in the last 12 hours.</p>}
          {waiting.length > 0 && <Section title="Waiting for you" sessions={waiting} now={now} className="waiting" onDetails={setDetailId} />}
          {groups.map((g) => (
            <Section key={g.project} title={g.project} sessions={g.sessions} now={now} onDetails={setDetailId} />
          ))}
          <ClosedSection closed={closed} onDetails={setDetailId} />
        </>
      )}
      {detailId && <DetailPanel sessionId={detailId} title={detailTitle(detailId)} onClose={closeDetail} />}
    </main>
  );
}
