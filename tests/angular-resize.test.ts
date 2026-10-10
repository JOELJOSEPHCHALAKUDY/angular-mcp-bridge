import { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransport } from '../packages/angular/src/transport.js';

let observed: { callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
let frames: Map<number, FrameRequestCallback>, frameSequence: number, measuredHeight: number;
let root: { style: { height: string }; getBoundingClientRect(): { height: number } };
let sendSize: ReturnType<typeof vi.spyOn>;
function flushFrame(): FrameRequestCallback {
  const [id, callback] = [...frames][0]; frames.delete(id); callback(0); return callback;
}
beforeEach(() => {
  observed = []; frames = new Map(); frameSequence = 0; measuredHeight = 230.1;
  root = { style: { height: '100%' }, getBoundingClientRect: () => ({ height: measuredHeight }) };
  vi.stubGlobal('document', { documentElement: root, body: {} });
  vi.stubGlobal('window', { innerWidth: 479.3 });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = ++frameSequence; frames.set(id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) { observed.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
  });
  vi.spyOn(App.prototype, 'connect').mockResolvedValue();
  vi.spyOn(App.prototype, 'close').mockImplementation(async function(this: App) { this.onclose?.(); });
  sendSize = vi.spyOn(App.prototype, 'sendSizeChanged').mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Angular transport resize lifetime', () => {
  it('disconnects the observer and cancels queued frames before closing the SDK transport', async () => {
    const app = createTransport({ name: 'resize-test' }); await app.connect();
    expect(observed).toHaveLength(1); expect(observed[0].observe).toHaveBeenCalledTimes(2);
    const queued = [...frames.values()][0];
    await app.close();
    expect(observed[0].disconnect).toHaveBeenCalledOnce(); expect(cancelAnimationFrame).toHaveBeenCalled(); expect(frames.size).toBe(0);
    // Browser callbacks already queued for execution may still run after cancellation/disconnect.
    queued(0); observed[0].callback([], {} as ResizeObserver);
    expect(sendSize).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
  });
  it('coalesces size changes, restores document style and cleans up on remote close', async () => {
    const app = createTransport({ name: 'resize-test' }), closed = vi.fn(); app.onclose = closed; await app.connect();
    flushFrame(); expect(sendSize).toHaveBeenCalledWith({ width: 480, height: 231 }); expect(root.style.height).toBe('100%');
    observed[0].callback([], {} as ResizeObserver); observed[0].callback([], {} as ResizeObserver);
    expect(frames.size).toBe(1); flushFrame(); expect(sendSize).toHaveBeenCalledOnce();
    measuredHeight = 300; observed[0].callback([], {} as ResizeObserver); const queued = [...frames.values()][0];
    app.onclose?.(); queued(0);
    expect(closed).toHaveBeenCalledOnce(); expect(observed[0].disconnect).toHaveBeenCalledOnce(); expect(sendSize).toHaveBeenCalledOnce();
  });
  it('does not install observers when close wins a pending handshake', async () => {
    let finishHandshake!: () => void;
    vi.mocked(App.prototype.connect).mockImplementationOnce(() => new Promise<void>(resolve => { finishHandshake = resolve; }));
    const app = createTransport({ name: 'resize-test' }); const connecting = app.connect();
    await app.close(); finishHandshake(); await connecting;
    expect(observed).toHaveLength(0); expect(frames.size).toBe(0); expect(sendSize).not.toHaveBeenCalled();
  });
  it('handles a notification rejection after teardown without reporting a stale error', async () => {
    let rejectSend!: (error: Error) => void;
    sendSize.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const app = createTransport({ name: 'resize-test' }), error = vi.fn(); app.onerror = error; await app.connect(); flushFrame();
    await app.close(); rejectSend(new Error('Not connected')); await Promise.resolve();
    expect(error).not.toHaveBeenCalled(); expect(observed[0].disconnect).toHaveBeenCalledOnce();
  });
});
