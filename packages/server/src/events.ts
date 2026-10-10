import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { INVALID_PARAMS, McpServer, ProtocolError, type ServerCapabilities, type ServerContext } from '@modelcontextprotocol/server';

export interface EventSubscription { id: string; url: string; secret: string; expiresAt: Date }
export interface EventOccurrence { name: string; id: string; timestamp?: Date; data: unknown }
export type EventDeliveryResult = { ok: true } | { ok: false; reason: string; retryable: boolean; status?: number };
/** Provisional event draft allocations; this experimental surface may evolve with the upstream proposal. */
export const EVENT_ERROR = { NotFound: -32023, Forbidden: -32024, Unsupported: -32026, CallbackEndpointError: -32027 } as const;
export interface EventDeliveryOptions {
  /** Exact callback origins explicitly trusted by this deployment. Redirects are never followed. */
  allowedOrigins: string[];
  /** Local test callbacks only; never enable on a public deployment. */
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
}
export interface EventDefinition<I extends z.ZodObject = z.ZodObject, P extends z.ZodObject = z.ZodObject> {
  name: string; description?: string; input?: I; payload: P; meta?: Record<string, unknown>;
  onSubscribe(input: z.output<I>, context: { subscription: EventSubscription; sdk: ServerContext }): void | Promise<void>;
  onUnsubscribe(input: z.output<I>, context: { subscription: Pick<EventSubscription, 'id'>; sdk: ServerContext }): void | Promise<void>;
}
export function defineEvent<I extends z.ZodObject, P extends z.ZodObject>(definition: EventDefinition<I, P>): EventDefinition<I, P> { return definition; }
/** Validate outgoing event payloads with the same schema advertised to subscribers. */
export function createEventPublisher<I extends z.ZodObject, P extends z.ZodObject>(definition: EventDefinition<I, P>, options: EventDeliveryOptions) {
  return (subscription: Parameters<typeof deliverEvent>[0], occurrence: { id: string; timestamp?: Date; data: z.input<P> }) =>
    deliverEvent(subscription, { ...occurrence, name: definition.name, data: definition.payload.parse(occurrence.data) }, options);
}
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(address, prefix, 'ipv6');
async function callbackAddress(raw: string, options: EventDeliveryOptions): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  const url = new URL(raw), host = url.hostname.replace(/^\[|\]$/g, '');
  const local = options.allowInsecureLocalhost && ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (url.username || url.password || url.hash || !options.allowedOrigins.includes(url.origin) || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('The webhook callback URL is not allowed.');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => blocked.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4') && !(local && ['127.0.0.1', '::1'].includes(item.address)))) throw new Error('Private and reserved webhook callback addresses are not allowed.');
  return { url, addresses };
}
function secretBytes(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Webhook secret must be whsec_ followed by base64.');
  const bytes = Buffer.from(secret.slice(6), 'base64');
  if (bytes.length < 24 || bytes.length > 64) throw new Error('Webhook secret must contain 24 to 64 bytes.');
  return bytes;
}
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}
async function signedPost(subscription: Pick<EventSubscription, 'id' | 'url'> & { secret: string | string[] }, id: string, body: string, options: EventDeliveryOptions): Promise<{ ok: boolean; body: string; status?: number; reason?: string }> {
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Webhook event exceeds the 256 KiB payload limit.');
  const target = await callbackAddress(subscription.url, options);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': [subscription.secret].flat().map(secret => signWebhook(secret, id, timestamp, body)).join(' '), 'x-mcp-subscription-id': subscription.id };
  return new Promise(resolve => {
    const request = (target.url.protocol === 'https:' ? https : http).request(target.url, { method: 'POST', headers, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      // Pin the validated DNS address for this delivery, including TLS hostname checks.
      lookup: (_hostname, lookupOptions, callback) => lookupOptions.all
        ? callback(null, target.addresses)
        : callback(null, target.addresses[0].address, target.addresses[0].family),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) response.destroy(new Error('Webhook response exceeds 64 KiB.')); else chunks.push(chunk); });
      response.on('end', () => resolve({ ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300, status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => resolve({ ok: false, body: '', reason: 'response_error' }));
    });
    request.on('error', error => resolve({ ok: false, body: '', reason: error.name === 'AbortError' ? 'timeout' : 'connection_error' }));
    request.end(body);
  });
}
/** Standard Webhooks signing and MCP event envelope. Durable retries and subscription storage belong to the application. */
export async function deliverEvent(subscription: Pick<EventSubscription, 'id' | 'url'> & { secret: string | string[]; expiresAt: Date | string }, occurrence: EventOccurrence, options: EventDeliveryOptions): Promise<EventDeliveryResult> {
  if (!(new Date(subscription.expiresAt).getTime() > Date.now())) return { ok: false, reason: 'expired', retryable: false };
  const result = await signedPost(subscription, occurrence.id, JSON.stringify({ eventId: occurrence.id, name: occurrence.name, timestamp: (occurrence.timestamp ?? new Date()).toISOString(), data: occurrence.data, cursor: null }), options);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? `http_${result.status}`, status: result.status, retryable: !result.status || result.status === 429 || result.status >= 500 };
}
function canonical(value: unknown): string { return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value); }
const keySchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(), delivery: z.object({ url: z.string() }) });
export function registerEvents(server: McpServer, definitions: readonly EventDefinition[], options: EventDeliveryOptions): void {
  const events = new Map(definitions.map(event => [event.name, event]));
  if (events.size !== definitions.length) throw new Error('Event names must be unique.');
  const resolve = (params: z.infer<typeof keySchema>, sdk: ServerContext) => {
    const auth = sdk.http?.authInfo;
    const principal = typeof auth?.extra?.['subject'] === 'string' ? auth.extra['subject'] : auth?.clientId;
    if (!principal) throw new ProtocolError(EVENT_ERROR.Forbidden, 'Event subscriptions require an authenticated caller.');
    const event = events.get(params.name); if (!event) throw new ProtocolError(EVENT_ERROR.NotFound, 'Unknown event.', { kind: 'event' });
    const checked = (event.input ?? z.object({})).safeParse(params.arguments ?? {});
    if (!checked.success) throw new ProtocolError(INVALID_PARAMS, 'Event arguments do not match the registered input schema.');
    const input = checked.data;
    let parsed: URL;
    try { parsed = new URL(params.delivery.url); } catch { throw new ProtocolError(INVALID_PARAMS, 'Invalid webhook callback URL.'); }
    const local = options.allowInsecureLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.hash || !options.allowedOrigins.includes(parsed.origin) || (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) throw new ProtocolError(INVALID_PARAMS, 'The webhook callback URL is not allowed.');
    const url = parsed.href;
    const id = `sub_${createHash('sha256').update(canonical([principal, url, event.name, input])).digest('hex').slice(0, 32)}`;
    return { event, input, id, url };
  };
  server.server.registerCapabilities({ events: {} } as ServerCapabilities);
  server.server.setRequestHandler('events/list', { params: z.object({ cursor: z.string().optional() }).optional() }, () => ({ events: definitions.map(event => ({ name: event.name, description: event.description, delivery: ['webhook'], inputSchema: z.toJSONSchema(event.input ?? z.object({})), payloadSchema: z.toJSONSchema(event.payload), ...(event.meta ? { _meta: event.meta } : {}) })) }));
  server.server.setRequestHandler('events/subscribe', { params: keySchema.extend({ delivery: z.object({ mode: z.string().optional(), url: z.string(), secret: z.string() }), ttlMs: z.number().nullable().optional(), cursor: z.string().nullable().optional() }) }, async (params, sdk) => {
    if (params.delivery.mode && params.delivery.mode !== 'webhook') throw new ProtocolError(EVENT_ERROR.Unsupported, 'Only webhook event delivery is supported.', { feature: 'deliveryMode', value: params.delivery.mode });
    const { event, input, id, url } = resolve(params, sdk);
    try { secretBytes(params.delivery.secret); } catch { throw new ProtocolError(INVALID_PARAMS, 'Webhook secret must be whsec_ followed by base64 of 24 to 64 bytes.'); }
    const maximumTtl = 24 * 60 * 60_000;
    const subscription: EventSubscription = { id, url, secret: params.delivery.secret, expiresAt: new Date(Date.now() + Math.min(maximumTtl, Math.max(60_000, params.ttlMs === null ? maximumTtl : params.ttlMs ?? 30 * 60_000))) };
    const challenge = randomBytes(24).toString('base64url');
    let delivery: Awaited<ReturnType<typeof signedPost>>;
    try { delivery = await signedPost(subscription, `verification_${randomBytes(12).toString('hex')}`, JSON.stringify({ type: 'verification', challenge }), options); }
    catch (error) { if (error instanceof Error && error.message.includes('addresses are not allowed')) throw new ProtocolError(INVALID_PARAMS, 'The webhook callback address is not allowed.'); throw new ProtocolError(EVENT_ERROR.CallbackEndpointError, 'Webhook verification failed.', { reason: 'connection_refused' }); }
    let echoed: unknown; try { echoed = JSON.parse(delivery.body)['challenge']; } catch { /* Reject invalid response. */ }
    if (!delivery.ok || typeof echoed !== 'string' || Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw new ProtocolError(EVENT_ERROR.CallbackEndpointError, 'Webhook verification failed.', { reason: delivery.ok ? 'challenge_failed' : delivery.reason === 'timeout' ? 'timeout' : delivery.status ? delivery.status >= 500 ? 'http_5xx' : 'http_4xx' : 'connection_refused' });
    await event.onSubscribe(input, { subscription, sdk });
    return { id, refreshBefore: subscription.expiresAt.toISOString(), cursor: null, truncated: false };
  });
  server.server.setRequestHandler('events/unsubscribe', { params: keySchema }, async (params, sdk) => {
    const { event, input, id } = resolve(params, sdk); await event.onUnsubscribe(input, { subscription: { id }, sdk }); return {};
  });
}
