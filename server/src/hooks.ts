import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code hooks send each event to POST /api/hooks. They give the exact "needs_permission"
 * (PermissionRequest); the JSONL rules stay as the fallback.
 * A command hook with curl, not an "http" hook: when the dashboard does not run, curl fails in silence.
 */

export const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');
/** Every hook command of claude-dash contains this text. Install and remove find our hooks by it. */
const MARKER = 'claude-dash';
export const HOOK_EVENTS = [
  'PermissionRequest',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
] as const;

export function hookCommand(port: number): string {
  // "|| true": a stopped dashboard must never block or slow down Claude Code. -m 1: wait at most 1 s.
  return `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:${port}/api/hooks?from=${MARKER}' >/dev/null 2>&1 || true`;
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

const isOurs = (entry: HookEntry) => entry.hooks?.some((h) => h.command?.includes(MARKER)) ?? false;

async function readSettings(file: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Writes a backup (<file>.claude-dash-backup) once per change, then the new file in one step. */
async function writeSettings(file: string, settings: Settings): Promise<void> {
  await copyFile(file, `${file}.claude-dash-backup`).catch(() => undefined);
  const tmp = `${file}.claude-dash-tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n');
  await rename(tmp, file);
}

/** True if all our hooks are in the file with the command for this port. */
export async function hooksInstalled(port: number, file = SETTINGS_FILE): Promise<boolean> {
  const settings = await readSettings(file).catch(() => ({}) as Settings);
  const command = hookCommand(port);
  return HOOK_EVENTS.every((event) => settings.hooks?.[event]?.some((e) => e.hooks?.some((h) => h.command === command)));
}

/** Adds our hooks. Keeps all other hooks and settings. Replaces old hooks of claude-dash. */
export async function installHooks(port: number, file = SETTINGS_FILE): Promise<void> {
  const settings = await readSettings(file);
  const hooks = (settings.hooks ??= {});
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((e) => !isOurs(e));
    hooks[event] = [...kept, { hooks: [{ type: 'command', command: hookCommand(port) }] }];
  }
  await writeSettings(file, settings);
}

/** Removes only our hooks. */
export async function removeHooks(file = SETTINGS_FILE): Promise<void> {
  const settings = await readSettings(file);
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    const kept = settings.hooks[event].filter((e) => !isOurs(e));
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await writeSettings(file, settings);
}
