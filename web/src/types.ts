// Same shape as SessionView in server/src/session.ts.
export type Status = 'working' | 'your_turn' | 'needs_permission' | 'idle';

export interface Session {
  id: string;
  /** Chat title, or null if the session has no title yet. */
  title: string | null;
  project: string;
  branch: string | null;
  status: Status;
  /** Epoch milliseconds. */
  statusSince: number;
  lastMessage: string;
  contextTokens: number;
  contextLimit: number;
  /** Epoch milliseconds. */
  lastActivity: number;
  /** The loop or workflow that runs this session, or null. */
  run: { kind: 'loop' | 'workflow'; id: string } | null;
  /** True if hooks gave the status. False: a guess from the JSONL file. */
  exact: boolean;
  /** The tool that waits for permission (from hooks), or null. */
  permissionTool: string | null;
  /** The latest tool error or API error, until the next success. */
  error: { kind: 'tool' | 'api'; text: string; tool: string | null; at: number } | null;
  source: 'terminal' | 'desktop' | 'vscode' | 'sdk' | 'other';
  /** When the prompt cache expires (epoch ms, about), or null. */
  cacheExpiresAt: number | null;
}

// Same shape as SettingsView in server/src/settings.ts.
export interface Settings {
  muted: boolean;
  desktopConnected: boolean;
  hooksInstalled: boolean;
}

/** A run session is "your turn" between steps. The run card shows its state, so it never waits for you. */
export const isWaiting = (s: Session) => !s.run && (s.status === 'your_turn' || s.status === 'needs_permission');

// Same shape as LoopView in server/src/loops.ts.
export type LoopStatus = 'running' | 'checking' | 'success' | 'failed' | 'stopped';

export interface Loop {
  id: string;
  project: string;
  repo: string;
  worktree: string;
  branch: string;
  task: string;
  check: string;
  maxIterations: number;
  iteration: number;
  status: LoopStatus;
  sessionId: string | null;
  lastCheck: CheckResult | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface CheckResult {
  passed: boolean;
  output: string;
  at: number;
}

// Same shape as RunView and StepView in server/src/workflows.ts.
export type RunStatus = 'running' | 'success' | 'failed' | 'stopped';
export type StepStatus = 'waiting' | 'running' | 'checking' | 'done' | 'failed' | 'stopped';

export interface Step {
  id: string;
  name: string;
  access: 'read' | 'edit';
  status: StepStatus;
  check: string | null;
  iteration: number;
  maxIterations: number;
  sessionId: string | null;
  lastCheck: CheckResult | null;
  answer: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface Run {
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
  steps: Step[];
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  file: string;
  steps: string[];
}

// Same shapes as server/src/detail.ts and server/src/closed.ts.
export type Entry =
  | { kind: 'user' | 'assistant'; at: number; text: string }
  | { kind: 'tool'; at: number; id: string; tool: string; input: string; result: string | null; isError: boolean; doneAt: number | null };

export interface Subagent {
  id: string;
  description: string;
  agentType: string;
  depth: number;
  status: 'running' | 'done' | 'stopped';
  currentTool: string | null;
  currentInput: string | null;
  startedAt: number;
  lastActivity: number;
}

export interface Detail {
  id: string;
  entries: Entry[];
  subagents: Subagent[];
}

// Same shape as CostView in server/src/usage.ts.
export interface Costs {
  today: number;
  sessions: Record<string, number>;
  unknownModels: string[];
}

export interface ClosedSession {
  id: string;
  title: string | null;
  project: string;
  branch: string | null;
  lastMessage: string;
  lastActivity: number;
  closedAt: number;
}

// Same shapes as server/src/history.ts.
export interface HistoryItem {
  id: string;
  title: string | null;
  project: string;
  branch: string | null;
  firstPrompt: string;
  lastActivity: number;
  size: number;
}

export interface SearchHit {
  sessionId: string;
  title: string | null;
  project: string;
  at: number;
  kind: 'prompt' | 'answer' | 'tool' | 'result';
  tool: string | null;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  filesScanned: number;
  bytesScanned: number;
  elapsedMs: number;
  truncated: boolean;
}
