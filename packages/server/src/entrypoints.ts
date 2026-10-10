import { z } from 'zod';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { FileEntrypointInput, type OpenAIToolUi, type SecurityScheme, type ToolIcon } from '@angular-mcp-bridge/contracts';
import { bearerChallenge, evaluateSecuritySchemes } from './auth.js';
import { captureToolError } from './middleware.js';
import type { ToolResponse } from './index.js';

interface SecurityOptions { securitySchemes?: SecurityScheme[]; resourceMetadataUrl?: string }
const policies = new WeakMap<McpServer, SecurityOptions>();
/** @internal Inherit the configured bridge's OAuth default in convenience registrations. */
export function configureEntrypointAuthorization(server: McpServer, options: SecurityOptions): void { policies.set(server, options); }
const security = (server: McpServer, options: SecurityOptions): SecurityOptions => ({ ...policies.get(server), ...options, securitySchemes: options.securitySchemes ?? policies.get(server)?.securitySchemes });
function secured(options: SecurityOptions, handler: (input: Record<string, unknown>, context: ServerContext) => Promise<CallToolResult | InputRequiredResult>) {
  return async (input: Record<string, unknown>, context: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
    const denied = evaluateSecuritySchemes(options.securitySchemes, context.http?.authInfo, false);
    if (denied) return { isError: true, content: [{ type: 'text', text: denied.message }], _meta: { 'mcp/www_authenticate': [bearerChallenge(denied, context.http?.authInfo?.resourceMetadataUrl ?? options.resourceMetadataUrl)] } };
    try { return await handler(input, context); } catch (error) { captureToolError(context, error); throw error; }
  };
}
function securityMeta(options: SecurityOptions): Record<string, unknown> { return options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}; }
export interface FileViewerConfig<O extends z.ZodObject> extends SecurityOptions {
  name: string; title?: string; description?: string;
  /** URI of a registered Angular UI resource. Shared-contract users should prefer defineFileViewerTool. */
  resourceUri: string;
  extensions: string[];
  output: O;
  icons?: ToolIcon[];
  preferredModelDisplayMode?: 'inline' | 'fullscreen';
}
/** Register a file entrypoint for an existing Angular view through configure(). */
export function registerFileViewer<O extends z.ZodObject>(server: McpServer, config: FileViewerConfig<O>, handler: (input: z.output<typeof FileEntrypointInput>, context: ServerContext) => ToolResponse<z.output<O>> | Promise<ToolResponse<z.output<O>>>): void {
  if (!config.resourceUri.startsWith('ui://') || !config.extensions.length || config.extensions.some(extension => !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(extension))) throw new Error('A file viewer needs a registered ui:// resource and dot-prefixed file extensions.');
  const authorization = security(server, config);
  const toolConfig = { title: config.title, description: config.description ?? 'Open a file in this application.', inputSchema: FileEntrypointInput, outputSchema: config.output, icons: config.icons,
    _meta: { ...securityMeta(authorization), ui: { resourceUri: config.resourceUri }, 'openai/ui': { entrypoints: [{ type: 'file', extensions: config.extensions }], ...(config.preferredModelDisplayMode ? { preferredModelDisplayMode: config.preferredModelDisplayMode } : {}) } },
  };
  registerAppTool(server, config.name, toolConfig, secured(authorization, async (input, context) => {
    const result = await handler(FileEntrypointInput.parse(input), context);
    return { content: [...result.content ?? [], ...(result.text ? [{ type: 'text' as const, text: result.text }] : [])], structuredContent: await config.output.parseAsync(result.data), ...(result.meta ? { _meta: result.meta } : {}), ...(result.isError ? { isError: true } : {}) };
  }));
}
const linkSchema = z.looseObject({ type: z.literal('resource_link'), uri: z.string().min(1), name: z.string().min(1), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional(), size: z.number().nonnegative().optional() });
export interface MentionsConfig extends SecurityOptions {
  name: string; description?: string;
  handler(input: { query: string }, context: ServerContext): { items: z.output<typeof linkSchema>[] } | Promise<{ items: z.output<typeof linkSchema>[] }>;
}
/** ChatGPT composer search, hidden from the model and validated as resource links. */
export function registerMentions(server: McpServer, config: MentionsConfig): void {
  const authorization = security(server, config);
  const input = z.object({ query: z.string() }), output = z.object({ items: z.array(linkSchema) });
  server.registerTool(config.name, { description: config.description ?? 'Search resources to mention.', inputSchema: input, outputSchema: output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ...securityMeta(authorization), 'openai/extensions': { 'mentions/search': {} }, ui: { visibility: ['app'] } },
  }, secured(authorization, async (params, context) => ({ content: [], structuredContent: output.parse(await config.handler(input.parse(params), context)) })));
}
export interface SettingsField { title: string; description?: string; schema: z.ZodType<string | number | boolean> }
export type SettingsValues<F extends Record<string, SettingsField>> = { -readonly [K in keyof F]-?: z.output<F[K]['schema']> };
export type SettingsLayout<F extends Record<string, SettingsField>> = { kind: 'group'; title: string; items: ({ kind: 'property'; property: Extract<keyof F, string> } | { kind: 'tool'; tool: string; title: string; description?: string })[] }[];
export interface SettingsConfig<F extends Record<string, SettingsField>> extends SecurityOptions {
  fields: F; layout?: SettingsLayout<F>; readTool?: string; updateTool?: string;
  read(context: ServerContext): SettingsValues<F> | Promise<SettingsValues<F>>;
  /** Changed fields only; return every current value after persistence. */
  update(set: Partial<SettingsValues<F>>, context: ServerContext): SettingsValues<F> | Promise<SettingsValues<F>>;
}
/** Strict primitive settings with explicit persistence callbacks and validated partial updates. */
export function registerSettings<F extends Record<string, SettingsField>>(server: McpServer, config: SettingsConfig<F>): void {
  const authorization = security(server, config);
  if (!Object.keys(config.fields).length) throw new Error('Settings must declare at least one field.');
  const readTool = config.readTool ?? 'settings.read', updateTool = config.updateTool ?? 'settings.update';
  if (readTool === updateTool) throw new Error('Settings read and update tools need different names.');
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(config.fields)) {
    if (field.schema.safeParse(undefined).success) throw new Error(`Setting ${name} must be required and cannot have a default.`);
    const schema = z.toJSONSchema(field.schema);
    if (!['boolean', 'string', 'number', 'integer'].includes(String(schema.type)) || schema.enum && schema.type !== 'string') throw new Error(`Setting ${name} must be a primitive or string enum.`);
    shape[name] = field.schema.meta({ title: field.title, ...(field.description ? { description: field.description } : {}) });
  }
  const placed = new Set<string>();
  for (const group of config.layout ?? []) for (const item of group.items) if (item.kind === 'property') {
    if (!Object.hasOwn(shape, item.property) || placed.has(item.property)) throw new Error(`Settings layout names an unknown or duplicate field ${item.property}.`);
    placed.add(item.property);
  }
  const values = z.strictObject(shape), { $schema: _schema, ...jsonSchema } = z.toJSONSchema(values);
  const readOutput = z.object({ schema: z.record(z.string(), z.unknown()), values, layout: z.array(z.record(z.string(), z.unknown())).optional() });
  server.registerTool(readTool, { description: 'Read application settings.', inputSchema: z.strictObject({}), outputSchema: readOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: securityMeta(authorization),
  }, secured(authorization, async (_input, context) => ({ content: [], structuredContent: { schema: jsonSchema, values: await values.parseAsync(await config.read(context)), ...(config.layout ? { layout: config.layout } : {}) } })));
  const patch = values.partial().refine(value => Object.keys(value).length > 0, 'A settings update must contain a changed field.').meta({ minProperties: 1 });
  server.registerTool(updateTool, { description: 'Update application settings.', inputSchema: z.strictObject({ set: patch }), outputSchema: z.object({ values }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: securityMeta(authorization),
  }, secured(authorization, async (input, context) => {
    const set = patch.parse(input['set']) as Partial<SettingsValues<F>>;
    return { content: [], structuredContent: { values: await values.parseAsync(await config.update(set, context)) } };
  }));
  const capability = { readTool, updateTool };
  server.server.registerCapabilities({ extensions: { 'openai/settings': capability }, experimental: { 'openai/settings': capability } });
}
export type { OpenAIToolUi };
