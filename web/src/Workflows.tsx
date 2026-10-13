import { useEffect, useState, type FormEvent } from 'react';
import { get, post } from './api';
import type { Run, RunStatus, Step, StepStatus, WorkflowInfo } from './types';

const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  stopped: 'Stopped',
};

const STEP_LABEL: Record<StepStatus, string> = {
  waiting: 'waiting',
  running: 'running',
  checking: 'checking',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

function StepRow({ step }: { step: Step }) {
  const iteration = step.check && step.iteration > 0 ? ` · iteration ${step.iteration}/${step.maxIterations}` : '';
  return (
    <li className={`step ${step.status}`}>
      <div className="step-head">
        <span className="step-name">{step.name}</span>
        <span className={`step-status ${step.status}`}>
          {STEP_LABEL[step.status]}
          {iteration}
        </span>
      </div>
      {step.lastCheck && (
        <details className="check">
          <summary>Last check: {step.lastCheck.passed ? 'passed' : 'failed'}</summary>
          <pre>{step.lastCheck.output.trim() || '(no output)'}</pre>
        </details>
      )}
      {step.answer && (
        <details className="check" open={step.id === 'review'}>
          <summary>Answer</summary>
          <pre>{step.answer.trim()}</pre>
        </details>
      )}
    </li>
  );
}

export function RunCard({ run }: { run: Run }) {
  const [error, setError] = useState<string | null>(null);
  const current = run.steps.find((s) => s.status === 'running' || s.status === 'checking');

  async function stop() {
    setError(await post(`/api/runs/${run.id}/stop`));
  }

  return (
    <article className={`card loop ${run.status === 'running' ? 'running' : run.status}`}>
      <div className="top">
        <span className="title">{run.task}</span>
        <span className={`badge loop-${run.status}`}>
          {RUN_LABEL[run.status]}
          {current ? ` · ${current.name}` : ''}
        </span>
      </div>
      <div className="meta">
        <span className="tag">Workflow</span>
        <span className="project">{run.name}</span>
        <span className="project">{run.project}</span>
        <span className="branch">{run.branch}</span>
      </div>
      <ol className="steps">
        {run.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>
      {run.error && <div className="error">{run.error}</div>}
      {run.endedAt === null && (
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

export function NewRunForm({ onClose }: { onClose: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const [folder, setFolder] = useState('');
  const [task, setTask] = useState('');
  const [check, setCheck] = useState('npm test');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ workflows: WorkflowInfo[]; errors: string[] }>('/api/workflows')
      .then(({ workflows, errors }) => {
        setWorkflows(workflows);
        setFileErrors(errors);
        setWorkflowId((id) => id || workflows[0]?.id || '');
      })
      .catch((err) => setError(String(err.message ?? err)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const err = await post('/api/runs', { workflowId, folder, task, check });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }

  const selected = workflows.find((w) => w.id === workflowId);
  return (
    <form className="card loop-form" onSubmit={submit}>
      <label>
        Workflow
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} required>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p className="hint">
          Steps: {selected.steps.join(' → ')}. File: {selected.file}
        </p>
      )}
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
        <input value={check} onChange={(e) => setCheck(e.target.value)} />
      </label>
      <p className="hint">
        The workflow runs in a new git worktree and branch. Add your own workflows as YAML files in ~/.claude-dash/workflows/.
      </p>
      {fileErrors.map((e) => (
        <div key={e} className="error">
          {e}
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !workflowId}>
          Start workflow
        </button>
      </div>
    </form>
  );
}
