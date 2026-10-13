import { basename, dirname } from 'node:path';

export type Status = 'working' | 'your_turn' | 'needs_permission' | 'idle';

/** A loop or workflow run of claude-dash that owns the session. */
export interface RunRef {
  kind: 'loop' | 'workflow';
  id: string;
}

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
  /** The loop or workflow that runs this session, or null. */
  run: RunRef | null;
  /** True if a hook gave the status (exact). False: a guess from the JSONL file. */
  exact: boolean;
  /** The tool that waits for permission (from hooks), or null. */
  permissionTool: string | null;
  /** The latest tool error or API error, until the next success. */
  error: SessionError | null;
  /** Where the session runs, from the "entrypoint" field. */
  source: Source;
  /**
   * When the prompt cache of the last API call expires (epoch ms), or null if the session used no cache.
   * About: the TTL counts from the start of the request, the line time is its end.
   */
  cacheExpiresAt: number | null;
}

export type Source = 'terminal' | 'desktop' | 'vscode' | 'sdk' | 'other';

function sourceOf(entrypoint: string): Source {
  if (entrypoint === 'cli') return 'terminal';
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'claude-vscode') return 'vscode';
  if (entrypoint.startsWith('sdk')) return 'sdk';
  return 'other';
}

const CACHE_5M_MS = 5 * 60_000;
const CACHE_1H_MS = 60 * 60_000;

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
  private titles: { custom?: string; agent?: string; ai?: string } = {};
  /**
   * Timestamp of the last conversation line. Not the file time: Claude Code also appends
   * metadata lines (ai-title, last-prompt) without a timestamp to old sessions.
   */
  lastLineAt = 0;
  /** Time of the last write to any sub-agent file of this session. */
  lastSubagentWrite = 0;
  /**
   * The run, from the file alone: an Agent SDK session in a loop or workflow worktree.
   * The server forgets its runs on restart, but these sessions still must not count as waiting.
   */
  run: RunRef | null = null;

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
  /** Time of the last real API call (assistant line with usage) that used the cache. */
  private cacheAt = 0;
  /** True once the session wrote a 1-hour cache entry: Claude Code then uses the 1-hour TTL. */
  private cache1h = false;

  constructor(
    readonly id: string,
    /** Folder name in ~/.claude/projects, for example "-Users-me-code-app". */
    private projectDir: string,
  ) {
    this.project = id.slice(0, 8);
  }

  applyLine(raw: string): void {
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      return;
    }
    if (line.isSidechain) return;

    if (typeof line.cwd === 'string') {
      this.project = projectName(line.cwd, this.projectDir);
      const run = /[/\\]\.claude[/\\]worktrees[/\\](loop|wf)-([0-9a-f]+)$/.exec(line.cwd);
      if (run && typeof line.entrypoint === 'string' && line.entrypoint.startsWith('sdk')) {
        this.run = { kind: run[1] === 'loop' ? 'loop' : 'workflow', id: run[2] };
      }
    }
    if (typeof line.gitBranch === 'string' && line.gitBranch) this.branch = line.gitBranch;
    if (typeof line.entrypoint === 'string') this.source = sourceOf(line.entrypoint);
    const at = Date.parse(line.timestamp) || this.lastLineAt;
    this.lastLineAt = Math.max(this.lastLineAt, at);

    if (line.type === 'custom-title' && typeof line.customTitle === 'string') this.titles.custom = line.customTitle;
    else if (line.type === 'agent-name' && typeof line.agentName === 'string') this.titles.agent = line.agentName;
    else if (line.type === 'ai-title' && typeof line.aiTitle === 'string') this.titles.ai = line.aiTitle;
    else if (line.type === 'user' && !line.isMeta) this.applyUser(line.message?.content, at);
    else if (line.type === 'assistant') this.applyAssistant(line.message, at, line.isApiErrorMessage === true || typeof line.error === 'string');
    else if (line.type === 'system' && line.subtype === 'turn_duration') this.setMarker('user_turn', at);
  }

  private applyUser(content: unknown, at: number): void {
    // Any later line means the permission prompt is gone: approved (tool result) or refused.
    if (this.permission && at > this.permission.since) this.permission = null;
    this.applyToolResults(content, at);
    const text = textOf(content);
    if (text.includes('[Request interrupted by user')) {
      this.setMarker('user_turn', at);
    } else if (text.startsWith('<local-command-stdout>') || text.startsWith('<local-command-stderr>')) {
      // A local slash command (/model, /clear) finished. No turn follows.
      this.setMarker('user_turn', at);
    } else {
      // A prompt or a tool result: Claude works next.
      this.setMarker('claude', at);
      if (text && !text.startsWith('<')) {
        this.lastMessage = preview(text);
        this.error = null; // A new prompt: old errors are not interesting any more.
      }
    }
  }

  /** A tool result with is_error is a tool error. A good result clears the last tool error. */
  private applyToolResults(content: unknown, at: number): void {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      const text = textOf(b.content).trim();
      if (b.is_error === true && !USER_REJECT.test(text)) {
        this.error = { kind: 'tool', text: text.slice(0, ERROR_CHARS) || 'Tool error', tool: this.toolNames.get(b.tool_use_id) ?? null, at };
      } else if (this.error?.kind === 'tool') {
        this.error = null;
      }
    }
  }

  private applyAssistant(message: any, at: number, apiError: boolean): void {
    if (apiError) {
      // Claude Code writes an API error as a synthetic assistant message with the error text.
      this.error = { kind: 'api', text: textOf(message?.content).slice(0, ERROR_CHARS) || 'API error', tool: null, at };
    } else if (this.error?.kind === 'api' && message?.model !== '<synthetic>') {
      this.error = null;
    }
    const u = message?.usage;
    if (u && message?.model !== '<synthetic>' && (u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0)) {
      this.cacheAt = Math.max(this.cacheAt, at);
      if (u.cache_creation?.ephemeral_1h_input_tokens > 0) this.cache1h = true;
    }
    if (Array.isArray(message?.content)) {
      for (const b of message.content) if (b?.type === 'tool_use' && typeof b.id === 'string') this.toolNames.set(b.id, b.name);
    }
    const usage = message?.usage;
    if (usage) {
      const tokens =
        (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (tokens > 0) this.contextTokens = tokens;
    }
    const text = textOf(message?.content);
    if (text) this.lastMessage = preview(text);

    // Claude Code writes one line per content block. All blocks of one message share stop_reason.
    const stop = message?.stop_reason;
    if (stop === 'tool_use') {
      if (this.marker !== 'tool') this.subagentRunning = false;
      if (Array.isArray(message.content)) {
        for (const b of message.content) {
          if (b?.type === 'tool_use' && SUBAGENT_TOOLS.has(b.name)) this.subagentRunning = true;
        }
      }
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
      // A title you set wins over the desktop app name, which wins over the generated title.
      title: this.titles.custom || this.titles.agent || this.titles.ai || null,
      project: this.project,
      branch: this.branch,
      status: this.status,
      statusSince: this.statusSince,
      lastMessage: this.lastMessage,
      contextTokens: this.contextTokens,
      contextLimit: this.contextTokens > DEFAULT_CONTEXT_LIMIT ? LARGE_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT,
      lastActivity: Math.max(this.lastLineAt, this.lastSubagentWrite),
      run: this.run,
      exact: this.hooked,
      permissionTool: this.permission?.tool ?? null,
      error: this.error,
      source: this.source,
      cacheExpiresAt: this.cacheAt ? this.cacheAt + (this.cache1h ? CACHE_1H_MS : CACHE_5M_MS) : null,
    };
  }
}

/**
 * The project folder name. `cwd` can be a subfolder, so walk up to the folder that Claude Code
 * encoded as `projectDir`. A worktree under ".claude/worktrees" uses the name of its repo.
 */
function projectName(cwd: string, projectDir: string): string {
  const worktree = cwd.indexOf('/.claude/worktrees/');
  if (worktree > 0) return basename(cwd.slice(0, worktree));
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.replace(/[^a-zA-Z0-9]/g, '-') === projectDir) return basename(dir);
  }
  return basename(cwd);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function preview(text: string): string {
  const flat = text
    .replace(/\*\*|__|`|^#+ /gm, '') // Markdown marks
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS - 1) + '…' : flat;
}
