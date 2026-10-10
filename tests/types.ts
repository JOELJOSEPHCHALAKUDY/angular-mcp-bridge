import { createToolClient } from '@angular-mcp-bridge/angular';
import type { ToolHandlers } from '@angular-mcp-bridge/server';
import { tools } from '../examples/shared/tools.js';
// Compile-only contract tests. These functions are never invoked.
function typedUsage() {
  const client = createToolClient(tools);
  client.inject('get_project').execute({ id: 'atlas' });
  // @ts-expect-error Tool names are inferred from the shared registry.
  client.inject('missing_tool');
  // @ts-expect-error Required tool input is checked.
  client.inject('get_project').execute({ wrong: 'atlas' });
  client.resource('list_projects', { params: () => ({ status: 'ready' }) });
}
const handlers: ToolHandlers<typeof tools> = {
  list_projects: () => ({ data: { projects: [], total: 0, filter: 'all' } }),
  // @ts-expect-error Handler output must conform to the shared schema.
  get_project: () => ({ data: { wrong: true } }),
};
void typedUsage; void handlers;
