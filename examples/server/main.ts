import { serveBridge } from './app.js';
import { frameworkOptions, frameworkAssets, publicRuntime } from './framework-app.js';
const port = Number(process.env['PORT'] ?? 3000);
const instance = await serveBridge(frameworkOptions(), {
  port, hostname: process.env['HOST'] ?? '127.0.0.1',
  assets: frameworkAssets(),
  allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200,http://localhost:4201').split(',').filter(Boolean),
  allowedHosts: (process.env['ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,[::1]').split(',').filter(Boolean),
  configureApp: app => { app.get('/__bridge/runtime', (_request, response) => response.json(publicRuntime())); },
});
console.log(`Angular MCP Bridge: http://localhost:${port}/mcp`);
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await instance.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
