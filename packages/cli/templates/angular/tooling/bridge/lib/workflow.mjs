/** Keep existing-app scripts intact and point bridge guidance at its own scripts. */
export function workflowCommands(manifest) {
  const command = name => `npm run ${manifest.scripts?.[`mcp:${name}`] ? `mcp:${name}` : name}`;
  return { dev: command('dev'), build: command('build'), start: command('start') };
}
