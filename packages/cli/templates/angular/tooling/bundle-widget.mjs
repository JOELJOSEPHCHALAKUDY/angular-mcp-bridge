// esbuild standalone Angular resource bundler
import { buildProject } from './bridge/lib/commands.mjs';
await buildProject(process.cwd(), { bundleOnly: true });
