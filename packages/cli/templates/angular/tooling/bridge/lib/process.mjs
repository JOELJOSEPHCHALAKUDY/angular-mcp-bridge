import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve, delimiter } from 'node:path';

export async function choosePort(preferred, reserved = new Set(), probe = portAvailable) {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) throw new Error(`Invalid port: ${preferred}`);
  for (let port = preferred; port <= Math.min(65535, preferred + 1000); port++) {
    if (!reserved.has(port) && await probe(port)) { reserved.add(port); return port; }
  }
  throw new Error(`No available port near ${preferred}.`);
}
export async function portAvailable(port) {
  // Check both IP families: Angular's localhost binding can otherwise collide with IPv6 apps.
  async function check(host) {
    return new Promise(resolveProbe => {
      const server = createServer();
      server.once('error', error => resolveProbe(error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL'));
      server.listen({ host, port, exclusive: true }, () => server.close(() => resolveProbe(true)));
    });
  }
  return await check('127.0.0.1') && await check('::1');
}
export function spawnLocal(root, executable, args, options = {}) {
  const { env, ...rest } = options;
  return spawn(resolve(root, 'node_modules/.bin', executable), args, { cwd: root, stdio: 'inherit', ...rest, env: { ...process.env, ...env, PATH: `${resolve(root, 'node_modules/.bin')}${delimiter}${env?.PATH ?? process.env.PATH ?? ''}` } });
}
export async function runLocal(root, executable, args, options = {}) {
  const child = spawnLocal(root, executable, args, options);
  await new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${executable} ${args.join(' ')} failed (${signal ?? code}).`)));
  });
}
export async function waitForUrl(url, child, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Process exited before ${url} became ready.`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Await local build. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}
export function manageChildren(children) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const exited = children.map(child => new Promise(resolveExit => { if (child.exitCode !== null || child.signalCode) resolveExit(); else child.once('exit', resolveExit); }));
    for (const child of children) child.kill('SIGTERM');
    const timer = setTimeout(() => { for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 5000); timer.unref();
    await Promise.all(exited); clearTimeout(timer);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  };
  const onSignal = () => { void stop(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  return stop;
}
