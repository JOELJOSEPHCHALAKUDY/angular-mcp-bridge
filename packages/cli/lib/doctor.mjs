import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfiguration, discoverViews, containedPath } from './config.mjs';
import { workflowCommands } from './workflow.mjs';

export const supportedNodeRange = '^22.22.3 || ^24.15.0 || >=26.0.0';
export function supportedNodeVersion(version) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major >= 26 || (major === 24 && minor >= 15) || (major === 22 && (minor > 22 || (minor === 22 && patch >= 3)));
}
async function fileExists(path) { try { return (await stat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function packageManifest(root, name) {
  try { return JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function entryPath(manifest) {
  let entry = manifest.exports?.['.'];
  for (let depth = 0; entry && typeof entry === 'object' && depth < 8; depth++) entry = entry.import ?? entry.default ?? entry.node;
  return typeof entry === 'string' ? entry : manifest.module ?? manifest.main;
}

/** Reads only package/configuration manifests and file metadata; never imports app code. */
export async function diagnoseProject(root = process.cwd(), options = {}) {
  root = resolve(root); const checks = [];
  const add = (id, status, message, command) => checks.push({ id, status, message, ...(command ? { command } : {}) });
  const version = options.nodeVersion ?? process.versions.node;
  add('node', supportedNodeVersion(version) ? 'ok' : 'error', `Node ${version}; required ${supportedNodeRange}`, supportedNodeVersion(version) ? undefined : 'Install Node 24.15 or a newer supported LTS release, then npm install');
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')); add('workspace', 'ok', `Project ${manifest.name ?? '(unnamed)'}`); }
  catch (error) { add('workspace', 'error', error.code === 'ENOENT' ? 'No package.json in this folder. Run doctor from your app folder.' : 'package.json is invalid JSON.', 'cd <your-angular-mcp-app>'); return { root, checks, exitCode: 1, nextCommand: 'cd <your-angular-mcp-app>' }; }
  const frameworkWorkspace = Boolean(manifest.workspaces && manifest.scripts?.['build:packages']);
  const commands = workflowCommands(manifest);
  const missing = [];
  for (const name of ['@angular/core', '@angular/cli', '@angular/build', '@angular/compiler-cli', 'typescript', 'tsx', 'esbuild']) {
    let installed;
    try { installed = await packageManifest(root, name); }
    catch { add(`package:${name}`, 'error', `${name} has an invalid installed package manifest.`, 'npm install'); continue; }
    if (!installed) { missing.push(name); continue; }
    if (name.startsWith('@angular/') && !/^22\./.test(installed.version ?? '')) add(`package:${name}`, 'error', `${name} ${installed.version ?? '(unknown)'} is installed; this scaffold requires Angular 22.`, 'npm install');
  }
  const missingBins = [];
  for (const name of ['ng', 'tsc', 'tsx']) {
    try { await stat(resolve(root, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missingBins.push(name); }
  }
  add('dependencies', missing.length || missingBins.length ? 'error' : 'ok', missing.length || missingBins.length ? `Missing installed dependencies${missing.length ? `: ${missing.join(', ')}` : ''}${missingBins.length ? `; missing local executables: ${missingBins.join(', ')}` : ''}.` : 'Angular CLI, compiler, TypeScript, tsx and bundler are installed.', missing.length || missingBins.length ? 'npm install' : undefined);
  const missingFramework = [];
  for (const name of ['angular', 'contracts', 'server']) {
    const directory = frameworkWorkspace && name === 'angular' ? resolve(root, 'dist/angular') : resolve(root, 'node_modules/@angular-mcp-bridge', name);
    try {
      const installed = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      const entry = entryPath(installed);
      if (!entry || !(await fileExists(containedPath(directory, entry, 'Package entry')))) missingFramework.push(name);
    } catch { missingFramework.push(name); }
  }
  add('framework', missingFramework.length ? (frameworkWorkspace ? 'warning' : 'error') : 'ok', missingFramework.length ? `Framework build/install is needed: ${missingFramework.join(', ')}.` : 'Angular bridge, contracts and server entry points are available.', missingFramework.length ? (frameworkWorkspace ? 'npm run build:packages' : 'npm install') : undefined);
  let config; let views;
  try {
    config = await readConfiguration(root); views = await discoverViews(config);
    if (![config.server.port, config.workbench.port, ...views.map(view => view.devPort)].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('Configured ports must be integers between 1 and 65535.');
    if (config.angular.projects?.[config.workbench.project]?.projectType !== 'application') throw new Error(`Unknown Angular workbench application: ${config.workbench.project}`);
    add('configuration', 'ok', `${views.length} Angular views discovered: ${views.map(view => view.name).join(', ')}.`);
    const serverExists = await fileExists(containedPath(root, config.server.entry));
    add('server', serverExists ? 'ok' : 'error', `Server entry: ${config.server.entry}`, serverExists ? undefined : 'Fix server.entry in bridge.config.json');
  } catch (error) { add('configuration', 'error', error.code === 'ENOENT' ? 'Angular workspace files are missing. Run doctor from the generated app folder.' : error.message, 'Fix angular.json, bridge.config.json and views/*/view.json'); }
  if (config && views) {
    const manifestPath = resolve(root, config.outputDirectory, 'bridge-manifest.json');
    let built = false;
    try {
      const build = JSON.parse(await readFile(manifestPath, 'utf8'));
      built = Boolean(build.views) && (await Promise.all(views.map(async view => typeof build.views[view.name]?.htmlPath === 'string' && await fileExists(containedPath(root, build.views[view.name].htmlPath))))).every(Boolean);
    } catch { /* Missing/invalid artifacts are rebuilt by dev. */ }
    add('build', built ? 'ok' : 'warning', built ? `Bundled resources are available for ${commands.start}.` : `No complete build yet; ${commands.dev} builds the initial resources automatically.`, built ? undefined : commands.dev);
  }
  const exitCode = checks.some(check => check.status === 'error') ? 1 : 0;
  const nextCommand = checks.find(check => check.status === 'error')?.command ?? commands.dev;
  return { root, checks, exitCode, nextCommand };
}
export function formatDiagnosis(report) {
  return `Angular MCP Bridge doctor\n${report.root}\n\n${report.checks.map(check => `${check.status === 'ok' ? 'OK' : check.status === 'warning' ? 'WARN' : 'FAIL'}  ${check.message}${check.command ? `\n      ${check.command}` : ''}`).join('\n')}\n\n${report.exitCode ? 'Setup needs attention.' : 'Ready for local development.'}\nNext: ${report.nextCommand}`;
}
