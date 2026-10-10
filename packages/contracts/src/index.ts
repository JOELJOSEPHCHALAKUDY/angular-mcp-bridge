import { z } from 'zod';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}
/** OAuth alternatives are OR'd and their scopes AND'd; noauth permits callers without credentials. */
export type SecurityScheme = { type: 'noauth' } | { type: 'oauth2'; scopes?: string[] };
export interface ToolIcon { src: string; mimeType?: string; sizes?: string[]; theme?: 'light' | 'dark' }
export interface OpenAIQuickAction { title: string; icons: [ToolIcon, ...ToolIcon[]]; target: { type: 'tool'; name: string; arguments?: Record<string, unknown> } }
export type OpenAIEntrypoint = { type: 'global'; quickAction?: OpenAIQuickAction } | { type: 'thread' } | { type: 'file'; extensions: string[] } | { type: 'settings'; searchTerms?: string[] };
export interface OpenAIToolUi {
  entrypoints?: OpenAIEntrypoint[];
  availableDisplayModes?: ('inline' | 'fullscreen')[];
  preferredDisplayMode?: 'inline' | 'fullscreen';
  preferredModelDisplayMode?: 'inline' | 'fullscreen';
}
export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
  /** View identifier, registered separately on the server. */
  view?: string;
  /** Declared in tools/list and enforced by the server before the handler runs. */
  securitySchemes?: SecurityScheme[];
  icons?: ToolIcon[];
  /** Host-specific metadata; reserved UI and security keys are set by the server. */
  meta?: Record<string, unknown>;
  visibility?: ('model' | 'app')[];
  invoking?: string;
  invoked?: string;
  openai?: OpenAIToolUi;
}
export type ToolRegistry = Record<string, ToolDefinition>;
export type ToolInput<T extends ToolDefinition> = z.input<T['input']>;
export type ToolParsedInput<T extends ToolDefinition> = z.output<T['input']>;
export type ToolOutput<T extends ToolDefinition> = z.output<T['output']>;
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(definition: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return definition;
}
export function defineTools<const T extends ToolRegistry>(tools: T): T { return tools; }
export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};
/** Host-managed file reference. Fetching a download URL is an explicit application decision. */
export const FileRef = z.object({
  file_id: z.string().min(1), download_url: z.url(),
  mime_type: z.string().optional(), file_name: z.string().optional(),
});
export type FileRef = z.infer<typeof FileRef>;
export const FileEntrypointInput = z.object({ file: z.object({ name: z.string().min(1), resourceUri: z.string().trim().min(1) }) });
export type FileEntrypointInput = z.output<typeof FileEntrypointInput>;
/** Typed shared contract for an Angular file viewer; register its view and handler normally. */
export function defineFileViewerTool<O extends z.ZodObject>(definition: Omit<ToolDefinition<typeof FileEntrypointInput, O>, 'input' | 'openai'> & { extensions: string[]; openai?: Omit<OpenAIToolUi, 'entrypoints'> }): ToolDefinition<typeof FileEntrypointInput, O> {
  if (!definition.extensions.length || definition.extensions.some(extension => !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(extension))) throw new Error('File extensions must start with a dot and contain a file suffix.');
  if (!definition.view) throw new Error('A file viewer needs an Angular view identifier.');
  const { extensions, openai, ...tool } = definition;
  return { ...tool, input: FileEntrypointInput, openai: { ...openai, entrypoints: [{ type: 'file', extensions }] } };
}
