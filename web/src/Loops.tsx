import { useState, type FormEvent } from 'react';
import { post } from './api';
import type { Loop, LoopStatus } from './types';

const STATUS_LABEL: Record<LoopStatus, string> = {
  running: 'Running',
  checking: 'Checking',
  success: 'Success',
  failed: 'Failed',
  stopped: 'Stopped',
};

const DEFAULT_MAX_ITERATIONS = 5;

export function LoopCard({ loop }: { loop: Loop }) {
  const [error, setError] = useState<string | null>(null);
  const ended = loop.endedAt !== null;

  async function stop() {
    setError(await post(`/api/loops/${loop.id}/stop`));
  }

  return (
    <article className={`card loop ${loop.status}`}>
      <div className="top">
        <span className="title">{loop.task}</span>
        <span className={`badge loop-${loop.status}`}>
          {STATUS_LABEL[loop.status]} · iteration {loop.iteration}/{loop.maxIterations}
        </span>
      </div>
      <div className="meta">
        <span className="tag">Loop</span>
        <span className="project">{loop.project}</span>
        <span className="branch">{loop.branch}</span>
      </div>
      <div className="meta">
        <span className="branch">check: {loop.check}</span>
      </div>
      {loop.lastCheck && (
        <details className="check">
          <summary>Last check: {loop.lastCheck.passed ? 'passed' : 'failed'}</summary>
          <pre>{loop.lastCheck.output.trim() || '(no output)'}</pre>
        </details>
      )}
      {loop.error && <div className="error">{loop.error}</div>}
      {!ended && (
        <div className="actions">
          <button type="button" onClick={stop}>
            Stop
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </article>
  );
}

export function NewLoopForm({ onClose }: { onClose: () => void }) {
  const [folder, setFolder] = useState('');
  const [task, setTask] = useState('');
  const [check, setCheck] = useState('npm test');
  const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const err = await post('/api/loops', { folder, task, check, maxIterations });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }

  return (
    <form className="card loop-form" onSubmit={submit}>
      <label>
        Project folder
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/code/my-app" required />
      </label>
      <label>
        Task
        <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} required />
      </label>
      <label>
        Check command
        <input value={check} onChange={(e) => setCheck(e.target.value)} required />
      </label>
      <label>
        Max iterations
        <input type="number" min={1} value={maxIterations} onChange={(e) => setMaxIterations(Number(e.target.value))} />
      </label>
      <p className="hint">The agent works in a new git worktree and branch. It may read, edit and write files, and run the check command, npm, npx, node and git (no push).</p>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          Start loop
        </button>
      </div>
    </form>
  );
}
