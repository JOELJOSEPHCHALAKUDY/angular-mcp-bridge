import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error The CLI is a directly executable ESM file.
import { createProject, main as cliMain, commandHelp } from '../packages/cli/bin/bridge.mjs';
// @ts-expect-error Direct ESM tooling.
import { creationInstructions, shellArgument } from '../packages/cli/lib/create.mjs';
// @ts-expect-error Direct ESM tooling.
import { diagnoseProject, supportedNodeVersion, formatDiagnosis } from '../packages/cli/lib/doctor.mjs';
// @ts-expect-error Direct ESM tooling.
import { createApp, main as createMain } from '../tooling/create-app.mjs';
const runFile = promisify(execFile);
async function localTarballs(root: string) {
  const tarballs = join(root, 'dist/tarballs'); await mkdir(tarballs, { recursive: true });
  for (const name of ['angular', 'contracts', 'server']) await writeFile(join(tarballs, `angular-mcp-bridge-${name}-0.1.3.tgz`), 'fixture');
}
describe('project scaffolding', () => {
  it('creates a portable template with vendored packages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
    try {
      const tarballs = join(directory, 'framework/dist/tarballs'); await mkdir(tarballs, { recursive: true });
      for (const name of ['angular','contracts','server']) await writeFile(join(tarballs, `angular-mcp-bridge-${name}-0.1.3.tgz`), 'fixture');
      const target = join(directory, 'My-App');
      await createProject(target, join(directory, 'framework'));
      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('my-app'); expect(pkg.dependencies['@angular/core']).toBe('22.2.2');
      expect(pkg.dependencies['@angular-mcp-bridge/angular']).toBe('file:vendor/angular-mcp-bridge-angular-0.1.3.tgz');
      expect((await readdir(join(target,'vendor'))).length).toBe(3);
      const config = JSON.parse(await readFile(join(target, 'tsconfig.json'), 'utf8')); expect(config.compilerOptions.paths).toBeUndefined();
      expect(await readFile(join(target, 'tooling/bundle-widget.mjs'), 'utf8')).toContain('esbuild');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('creates an app that installs the framework from npm when no local folder is given', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
    try {
      const target = join(directory, 'Registry-App');
      await createProject(target);
      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('registry-app');
      for (const name of ['angular', 'contracts', 'server']) expect(pkg.dependencies[`@angular-mcp-bridge/${name}`]).toMatch(/^\d+\.\d+\.\d+$/);
      for (const name of ['cli', 'testing']) expect(pkg.devDependencies[`@angular-mcp-bridge/${name}`]).toMatch(/^\d+\.\d+\.\d+$/);
      await expect(readdir(join(target, 'vendor'))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses to overwrite existing work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
    try { await writeFile(join(directory,'keep.txt'),'keep'); await expect(createProject(directory, resolve('.'))).rejects.toThrow('not empty'); expect(await readFile(join(directory,'keep.txt'),'utf8')).toBe('keep'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects a symbolic-link destination before modifying the linked folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
    try {
      const original = join(root, 'original'); await mkdir(original); await symlink(original, join(root, 'linked'));
      await expect(createProject(join(root, 'linked'), root)).rejects.toThrow('symbolic link');
      expect(await readdir(original)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('publishes into an existing empty folder and safely quotes shell-sensitive names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
    try {
      await localTarballs(root); const target = join(root, "app $(touch unwanted) `echo no`' name"); await mkdir(target);
      await createProject(target, root);
      const result = await runFile('/bin/sh', ['-c', `printf '%s' ${shellArgument(target)}`]);
      expect(result.stdout).toBe(target); expect(await readdir(root)).not.toContain('unwanted');
      const instructions = creationInstructions(target);
      expect(instructions).toContain('  npm install\n  npm run dev'); expect(instructions).not.toContain('npm run build');
      expect(creationInstructions(target, true)).not.toContain('npm install');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('easy local create workflow', () => {
  it('validates an occupied destination before preparing packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-create-')); const calls: unknown[] = [];
    try {
      await writeFile(join(root, 'keep.txt'), 'keep');
      await expect(createApp(root, { run: async (...args: unknown[]) => calls.push(args), nodeVersion: '24.15.0', log: () => {} })).rejects.toThrow('not empty');
      expect(calls).toEqual([]); expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('prepares packages then scaffolds without installing unless requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-create-')); const calls: unknown[] = []; const output: string[] = [];
    try {
      const target = join(root, 'app');
      await createApp(target, { root, run: async (cwd: string, args: string[]) => { calls.push([cwd, args]); if (args[1] === 'pack:all') await localTarballs(root); }, nodeVersion: '24.15.0', log: (text: string) => output.push(text) });
      expect(calls).toEqual([[root, ['run', 'build:packages']], [root, ['run', 'pack:all']]]);
      expect((await stat(join(target, 'angular.json'))).isFile()).toBe(true);
      expect(output.at(-1)).toContain('  npm install\n  npm run dev');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('installs only with --install and leaves a repairable scaffold on install failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-create-')); const calls: unknown[] = [];
    try {
      await localTarballs(root); const target = join(root, 'app');
      await expect(createMain([target, '--install'], { root, run: async (cwd: string, args: string[]) => { calls.push([cwd, args]); if (args[0] === 'install') throw new Error('Fixture install failed'); }, nodeVersion: '24.15.0', log: () => {} })).rejects.toThrow('The app was created successfully. Retry:');
      expect(calls).toEqual([[root, ['run', 'build:packages']], [root, ['run', 'pack:all']], [target, ['install']]]);
      expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).name).toBe('app');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rechecks a destination that gains files while the framework is being prepared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-create-'));
    try {
      await localTarballs(root); const target = join(root, 'app');
      await expect(createApp(target, { root, run: async (_cwd: string, args: string[]) => { if (args[1] === 'pack:all') { await mkdir(target); await writeFile(join(target, 'keep.txt'), 'keep'); } }, nodeVersion: '24.15.0', log: () => {} })).rejects.toThrow('not empty');
      expect(await readdir(target)).toEqual(['keep.txt']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function doctorFixture(root: string) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'doctor-app', scripts: { dev: 'node tooling/bridge/bin/bridge.mjs dev' } }));
  await writeFile(join(root, 'angular.json'), JSON.stringify({ projects: { demo: { projectType: 'application' }, workbench: { projectType: 'application' } } }));
  await mkdir(join(root, 'examples/server'), { recursive: true }); await writeFile(join(root, 'examples/server/main.ts'), '// application code must not be imported by doctor');
  for (const name of ['@angular/core', '@angular/cli', '@angular/build', '@angular/compiler-cli', 'typescript', 'tsx', 'esbuild', '@angular-mcp-bridge/angular', '@angular-mcp-bridge/contracts', '@angular-mcp-bridge/server']) {
    const directory = join(root, 'node_modules', name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: name.startsWith('@angular/') ? '22.2.2' : '0.1.0', exports: { '.': { import: './index.js' } } }));
    await writeFile(join(directory, 'index.js'), 'throw new Error("Doctor must not execute installed packages");');
  }
  await mkdir(join(root, 'node_modules/.bin')); for (const bin of ['ng', 'tsx', 'tsc']) await writeFile(join(root, 'node_modules/.bin', process.platform === 'win32' ? `${bin}.cmd` : bin), 'fixture');
}
describe('local doctor and command help', () => {
  it('checks exact supported Node branches', () => {
    for (const version of ['22.22.3', '22.23.0', '24.15.0', '24.16.0', '26.0.0', '27.0.0']) expect(supportedNodeVersion(version)).toBe(true);
    for (const version of ['20.20.0', '22.22.2', '23.0.0', '24.14.9', '25.9.0', '24.15.0-beta.1', 'invalid']) expect(supportedNodeVersion(version)).toBe(false);
  });
  it('reports installed/configured setup and treats absent dev resources as a rebuild warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-doctor-'));
    try {
      await doctorFixture(root); await writeFile(join(root, '.env'), 'DO_NOT_READ=secret-test-fixture');
      const report = await diagnoseProject(root, { nodeVersion: '24.15.0' });
      expect(report.exitCode).toBe(0); expect(report.nextCommand).toBe('npm run dev');
      expect(report.checks.find((check: {id: string}) => check.id === 'build').status).toBe('warning');
      expect(formatDiagnosis(report)).not.toContain('secret-test-fixture');
      await mkdir(join(root, 'dist/views'), { recursive: true }); await writeFile(join(root, 'dist/views/projects.html'), '<html>fixture</html>');
      await writeFile(join(root, 'dist/bridge-manifest.json'), JSON.stringify({ views: { projects: { htmlPath: 'dist/views/projects.html' } } }));
      expect((await diagnoseProject(root, { nodeVersion: '24.15.0' })).checks.find((check: {id: string}) => check.id === 'build').status).toBe('ok');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('returns failure status and actionable install/configuration diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-doctor-'));
    try {
      await doctorFixture(root); await rm(join(root, 'node_modules'), { recursive: true });
      let report = await diagnoseProject(root, { nodeVersion: '24.15.0' }); expect(report.exitCode).toBe(1); expect(report.nextCommand).toBe('npm install');
      await writeFile(join(root, 'bridge.config.json'), '{broken');
      report = await diagnoseProject(root, { nodeVersion: '20.0.0' }); expect(report.checks.find((check: {id: string}) => check.id === 'node').status).toBe('error');
      expect(report.checks.find((check: {id: string}) => check.id === 'configuration').status).toBe('error');
      const output: string[] = []; expect(await cliMain(['doctor', '--json'], { root, nodeVersion: '24.15.0', log: (text: string) => output.push(text) })).toBe(1);
      expect(JSON.parse(output[0]).exitCode).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recommends bridge scripts in an existing Angular app while preserving its own scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-doctor-'));
    try {
      await doctorFixture(root);
      const manifest = { name: 'existing-app', scripts: { start: 'ng serve', build: 'ng build', 'mcp:dev': 'angular-mcp-bridge dev', 'mcp:build': 'angular-mcp-bridge build', 'mcp:start': 'angular-mcp-bridge start' } };
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
      let report = await diagnoseProject(root, { nodeVersion: '24.15.0' });
      expect(report.nextCommand).toBe('npm run mcp:dev');
      expect(report.checks.find((check: {id: string}) => check.id === 'build')).toMatchObject({ status: 'warning', command: 'npm run mcp:dev', message: expect.stringContaining('npm run mcp:dev') });
      await mkdir(join(root, 'dist/views'), { recursive: true }); await writeFile(join(root, 'dist/views/projects.html'), '<html>fixture</html>');
      await writeFile(join(root, 'dist/bridge-manifest.json'), JSON.stringify({ views: { projects: { htmlPath: 'dist/views/projects.html' } } }));
      report = await diagnoseProject(root, { nodeVersion: '24.15.0' });
      expect(report.checks.find((check: {id: string}) => check.id === 'build')).toMatchObject({ status: 'ok', message: expect.stringContaining('npm run mcp:start') });
      expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual(manifest);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('provides specific help without requiring dependencies and rejects invalid options', async () => {
    const output: string[] = [];
    expect(await cliMain(['doctor', '--help'], { log: (text: string) => output.push(text) })).toBe(0);
    expect(output[0]).toContain('Exit 0:'); expect(output[0]).not.toContain('Usage: angular-mcp-bridge create');
    expect(commandHelp('tunnel')).toContain('--provider cloudflared|ngrok');
    await expect(cliMain(['create', 'app', '--local'], { nodeVersion: '24.15.0' })).rejects.toThrow('--local requires a value');
    await expect(cliMain(['dev', '--typo'], { nodeVersion: '24.15.0' })).rejects.toThrow('Unknown option');
    const root = await mkdtemp(join(tmpdir(), 'bridge-help-'));
    try {
      await mkdir(join(root, 'bin')); await mkdir(join(root, 'lib'));
      for (const [source, target] of [['packages/cli/bin/bridge.mjs', 'bin/bridge.mjs'], ['packages/cli/lib/create.mjs', 'lib/create.mjs'], ['packages/cli/lib/doctor.mjs', 'lib/doctor.mjs'], ['packages/cli/lib/config.mjs', 'lib/config.mjs'], ['packages/cli/lib/workflow.mjs', 'lib/workflow.mjs']]) await writeFile(join(root, target), await readFile(source));
      const result = await runFile(process.execPath, [join(root, 'bin/bridge.mjs'), 'dev', '--help']);
      expect(result.stdout).toContain('Usage: angular-mcp-bridge dev'); expect(result.stderr).toBe('');
      await expect(runFile(process.execPath, [join(root, 'bin/bridge.mjs'), 'doctor'], { cwd: root })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('No package.json') });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses the built Angular package format in the framework checkout and reports unsafe entry points', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-doctor-'));
    try {
      await doctorFixture(root); await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'framework', workspaces: ['packages/*'], scripts: { 'build:packages': 'fixture' } }));
      await mkdir(join(root, 'dist/angular/fesm2022'), { recursive: true });
      await writeFile(join(root, 'dist/angular/package.json'), JSON.stringify({ exports: { '.': { default: './fesm2022/bridge.mjs' } } })); await writeFile(join(root, 'dist/angular/fesm2022/bridge.mjs'), 'fixture');
      await writeFile(join(root, 'node_modules/@angular-mcp-bridge/angular/package.json'), JSON.stringify({ name: '@angular-mcp-bridge/angular' }));
      let report = await diagnoseProject(root, { nodeVersion: '24.15.0' }); expect(report.checks.find((check: {id: string}) => check.id === 'framework').status).toBe('ok');
      await writeFile(join(root, 'node_modules/@angular-mcp-bridge/server/package.json'), JSON.stringify({ exports: { '.': { import: '../../../../outside.js' } } }));
      report = await diagnoseProject(root, { nodeVersion: '24.15.0' }); expect(report.checks.find((check: {id: string}) => check.id === 'framework')).toMatchObject({ status: 'warning', command: 'npm run build:packages' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
