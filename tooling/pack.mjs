import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('dist/tarballs', { recursive: true });
for (const directory of ['packages/contracts', 'packages/server', 'dist/angular', 'packages/testing', 'packages/cli']) {
  const result = spawnSync('npm', ['pack', '--cache', resolve('.cache/npm'), '--pack-destination', resolve('dist/tarballs')], { cwd: directory, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
