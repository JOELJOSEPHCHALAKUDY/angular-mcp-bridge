import { resolve } from 'node:path';
import { serveBridge } from '../examples/server/app.js';
import { frameworkOptions, frameworkAssets, publicRuntime } from '../examples/server/framework-app.js';
const port = Number(process.env['PORT'] ?? 3000);
const instance = await serveBridge(frameworkOptions(), { port, workbenchPath: resolve('dist/workbench/browser'), assets: frameworkAssets(),
  configureApp: app => { app.get('/__bridge/runtime', (_request, response) => response.json(publicRuntime())); },
});
console.log(`Workbench: http://127.0.0.1:${port}`);
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await instance.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
