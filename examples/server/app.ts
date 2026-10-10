import { resolve } from 'node:path';
import { serveBridge, type BridgeServerOptions } from '@angular-mcp-bridge/server';
import { tools, type DemoTools, type Project } from '../shared/tools.js';

const projects: Project[] = [
  { id: 'atlas', name: 'Atlas workspace', description: 'A shared view of projects, milestones and team context.', status: 'ready', progress: 100 },
  { id: 'fieldnotes', name: 'Fieldnotes', description: 'Turn research conversations into a useful reading list.', status: 'in-progress', progress: 68 },
  { id: 'waypoint', name: 'Waypoint', description: 'Plan a trip together, one thoughtful stop at a time.', status: 'in-progress', progress: 42 },
  { id: 'studio', name: 'Studio library', description: 'Explore a collection of reusable creative assets.', status: 'planned', progress: 12 },
];
export function demoOptions(htmlPath = resolve('dist/widget.html')): BridgeServerOptions<DemoTools> {
  return {
    name: 'angular-mcp-bridge-demo', version: '0.1.0', tools,
    views: { projects: { htmlPath, description: 'An Angular project browser with status filters, project details and follow-up messages.' } },
    handlers: {
      list_projects: ({ status }) => ({ data: { projects: projects.filter(project => status === 'all' || project.status === status), total: projects.length, filter: status }, text: `Projects filtered by ${status}.` }),
      get_project: ({ id }) => {
        const project = projects.find(project => project.id === id);
        if (!project) throw new Error(`Unknown project: ${id}`);
        return { data: { project }, text: `${project.name}: ${project.description}` };
      },
    },
  };
}
export { serveBridge };
