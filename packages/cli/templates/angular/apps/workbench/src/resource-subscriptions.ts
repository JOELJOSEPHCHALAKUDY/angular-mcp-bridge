import type { Client } from '@modelcontextprotocol/client';

/** Translate the Apps extension into the negotiated MCP subscription protocol. */
export class ResourceSubscriptions {
  private readonly active = new Map<string, Promise<() => Promise<void>>>();
  constructor(private readonly client: Pick<Client, 'getNegotiatedProtocolVersion' | 'listen' | 'subscribeResource' | 'unsubscribeResource'>) {}
  async subscribe(uri: string): Promise<Record<string, never>> {
    let pending = this.active.get(uri);
    if (!pending) {
      pending = this.open(uri);
      this.active.set(uri, pending);
    }
    try { await pending; return {}; }
    catch (error) { if (this.active.get(uri) === pending) this.active.delete(uri); throw error; }
  }
  private async open(uri: string): Promise<() => Promise<void>> {
    const version = this.client.getNegotiatedProtocolVersion();
    if (version && version >= '2026-07-28') {
      const stream = await this.client.listen({ resourceSubscriptions: [uri] });
      if (!stream.honoredFilter.resourceSubscriptions?.includes(uri)) {
        await stream.close();
        throw new Error('The server did not accept this resource subscription.');
      }
      return () => stream.close();
    }
    await this.client.subscribeResource({ uri });
    return async () => { await this.client.unsubscribeResource({ uri }); };
  }
  async unsubscribe(uri: string): Promise<Record<string, never>> {
    const pending = this.active.get(uri); this.active.delete(uri);
    if (pending) await (await pending)();
    return {};
  }
  async close(): Promise<void> {
    const entries = [...this.active.values()]; this.active.clear();
    await Promise.allSettled(entries.map(async pending => { await (await pending)(); }));
  }
}
