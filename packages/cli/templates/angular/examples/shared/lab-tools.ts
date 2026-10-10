import { defineTool, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { z } from 'zod';
const schemaInput = z.object({
  enabled: z.boolean(), limit: z.number().int().min(1).max(5),
  filters: z.object({ mode: z.enum(['all', 'ready']), tags: z.array(z.string().min(1)).default([]) }),
  advanced: z.union([z.literal('auto'), z.number().int().min(1)]).optional(),
});
export const labTools = {
  inspect_schema: defineTool({
    title: 'Angular input schema', description: 'Validate and echo schema-rich arguments for local input form inspection.',
    input: schemaInput, output: schemaInput, annotations: readOnlyAnnotations,
  }),
  open_lab: defineTool({
    title: 'Angular integration lab', description: 'Use this when the user wants to explore Angular MCP bridge capabilities, file resources, private selection, UI tools, or modal layouts. Opens a second standalone Angular view.',
    input: z.object({}), output: z.object({ message: z.string(), resource: z.string() }),
    annotations: readOnlyAnnotations, view: 'lab',
  }),
};
