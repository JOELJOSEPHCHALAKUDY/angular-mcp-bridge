import type { McpUiHostCapabilities } from '@modelcontextprotocol/ext-apps';
export type HostProfile = 'standard' | 'limited' | 'chatgpt' | 'claude' | 'vscode';
export const hostProfiles: Record<HostProfile, { label: string; capabilities: McpUiHostCapabilities; modes: ('inline' | 'fullscreen' | 'pip')[] }> = {
  standard: { label: 'Standard capabilities', capabilities: { serverTools: {}, serverResources: { listChanged: true }, openLinks: {}, downloadFile: {}, message: { text: {}, image: {}, audio: {}, resource: {} }, updateModelContext: { text: {}, image: {}, resource: {} }, experimental: { 'openai/resource': {} } }, modes: ['inline', 'fullscreen', 'pip'] },
  limited: { label: 'Limited host · no messages', capabilities: { serverTools: {} }, modes: ['inline'] },
  chatgpt: { label: 'ChatGPT-shaped · simulation', capabilities: { serverTools: {}, serverResources: {}, openLinks: {}, downloadFile: {}, message: { text: {}, image: {}, resource: {} }, updateModelContext: { text: {}, resource: {} }, experimental: { 'openai/resource': {} } }, modes: ['inline', 'fullscreen', 'pip'] },
  claude: { label: 'Claude-shaped · simulation', capabilities: { serverTools: {}, serverResources: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {} } }, modes: ['inline', 'fullscreen'] },
  vscode: { label: 'VS Code-shaped · simulation', capabilities: { serverTools: {}, serverResources: {}, openLinks: {}, updateModelContext: { text: {} } }, modes: ['inline'] },
};
