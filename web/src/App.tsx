import { useCallback, useEffect, useState } from 'react';
import { post } from './api';
import { CommandPalette } from './CommandPalette';
import { DetailPanel } from './DetailPanel';
import { History } from './History';
import { ago, dollars } from './format';
import { LoopCard, NewLoopForm } from './Loops';
import { SessionCard } from './SessionCard';
import { unlockSound } from './sounds';
import { isWaiting, type ClosedSession, type Session, type Settings, type Status } from './types';
import { useEvents } from './useEvents';
import { NewRunForm, RunCard } from './Workflows';

const ORDER: Record<Status, number> = { your_turn: 0, needs_permission: 1, working: 2, idle: 3 };

type View = 'grid' | 'list' | 'kanban';
const VIEWS: { id: View; label: string }[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'list', label: 'List' },
  { id: 'kanban', label: 'Kanban' },
];
const KANBAN: { status: Status; title: string }[] = [
  { status: 'your_turn', title: 'Your turn' },
  { status: 'needs_permission', title: 'Needs permission' },
  { status: 'working', title: 'Working' },
  { status: 'idle', title: 'Idle' },
];
const VIEW_KEY = 'claude-dash.view';

/** The view is a per-browser choice. Storage can be blocked, so every access is guarded. */
function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'list' || v === 'kanban') return v;
  } catch {
    // Blocked storage: the default view.
  }
  return 'grid';
}

function saveView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Blocked storage: the choice lasts until reload.
  }
}

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
  costs: Record<string, number>;
}

function Section({ title, sessions, now, className, onDetails, costs }: SectionProps) {
  return (
    <section className={className}>
      <h2>
        {title} <span className="count">{sessions.length}</span>
      </h2>
      <div className="grid">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} now={now} cost={costs[s.id]} onDetails={onDetails} />
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
  const { sessions, loops, runs, settings, connected, closed, costs } = useEvents();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [view, setView] = useState<View>(loadView);
  // "#history" opens the tucked-away History tab. The Live view is the default.
  const [tab, setTab] = useState<'live' | 'history'>(location.hash === '#history' ? 'history' : 'live');
  useEffect(() => {
    const onHash = () => setTab(location.hash === '#history' ? 'history' : 'live');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Cmd+K (Ctrl+K on other systems) opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [form, setForm] = useState<'loop' | 'workflow' | null>(null);
  const [now, setNow] = useState(Date.now());

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
  // Loops and workflow runs. Running ones first, then the latest started.
  const runList = [
    ...[...loops.values()].map((loop) => ({ kind: 'loop' as const, loop, endedAt: loop.endedAt, startedAt: loop.startedAt })),
    ...[...runs.values()].map((run) => ({ kind: 'workflow' as const, run, endedAt: run.endedAt, startedAt: run.startedAt })),
  ].sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || b.startedAt - a.startedAt);
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
        <span
          className="today-cost"
          title={`Today's cost over all sessions (estimate from server/src/prices.ts)${costs.unknownModels.length ? `. No price for: ${costs.unknownModels.join(', ')}` : ''}`}
        >
          Today {dollars(costs.today)}
        </span>
        <nav className="tabs">
          <a href="#" className={tab === 'live' ? 'active' : ''}>
            Live
          </a>
          <a href="#history" className={tab === 'history' ? 'active' : ''}>
            History
          </a>
        </nav>
        <div className="header-actions">
          <button type="button" className="header-toggle" onClick={() => setPalette(true)} title="Jump to a session (Cmd+K)">
            ⌘K
          </button>
          <div className="view-switch" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={view === v.id ? 'header-toggle active' : 'header-toggle'}
                aria-pressed={view === v.id}
                onClick={() => {
                  setView(v.id);
                  saveView(v.id);
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
          <HeaderToggles settings={settings} />
          <button type="button" onClick={() => setForm('loop')} disabled={form !== null}>
            New loop
          </button>
          <button type="button" onClick={() => setForm('workflow')} disabled={form !== null}>
            New workflow
          </button>
        </div>
      </header>
      {tab === 'history' && <History onDetails={setDetailId} />}
      {tab === 'live' && (
        <>
      {form === 'loop' && <NewLoopForm onClose={() => setForm(null)} />}
      {form === 'workflow' && <NewRunForm onClose={() => setForm(null)} />}
      {runList.length > 0 && (
        <section className="loops">
          <h2>
            Loops and workflows <span className="count">{runList.length}</span>
          </h2>
          <div className="grid">
            {runList.map((r) => (r.kind === 'loop' ? <LoopCard key={r.loop.id} loop={r.loop} /> : <RunCard key={r.run.id} run={r.run} />))}
          </div>
        </section>
      )}
      {list.length === 0 && <p className="empty">No active sessions in the last 12 hours.</p>}
      {view === 'kanban' ? (
        <div className="kanban">
          {KANBAN.map((col) => (
            <Section
              key={col.status}
              title={col.title}
              sessions={list.filter((s) => s.status === col.status)}
              now={now}
              className={`kanban-col ${col.status}`}
              onDetails={setDetailId}
              costs={costs.sessions}
            />
          ))}
        </div>
      ) : (
        <div className={view === 'list' ? 'view-list' : undefined}>
          {waiting.length > 0 && (
            <Section title="Waiting for you" sessions={waiting} now={now} className="waiting" onDetails={setDetailId} costs={costs.sessions} />
          )}
          {groups.map((g) => (
            <Section key={g.project} title={g.project} sessions={g.sessions} now={now} onDetails={setDetailId} costs={costs.sessions} />
          ))}
        </div>
      )}
      <ClosedSection closed={closed} onDetails={setDetailId} />
        </>
      )}
      {palette && (
        <CommandPalette
          sessions={list}
          closed={closed}
          onPick={(id) => {
            setPalette(false);
            setDetailId(id);
          }}
          onClose={() => setPalette(false)}
        />
      )}
      {detailId && <DetailPanel sessionId={detailId} title={detailTitle(detailId)} onClose={closeDetail} />}
    </main>
  );
}
