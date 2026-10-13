/**
 * The Claude Code session file format (JSONL). Only this module reads raw lines.
 * Session status, detail, history and search use the typed TranscriptLine.
 */

export type TitleSource = 'custom' | 'agent' | 'ai';
export type Titles = Partial<Record<TitleSource, string>>;

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolUseId: string;
  /** The result text, not trimmed. */
  text: string;
  isError: boolean;
}

/** A user line (not a meta line): a prompt, tool results, or a local command result. */
export interface UserPart {
  /** The text blocks, or the string content. */
  texts: string[];
  /** The texts, joined with newlines. */
  text: string;
  /** The trimmed text if you typed it, else null (tool results, commands, other "<…>" texts). */
  prompt: string | null;
  /** The result of a local slash command (/model, /clear). No turn follows. */
  localCommand: boolean;
  /** "[Request interrupted by user]". */
  interrupted: boolean;
  toolResults: ToolResult[];
}

export interface AssistantPart {
  /** The text blocks. */
  texts: string[];
  /** The texts, joined with newlines. */
  text: string;
  toolUses: ToolUse[];
  /** "tool_use", "end_turn", … Claude Code writes one line per block; all blocks share it. */
  stopReason: string | null;
  /** input + cache read + cache creation tokens, or 0 if the line has no usage. */
  contextTokens: number;
  /** Claude Code writes an API error as a synthetic assistant message with the error text. */
  apiError: boolean;
  /** model "<synthetic>": written by Claude Code, not by the model. */
  synthetic: boolean;
}

export interface TranscriptLine {
  /** Epoch milliseconds, or 0 if the line has no timestamp (metadata lines such as ai-title). */
  at: number;
  /** A line of a sub-agent conversation inside the session file. */
  sidechain: boolean;
  cwd: string | null;
  /** The git branch, or null if the line has none or an empty one. */
  branch: string | null;
  entrypoint: string | null;
  title: { source: TitleSource; text: string } | null;
  user: UserPart | null;
  assistant: AssistantPart | null;
  /** A system turn_duration line: the turn ended. */
  turnEnd: boolean;
}

/** Parses one JSONL line. Null if the line is not valid JSON. */
export function readLine(raw: string): TranscriptLine | null {
  let line: any;
  try {
    line = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!line || typeof line !== 'object') return null;
  return {
    at: Date.parse(line.timestamp) || 0,
    sidechain: line.isSidechain === true,
    cwd: str(line.cwd),
    branch: str(line.gitBranch) || null,
    entrypoint: str(line.entrypoint),
    title: titleOf(line),
    user: line.type === 'user' && !line.isMeta ? userPart(line.message?.content) : null,
    assistant: line.type === 'assistant' ? assistantPart(line) : null,
    turnEnd: line.type === 'system' && line.subtype === 'turn_duration',
  };
}

/** A title you set wins over the desktop app name, which wins over the generated title. */
export function pickTitle(titles: Titles): string | null {
  return titles.custom || titles.agent || titles.ai || null;
}

/** Text of a message content: a string, or the text blocks of a block list. */
export function textOf(content: unknown): string {
  return textsOf(content).join('\n');
}

/** A short text for a tool input: the command, the file path, the pattern, or the start of the JSON. */
export function shortInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const value = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  const text = typeof value === 'string' ? value : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const str = (value: unknown) => (typeof value === 'string' ? value : null);

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
}

function titleOf(line: any): TranscriptLine['title'] {
  const pick = (source: TitleSource, value: unknown) => (typeof value === 'string' && value ? { source, text: value } : null);
  if (line.type === 'custom-title') return pick('custom', line.customTitle);
  if (line.type === 'agent-name') return pick('agent', line.agentName);
  if (line.type === 'ai-title') return pick('ai', line.aiTitle);
  return null;
}

function userPart(content: unknown): UserPart {
  const texts = textsOf(content);
  const text = texts.join('\n');
  const trimmed = text.trim();
  const toolResults: ToolResult[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      toolResults.push({ toolUseId: String(b.tool_use_id), text: textOf(b.content), isError: b.is_error === true });
    }
  }
  return {
    texts,
    text,
    prompt: trimmed && !trimmed.startsWith('<') ? trimmed : null,
    localCommand: trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-stderr>'),
    interrupted: text.includes('[Request interrupted by user'),
    toolResults,
  };
}

function assistantPart(line: any): AssistantPart {
  const message = line.message;
  const content = message?.content;
  const toolUses: ToolUse[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') toolUses.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  const usage = message?.usage;
  const texts = textsOf(content);
  return {
    texts,
    text: texts.join('\n'),
    toolUses,
    stopReason: str(message?.stop_reason),
    contextTokens: usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0,
    apiError: line.isApiErrorMessage === true || typeof line.error === 'string',
    synthetic: message?.model === '<synthetic>',
  };
}
