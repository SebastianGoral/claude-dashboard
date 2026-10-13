import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Claude Code writes one file per running process: ~/.claude/sessions/<pid>.json.
 * A desktop app session also has entrypoint "claude-desktop" and hostSessionId "local_<id>".
 */
const PROCESS_DIR = join(homedir(), '.claude', 'sessions');

// Selects the Terminal.app tab that uses the TTY, minimizes all other Terminal windows,
// and brings the tab's window to the front.
// "activate" would raise all Terminal windows, so System Events makes Terminal frontmost instead.
const FOCUS_SCRIPT = `
on run argv
  set ttyPath to item 1 of argv
  tell application "Terminal"
    set targetId to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is ttyPath then
          set selected of t to true
          set targetId to id of w
        end if
      end repeat
    end repeat
    if targetId is missing value then return "not found"

    -- Loop over ids: minimizing a window changes the order of "windows".
    set winIds to id of every window
    repeat with winId in winIds
      set w to window id (contents of winId)
      if (contents of winId) is not targetId and miniaturized of w is false then set miniaturized of w to true
    end repeat
    set target to window id targetId
    set miniaturized of target to false
    set index of target to 1
  end tell
  tell application "System Events" to set frontmost of process "Terminal" to true
  return "ok"
end run`;

interface ProcessInfo {
  pid: number;
  entrypoint?: string;
  hostSessionId?: string;
}

/** The desktop app accepts only this id format in its link. */
const DESKTOP_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;

async function findProcess(sessionId: string): Promise<ProcessInfo | null> {
  const files = (await readdir(PROCESS_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const info = JSON.parse(await readFile(join(PROCESS_DIR, file), 'utf8'));
      if (info.sessionId !== sessionId || typeof info.pid !== 'number') continue;
      process.kill(info.pid, 0); // Throws if the process does not exist.
      return info;
    } catch {
      // Unreadable file or dead process: try the next file.
    }
  }
  return null;
}

/** Returns an error text, or null when the session (Terminal.app tab or desktop app) is now in front. */
export async function focusTerminal(sessionId: string): Promise<string | null> {
  const info = await findProcess(sessionId);
  if (info === null) return 'No running claude process for this session';

  if (info.entrypoint === 'claude-desktop') {
    if (!info.hostSessionId || !DESKTOP_SESSION_ID.test(info.hostSessionId)) return 'Unknown desktop app session';
    // Undocumented link of the Claude desktop app. It can stop working after an app update.
    await run('open', [`claude://code/continue?session=${info.hostSessionId}`]);
    return null;
  }

  const { stdout } = await run('ps', ['-o', 'tty=', '-p', String(info.pid)]);
  const tty = stdout.trim();
  if (!/^ttys\d+$/.test(tty)) return 'The claude process has no terminal';

  const result = await run('osascript', ['-e', FOCUS_SCRIPT, `/dev/${tty}`]);
  return result.stdout.trim() === 'ok' ? null : 'No Terminal.app tab for this session';
}

// Opens a new Terminal.app window in the folder and starts claude. "quoted form of" makes the path safe for the shell.
const NEW_SESSION_SCRIPT = `
on run argv
  set folderPath to item 1 of argv
  tell application "Terminal" to do script "cd " & quoted form of folderPath & " && claude"
  tell application "System Events" to set frontmost of process "Terminal" to true
end run`;

/** Starts a new Claude Code session in the folder, in Terminal.app or in the desktop app. */
export async function openNewSession(folder: string, app: 'terminal' | 'desktop'): Promise<void> {
  if (app === 'desktop') {
    // Undocumented link. The desktop app uses it for its Finder menu item "New Claude Code Session Here".
    await run('open', [`claude://code/new?folder=${encodeURIComponent(folder)}&source=services`]);
    return;
  }
  await run('osascript', ['-e', NEW_SESSION_SCRIPT, folder]);
}
