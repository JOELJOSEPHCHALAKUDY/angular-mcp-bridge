import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfiguration, containedPath, assertSafeDestination } from './config.mjs';
import { workflowCommands } from './workflow.mjs';

export async function createDeployment(root = process.cwd(), output = 'deploy') {
  const config = await readConfiguration(root);
  const manifestPath = resolve(config.root, config.outputDirectory, 'bridge-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const view of Object.values(manifest.views)) await access(containedPath(config.root, view.htmlPath, 'Manifest htmlPath'));
  const directory = containedPath(config.root, output, 'Deployment output');
  await assertSafeDestination(config.root, directory);
  try { if ((await readdir(directory)).length) throw new Error(`Deployment folder is not empty: ${directory}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory, { recursive: true });
  await access(resolve(config.root, 'package-lock.json'));
  const buildCommand = workflowCommands(JSON.parse(await readFile(resolve(config.root, 'package.json'), 'utf8'))).build;
  const dockerfile = `# Build from the workspace root: docker build -f ${output}/Dockerfile -t angular-mcp-app .\nFROM node:24.15.0-bookworm-slim AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci\nRUN ${buildCommand}\nFROM node:24.15.0-bookworm-slim\nWORKDIR /app\nCOPY --from=build /app /app\nENV NODE_ENV=production HOST=0.0.0.0 PORT=3000\nEXPOSE 3000\nCMD [\"node_modules/.bin/tsx\", ${JSON.stringify(config.server.entry)}]\n`;
  await writeFile(resolve(directory, 'Dockerfile'), dockerfile);
  await writeFile(resolve(directory, 'Dockerfile.dockerignore'), '.git\n**/node_modules\n.angular\n.cache\ntest-results\nplaywright-report\n.bridge-runtime.json\n.bridge-proxy.json\n.env\n.env.*\n');
  await writeFile(resolve(directory, 'compose.yaml'), `services:\n  mcp:\n    build:\n      context: ..\n      dockerfile: ${output}/Dockerfile\n    ports:\n      - \"3000:3000\"\n    environment:\n      ALLOWED_HOSTS: \"localhost,127.0.0.1\"\n      ALLOWED_ORIGINS: \"\"\n    restart: unless-stopped\n`);
  await writeFile(resolve(directory, 'README.md'), '# Container artifact\n\nBuild from the workspace root with the command in Dockerfile. The artifact has been generated from an existing multi-view build. Set ALLOWED_HOSTS and ALLOWED_ORIGINS for your actual HTTPS domain; add your authentication configuration before deployment. The image retains dev dependencies because the server runs TypeScript through tsx. Nothing is published by this command.\n');
  return directory;
}
