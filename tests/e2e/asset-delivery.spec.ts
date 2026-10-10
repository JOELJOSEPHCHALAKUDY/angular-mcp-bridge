import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { createBridgeAssetMiddleware } from '../../packages/server/src/assets.js';
import { buildAssetViews } from '../../packages/cli/lib/assets.mjs';

test('hosted Angular assets load a real deferred chunk from a sandboxed MCP iframe', async ({ browser }) => {
  test.setTimeout(60000);
  const root = process.cwd();
  await mkdir(resolve(root, '.cache'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.cache/asset-browser-'));
  const app = express();
  let server: ReturnType<typeof createServer> | undefined;
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const certConfig = join(directory, 'certificate.conf');
    await writeFile(certConfig, '[req]\ndistinguished_name=subject\nx509_extensions=extensions\nprompt=no\n[subject]\nCN=localhost\n[extensions]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', certConfig, '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, app);
    await new Promise<void>(resolveReady => server!.listen(0, '127.0.0.1', resolveReady));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTPS port');
    const origin = `https://127.0.0.1:${address.port}`;
    const htmlPath = join(directory, 'widgets/lab.html');
    const manifest = await buildAssetViews({ root, outputDirectory: directory, defaultView: 'lab', delivery: { mode: 'assets', assetOrigin: origin } }, [{ name: 'lab', project: 'lab', sourceHtmlPath: resolve(root, 'dist/lab/browser/index.html'), htmlPath, description: 'Deferred Angular integration test.' }]);
    expect(manifest.views.lab.csp.resourceDomains).toContain(origin);
    expect(manifest.views.lab.csp.baseUriDomains).toContain(origin);
    app.use(manifest.assets.routePrefix, await createBridgeAssetMiddleware({ directory: join(directory, 'assets'), manifest: manifest.assets }));
    const productionManifest = JSON.parse(await readFile(resolve(root, 'dist/bridge-manifest.json'), 'utf8'));
    const standaloneHtml = await readFile(resolve(root, productionManifest.views.lab.htmlPath), 'utf8');
    let assetHtml = await readFile(htmlPath, 'utf8');
    // The workbench is a local host simulator. Enforce the manifest's asset/base
    // domains here to exercise a real browser CSP as well as module CORS.
    assetHtml = assetHtml.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline' ${origin}; img-src data: ${origin}; font-src ${origin}; base-uri ${origin}">`);
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const loadedModules = new Set<string>();
    const errors: string[] = [];
    page.on('request', request => { if (request.url().startsWith(origin) && /\.m?js(?:\?|$)/.test(request.url())) loadedModules.add(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/mcp', async route => {
      const request = route.request();
      const body = request.postDataJSON();
      if (body?.method !== 'resources/read') { await route.continue(); return; }
      const response = await route.fetch();
      const text = await response.text();
      await route.fulfill({ response, body: text.replace(JSON.stringify(standaloneHtml), JSON.stringify(assetHtml)) });
    });
    await page.goto('http://127.0.0.1:3100/');
    await page.getByRole('button', { name: /Angular integration lab open_lab/ }).click();
    await page.getByRole('button', { name: 'Run tool', exact: false }).click();
    const view = page.frameLocator('iframe');
    await expect(view.getByRole('heading', { name: 'Explore the bridge.' })).toBeVisible();
    await expect(page.locator('.preview-status')).toHaveText('connected');
    const initialModules = new Set(loadedModules);
    expect(initialModules.size).toBeGreaterThan(0);
    await expect(view.getByRole('heading', { name: 'Deferred Angular details' })).toHaveCount(0);
    await view.getByRole('button', { name: 'Load deferred details', exact: true }).click();
    await expect(view.getByRole('heading', { name: 'Deferred Angular details' })).toBeVisible();
    expect([...loadedModules].filter(url => !initialModules.has(url)).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); }
    await rm(directory, { recursive: true, force: true });
  }
});
