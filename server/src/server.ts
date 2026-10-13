import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { killSession, listWorktrees, removeWorktree, trashSession } from './cleanup.js';
import { readDetail } from './detail.js';
import { findSessionFile } from './files.js';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { listFolders, listHistory, search } from './history.js';
import { focusTerminal, openNewSession } from './focus.js';
import { liveProcesses } from './processes.js';
import { hooksInstalled, installHooks, removeHooks } from './hooks.js';
import { LiveList } from './livelist.js';
import type { HookEvent } from './session.js';
import { SettingsStore } from './settings.js';
import { SessionStore } from './watcher.js';

const HEARTBEAT_MS = 25_000;

export interface ServerOptions {
  port: number;
  /** Folder with the built web app (web/dist). Without it, only /api is served (dev uses Vite). */
  staticDir?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Starts the session watcher and the HTTP server. Resolves when the server listens. */
export async function startServer({ port, staticDir }: ServerOptions): Promise<void> {
  const store = new SessionStore();
  const live = new LiveList();
  store.on('view', (view) => live.update(view));
  store.on('remove', (id) => live.drop(id));
  await live.start();
  store.start();
  const settings = new SettingsStore();
  await settings.load();
  const checkHooks = async () => settings.setHooksInstalled(await hooksInstalled(port));
  await checkHooks();

  const app = Fastify();

  // Server-Sent Events. On connect: "snapshot" (sessions), "closed" and "settings".
  // Then one event per change: "upsert" or "remove" (session), "closed", "settings".
  app.get<{ Querystring: { client?: string } }>('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event: string) => (data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('snapshot')(live.views());
    send('closed')(live.closedList());
    // The desktop app connects with ?client=desktop. While it is connected, it gives the alerts.
    const desktop = req.query.client === 'desktop';
    if (desktop) settings.desktop(1);
    send('settings')(settings.view());
    const listeners: [{ off(e: string, fn: (d: any) => void): unknown }, string, (d: any) => void][] = [
      [live, 'upsert', send('upsert')],
      [live, 'remove', send('remove')],
      [live, 'closed', send('closed')],
      [settings, 'change', send('settings')],
    ];
    for (const [emitter, event, fn] of listeners) (emitter as any).on(event, fn);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      for (const [emitter, event, fn] of listeners) emitter.off(event, fn);
      if (desktop) settings.desktop(-1);
    });
  });

  // Claude Code hooks (see hooks.ts). The body is the hook input JSON.
  app.post<{ Body: HookEvent }>('/api/hooks', async (req, reply) => {
    const event = req.body;
    if (typeof event?.session_id !== 'string' || typeof event.hook_event_name !== 'string') {
      return reply.code(400).send({ error: 'session_id and hook_event_name are required' });
    }
    store.applyHook(event);
    if (event.hook_event_name === 'SessionEnd') live.close(event.session_id);
    return {};
  });

  app.post('/api/hooks/install', async (_req, reply) => {
    try {
      await installHooks(port);
      await checkHooks();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  app.post('/api/hooks/remove', async (_req, reply) => {
    try {
      await removeHooks();
      await checkHooks();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  app.post<{ Body: { muted?: boolean; newSessionApp?: 'terminal' | 'desktop' } }>('/api/settings', async (req) => {
    await settings.update({ muted: req.body?.muted, newSessionApp: req.body?.newSessionApp });
    return settings.view();
  });

  // Project folders for new sessions, the newest first.
  const folders = () => {
    const { extraFolders, hiddenFolders } = settings.view();
    return listFolders(extraFolders, hiddenFolders);
  };
  app.get('/api/folders', folders);

  // Starts a new session. Only a folder from the list, so the request cannot run claude in any path.
  app.post<{ Body: { path?: string } }>('/api/folders/open', async (req, reply) => {
    const path = req.body?.path;
    if (!(await folders()).some((f) => f.path === path)) return reply.code(404).send({ error: 'Unknown folder' });
    try {
      await openNewSession(path!, settings.view().newSessionApp);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: 'Could not start a new session' });
    }
  });

  app.post<{ Body: { path?: string } }>('/api/folders/add', async (req, reply) => {
    const raw = req.body?.path?.trim() ?? '';
    const path = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
    if (!isAbsolute(raw.replace(/^~/, '/')) || !(await stat(path).catch(() => null))?.isDirectory()) {
      return reply.code(400).send({ error: 'Not a folder. Use a full path, for example ~/projects/app' });
    }
    await settings.addFolder(path);
    return { ok: true };
  });

  app.post<{ Body: { path?: string } }>('/api/folders/hide', async (req, reply) => {
    if (typeof req.body?.path !== 'string') return reply.code(400).send({ error: 'path is required' });
    await settings.hideFolder(req.body.path);
    return { ok: true };
  });

  // Recent messages, tool calls and sub-agents of a session. Also for closed and old sessions.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/detail', async (req, reply) => {
    const file = store.pathOf(req.params.id) ?? (await findSessionFile(req.params.id));
    if (!file) return reply.code(404).send({ error: 'Session file not found' });
    return readDetail(file, req.params.id);
  });

  // Hides a session from the live list. It moves to "Recently closed". New activity shows it again.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/hide', async (req, reply) => {
    if (!live.hide(req.params.id)) return reply.code(404).send({ error: 'Session not found' });
    return { ok: true };
  });

  // Stops the claude process of a Terminal session, then hides the session.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (req, reply) => {
    const err = await killSession(req.params.id).catch((e) => `Could not stop the process: ${message(e)}`);
    if (err) return reply.code(409).send({ error: err });
    live.hide(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/unhide', async (req) => {
    live.unhide(req.params.id);
    return { ok: true };
  });

  // Moves the session file to the macOS Trash. Not while the session has a live process.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/delete', async (req, reply) => {
    const id = req.params.id;
    if ((await liveProcesses()).has(id)) return reply.code(409).send({ error: 'The session still runs. Close it first.' });
    const file = store.pathOf(id) ?? (await findSessionFile(id));
    if (!file) return reply.code(404).send({ error: 'Session file not found' });
    try {
      await trashSession(file);
      live.forget(id);
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: `Could not move to the Trash: ${message(err)}` });
    }
  });

  // Worktrees under .claude/worktrees of all known folders, hidden folders too.
  const worktrees = async () => listWorktrees((await listFolders(settings.view().extraFolders, [])).map((f) => f.path), await liveProcesses());
  app.get('/api/worktrees', worktrees);

  // Removes a worktree from the list. Git refuses if it has changes. The branch stays.
  app.post<{ Body: { path?: string } }>('/api/worktrees/remove', async (req, reply) => {
    const w = (await worktrees()).find((x) => x.path === req.body?.path);
    if (!w) return reply.code(404).send({ error: 'Unknown worktree' });
    if (w.sessionId) return reply.code(409).send({ error: 'A live session runs in this worktree. Close it first.' });
    try {
      await removeWorktree(w);
      return { ok: true };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      return reply.code(409).send({ error: stderr || message(err) });
    }
  });

  // All session files, the newest first.
  app.get('/api/history', async () => listHistory());

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => search(req.query.q ?? ''));

  // Brings the Terminal.app tab of the session to the front.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/focus', async (req, reply) => {
    try {
      const error = await focusTerminal(req.params.id);
      if (error) return reply.code(404).send({ error });
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: 'Could not focus the terminal' });
    }
  });

  if (staticDir) await app.register(fastifyStatic, { root: staticDir });

  await app.listen({ port, host: '127.0.0.1' });
  console.log(`server: http://127.0.0.1:${port}`);
}
