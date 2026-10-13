import { basename, dirname } from 'node:path';
import { pickTitle, readLine, type AssistantPart, type Titles, type UserPart } from './transcript.js';

export type Status = 'working' | 'your_turn' | 'needs_permission' | 'idle';


/** What the session sends to the browser. Times are epoch milliseconds. */
export interface SessionView {
  id: string;
  /** Chat title, or null if the file has no title line yet. */
  title: string | null;
  project: string;
  branch: string | null;
  status: Status;
  statusSince: number;
  lastMessage: string;
  contextTokens: number;
  contextLimit: number;
  lastActivity: number;
  /** True if a hook gave the status (exact). False: a guess from the JSONL file. */
  exact: boolean;
  /** The tool that waits for permission (from hooks), or null. */
  permissionTool: string | null;
  /** The latest tool error or API error, until the next success. */
  error: SessionError | null;
  /** Where the session runs, from the "entrypoint" field. */
  source: Source;
}

export type Source = 'terminal' | 'desktop' | 'vscode' | 'sdk' | 'other';

function sourceOf(entrypoint: string): Source {
  if (entrypoint === 'cli') return 'terminal';
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'claude-vscode') return 'vscode';
  if (entrypoint.startsWith('sdk')) return 'sdk';
  return 'other';
}


export interface SessionError {
  kind: 'tool' | 'api';
  text: string;
  /** The tool name, for a tool error. */
  tool: string | null;
  at: number;
}

/** The fields of a Claude Code hook input that we use. See hooks.ts. */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  tool_name?: string;
  notification_type?: string;
  message?: string;
  error?: string;
}

/** Rule 3: no write for this long while a tool runs means "maybe waiting for permission". */
export const PERMISSION_GUESS_MS = 15_000;
/** Rule 5: your_turn for this long becomes idle. */
export const IDLE_MS = 10 * 60_000;

const PREVIEW_CHARS = 200;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const LARGE_CONTEXT_LIMIT = 1_000_000;

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const ERROR_CHARS = 300;
/** A tool result with is_error that only says you refused the tool. That is not an error to show. */
const USER_REJECT = /doesn't want to proceed|user rejected|was rejected by the user|interrupted by user/i;

/** The last line that tells us whose turn it is. */
type TurnMarker = 'claude' | 'tool' | 'user_turn';

export class Session {
  project: string;
  branch: string | null = null;
  lastMessage = '';
  contextTokens = 0;
  /** The latest value of each title line type. */
  private titles: Titles = {};
  /**
   * Timestamp of the last conversation line. Not the file time: Claude Code also appends
   * metadata lines (ai-title, last-prompt) without a timestamp to old sessions.
   */
  lastLineAt = 0;
  /** Time of the last write to any sub-agent file of this session. */
  lastSubagentWrite = 0;

  private marker: TurnMarker | null = null;
  private markerAt = 0;
  /** True while the open tool calls include a sub-agent (Agent or Task tool). */
  private subagentRunning = false;
  private status: Status = 'idle';
  private statusSince = 0;

  /** True after the first hook event: then the "needs_permission" guess is off. */
  private hooked = false;
  /** Set by a PermissionRequest hook (or a permission Notification). Cleared by the next activity. */
  private permission: { tool: string | null; since: number } | null = null;
  private error: SessionError | null = null;
  /** Tool names by tool_use id, for the tool name of an error. */
  private toolNames = new Map<string, string>();
  private source: Source = 'other';

  constructor(
    readonly id: string,
    /** Folder name in ~/.claude/projects, for example "-Users-me-code-app". */
    private projectDir: string,
  ) {
    this.project = id.slice(0, 8);
  }

  applyLine(raw: string): void {
    const line = readLine(raw);
    if (!line || line.sidechain) return;

    if (line.cwd !== null) this.project = projectName(line.cwd, this.projectDir);
    if (line.branch) this.branch = line.branch;
    if (line.entrypoint !== null) this.source = sourceOf(line.entrypoint);
    const at = line.at || this.lastLineAt;
    this.lastLineAt = Math.max(this.lastLineAt, at);

    if (line.title) this.titles[line.title.source] = line.title.text;
    else if (line.user) this.applyUser(line.user, at);
    else if (line.assistant) this.applyAssistant(line.assistant, at);
    else if (line.turnEnd) this.setMarker('user_turn', at);
  }

  private applyUser(user: UserPart, at: number): void {
    // Any later line means the permission prompt is gone: approved (tool result) or refused.
    if (this.permission && at > this.permission.since) this.permission = null;
    this.applyToolResults(user, at);
    if (user.interrupted || user.localCommand) {
      // An interrupt, or a local slash command (/model, /clear) finished. No turn follows.
      this.setMarker('user_turn', at);
    } else {
      // A prompt or a tool result: Claude works next.
      this.setMarker('claude', at);
      if (user.prompt) {
        this.lastMessage = preview(user.prompt);
        this.error = null; // A new prompt: old errors are not interesting any more.
      }
    }
  }

  /** A tool result with is_error is a tool error. A good result clears the last tool error. */
  private applyToolResults(user: UserPart, at: number): void {
    for (const r of user.toolResults) {
      const text = r.text.trim();
      if (r.isError && !USER_REJECT.test(text)) {
        this.error = { kind: 'tool', text: text.slice(0, ERROR_CHARS) || 'Tool error', tool: this.toolNames.get(r.toolUseId) ?? null, at };
      } else if (this.error?.kind === 'tool') {
        this.error = null;
      }
    }
  }

  private applyAssistant(message: AssistantPart, at: number): void {
    if (message.apiError) {
      this.error = { kind: 'api', text: message.text.slice(0, ERROR_CHARS) || 'API error', tool: null, at };
    } else if (this.error?.kind === 'api' && !message.synthetic) {
      this.error = null;
    }
    for (const t of message.toolUses) this.toolNames.set(t.id, t.name);
    if (message.contextTokens > 0) this.contextTokens = message.contextTokens;
    if (message.text) this.lastMessage = preview(message.text);

    const stop = message.stopReason;
    if (stop === 'tool_use') {
      if (this.marker !== 'tool') this.subagentRunning = false;
      if (message.toolUses.some((t) => SUBAGENT_TOOLS.has(t.name))) this.subagentRunning = true;
      this.setMarker('tool', at);
    }
    else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') this.setMarker('user_turn', at);
    else this.setMarker('claude', at);
  }

  private setMarker(marker: TurnMarker, at: number): void {
    // Keep the start time of a run of the same marker (for example, many tool calls in a row).
    if (marker !== this.marker) this.markerAt = at;
    this.marker = marker;
  }

  /**
   * A Claude Code hook (see hooks.ts). PermissionRequest gives the exact "needs_permission".
   * All other events mean that the session goes on, so they clear it.
   */
  applyHook(event: HookEvent, at: number): void {
    this.hooked = true;
    const name = event.hook_event_name;
    if (name === 'PermissionRequest' || (name === 'Notification' && event.notification_type === 'permission_prompt')) {
      // The Notification comes after PermissionRequest. Keep the tool name and the start time.
      if (!this.permission) this.permission = { tool: event.tool_name ?? null, since: at };
      else if (event.tool_name) this.permission.tool = event.tool_name;
      return;
    }
    if (name === 'Notification') return; // For example "idle_prompt": no change.
    this.permission = null;
    if (name === 'Stop') this.setMarker('user_turn', at);
    else if (name === 'UserPromptSubmit' || name === 'PreToolUse' || name === 'PostToolUse' || name === 'PostToolUseFailure') {
      if (this.marker === 'user_turn' || this.marker === null) this.setMarker('claude', at);
    }
    if (name === 'PostToolUseFailure' && event.error && !USER_REJECT.test(event.error)) {
      this.error = { kind: 'tool', text: event.error.slice(0, ERROR_CHARS), tool: event.tool_name ?? null, at };
    }
  }

  /** Computes the status for `now`. Returns true if the status changed. */
  refresh(now: number): boolean {
    const [status, since] = this.compute(now);
    if (status === this.status && this.statusSince !== 0) return false;
    this.status = status;
    this.statusSince = since;
    return true;
  }

  private compute(now: number): [Status, number] {
    if (this.permission) return ['needs_permission', this.permission.since];
    switch (this.marker) {
      case 'claude':
        return ['working', this.markerAt];
      case 'tool': {
        // A sub-agent writes to its own file. While it runs, its writes count as activity of this session.
        const lastActivity = this.subagentRunning ? Math.max(this.lastLineAt, this.lastSubagentWrite) : this.lastLineAt;
        // With hooks, a permission prompt comes as a hook event. A silent tool then only runs long.
        const status = !this.hooked && now - lastActivity > PERMISSION_GUESS_MS ? 'needs_permission' : 'working';
        // For needs_permission, statusSince is the start of the tool, so the UI can show "tool running 40s".
        return [status, this.markerAt];
      }
      case 'user_turn':
        return now - this.markerAt > IDLE_MS ? ['idle', this.markerAt + IDLE_MS] : ['your_turn', this.markerAt];
      default:
        return ['idle', this.lastLineAt];
    }
  }

  view(): SessionView {
    return {
      id: this.id,
      title: pickTitle(this.titles),
      project: this.project,
      branch: this.branch,
      status: this.status,
      statusSince: this.statusSince,
      lastMessage: this.lastMessage,
      contextTokens: this.contextTokens,
      contextLimit: this.contextTokens > DEFAULT_CONTEXT_LIMIT ? LARGE_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT,
      lastActivity: Math.max(this.lastLineAt, this.lastSubagentWrite),
      exact: this.hooked,
      permissionTool: this.permission?.tool ?? null,
      error: this.error,
      source: this.source,
    };
  }
}

/**
 * The project folder path. `cwd` can be a subfolder, so walk up to the folder that Claude Code
 * encoded as `projectDir`. A worktree under ".claude/worktrees" uses its repo.
 */
export function projectRoot(cwd: string, projectDir: string): string {
  const worktree = cwd.indexOf('/.claude/worktrees/');
  if (worktree > 0) return cwd.slice(0, worktree);
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.replace(/[^a-zA-Z0-9]/g, '-') === projectDir) return dir;
  }
  return cwd;
}

const projectName = (cwd: string, projectDir: string) => basename(projectRoot(cwd, projectDir));

function preview(text: string): string {
  const flat = text
    .replace(/\*\*|__|`|^#+ /gm, '') // Markdown marks
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS - 1) + '…' : flat;
}
