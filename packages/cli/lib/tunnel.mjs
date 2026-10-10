import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { manageChildren } from './process.mjs';

export function parseTunnelLine(provider, line) {
  let candidate;
  if (provider === 'cloudflared') candidate = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
  else if (provider === 'ngrok') {
    try { const event = JSON.parse(line); if (event.msg === 'started tunnel' && event.url?.startsWith('https://')) candidate = event.url; } catch { /* Plain terminal output. */ }
    candidate ??= line.match(/url=(https:\/\/[^\s"']+)/)?.[1];
  }
  if (!candidate) return null;
  try { const url = new URL(candidate); if (url.protocol !== 'https:' || url.username || url.password) return null; return url.origin; } catch { return null; }
}
export function tunnelArguments(provider, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Tunnel port must be between 1 and 65535.');
  if (provider === 'cloudflared') return ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
  if (provider === 'ngrok') return ['http', `http://127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json'];
  throw new Error('Tunnel provider must be cloudflared or ngrok. Install and configure its executable first.');
}
export async function openTunnel(provider, port, options = {}) {
  const args = tunnelArguments(provider, port);
  const child = (options.spawn ?? spawn)(provider, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = manageChildren([child]); let errorText = '';
  let url;
  try {
    url = await new Promise((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Tunnel connection timed out. ${errorText}`)), options.timeout ?? 60000);
      const finish = value => { clearTimeout(timeout); resolveUrl(value); };
      const fail = error => { clearTimeout(timeout); reject(error); };
      child.once('error', error => fail(new Error(error.code === 'ENOENT' ? `${provider} is not installed or is not on PATH. Install the provider, then retry.` : error.message)));
      child.once('exit', code => fail(new Error(`${provider} exited before connecting (${code}). ${errorText}`)));
      for (const stream of [child.stdout, child.stderr].filter(Boolean)) {
        const lines = createInterface({ input: stream });
        lines.on('line', line => {
          const parsed = parseTunnelLine(provider, line);
          if (parsed) finish(parsed); else errorText = (errorText + '\n' + line).slice(-1500);
          if (options.verbose) console.log(line);
        });
        child.once('exit', () => lines.close());
      }
    });
    console.log(`Public MCP URL: ${url}/mcp\nConfigure ALLOWED_HOSTS with ${new URL(url).hostname} on the local server. The tunnel uses the provider's installed credentials and policy.`);
    if (options.onReady) await options.onReady(url);
    await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => code === 0 || child.signalCode ? resolveExit() : reject(new Error(`${provider} exited (${code}). ${errorText}`))); });
  } finally { await stop(); }
  return url;
}
