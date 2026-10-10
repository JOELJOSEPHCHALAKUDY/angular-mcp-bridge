import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RequestHandler } from 'express';

export interface BridgeAssetManifest {
  routePrefix: string;
  files: Record<string, { path: string; mimeType: string; sha256: string; bytes: number }>;
}
export interface BridgeAssetOptions {
  /** Directory containing the manifest's hash/view/file keys (usually dist/assets). */
  directory: string;
  manifest: BridgeAssetManifest;
}
const publicMimeTypes = new Set(['text/javascript', 'application/javascript', 'text/css', 'application/json', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'application/wasm']);

/** Serves a verified public build snapshot. It never exposes a directory or an application API. */
export async function createBridgeAssetMiddleware(options: BridgeAssetOptions): Promise<RequestHandler> {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(options.manifest.routePrefix)) throw new Error('Asset routePrefix must be a fixed absolute URL path.');
  const directory = await realpath(options.directory);
  const files = new Map<string, { content: Buffer; mimeType: string; etag: string }>();
  for (const [key, entry] of Object.entries(options.manifest.files)) {
    if (!key || key.startsWith('/') || key.includes('\\') || key.includes('%') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid asset manifest key: ${key}`);
    if (!publicMimeTypes.has(entry.mimeType)) throw new Error(`Unsupported public asset MIME type: ${entry.mimeType}`);
    const path = await realpath(resolve(directory, key));
    const location = relative(directory, path);
    if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location) || !(await stat(path)).isFile()) throw new Error(`Asset escapes its build directory: ${key}`);
    const content = await readFile(path);
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== entry.bytes || digest !== entry.sha256) throw new Error(`Asset integrity mismatch: ${key}`);
    files.set(key, { content, mimeType: entry.mimeType, etag: `"${digest}"` });
  }
  return (request, response) => {
    // Public module assets must work from sandboxed iframes whose Origin is "null".
    // This policy is confined to the allowlisted, immutable build snapshot.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let key: string;
    try { key = decodeURIComponent(request.path.slice(1)); } catch { response.sendStatus(400); return; }
    const asset = files.get(key);
    if (!asset) { response.sendStatus(404); return; }
    if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD, OPTIONS'); response.sendStatus(405); return; }
    response.setHeader('Content-Type', asset.mimeType);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('ETag', asset.etag);
    if (request.headers['if-none-match'] === asset.etag) { response.status(304).end(); return; }
    response.setHeader('Content-Length', asset.content.byteLength);
    if (request.method === 'HEAD') response.end(); else response.end(asset.content);
  };
}
