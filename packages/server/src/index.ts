import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { McpServer, createMcpHandler, isInputRequiredResult, type AuthInfo, type CallToolResult, type CreateMcpHandlerOptions, type InputRequiredResult, type McpServerOptions, type ServerContext, type ServerEventBus, type ServerNotifier } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpUiResourceCsp, McpUiResourcePermissions } from '@modelcontextprotocol/ext-apps';
import type { ToolDefinition, ToolInput, ToolParsedInput, ToolOutput, ToolRegistry } from '@angular-mcp-bridge/contracts';
import { AuthenticationError, bearerChallenge, evaluateSecuritySchemes, protectedResourceMetadataUrl, type OAuthProvider } from './auth.js';
import { captureToolError, installMiddleware, type MiddlewareEntry, type TelemetryObserver } from './middleware.js';
import { discoverSkills, registerSkills, type SkillsManifest } from './skills.js';
import { registerEvents, type EventDefinition, type EventDeliveryOptions } from './events.js';
import { configureEntrypointAuthorization } from './entrypoints.js';
import { createBridgeAssetMiddleware, type BridgeAssetOptions } from './assets.js';

export * from './auth.js';
export * from './content.js';
export * from './middleware.js';
export * from './form-input.js';
export * from './skills.js';
export * from './events.js';
export * from './entrypoints.js';
export * from './assets.js';
export { FileRef, FileEntrypointInput, defineFileViewerTool } from '@angular-mcp-bridge/contracts';
export { inputRequired, acceptedContent, createRequestStateCodec } from '@modelcontextprotocol/server';

export interface ViewDefinition {
  htmlPath?: string;
  /** Useful for adapters/tests that produce HTML without a temporary file. */
  html?: string;
  description: string;
  title?: string;
  prefersBorder?: boolean;
  domain?: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  meta?: Record<string, unknown>;
}
export interface ViewManifestEntry { name: string; uri: string; description: string; digest: string; bytes: number }
const viewHtmlCache = new Map<string, { mtimeMs: number; size: number; html: string }>();
/** The server is rebuilt per request, so avoid re-reading unchanged view files. */
async function readViewHtml(path: string): Promise<string> {
  const { mtimeMs, size } = await stat(path);
  const cached = viewHtmlCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.html;
  const html = await readFile(path, 'utf8');
  viewHtmlCache.set(path, { mtimeMs, size, html });
  return html;
}
const manifests = new WeakMap<McpServer, readonly ViewManifestEntry[]>();
export const getViewManifest = (server: McpServer): readonly ViewManifestEntry[] => manifests.get(server) ?? [];
export interface ToolResponse<O> {
  data: O;
  text?: string;
  content?: CallToolResult['content'];
  meta?: Record<string, unknown>;
  isError?: boolean;
}
export interface BridgeConstructionContext {
  /** Only pass an identity already verified by a trusted transport. */
  authInfo?: AuthInfo;
  requestInfo?: Request;
  notify?: ServerNotifier;
}
export interface BridgeRequestContext {
  signal: AbortSignal;
  requestId: string | number;
  sessionId?: string;
  locale?: string;
  userAgent?: string;
  meta: Readonly<Record<string, unknown>>;
  /** Deliberately excludes raw tokens and cookie/authorization headers. */
  auth?: { clientId: string; subject?: string; scopes: readonly string[]; claims: Readonly<Record<string, unknown>> };
  http?: { url: string; method: string; headers: Readonly<Record<string, string>> };
  /** Official SDK context for progress, custom notifications, input responses and verified request state. */
  sdk: ServerContext;
}
export type ToolHandlers<T extends ToolRegistry> = {
  -readonly [K in keyof T]: (input: ToolParsedInput<T[K]>, context: BridgeRequestContext) => ToolResponse<ToolOutput<T[K]>> | InputRequiredResult | Promise<ToolResponse<ToolOutput<T[K]>> | InputRequiredResult>;
};
export interface BridgeServerOptions<T extends ToolRegistry> {
  name: string;
  version?: string;
  instructions?: string;
  tools: T;
  handlers: ToolHandlers<T>;
  views: Record<string, ViewDefinition>;
  oauth?: OAuthProvider;
  middleware?: readonly MiddlewareEntry[];
  telemetry?: TelemetryObserver;
  skills?: SkillsManifest | { directory: string };
  events?: { definitions: readonly EventDefinition[]; delivery: EventDeliveryOptions };
  /** Official SDK options, including cache hints and integrity-protected requestState verification. */
  sdkOptions?: McpServerOptions;
  /** Register resources, prompts, custom methods and notifications through the official SDK. */
  configure?: (server: McpServer, context: BridgeConstructionContext) => void | Promise<void>;
}
const SAFE_HEADERS = ['accept', 'content-type', 'host', 'mcp-protocol-version', 'mcp-session-id', 'user-agent', 'accept-language'];
function requestContext(extra: ServerContext, construction: BridgeConstructionContext): BridgeRequestContext {
  const auth = extra.http?.authInfo ?? construction.authInfo;
  const request = extra.http?.req ?? construction.requestInfo;
  const meta = { ...extra.mcpReq._meta };
  const safeHeaders: Record<string, string> = {};
  for (const name of SAFE_HEADERS) {
    const value = request?.headers.get(name);
    if (value !== null && value !== undefined) safeHeaders[name] = value;
  }
  return {
    signal: extra.mcpReq.signal,
    requestId: extra.mcpReq.id,
    sessionId: extra.sessionId,
    locale: typeof meta['openai/locale'] === 'string' ? meta['openai/locale'] : request?.headers.get('accept-language')?.split(',')[0],
    userAgent: typeof meta['openai/userAgent'] === 'string' ? meta['openai/userAgent'] : request?.headers.get('user-agent') ?? undefined,
    meta: Object.freeze(meta),
    ...(auth ? {
      auth: {
        clientId: auth.clientId,
        subject: typeof auth.extra?.['subject'] === 'string' ? auth.extra['subject'] : undefined,
        scopes: Object.freeze([...auth.scopes]),
        claims: Object.freeze({ ...auth.extra }),
      },
    } : {}),
    ...(request ? { http: { url: request.url, method: request.method, headers: Object.freeze(safeHeaders) } } : {}),
    sdk: extra,
  };
}
/** HTML is hashed so hosts never reuse a stale resource after a rebuild. */
export async function createBridgeServer<T extends ToolRegistry>(options: BridgeServerOptions<T>, construction: BridgeConstructionContext = {}): Promise<McpServer> {
  if (!/^[a-zA-Z0-9._-]+$/.test(options.name)) throw new Error('Server name must be a URI-safe identifier.');
  const server = new McpServer({ name: options.name, version: options.version ?? '0.1.0' }, { ...options.sdkOptions, ...(options.instructions ? { instructions: options.instructions } : {}) });
  const identityMiddleware: MiddlewareEntry = { handle: async (_request, context, next) => {
    // The context is transport-owned. Explicit construction identity supplies in-process transport integrations.
    if (context && (construction.authInfo || construction.requestInfo)) context.http = { ...context.http, ...(construction.authInfo ? { authInfo: context.http?.authInfo ?? construction.authInfo } : {}), ...(construction.requestInfo ? { req: context.http?.req ?? construction.requestInfo } : {}) };
    return next();
  } };
  const securityDescriptorMiddleware: MiddlewareEntry = { filter: 'tools/list', handle: async (_request, _context, next) => {
    const result = await next() as { tools: Array<Record<string, unknown> & { _meta?: Record<string, unknown> }> };
    for (const tool of result.tools) {
      const schemes = tool._meta?.['securitySchemes'];
      if (schemes !== undefined && tool['securitySchemes'] === undefined) tool['securitySchemes'] = schemes;
    }
    return result;
  } };
  installMiddleware(server, [identityMiddleware, securityDescriptorMiddleware, ...options.middleware ?? []], options.telemetry);
  const resources = new Map<string, string>(), manifest: ViewManifestEntry[] = [];
  const displayMetadata = new Map<string, Record<string, unknown>>();
  for (const [name, definition] of Object.entries(options.tools)) {
    if (!definition.openai) continue;
    if (!definition.view) throw new Error(`Tool ${name} has OpenAI UI options without an Angular view.`);
    if (definition.openai.entrypoints?.some(entry => entry.type === 'global' || entry.type === 'thread') && !(await definition.input.safeParseAsync({})).success) throw new Error(`Tool ${name} has an entrypoint that opens with {}, but its input schema requires arguments.`);
    for (const entry of definition.openai.entrypoints ?? []) {
      if (entry.type === 'file' && (!entry.extensions.length || entry.extensions.some(extension => !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(extension)))) throw new Error(`Tool ${name} declares an invalid file extension.`);
      if (entry.type === 'global' && entry.quickAction) {
        const target = options.tools[entry.quickAction.target.name];
        if (!entry.quickAction.icons.length || !target || !(await target.input.safeParseAsync(entry.quickAction.target.arguments ?? {})).success) throw new Error(`Tool ${name} declares a quick action with an invalid target or arguments.`);
      }
    }
    const { availableDisplayModes, preferredDisplayMode } = definition.openai;
    if (preferredDisplayMode && availableDisplayModes && !availableDisplayModes.includes(preferredDisplayMode)) throw new Error(`Tool ${name} prefers an unavailable display mode.`);
    const viewMetadata = { ...(availableDisplayModes ? { availableDisplayModes } : {}), ...(preferredDisplayMode ? { preferredDisplayMode } : {}) };
    const previous = displayMetadata.get(definition.view);
    if (previous && JSON.stringify(previous) !== JSON.stringify(viewMetadata)) throw new Error(`Tools sharing view ${definition.view} must agree on its display modes.`);
    displayMetadata.set(definition.view, viewMetadata);
  }
  for (const [name, view] of Object.entries(options.views)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid view identifier: ${name}`);
    if (view.html === undefined && !view.htmlPath) throw new Error(`View ${name} needs htmlPath or html.`);
    const html = view.html ?? await readViewHtml(view.htmlPath!);
    const digest = createHash('sha256').update(html).digest('hex');
    const uri = `ui://${options.name}/${name}-${digest.slice(0, 16)}.html`;
    resources.set(name, uri); manifest.push(Object.freeze({ name, uri, description: view.description, digest: `sha256:${digest}`, bytes: Buffer.byteLength(html) }));
    const csp = view.csp ?? { connectDomains: [], resourceDomains: [] };
    const ui = { prefersBorder: view.prefersBorder ?? true, csp, ...(view.domain ? { domain: view.domain } : {}), ...(view.permissions ? { permissions: view.permissions } : {}) };
    const displayModes = displayMetadata.get(name);
    const openaiUi = displayModes ? { 'openai/ui': { ...(view.meta?.['openai/ui'] as Record<string, unknown> ?? {}), ...displayModes } } : {};
    const metadata = {
      ...view.meta,
      ui,
      ...openaiUi,
      'openai/widgetDescription': view.description,
      'openai/widgetPrefersBorder': view.prefersBorder ?? true,
      'openai/widgetCSP': { connect_domains: csp.connectDomains ?? [], resource_domains: csp.resourceDomains ?? [], ...(csp.frameDomains ? { frame_domains: csp.frameDomains } : {}) },
      ...(view.domain ? { 'openai/widgetDomain': view.domain } : {}),
    };
    registerAppResource(server, name, uri, { mimeType: RESOURCE_MIME_TYPE, description: view.description, title: view.title, _meta: metadata }, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: metadata }] }));
  }
  manifests.set(server, Object.freeze(manifest));
  for (const [name, definition] of Object.entries(options.tools)) {
    const uri = definition.view ? resources.get(definition.view) : undefined;
    if (definition.view && !uri) throw new Error(`Tool ${name} references an unregistered view: ${definition.view}`);
    if (!options.handlers[name]) throw new Error(`Tool ${name} has no handler.`);
    const schemes = definition.securitySchemes ?? (options.oauth ? [{ type: 'oauth2' as const }] : undefined);
    if (schemes?.some(scheme => scheme.type === 'oauth2') && !options.oauth && !construction.authInfo) throw new Error(`Tool ${name} declares OAuth without a configured provider.`);
    const openaiUi = definition.openai ? {
      'openai/ui': {
        ...(definition.meta?.['openai/ui'] as Record<string, unknown> ?? {}),
        ...(definition.openai.entrypoints ? { entrypoints: definition.openai.entrypoints } : {}),
        ...(definition.openai.preferredModelDisplayMode ? { preferredModelDisplayMode: definition.openai.preferredModelDisplayMode } : {}),
      },
    } : {};
    const metadata = {
      ...definition.meta,
      ...(schemes ? { securitySchemes: schemes } : {}),
      ...openaiUi,
      ...((uri || definition.visibility) ? { ui: { ...(uri ? { resourceUri: uri } : {}), ...(definition.visibility ? { visibility: definition.visibility } : {}) } } : {}),
      ...(uri ? { 'openai/outputTemplate': uri } : {}),
      ...(definition.invoking ? { 'openai/toolInvocation/invoking': definition.invoking } : {}),
      ...(definition.invoked ? { 'openai/toolInvocation/invoked': definition.invoked } : {}),
    };
    const config = { title: definition.title, description: definition.description, inputSchema: definition.input, outputSchema: definition.output, annotations: definition.annotations, icons: definition.icons, _meta: metadata };
    const callback = async (args: Record<string, unknown>, extra: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      const auth = extra.http?.authInfo ?? construction.authInfo;
      const denied = evaluateSecuritySchemes(schemes, auth, !!options.oauth);
      if (denied) return { isError: true, content: [{ type: 'text', text: denied.message }], _meta: { 'mcp/www_authenticate': [bearerChallenge(denied, auth?.resourceMetadataUrl ?? (options.oauth ? protectedResourceMetadataUrl((await options.oauth.resolve()).resource) : undefined))] } };
      try {
        const input = await definition.input.parseAsync(args) as ToolParsedInput<T[string]>;
        const response = await options.handlers[name](input, requestContext(extra, construction));
        if (isInputRequiredResult(response)) return response;
        const data = await definition.output.parseAsync(response.data);
        return { content: [...response.content ?? [], ...(response.text ? [{ type: 'text' as const, text: response.text }] : [])], structuredContent: data, ...(response.meta ? { _meta: response.meta } : {}), ...(response.isError ? { isError: true } : {}) };
      } catch (error) { captureToolError(extra, error); throw error; }
    };
    if (uri) registerAppTool(server, name, config, callback);
    else server.registerTool(name, config, callback);
  }
  if (options.skills) registerSkills(server, Array.isArray(options.skills) ? options.skills : await discoverSkills(options.skills.directory));
  if (options.events) registerEvents(server, options.events.definitions, options.events.delivery);
  if (options.oauth) configureEntrypointAuthorization(server, { securitySchemes: [{ type: 'oauth2' }], resourceMetadataUrl: protectedResourceMetadataUrl((await options.oauth.resolve()).resource) });
  await options.configure?.(server, construction);
  return server;
}

export interface HttpBridgeOptions {
  port?: number;
  hostname?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  workbenchPath?: string;
  /** Optional public, integrity-checked module assets; MCP origin/auth policies stay separate. */
  assets?: BridgeAssetOptions;
  /** Defaults to optional only when a tool explicitly permits noauth. */
  authentication?: 'required' | 'optional';
  handlerOptions?: CreateMcpHandlerOptions;
  /** Register application HTTP routes after security headers and before MCP handling. */
  configureApp?: (app: express.Express) => void;
}
export interface RunningBridge { server: Server; close(): Promise<void>; notify: ServerNotifier; bus: ServerEventBus }
export async function serveBridge<T extends ToolRegistry>(options: BridgeServerOptions<T>, httpOptions: HttpBridgeOptions = {}): Promise<RunningBridge> {
  const app = express(); app.disable('x-powered-by');
  const hostname = httpOptions.hostname ?? '127.0.0.1';
  if (!options.oauth && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    console.warn(`[angular-mcp-bridge] /mcp is bound to ${hostname} with no oauth provider configured; anyone who can reach it can call your tools.`);
  }
  const hosts = new Set(httpOptions.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']);
  app.use((req, res, next) => {
    const host = req.headers.host; let requestHostname = '';
    try { requestHostname = new URL(`http://${host}`).hostname; } catch { /* Reject malformed Host. */ }
    if (!hosts.has(requestHostname)) { res.status(403).json({ error: 'Host is not allowed. Configure allowedHosts for your deployment.' }); return; }
    next();
  });
  if (httpOptions.assets) app.use(httpOptions.assets.manifest.routePrefix, await createBridgeAssetMiddleware(httpOptions.assets));
  app.use((req, res, next) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false; try { sameOrigin = new URL(origin).host === host; } catch { /* Reject malformed Origin. */ }
      if (!sameOrigin && !httpOptions.allowedOrigins?.includes(origin)) { res.status(403).json({ error: 'Origin is not allowed.' }); return; }
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-protocol-version, mcp-session-id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, WWW-Authenticate');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; } next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', name: options.name, version: options.version ?? '0.1.0' }));
  const oauth = await options.oauth?.resolve();
  if (oauth) {
    const resource = new URL(oauth.resource);
    const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`;
    const metadataUrl = new URL(metadataPath, resource.origin).href;
    const metadata = { resource: oauth.resource, authorization_servers: oauth.authorizationServers, bearer_methods_supported: ['header'], ...(oauth.scopes ? { scopes_supported: oauth.scopes } : {}) };
    for (const path of new Set(['/.well-known/oauth-protected-resource', metadataPath])) app.get(path, (_req, res) => res.json(metadata));
    if (oauth.authorizationMetadata) app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(oauth.authorizationMetadata));
    const required = httpOptions.authentication === 'required' || httpOptions.authentication !== 'optional' && !Object.values(options.tools).some(tool => tool.securitySchemes?.some(scheme => scheme.type === 'noauth'));
    app.use('/mcp', async (req, res, next) => {
      const authorization = req.headers.authorization;
      if (!authorization && !required) { next(); return; }
      const token = /^Bearer ([^\s]+)$/i.exec(authorization ?? '')?.[1];
      try {
        if (!token) throw new AuthenticationError('invalid_token', 'A bearer access token is required.');
        const auth = await oauth.verifier.verifyAccessToken(token);
        if (auth.expiresAt !== undefined && auth.expiresAt <= Date.now() / 1000) throw new AuthenticationError('invalid_token', 'The access token has expired.');
        auth.resourceMetadataUrl ??= metadataUrl; auth.resource ??= resource;
        (req as express.Request & { auth: AuthInfo }).auth = auth; next();
      } catch (error) {
        const failure = error instanceof AuthenticationError ? error : new AuthenticationError('invalid_token', 'The access token is invalid.');
        res.setHeader('WWW-Authenticate', bearerChallenge(failure, metadataUrl)); res.status(failure.code === 'insufficient_scope' ? 403 : 401).json({ error: failure.code });
      }
    });
  }
  httpOptions.configureApp?.(app);
  const handler = createMcpHandler(context => createBridgeServer(options, { ...context, notify: handler.notify }), httpOptions.handlerOptions);
  const nodeHandler = toNodeHandler(handler);
  app.all('/mcp', async (req, res, next) => { try { await nodeHandler(req, res, req.body); } catch (error) { next(error); } });
  if (httpOptions.workbenchPath) app.use(express.static(httpOptions.workbenchPath));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(httpOptions.port ?? 3000, hostname, resolve); });
  return { server, notify: handler.notify, bus: handler.bus, close: async () => { await handler.close(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); } };
}
export type { ToolDefinition, ToolInput, ToolParsedInput, ToolOutput, ToolRegistry };
