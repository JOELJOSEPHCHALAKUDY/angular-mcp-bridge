import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { demoOptions } from './app.js';
import { labTools } from '../shared/lab-tools.js';
import { tools as generatedTools } from '../shared/generated-tools.js';
import { handlers as generatedHandlers } from './generated-handlers.js';
import type { BridgeServerOptions, BridgeAssetManifest, BridgeAssetOptions } from '@angular-mcp-bridge/server';
import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps';

interface BuildManifest { views: Record<string, { htmlPath: string; description: string; csp?: McpUiResourceCsp }>; assets?: BridgeAssetManifest }
interface RuntimeManifest { mcpUrl: string; workbenchUrl?: string; views: Record<string, { devUrl?: string }> }
/** Runtime endpoints expose only public dev URLs, never local filesystem paths. */
export function publicRuntime(): RuntimeManifest {
  const path = process.env['BRIDGE_RUNTIME_MANIFEST'];
  if (!path) return { mcpUrl: `http://127.0.0.1:${process.env['PORT'] ?? 3000}/mcp`, views: {} };
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest;
  return { mcpUrl: manifest.mcpUrl, workbenchUrl: manifest.workbenchUrl, views: Object.fromEntries(Object.entries(manifest.views).map(([name, view]) => [name, { devUrl: view.devUrl }])) };
}
/** Module assets are served only when the build explicitly selects hosted delivery. */
export function frameworkAssets(): BridgeAssetOptions | undefined {
  const manifest = JSON.parse(readFileSync(resolve('dist/bridge-manifest.json'), 'utf8')) as BuildManifest;
  return manifest.assets ? { directory: resolve('dist/assets'), manifest: manifest.assets } : undefined;
}
export function frameworkOptions() {
  const manifestPath = resolve('dist/bridge-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('Run npm run build first to generate the Angular view manifest.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest;
  const base = demoOptions(resolve(manifest.views['projects'].htmlPath));
  const registry = { ...base.tools, ...labTools, ...generatedTools };
  let note = 'Angular owns the view. MCP connects it to the host.';
  const etag = () => createHash('sha256').update(note).digest('hex').slice(0, 16);
  const options: BridgeServerOptions<typeof registry> = {
    ...base, tools: registry,
    instructions: 'Use list_projects for the project browser. Use open_lab for Angular capabilities. get_project returns data without opening another view.',
    views: Object.fromEntries(Object.entries(manifest.views).map(([name, view]) => [name, { htmlPath: resolve(view.htmlPath), description: view.description, csp: view.csp }])),
    handlers: { ...base.handlers, ...generatedHandlers, inspect_schema: input => ({ data: input, text: 'Schema accepted.' }), open_lab: () => ({ data: { message: 'Angular integration lab ready.', resource: 'bridge://lab/notes' } }) },
    skills: { directory: resolve('examples/skills') },
    configure(server, context) {
      server.registerPrompt('angular-help', { description: 'Explain an Angular concept using this integration lab.', argsSchema: z.object({ topic: z.string().min(1) }) }, ({ topic }) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Explain Angular ${topic} with a standalone component example.` } }],
      }));
      server.server.registerCapabilities({ resources: { subscribe: true }, extensions: { 'openai/resource': {} } });
      server.registerResource('Shared lab note', 'bridge://lab/notes', { mimeType: 'text/plain', description: 'A process-local demo note with optimistic concurrency.' }, async () => ({
        contents: [{ uri: 'bridge://lab/notes', mimeType: 'text/plain', text: note, _meta: { 'openai/resource': { writable: true, etag: etag() } } }],
      }));
      const subscription = { params: z.object({ uri: z.literal('bridge://lab/notes') }), result: z.object({}) };
      server.server.setRequestHandler('resources/subscribe', subscription, () => ({}));
      server.server.setRequestHandler('resources/unsubscribe', subscription, () => ({}));
      server.server.setRequestHandler('openai/resources/write', {
        params: z.object({ uri: z.literal('bridge://lab/notes'), text: z.string(), ifMatch: z.string().optional() }),
        result: z.union([z.object({ outcome: z.literal('saved'), etag: z.string() }), z.object({ outcome: z.literal('conflict'), etag: z.string() }), z.object({ outcome: z.literal('too-large'), maxBytes: z.number() })]),
      }, async params => {
        if (Buffer.byteLength(params.text) > 16_384) return { outcome: 'too-large' as const, maxBytes: 16_384 };
        if (params.ifMatch !== etag()) return { outcome: 'conflict' as const, etag: etag() };
        note = params.text;
        if (context.notify) await context.notify.resourceUpdated('bridge://lab/notes');
        return { outcome: 'saved' as const, etag: etag() };
      });
    },
  };
  return options;
}
