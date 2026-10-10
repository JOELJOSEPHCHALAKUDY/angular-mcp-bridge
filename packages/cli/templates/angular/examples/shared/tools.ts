import { defineTool, defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { z } from 'zod';

export const projectSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(),
  status: z.enum(['ready', 'in-progress', 'planned']), progress: z.number().min(0).max(100),
});
export const tools = defineTools({
  list_projects: defineTool({
    title: 'Project overview',
    description: 'Use this when the user wants to explore demo projects or filter them by status. Opens an interactive Angular project view.',
    input: z.object({ status: z.enum(['all', 'ready', 'in-progress', 'planned']).default('all') }),
    output: z.object({ projects: z.array(projectSchema), total: z.number(), filter: z.string() }),
    annotations: readOnlyAnnotations, view: 'projects',
  }),
  get_project: defineTool({
    title: 'Project details', description: 'Use this when the user asks for details about a specific demo project ID.',
    input: z.object({ id: z.string().min(1) }), output: z.object({ project: projectSchema }),
    annotations: readOnlyAnnotations,
  }),
});
export type DemoTools = typeof tools;
export type Project = z.infer<typeof projectSchema>;
