#!/usr/bin/env node
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProject, creationInstructions } from '../lib/create.mjs';
import { diagnoseProject, formatDiagnosis, supportedNodeVersion, supportedNodeRange } from '../lib/doctor.mjs';
export { createProject } from '../lib/create.mjs';

const commandDescriptions = {
  create: 'Create a standalone Angular app that installs the framework from npm.',
  doctor: 'Check Node, installed packages, configuration and build prerequisites.',
  dev: 'Build initial resources and start the MCP server, workbench and Angular HMR.',
  build: 'Build Angular views and the workbench, validate server types and bundle resources.',
  start: 'Start the MCP server using an existing build.',
  'add-view': 'Generate a typed MCP feature and standalone Angular view when a native registry is configured.',
  tunnel: 'Open a public tunnel through an installed cloudflared or ngrok executable.',
  deploy: 'Write a local Dockerfile and Compose artifact from an existing build.',
};
const details = {
  create: 'Usage: angular-mcp-bridge create <folder> [--local <framework-folder>]\n\nInstalls the framework packages from npm. With --local, the folder must contain built dist/tarballs instead. Existing work is protected.\nFrom a framework checkout, this prepares local packages automatically:\n  npm run create -- ../my-angular-app\n  npm run create -- ../my-angular-app --install\n\nWithout --install, run npm install in the new app, then npm run dev.',
  doctor: 'Usage: angular-mcp-bridge doctor [--json]\n\nRun from the framework checkout or a generated app folder. Checks are local\nand read-only: no network, app code execution, credentials or environment files.\nExit 0: ready, possibly with rebuild warnings. Exit 1: setup needs attention.\nThe report supplies an actionable next command.',
  dev: 'Usage: angular-mcp-bridge dev\n\nInstall dependencies with npm install first. Dev builds initial resources,\nselects available ports and prints the actual workbench, MCP and view URLs.\nAngular template/component changes use HMR. Stop with Ctrl+C.',
  build: 'Usage: angular-mcp-bridge build\n\nInstall dependencies first. Uses Angular CLI application builders and generates\nview types plus dist/bridge-manifest.json and standalone widget HTML.',
  start: 'Usage: angular-mcp-bridge start\n\nRun npm run build first. This starts the MCP server without Angular HMR.\nPORT can override the configured preferred API port.',
  'add-view': 'Usage: angular-mcp-bridge add-view <name>\n\nNames start with a lowercase letter; lowercase letters, numbers, underscores\nand hyphens are allowed. Existing applications and markers are protected.\nA configured native registry generates and registers a typed contract, handler\nand Angular view through ng generate. Old workspaces without a native registry\nkeep the view-only generator and require manual tool binding.\nUse ng generate @angular-mcp-bridge/cli:view <name> --dry-run for a native preview.',
  tunnel: 'Usage: angular-mcp-bridge tunnel --provider cloudflared|ngrok [--port 3000] [--verbose]\n\nInstall and configure the provider separately. Start your MCP server first,\nthen pass the actual API port printed by dev. This explicitly opens a public\nendpoint. Configure the server ALLOWED_HOSTS for the printed public hostname.',
  deploy: 'Usage: angular-mcp-bridge deploy [folder]\n\nDefault folder: deploy. Requires npm run build and package-lock.json.\nWrites local container files, protects existing work, and does not publish.\nReview the generated configuration and provide production domain/OAuth settings.',
};
export function commandHelp(command) {
  if (!command) return `Angular MCP Bridge v0.1.1\n\nUsage: angular-mcp-bridge <command> [options]\n\n${Object.entries(commandDescriptions).map(([name, description]) => `  ${name.padEnd(10)} ${description}`).join('\n')}\n\nQuickstart:\n  npx @angular-mcp-bridge/cli create my-angular-app\n  cd my-angular-app\n  npm install\n  npm run dev\n\nHelp: angular-mcp-bridge <command> --help\nDiagnostics: angular-mcp-bridge doctor`;
  if (!details[command]) throw new Error(`Unknown command: ${command}. Run angular-mcp-bridge --help.`);
  return `${commandDescriptions[command]}\n\n${details[command]}\n\nOptions:\n  -h, --help  Show this command's help.`;
}
function parseArguments(args, flags = {}) {
  const positionals = []; const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('-')) { positionals.push(argument); continue; }
    if (!(argument in flags)) throw new Error(`Unknown option: ${argument}. Use --help to see supported options.`);
    if (options[argument] !== undefined) throw new Error(`Option was provided more than once: ${argument}`);
    if (flags[argument] === 'value') {
      const value = args[++index]; if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value. Use --help for an example.`);
      options[argument] = value;
    } else options[argument] = true;
  }
  return { positionals, options };
}
function expectArguments(positionals, minimum, maximum, command) {
  if (positionals.length < minimum || positionals.length > maximum) throw new Error(`Invalid arguments for ${command}.\n${details[command].split('\n')[0]}\nRun angular-mcp-bridge ${command} --help for details.`);
}
export async function main(args = process.argv.slice(2), context = {}) {
  const log = context.log ?? console.log; const root = context.root ?? process.cwd();
  if (!args.length || ['--help', '-h'].includes(args[0])) { log(commandHelp()); return 0; }
  if (args[0] === 'help') { if (args.length > 2) throw new Error('Usage: angular-mcp-bridge help [command]'); log(commandHelp(args[1])); return 0; }
  const command = args[0]; commandHelp(command);
  if (args.includes('--help') || args.includes('-h')) { log(commandHelp(command)); return 0; }
  if (command === 'doctor') {
    const { positionals, options } = parseArguments(args.slice(1), { '--json': 'boolean' }); expectArguments(positionals, 0, 0, command);
    const report = await diagnoseProject(root, { nodeVersion: context.nodeVersion }); log(options['--json'] ? JSON.stringify(report, null, 2) : formatDiagnosis(report)); return report.exitCode;
  }
  if (!supportedNodeVersion(context.nodeVersion ?? process.versions.node)) throw new Error(`Unsupported Node version. Required: ${supportedNodeRange}. Install a supported Node release, then npm install. Run angular-mcp-bridge doctor for details.`);
  if (command === 'create') {
    const { positionals, options } = parseArguments(args.slice(1), { '--local': 'value' }); expectArguments(positionals, 1, 1, command);
    const directory = await createProject(resolve(root, positionals[0]), options['--local'] && resolve(root, options['--local'])); log(creationInstructions(directory)); return 0;
  }
  if (command === 'tunnel') {
    const { positionals, options } = parseArguments(args.slice(1), { '--provider': 'value', '--port': 'value', '--verbose': 'boolean' }); expectArguments(positionals, 0, 0, command);
    const { openTunnel } = await import('../lib/tunnel.mjs'); await openTunnel(options['--provider'], options['--port'] === undefined ? 3000 : Number(options['--port']), { verbose: Boolean(options['--verbose']) }); return 0;
  }
  const { positionals } = parseArguments(args.slice(1)); expectArguments(positionals, command === 'add-view' ? 1 : 0, ['add-view', 'deploy'].includes(command) ? 1 : 0, command);
  if (command === 'deploy') { const { createDeployment } = await import('../lib/deploy.mjs'); log(`Container artifact: ${await createDeployment(root, positionals[0] ?? 'deploy')}`); return 0; }
  const operations = await import('../lib/commands.mjs');
  if (command === 'build') await operations.buildProject(root);
  if (command === 'dev') await operations.developProject(root);
  if (command === 'start') await operations.startProject(root);
  if (command === 'add-view') { const view = await operations.addView(positionals[0], root); log(`Created standalone Angular application ${view.project}.\n${view.tool ? `Registered typed tool ${view.tool}. Edit its generated contract and handler, then run your dev command.` : `Bind a tool to view ${view.name}, then run npm run dev.`}`); }
  return 0;
}
function isMain() { try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; } }
if (isMain()) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Angular MCP Bridge: ${error.message}`); process.exitCode = 1; });
}
