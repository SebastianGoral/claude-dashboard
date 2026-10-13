import { homedir } from 'node:os';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ClosedStore } from './closed.js';
import { readDetail } from './detail.js';
import { findSessionFile } from './files.js';
import { exportMarkdown, listHistory, search } from './history.js';
import { focusTerminal } from './focus.js';
import { hooksInstalled, installHooks, removeHooks } from './hooks.js';
import { LoopManager, type LoopInput } from './loops.js';
import type { HookEvent, RunRef } from './session.js';
import { SettingsStore } from './settings.js';
import { UsageTracker } from './usage.js';
import { SessionStore } from './watcher.js';
import { WorkflowManager, type RunInput } from './workflows.js';

const HEARTBEAT_MS = 25_000;

export interface ServerOptions {
  port: number;
  /** Folder with the built web app (web/dist). Without it, only /api is served (dev uses Vite). */
  staticDir?: string;
  /** Folder with the built-in workflow files (server/workflows). */
  workflowsDir: string;
  /** The Claude Code binary for loops. The desktop app sets it, because the SDK cannot run a binary inside app.asar. */
  claudeExecutable?: string;
}

const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Starts the session watcher and the HTTP server. Resolves when the server listens. */
export async function startServer({ port, staticDir, workflowsDir, claudeExecutable }: ServerOptions): Promise<void> {
  const loops = new LoopManager(claudeExecutable);
  const workflows = new WorkflowManager(workflowsDir, claudeExecutable);
  const runOf = (sessionId: string): RunRef | null => {
    const loop = loops.loopOf(sessionId);
    if (loop) return { kind: 'loop', id: loop };
    const run = workflows.runOf(sessionId);
    return run ? { kind: 'workflow', id: run } : null;
  };
  const store = new SessionStore(runOf);
  const closed = new ClosedStore(
    (id) => store.get(id),
    (id) => loops.isActive(id) || workflows.isActive(id),
  );
  store.hidden = (view) => {
    closed.reopenIfActive(view);
    return closed.isClosed(view);
  };
  closed.on('change', () => store.syncHidden());
  await closed.start();
  store.start();
  const usage = new UsageTracker();
  usage.start();
  const settings = new SettingsStore();
  await settings.load();
  const checkHooks = async () => settings.setHooksInstalled(await hooksInstalled(port));
  await checkHooks();

  // A session card gets its run badge as soon as the run knows the session id.
  const known = new Set<string>();
  const resendNew = (sessionIds: (string | null)[]) => {
    for (const id of sessionIds) {
      if (id && !known.has(id)) {
        known.add(id);
        store.resend(id);
      }
    }
  };
  loops.on('loop', (view) => resendNew([view.sessionId]));
  workflows.on('run', (view) => resendNew(view.steps.map((s) => s.sessionId)));

  const app = Fastify();

  // Server-Sent Events. On connect: "snapshot" (sessions), "loops" and "runs" (lists).
  // Then one event per change: "upsert" or "remove" (session), "loop", "run".
  app.get<{ Querystring: { client?: string } }>('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event: string) => (data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('snapshot')(store.views());
    send('loops')(loops.views());
    send('runs')(workflows.views());
    send('closed')(closed.list());
    send('costs')(usage.view());
    // The desktop app connects with ?client=desktop. While it is connected, it gives the alerts.
    const desktop = req.query.client === 'desktop';
    if (desktop) settings.desktop(1);
    send('settings')(settings.view());
    const listeners: [{ off(e: string, fn: (d: any) => void): unknown }, string, (d: any) => void][] = [
      [store, 'upsert', send('upsert')],
      [store, 'remove', send('remove')],
      [loops, 'loop', send('loop')],
      [workflows, 'run', send('run')],
      [settings, 'change', send('settings')],
      [closed, 'change', send('closed')],
      [usage, 'change', send('costs')],
    ];
    for (const [emitter, event, fn] of listeners) (emitter as any).on(event, fn);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      for (const [emitter, event, fn] of listeners) emitter.off(event, fn);
      if (desktop) settings.desktop(-1);
    });
  });

  app.post<{ Body: LoopInput }>('/api/loops', async (req, reply) => {
    const { folder, task, check, maxIterations } = req.body ?? ({} as LoopInput);
    if (typeof folder !== 'string' || typeof task !== 'string' || typeof check !== 'string') {
      return reply.code(400).send({ error: 'folder, task and check are required' });
    }
    try {
      return await loops.start({ folder: expandHome(folder), task, check, maxIterations: Number(maxIterations) || undefined });
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/loops/:id/stop', async (req, reply) => {
    if (!loops.stop(req.params.id)) return reply.code(404).send({ error: 'No running loop with this id' });
    return { ok: true };
  });

  // The workflow files, without their prompts.
  app.get('/api/workflows', async () => {
    const { workflows: list, errors } = await workflows.list();
    return {
      workflows: list.map((w) => ({ id: w.id, name: w.name, file: w.file, steps: w.steps.map((s) => s.name) })),
      errors,
    };
  });

  app.post<{ Body: RunInput }>('/api/runs', async (req, reply) => {
    const { workflowId, folder, task, check } = req.body ?? ({} as RunInput);
    if (typeof workflowId !== 'string' || typeof folder !== 'string' || typeof task !== 'string') {
      return reply.code(400).send({ error: 'workflowId, folder and task are required' });
    }
    try {
      return await workflows.start({ workflowId, folder: expandHome(folder), task, check: typeof check === 'string' ? check : '' });
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req, reply) => {
    if (!workflows.stop(req.params.id)) return reply.code(404).send({ error: 'No running workflow with this id' });
    return { ok: true };
  });

  // Claude Code hooks (see hooks.ts). The body is the hook input JSON.
  app.post<{ Body: HookEvent }>('/api/hooks', async (req, reply) => {
    const event = req.body;
    if (typeof event?.session_id !== 'string' || typeof event.hook_event_name !== 'string') {
      return reply.code(400).send({ error: 'session_id and hook_event_name are required' });
    }
    store.applyHook(event);
    if (event.hook_event_name === 'SessionEnd') closed.close(event.session_id);
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

  app.post<{ Body: { muted?: boolean } }>('/api/settings', async (req) => {
    await settings.update({ muted: req.body?.muted });
    return settings.view();
  });

  // Recent messages, tool calls and sub-agents of a session. Also for closed and old sessions.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/detail', async (req, reply) => {
    const file = store.pathOf(req.params.id) ?? (await findSessionFile(req.params.id));
    if (!file) return reply.code(404).send({ error: 'Session file not found' });
    return readDetail(file, req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/export.md', async (req, reply) => {
    const file = store.pathOf(req.params.id) ?? (await findSessionFile(req.params.id));
    if (!file) return reply.code(404).send({ error: 'Session file not found' });
    const { name, markdown } = await exportMarkdown(file, req.params.id);
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(markdown);
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
