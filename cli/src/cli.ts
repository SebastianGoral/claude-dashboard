import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { startServer } from '../../server/src/server.js';

const PORT = 4317;
const URL = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  try {
    // The build copies web/dist next to this file.
    await startServer({ port: PORT, staticDir: join(__dirname, 'web') });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    console.error(`Port ${PORT} is in use. Is claude-dash (or its desktop app) already running? Open ${URL}`);
    process.exit(1);
  }
  console.log(`claude-dash runs on ${URL}. Press Ctrl+C to stop.`);
  execFile('open', [URL]);
}

void main();
