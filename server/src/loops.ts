import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { appendLog, makeWorktree, runStep, StoppedError, type CheckResult } from './agent.js';

export type LoopStatus = 'running' | 'checking' | 'success' | 'failed' | 'stopped';

/** What the loop sends to the browser. Times are epoch milliseconds. */
export interface LoopView {
  id: string;
  project: string;
  /** The repo folder, not the worktree. */
  repo: string;
  worktree: string;
  branch: string;
  task: string;
  check: string;
  maxIterations: number;
  iteration: number;
  status: LoopStatus;
  /** The Claude session of the loop. Null until the agent starts. */
  sessionId: string | null;
  lastCheck: CheckResult | null;
  /** Why the loop failed, if it is not a failed check. */
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface LoopInput {
  folder: string;
  task: string;
  check: string;
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 5;

interface Run {
  view: LoopView;
  abort: AbortController;
}

export interface LoopManager {
  on(event: 'loop', fn: (view: LoopView) => void): this;
}

export class LoopManager extends EventEmitter {
  private runs = new Map<string, Run>();

  /** @param claudeExecutable The Claude Code binary. Omit to let the SDK find it (it fails inside app.asar). */
  constructor(private claudeExecutable?: string) {
    super();
  }

  views(): LoopView[] {
    return [...this.runs.values()].map((r) => r.view);
  }

  /** The loop id of a Claude session, or null. */
  loopOf(sessionId: string): string | null {
    for (const r of this.runs.values()) if (r.view.sessionId === sessionId) return r.view.id;
    return null;
  }

  /** True while the loop of this session still runs. */
  isActive(sessionId: string): boolean {
    for (const r of this.runs.values()) if (r.view.sessionId === sessionId && !r.view.endedAt) return true;
    return false;
  }

  /** Makes the worktree, then runs the loop in the background. Throws if the folder is not a git repo. */
  async start(input: LoopInput): Promise<LoopView> {
    const task = input.task.trim();
    const check = input.check.trim();
    if (!task || !check) throw new Error('Task and check command are required');
    const id = randomBytes(4).toString('hex');
    const { repo, worktree, branch } = await makeWorktree(input.folder, 'loop', id);

    const view: LoopView = {
      id,
      project: basename(repo),
      repo,
      worktree,
      branch,
      task,
      check,
      maxIterations: Math.max(1, Math.floor(input.maxIterations ?? DEFAULT_MAX_ITERATIONS)),
      iteration: 0,
      status: 'running',
      sessionId: null,
      lastCheck: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    const run: Run = { view, abort: new AbortController() };
    this.runs.set(id, run);
    this.emit('loop', view);
    void this.run(run);
    return view;
  }

  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.view.endedAt) return false;
    run.abort.abort();
    this.finish(run, 'stopped');
    return true;
  }

  private async run(run: Run): Promise<void> {
    const { view } = run;
    const log = (text: string) => appendLog('loops', view.id, text);
    await log(`loop ${view.id}: ${view.repo} → ${view.worktree} (${view.branch})\ntask: ${view.task}\ncheck: ${view.check}`);
    try {
      const { passed } = await runStep({
        cwd: view.worktree,
        prompt: view.task,
        check: view.check,
        maxIterations: view.maxIterations,
        access: 'edit',
        abort: run.abort,
        claudeExecutable: this.claudeExecutable,
        log,
        onSession: (sessionId) => this.update(view, { sessionId }),
        onIteration: (iteration) => this.update(view, { iteration, status: 'running' }),
        onChecking: () => this.update(view, { status: 'checking' }),
        onCheck: (lastCheck) => this.update(view, { lastCheck }),
      });
      this.finish(run, passed ? 'success' : 'failed');
    } catch (err) {
      if (err instanceof StoppedError) return;
      view.error = err instanceof Error ? err.message : String(err);
      await log(`error: ${view.error}`);
      this.finish(run, 'failed');
    }
  }

  private finish(run: Run, status: LoopStatus): void {
    if (run.view.endedAt) return;
    this.update(run.view, { status, endedAt: Date.now() });
    void appendLog('loops', run.view.id, `loop ${status}`);
  }

  private update(view: LoopView, changes: Partial<LoopView>): void {
    Object.assign(view, changes);
    this.emit('loop', view);
  }
}
