import { spawn } from 'node:child_process';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Shared by loops and workflows: the worktree, one agent step, and the check command. */

export interface CheckResult {
  passed: boolean;
  /** The last part of stdout + stderr. */
  output: string;
  at: number;
}

/**
 * What the agent may do. Headless: nobody can answer a prompt, so "dontAsk" refuses every tool call
 * that is not allowed below. The agent gets the refusal and goes on.
 * - read: read files, look at git (plan, review), and run the check command of the run.
 * - edit: also edit and write files, and run the check command, npm, npx, node and git (no push).
 */
export type Access = 'read' | 'edit';

export const RUNS_DIR = join(homedir(), '.claude-dash');
/** The check output that goes back to the agent and to the card. */
const CHECK_OUTPUT_CHARS = 4000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
/** The last answer of a step, for the card and for the next step. */
const ANSWER_CHARS = 20_000;

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const GIT_READ = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];

function toolOptions(access: Access, check: string | null) {
  if (access === 'read') {
    const allowed = [...READ_TOOLS, ...GIT_READ];
    if (check) allowed.push(`Bash(${check})`);
    return { tools: [...READ_TOOLS, 'Bash'], allowedTools: allowed, disallowedTools: [] };
  }
  const bash = ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git:*)'];
  if (check) bash.unshift(`Bash(${check})`);
  return {
    tools: [...READ_TOOLS, 'Edit', 'Write', 'Bash'],
    allowedTools: [...READ_TOOLS, 'Edit', 'Write', ...bash],
    disallowedTools: ['Bash(git push:*)'],
  };
}

export class StoppedError extends Error {}

/** Runs a command in the login shell, so PATH has npm and node also when the desktop app starts from Finder. */
export function shell(command: string, cwd: string, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], { cwd, timeout: CHECK_TIMEOUT_MS });
    const kill = () => child.kill();
    signal?.addEventListener('abort', kill);
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      resolve({ code: code ?? 1, output });
    });
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const { code, output } = await shell(`git ${quoted}`, cwd);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${output.trim()}`);
  return output.trim();
}

export interface Worktree {
  repo: string;
  worktree: string;
  branch: string;
}

/**
 * Makes <repo>/.claude/worktrees/<prefix>-<id> on a new branch <prefix>/<id>.
 * Session.applyLine finds runs again by this folder name. Throws if the folder is not a git repo.
 */
export async function makeWorktree(folder: string, prefix: 'loop' | 'wf', id: string): Promise<Worktree> {
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Folder not found: ${folder}`);
  const repo = await git(['rev-parse', '--show-toplevel'], folder);
  const branch = `${prefix}/${id}`;
  const worktree = join(repo, '.claude', 'worktrees', `${prefix}-${id}`);
  await git(['worktree', 'add', '-b', branch, worktree, 'HEAD'], repo);
  return { repo, worktree, branch };
}

/** Appends to ~/.claude-dash/<folder>/<id>.log. A failed write is only reported on the console. */
export async function appendLog(folder: string, id: string, text: string): Promise<void> {
  try {
    const dir = join(RUNS_DIR, folder);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${id}.log`), `[${new Date().toISOString()}] ${text}\n`);
  } catch (err) {
    console.error(`log failed: ${folder}/${id}:`, err);
  }
}

/** One line per SDK message for the log file. */
function logLine(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    return msg.message.content
      .map((c: any) => (c.type === 'text' ? `assistant: ${c.text}` : c.type === 'tool_use' ? `tool: ${c.name} ${JSON.stringify(c.input).slice(0, 300)}` : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (msg.type === 'result') return `result: ${msg.subtype}${msg.is_error ? ' (error)' : ''}`;
  return null;
}

export interface StepOptions {
  cwd: string;
  prompt: string;
  /** Runs after each turn. Null: one turn only. */
  check: string | null;
  /** One more command the agent may run, for example the check of a workflow run. */
  allowCommand?: string | null;
  maxIterations: number;
  access: Access;
  abort: AbortController;
  claudeExecutable?: string;
  log(text: string): Promise<void>;
  onSession(sessionId: string): void;
  onIteration(iteration: number): void;
  onChecking(): void;
  onCheck(result: CheckResult): void;
}

export interface StepResult {
  /** True if the check passed, or if there is no check. */
  passed: boolean;
  /** The last answer of the agent. */
  answer: string;
}

/**
 * One agent session. Without a check: one turn. With a check: after each turn run the check;
 * a failed check sends its output back to the same session, until it passes or maxIterations is reached.
 * Throws StoppedError after abort.
 */
export async function runStep(o: StepOptions): Promise<StepResult> {
  let sessionId: string | null = null;
  let prompt = o.prompt;
  let answer = '';
  for (let iteration = 1; iteration <= o.maxIterations; iteration++) {
    o.onIteration(iteration);
    await o.log(`--- iteration ${iteration}/${o.maxIterations} ---\nprompt: ${prompt}`);
    const messages = query({
      prompt,
      options: {
        cwd: o.cwd,
        pathToClaudeCodeExecutable: o.claudeExecutable,
        resume: sessionId ?? undefined,
        ...toolOptions(o.access, o.check ?? o.allowCommand ?? null),
        permissionMode: 'dontAsk',
        // Project settings and CLAUDE.md only. The user's own allow rules must not widen the tool list.
        settingSources: ['project'],
        abortController: o.abort,
      },
    });
    try {
      for await (const msg of messages) {
        if (!sessionId && msg.session_id) {
          sessionId = msg.session_id;
          o.onSession(sessionId);
        }
        const line = logLine(msg);
        if (line) await o.log(line);
        if (msg.type === 'result') {
          if (msg.is_error) throw new Error(msg.subtype === 'success' ? msg.result : `${msg.subtype}: ${msg.errors.join('; ')}`);
          if (msg.subtype === 'success') answer = msg.result.slice(-ANSWER_CHARS);
        }
      }
    } catch (err) {
      if (o.abort.signal.aborted) throw new StoppedError();
      throw err;
    }
    if (o.abort.signal.aborted) throw new StoppedError();
    if (!o.check) return { passed: true, answer };

    o.onChecking();
    const { code, output } = await shell(o.check, o.cwd, o.abort.signal);
    if (o.abort.signal.aborted) throw new StoppedError();
    const passed = code === 0;
    const tail = output.slice(-CHECK_OUTPUT_CHARS);
    o.onCheck({ passed, output: tail, at: Date.now() });
    await o.log(`check exit ${code}:\n${tail}`);
    if (passed) return { passed, answer };
    prompt = `The check command \`${o.check}\` failed with exit code ${code}. Output:\n\n${tail}\n\nFix the problem.`;
  }
  return { passed: false, answer };
}
