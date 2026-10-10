// esbuild flattens Angular CLI output into standalone, CSP-compatible MCP resources.
// Existing v0.1 workspaces without markers retain dist/widget.html.
import { buildProject } from '../packages/cli/lib/commands.mjs';
await buildProject(process.cwd(), { bundleOnly: true });
