import { describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveBridge } from '@angular-mcp-bridge/server';
import { InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { ResourceSubscriptions } from '../apps/workbench/src/resource-subscriptions.js';
import { demoOptions } from '../examples/server/app.js';

describe('workbench resource subscriptions', () => {
  it('deduplicates modern streams and closes them when the view is replaced', async () => {
    const close = vi.fn(async () => {});
    const client = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      listen: vi.fn(async () => ({ honoredFilter: { resourceSubscriptions: ['bridge://note'] }, close, closed: new Promise<'local'>(() => {}) })),
      subscribeResource: vi.fn(), unsubscribeResource: vi.fn(),
    };
    const subscriptions = new ResourceSubscriptions(client);
    await Promise.all([subscriptions.subscribe('bridge://note'), subscriptions.subscribe('bridge://note')]);
    expect(client.listen).toHaveBeenCalledTimes(1);
    expect(client.subscribeResource).not.toHaveBeenCalled();
    await subscriptions.close(); await subscriptions.close(); expect(close).toHaveBeenCalledTimes(1);
  });
  it('uses the legacy methods for a legacy host and permits resubscription', async () => {
    const client = { getNegotiatedProtocolVersion: () => '2025-11-25', listen: vi.fn(),
      subscribeResource: vi.fn(async () => ({})), unsubscribeResource: vi.fn(async () => ({})) };
    const subscriptions = new ResourceSubscriptions(client);
    await subscriptions.subscribe('bridge://note'); await subscriptions.unsubscribe('bridge://note');
    await subscriptions.subscribe('bridge://note'); await subscriptions.close();
    expect(client.listen).not.toHaveBeenCalled();
    expect(client.subscribeResource).toHaveBeenCalledTimes(2); expect(client.unsubscribeResource).toHaveBeenCalledTimes(2);
  });
  it('receives a real modern HTTP resource notification and removes its stream', async () => {
    const options = demoOptions(); options.views = { projects: { html: '<html>Test</html>', description: 'Test view' } };
    options.configure = server => { server.server.registerCapabilities({ resources: { subscribe: true } }); };
    const bus = new InMemoryServerEventBus();
    const running = await serveBridge(options, { port: 0, handlerOptions: { bus } });
    const address = running.server.address(); if (!address || typeof address === 'string') throw new Error('No server port');
    const client = new Client({ name: 'subscription-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    const subscriptions = new ResourceSubscriptions(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const received = vi.fn(); client.setNotificationHandler('notifications/resources/updated', received);
      await subscriptions.subscribe('bridge://note');
      await running.notify.resourceUpdated('bridge://note');
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
      expect(received.mock.calls[0][0].params).toMatchObject({ uri: 'bridge://note' });
      await subscriptions.close();
      await vi.waitFor(() => expect(bus.listenerCount).toBe(0));
    } finally { await subscriptions.close(); await client.close(); await running.close(); }
  });
});
