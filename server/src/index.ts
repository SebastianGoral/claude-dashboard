import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

await startServer({ port: 4317, workflowsDir: fileURLToPath(new URL('../workflows', import.meta.url)) });
