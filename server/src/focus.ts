import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findProcess } from './processes.js';

const run = promisify(execFile);

// Selects the Terminal.app tab that uses the TTY and brings only the tab's window to the front.
// Other Terminal windows stay where they are.
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

    set target to window id targetId
    set miniaturized of target to false
    set index of target to 1
  end tell
  tell application "System Events" to set frontmost of process "Terminal" to true
  return "ok"
end run`;

/** The desktop app accepts only this id format in its link. */
const DESKTOP_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;

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

// Opens a new Terminal.app window in the folder and resumes the session. Both arguments are quoted for the shell.
const RESUME_SCRIPT = `
on run argv
  set folderPath to item 1 of argv
  set sessionId to item 2 of argv
  tell application "Terminal" to do script "cd " & quoted form of folderPath & " && claude --resume " & quoted form of sessionId
  tell application "System Events" to set frontmost of process "Terminal" to true
end run`;

/** Resumes an ended session in Terminal.app. `folder` must be the folder where the session started. */
export async function resumeSession(folder: string, sessionId: string): Promise<void> {
  await run('osascript', ['-e', RESUME_SCRIPT, folder, sessionId]);
}
