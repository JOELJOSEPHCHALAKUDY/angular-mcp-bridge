import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeAssetMiddleware, serveBridge, type BridgeAssetManifest } from '@angular-mcp-bridge/server';
import { demoOptions } from '../examples/server/app.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'angular-mcp-assets-')); directories.push(directory);
  const key = 'build/view/main.js', content = 'export const message = "Angular";';
  await mkdir(join(directory, 'build/view'), { recursive: true });
  await writeFile(join(directory, key), content);
  const manifest: BridgeAssetManifest = { routePrefix: '/__bridge/assets', files: { [key]: { path: `dist/assets/${key}`, mimeType: 'text/javascript', sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) } } };
  return { directory, key, content, manifest };
}
describe('public Angular module assets', () => {
  it('allows sandboxed iframe module reads with immutable headers while preserving MCP origin rejection', async () => {
    const f = await fixture(), htmlPath = join(f.directory, 'widget.html'); await writeFile(htmlPath, '<html>Angular</html>');
    const server = await serveBridge(demoOptions(htmlPath), { port: 0, assets: { directory: f.directory, manifest: f.manifest } });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const assetUrl = `${url}${f.manifest.routePrefix}/${f.key}`;
      const response = await fetch(assetUrl, { headers: { Origin: 'null' } });
      expect(response.status).toBe(200); expect(await response.text()).toBe(f.content);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-type')).toContain('javascript');
      expect((await fetch(assetUrl, { headers: { 'If-None-Match': response.headers.get('etag')! } })).status).toBe(304);
      expect((await fetch(assetUrl, { method: 'HEAD' })).headers.get('content-length')).toBe(String(Buffer.byteLength(f.content)));
      expect((await fetch(assetUrl, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
      expect((await fetch(`${url}/health`, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      expect((await fetch(`${url}${f.manifest.routePrefix}/widget.html`)).status).toBe(404);
      expect((await fetch(`${url}${f.manifest.routePrefix}/build/view/unknown.js`)).status).toBe(404);
    } finally { await server.close(); }
  });
  it('refuses tampered builds, unsafe keys and symlinks outside the public build', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, f.key), 'tampered');
    await expect(createBridgeAssetMiddleware({ directory: f.directory, manifest: f.manifest })).rejects.toThrow('integrity mismatch');
    for (const key of ['../secret', '/secret', 'build/%2e%2e/secret', 'build\\secret']) {
      await expect(createBridgeAssetMiddleware({ directory: f.directory, manifest: { routePrefix: '/assets', files: { [key]: f.manifest.files[f.key] } } })).rejects.toThrow('manifest key');
    }
    const outside = await mkdtemp(join(tmpdir(), 'angular-mcp-private-')); directories.push(outside);
    await writeFile(join(outside, 'secret.js'), f.content); await rm(join(f.directory, f.key));
    await symlink(join(outside, 'secret.js'), join(f.directory, f.key));
    await expect(createBridgeAssetMiddleware({ directory: f.directory, manifest: f.manifest })).rejects.toThrow('escapes');
  });
});
