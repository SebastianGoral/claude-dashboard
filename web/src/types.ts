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
  /** True if hooks gave the status. False: a guess from the JSONL file. */
  exact: boolean;
  /** The tool that waits for permission (from hooks), or null. */
  permissionTool: string | null;
  /** The latest tool error or API error, until the next success. */
  error: { kind: 'tool' | 'api'; text: string; tool: string | null; at: number } | null;
  source: 'terminal' | 'desktop' | 'vscode' | 'sdk' | 'other';
}

// Same shape as SettingsView in server/src/settings.ts.
export interface Settings {
  muted: boolean;
  newSessionApp: 'terminal' | 'desktop';
  hiddenFolders: string[];
  extraFolders: string[];
  desktopConnected: boolean;
  hooksInstalled: boolean;
}

// Same shape as Folder in server/src/history.ts.
export interface Folder {
  path: string;
  name: string;
  lastActivity: number;
}

export const isWaiting = (s: Session) => s.status === 'your_turn' || s.status === 'needs_permission';

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
