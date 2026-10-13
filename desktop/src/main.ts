import { join } from 'node:path';
import { app, BrowserWindow, dialog, nativeImage, Notification, Tray } from 'electron';
import type { SessionView } from '../../server/src/session.js';
import { startServer } from '../../server/src/server.js';
import { watchSessions } from './sse.js';

const PORT = 4317;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
/** In dev the window loads Vite (hot reload). Vite proxies /api to the server. */
const DEV_URL = 'http://localhost:4318';
const DEV_RETRY_MS = 1_000;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** True after Cmd+Q. Until then, closing the window only hides it. */
let quitting = false;
/** Electron can drop the click handler of a notification that is garbage collected. Keep a reference. */
const notifications = new Set<Notification>();

function showWindow(): void {
  if (!win) return;
  win.show();
  app.focus({ steal: true });
}

function createWindow(): void {
  win = new BrowserWindow({ width: 1100, height: 800, title: 'claude-dash', show: false });
  win.once('ready-to-show', () => win?.show());
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
  });

  if (app.isPackaged) {
    void win.loadURL(SERVER_URL);
  } else {
    // Vite can start after Electron. Retry until it answers.
    win.webContents.on('did-fail-load', () => setTimeout(() => void win?.loadURL(DEV_URL), DEV_RETRY_MS));
    void win.loadURL(DEV_URL);
  }
}

function createTray(): void {
  // The "Template" suffix tells macOS to color the icon for a light or dark menu bar.
  tray = new Tray(nativeImage.createFromPath(join(__dirname, '../assets/trayTemplate.png')));
  tray.setToolTip('claude-dash');
  tray.on('click', () => {
    if (win?.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
}

function setWaitingCount(count: number): void {
  const text = count > 0 ? String(count) : '';
  app.dock?.setBadge(text);
  tray?.setTitle(text);
  tray?.setToolTip(count > 0 ? `claude-dash: ${count} waiting` : 'claude-dash');
}

/** From the server settings. A muted notification still shows, but makes no sound. */
let muted = false;

function statusText(view: SessionView): string {
  if (view.status !== 'needs_permission') return 'Your turn';
  if (!view.exact) return 'Waiting? (maybe a permission prompt)';
  return view.permissionTool ? `Needs permission: ${view.permissionTool}` : 'Needs permission';
}

function notify(view: SessionView): void {
  if (!Notification.isSupported()) return;
  const status = statusText(view);
  const notification = new Notification({
    silent: muted,
    title: view.title ?? view.project,
    subtitle: view.title ? view.project : undefined,
    body: status,
  });
  notifications.add(notification);
  notification.on('click', () => {
    notifications.delete(notification);
    showWindow();
  });
  notification.on('close', () => notifications.delete(notification));
  notification.show();
}

async function main(): Promise<void> {
  await app.whenReady();
  // The built app takes its icon from icon.icns. In dev (electron .) the Dock shows the Electron icon without this.
  if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(join(__dirname, '../assets/icon.png')));
  try {
    await startServer({ port: PORT, staticDir: app.isPackaged ? join(process.resourcesPath, 'web') : undefined });
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
    dialog.showErrorBox(
      'claude-dash cannot start',
      busy ? `Port ${PORT} is in use. Stop "npm run dev" or the other claude-dash and try again.` : String(err),
    );
    app.exit(1);
    return;
  }

  createWindow();
  createTray();
  // "client=desktop": while the desktop app is connected, the browser plays no sounds (no double alerts).
  watchSessions(`${SERVER_URL}/api/events?client=desktop`, {
    onCount: setWaitingCount,
    onWaiting: notify,
    onSettings: (settings) => (muted = settings.muted),
  });
}

// A second start would fail on the port. Show the running app instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);
  // Cmd+Q, the Dock menu "Quit" and a system shutdown all come here first.
  app.on('before-quit', () => {
    quitting = true;
  });
  // A click on the Dock icon.
  app.on('activate', showWindow);
  void main();
}
