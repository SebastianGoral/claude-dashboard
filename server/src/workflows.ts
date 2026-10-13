import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parse } from 'yaml';
import { appendLog, makeWorktree, RUNS_DIR, runStep, StoppedError, type Access, type CheckResult } from './agent.js';

/** A workflow file: ~/.claude-dash/workflows/<id>.yaml, or a built-in one. */
export interface WorkflowDef {
  id: string;
  name: string;
  steps: StepDef[];
  /** Path of the file. */
  file: string;
}

interface StepDef {
  id: string;
  name: string;
  access: Access;
  prompt: string;
  check: string | null;
  maxIterations: number;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'stopped';
export type StepStatus = 'waiting' | 'running' | 'checking' | 'done' | 'failed' | 'stopped';

export interface StepView {
  id: string;
  name: string;
  access: Access;
  status: StepStatus;
  /** The check after the placeholders are filled in. Null: one turn only. */
  check: string | null;
  iteration: number;
  maxIterations: number;
  sessionId: string | null;
  lastCheck: CheckResult | null;
  /** The last part of the last answer. */
  answer: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** What a workflow run sends to the browser. Times are epoch milliseconds. */
export interface RunView {
  id: string;
  workflowId: string;
  name: string;
  project: string;
  repo: string;
  worktree: string;
  branch: string;
  task: string;
  check: string;
  status: RunStatus;
  steps: StepView[];
  /** Why the run failed, if it is not a failed check. */
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RunInput {
  workflowId: string;
  folder: string;
  task: string;
  check?: string;
}

export const USER_WORKFLOWS_DIR = join(RUNS_DIR, 'workflows');
const DEFAULT_MAX_ITERATIONS = 5;
const ANSWER_VIEW_CHARS = 4000;

/** Replaces {{name}} with vars[name]. An unknown name becomes an empty text. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, name: string) => vars[name] ?? '');
}

/** Reads one workflow file. Throws with a clear message if the file is not valid. */
function parseWorkflow(file: string, text: string): WorkflowDef {
  const data = parse(text);
  const where = basename(file);
  if (!data || typeof data !== 'object') throw new Error(`${where}: not a YAML object`);
  if (!Array.isArray(data.steps) || data.steps.length === 0) throw new Error(`${where}: "steps" must be a non-empty list`);
  const ids = new Set<string>();
  const steps = data.steps.map((s: any, i: number): StepDef => {
    const id = typeof s?.id === 'string' && /^[\w-]+$/.test(s.id) ? s.id : null;
    if (!id) throw new Error(`${where}: step ${i + 1} needs an "id" (letters, digits, - or _)`);
    if (ids.has(id) || id === 'task' || id === 'check') throw new Error(`${where}: step id "${id}" is used twice or is reserved`);
    ids.add(id);
    if (typeof s.prompt !== 'string' || !s.prompt.trim()) throw new Error(`${where}: step "${id}" needs a "prompt"`);
    const access = s.access ?? 'read';
    if (access !== 'read' && access !== 'edit') throw new Error(`${where}: step "${id}": access must be "read" or "edit"`);
    return {
      id,
      name: typeof s.name === 'string' ? s.name : id,
      access,
      prompt: s.prompt,
      check: typeof s.check === 'string' ? s.check : null,
      maxIterations: Math.max(1, Math.floor(Number(s.maxIterations) || DEFAULT_MAX_ITERATIONS)),
    };
  });
  const id = basename(file, extname(file));
  return { id, name: typeof data.name === 'string' ? data.name : id, steps, file };
}

interface Run {
  view: RunView;
  def: WorkflowDef;
  abort: AbortController;
}

export interface WorkflowManager {
  on(event: 'run', fn: (view: RunView) => void): this;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, Run>();

  /**
   * @param builtinDir Folder with the built-in workflow files (server/workflows).
   * @param claudeExecutable The Claude Code binary. Omit to let the SDK find it.
   */
  constructor(
    private builtinDir: string,
    private claudeExecutable?: string,
  ) {
    super();
  }

  /** Built-in files first. A user file with the same id replaces the built-in one. Invalid files are in `errors`. */
  async list(): Promise<{ workflows: WorkflowDef[]; errors: string[] }> {
    const byId = new Map<string, WorkflowDef>();
    const errors: string[] = [];
    for (const dir of [this.builtinDir, USER_WORKFLOWS_DIR]) {
      const files = (await readdir(dir).catch(() => [])).filter((f) => /\.ya?ml$/.test(f)).sort();
      for (const f of files) {
        const file = join(dir, f);
        try {
          const def = parseWorkflow(file, await readFile(file, 'utf8'));
          byId.set(def.id, def);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    return { workflows: [...byId.values()], errors };
  }

  views(): RunView[] {
    return [...this.runs.values()].map((r) => r.view);
  }

  /** The run id of a Claude session, or null. */
  runOf(sessionId: string): string | null {
    for (const r of this.runs.values()) if (r.view.steps.some((s) => s.sessionId === sessionId)) return r.view.id;
    return null;
  }

  /** True while the run of this session still runs. */
  isActive(sessionId: string): boolean {
    for (const r of this.runs.values()) {
      if (!r.view.endedAt && r.view.steps.some((s) => s.sessionId === sessionId)) return true;
    }
    return false;
  }

  async start(input: RunInput): Promise<RunView> {
    const task = input.task.trim();
    const check = (input.check ?? '').trim();
    if (!task) throw new Error('Task is required');
    const def = (await this.list()).workflows.find((w) => w.id === input.workflowId);
    if (!def) throw new Error(`Workflow not found: ${input.workflowId}`);
    const id = randomBytes(4).toString('hex');
    const { repo, worktree, branch } = await makeWorktree(input.folder, 'wf', id);
    const vars = { task, check };

    const view: RunView = {
      id,
      workflowId: def.id,
      name: def.name,
      project: basename(repo),
      repo,
      worktree,
      branch,
      task,
      check,
      status: 'running',
      steps: def.steps.map((s) => ({
        id: s.id,
        name: s.name,
        access: s.access,
        status: 'waiting',
        check: s.check ? fill(s.check, vars).trim() || null : null,
        iteration: 0,
        maxIterations: s.check ? s.maxIterations : 1,
        sessionId: null,
        lastCheck: null,
        answer: null,
        startedAt: null,
        endedAt: null,
      })),
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    const run: Run = { view, def, abort: new AbortController() };
    this.runs.set(id, run);
    this.emit('run', view);
    void this.run(run);
    return view;
  }

  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.view.endedAt) return false;
    run.abort.abort();
    for (const step of run.view.steps) {
      if (step.status === 'running' || step.status === 'checking') Object.assign(step, { status: 'stopped', endedAt: Date.now() });
    }
    this.finish(run, 'stopped');
    return true;
  }

  private async run(run: Run): Promise<void> {
    const { view, def } = run;
    const log = (text: string) => appendLog('runs', view.id, text);
    await log(`workflow ${def.id} (${def.file}) run ${view.id}: ${view.repo} → ${view.worktree} (${view.branch})\ntask: ${view.task}\ncheck: ${view.check}`);
    const vars: Record<string, string> = { task: view.task, check: view.check };
    for (const [i, stepDef] of def.steps.entries()) {
      const step = view.steps[i];
      const set = (changes: Partial<StepView>) => {
        Object.assign(step, changes);
        this.emit('run', view);
      };
      set({ status: 'running', startedAt: Date.now() });
      await log(`\n=== step ${step.id} (${step.access}) ===`);
      try {
        const { passed, answer } = await runStep({
          cwd: view.worktree,
          prompt: fill(stepDef.prompt, vars),
          check: step.check,
          // A read step has no own check, but it may run the check of the run (for example, the reviewer).
          allowCommand: view.check || null,
          maxIterations: step.maxIterations,
          access: step.access,
          abort: run.abort,
          claudeExecutable: this.claudeExecutable,
          log,
          onSession: (sessionId) => set({ sessionId }),
          onIteration: (iteration) => set({ iteration, status: 'running' }),
          onChecking: () => set({ status: 'checking' }),
          onCheck: (lastCheck) => set({ lastCheck }),
        });
        vars[step.id] = answer;
        set({ status: passed ? 'done' : 'failed', answer: answer.slice(-ANSWER_VIEW_CHARS), endedAt: Date.now() });
        if (!passed) return this.finish(run, 'failed');
      } catch (err) {
        if (err instanceof StoppedError) return;
        view.error = `${step.name}: ${err instanceof Error ? err.message : String(err)}`;
        await log(`error: ${view.error}`);
        set({ status: 'failed', endedAt: Date.now() });
        return this.finish(run, 'failed');
      }
    }
    this.finish(run, 'success');
  }

  private finish(run: Run, status: RunStatus): void {
    if (run.view.endedAt) return;
    Object.assign(run.view, { status, endedAt: Date.now() });
    this.emit('run', run.view);
    void appendLog('runs', run.view.id, `workflow ${status}`);
  }
}
