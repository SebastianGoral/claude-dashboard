import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { get, post } from './api';
import { DetailPanel } from './DetailPanel';
import { ago } from './format';
import { History } from './History';
import { Worktrees } from './Worktrees';
import { SessionCard } from './SessionCard';
import { unlockSound } from './sounds';
import { isWaiting, type ClosedSession, type Folder, type Session, type Settings, type Status } from './types';
import { useEvents } from './useEvents';

const ORDER: Record<Status, number> = { your_turn: 0, needs_permission: 1, working: 2, idle: 3 };

type View = 'groups' | 'kanban';
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
    if (localStorage.getItem(VIEW_KEY) === 'kanban') return 'kanban';
  } catch {
    // Blocked storage: the default view.
  }
  return 'groups';
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
  /** Starts a new session in the project folder. Only on project groups. */
  onNew?: () => void;
}

function Section({ title, sessions, now, className, onDetails, onNew }: SectionProps) {
  return (
    <section className={className}>
      <h2>
        {title} <span className="count">{sessions.length}</span>
        {onNew && (
          <button type="button" className="new-button" onClick={onNew} title="Start a new session in this folder">
            + New
          </button>
        )}
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
              <span className="closed-time">
                {c.hidden ? 'hidden' : 'closed'} {ago(c.closedAt)}
              </span>
            </button>
            {c.hidden && (
              <button type="button" className="details-button" onClick={() => post(`/api/sessions/${c.id}/unhide`)} title="Show it in the live list again">
                show
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The "New session" menu: all project folders, with hide, and a field to add a folder. */
function NewSessionMenu({ folders, onOpen, onChange }: { folders: Folder[]; onOpen: (path: string) => void; onChange: () => void }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const err = await post('/api/folders/add', { path });
    setError(err);
    if (!err) setPath('');
    onChange();
  }

  async function hide(folder: string) {
    setError(await post('/api/folders/hide', { path: folder }));
    onChange();
  }

  return (
    <details className="new-menu" onToggle={(e) => (e.currentTarget.open ? onChange() : undefined)}>
      <summary className="header-toggle">New session</summary>
      <div className="new-menu-panel">
        <ul>
          {folders.map((f) => (
            <li key={f.path}>
              <button type="button" className="folder" onClick={() => onOpen(f.path)} title={f.path}>
                <span className="title">{f.name}</span>
                <span className="folder-path">{f.path}</span>
              </button>
              <button type="button" className="details-button" onClick={() => hide(f.path)} title="Hide this folder">
                hide
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={add}>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/path/to/project" />
          <button type="submit" disabled={!path.trim()}>
            Add
          </button>
        </form>
        {error && <span className="error">{error}</span>}
      </div>
    </details>
  );
}

/** Hooks, sound and "New in" behind a menu button. All are server settings, so the web app and the desktop app share them. */
function SettingsMenu({ settings }: { settings: Settings }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // A click outside the menu or Esc closes it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
    <div className="settings-menu" ref={ref}>
      <button type="button" className="header-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Settings" title="Settings">
        ☰
      </button>
      {open && (
        <div className="settings-panel">
          <button type="button" className="header-toggle" onClick={toggleHooks} title="Claude Code hooks give the exact status">
            Hooks: {settings.hooksInstalled ? 'on' : 'off'}
          </button>
          <button type="button" className="header-toggle" onClick={() => post('/api/settings', { muted: !settings.muted })}>
            Sound: {settings.muted ? 'off' : 'on'}
          </button>
          <button
            type="button"
            className="header-toggle"
            onClick={() => post('/api/settings', { newSessionApp: settings.newSessionApp === 'terminal' ? 'desktop' : 'terminal' })}
            title="The app for a new session"
          >
            New in: {settings.newSessionApp === 'terminal' ? 'Terminal' : 'Desktop'}
          </button>
        </div>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** Groups (by project) or Kanban (by status). */
function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const views: { id: View; label: string }[] = [
    { id: 'groups', label: 'Groups' },
    { id: 'kanban', label: 'Kanban' },
  ];
  return (
    <div className="view-switch" role="group" aria-label="View">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          className={view === v.id ? 'header-toggle active' : 'header-toggle'}
          aria-pressed={view === v.id}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

const tabOf = () => (location.hash === '#history' ? 'history' : location.hash === '#cleanup' ? 'cleanup' : 'live');

export function App() {
  const { sessions, settings, connected, closed } = useEvents();
  const [detailId, setDetailId] = useState<string | null>(null);
  // "#history" and "#cleanup" open the other tabs. The Live view is the default.
  const [tab, setTab] = useState(tabOf);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<View>(loadView);
  const changeView = (v: View) => {
    setView(v);
    saveView(v);
  };

  useEffect(() => {
    const onHash = () => setTab(tabOf());
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

  // Project folders for "+ New". Load again when a new project shows up.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [newError, setNewError] = useState<string | null>(null);
  const loadFolders = useCallback(() => {
    get<Folder[]>('/api/folders').then(setFolders, () => undefined);
  }, []);
  const projectKey = groups.map((g) => g.project).sort().join('\n');
  useEffect(loadFolders, [loadFolders, projectKey]);
  const openFolder = async (path: string) => setNewError(await post('/api/folders/open', { path }));
  // A group knows only the project name. Use the newest folder with that name.
  const folderOf = (project: string) => folders.find((f) => f.name === project)?.path;

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
          <a href="#cleanup" className={tab === 'cleanup' ? 'active' : ''}>
            Cleanup
          </a>
        </nav>
        <div className="header-actions">
          {tab === 'live' && <ViewSwitch view={view} onChange={changeView} />}
          <NewSessionMenu folders={folders} onOpen={openFolder} onChange={loadFolders} />
          <SettingsMenu settings={settings} />
        </div>
      </header>
      {newError && <p className="error">{newError}</p>}
      {tab === 'history' && <History onDetails={setDetailId} />}
      {tab === 'cleanup' && <Worktrees />}
      {tab === 'live' && (
        <>
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
                />
              ))}
            </div>
          ) : (
            <>
              {waiting.length > 0 && <Section title="Waiting for you" sessions={waiting} now={now} className="waiting" onDetails={setDetailId} />}
              {groups.map((g) => {
                const folder = folderOf(g.project);
                return (
                  <Section
                    key={g.project}
                    title={g.project}
                    sessions={g.sessions}
                    now={now}
                    onDetails={setDetailId}
                    onNew={folder ? () => openFolder(folder) : undefined}
                  />
                );
              })}
            </>
          )}
          <ClosedSection closed={closed} onDetails={setDetailId} />
        </>
      )}
      {detailId && <DetailPanel sessionId={detailId} title={detailTitle(detailId)} onClose={closeDetail} />}
    </main>
  );
}
