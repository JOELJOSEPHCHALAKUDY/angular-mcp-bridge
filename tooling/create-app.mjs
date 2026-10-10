#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, dirname, delimiter, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEmptyDestination, createProject, creationInstructions } from '../packages/cli/lib/create.mjs';
import { supportedNodeVersion, supportedNodeRange } from '../packages/cli/lib/doctor.mjs';

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const createHelp = `Create a standalone Angular MCP app from this local checkout.\n\nUsage: npm run create -- <folder> [--install]\n\n  --install   Install the new app's dependencies after scaffolding.\n  -h, --help  Show this help.\n\nThis prepares local framework packages automatically. A nonempty destination\nis rejected before any build. Dependencies in this checkout must already be\ninstalled with npm install.\n\nQuickstart:\n  npm run create -- ../my-angular-app --install\n  cd ../my-angular-app\n  npm run dev\n\nWithout --install, run npm install in the generated app before npm run dev.`;
export async function runNpm(root, args) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${resolve(frameworkRoot, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}` } });
  await new Promise((resolveRun, reject) => {
    child.once('error', error => reject(new Error(`Cannot run npm: ${error.message}`)));
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`npm ${args.join(' ')} failed (${signal ?? code}).`)));
  });
}
export async function createApp(target, options = {}) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('A target folder is required. Example: npm run create -- ../my-angular-app --install');
  const root = resolve(options.root ?? frameworkRoot); const log = options.log ?? console.log; const run = options.run ?? runNpm;
  const directory = await assertEmptyDestination(resolve(options.cwd ?? process.cwd(), target));
  const first = relative(root, directory).split(sep)[0];
  if (['packages', 'dist', 'node_modules', '.angular', '.cache', '.git', 'generated'].includes(first)) throw new Error('Choose a new app folder outside the framework packages and build directories. Example: npm run create -- ../my-angular-app');
  if (!supportedNodeVersion(options.nodeVersion ?? process.versions.node)) throw new Error(`Unsupported Node version. Required: ${supportedNodeRange}. Install a supported Node release, then npm install.`);
  log('Preparing local framework packages (Angular library, contracts, server and testing)…');
  try { await run(root, ['run', 'build:packages']); await run(root, ['run', 'pack:all']); }
  catch (error) { throw new Error(`${error.message}\nPreparation failed. Run npm run doctor in the framework checkout and fix the reported issue. The destination has not been scaffolded.`); }
  const created = await createProject(directory, root);
  if (options.install) {
    log(`Installing dependencies in ${created}…`);
    try { await run(created, ['install']); }
    catch (error) { throw new Error(`${error.message}\nThe app was created successfully. Retry:\n  ${creationInstructions(created).split('Next:\n')[1]}`); }
  }
  log(creationInstructions(created, Boolean(options.install)));
  return created;
}
export async function main(args = process.argv.slice(2), options = {}) {
  if (args.includes('--help') || args.includes('-h')) { (options.log ?? console.log)(createHelp); return 0; }
  const target = args.filter(argument => !argument.startsWith('-'));
  const unknown = args.find(argument => argument.startsWith('-') && argument !== '--install');
  if (unknown || target.length !== 1 || args.filter(argument => argument === '--install').length > 1) throw new Error(`${unknown ? `Unknown option: ${unknown}.\n` : ''}Usage: npm run create -- <folder> [--install]\nRun npm run create -- --help for details.`);
  await createApp(target[0], { ...options, install: args.includes('--install') }); return 0;
}
function isMain() { try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; } }
if (isMain()) {
  main().catch(error => { console.error(`Angular MCP Bridge create: ${error.message}`); process.exitCode = 1; });
}
