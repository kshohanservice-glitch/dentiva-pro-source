/**
 * `npm run dev` — one command that starts both halves of the development setup:
 *
 *   1. the core services (real SQLite database) behind an HTTP bridge on 4319,
 *   2. the Vite dev server for the renderer on 5173, which proxies `/api` to the
 *      bridge.
 *
 * Opening http://localhost:5173 therefore gives the complete application in a
 * browser: real data, real permissions, real printing pipeline. The packaged
 * application replaces the bridge with Electron IPC and needs neither process.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = process.env.DENTIVA_DEV_BRIDGE_PORT ?? '4319';

const children = [];

function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Dentiva Pro — development mode');
console.log(`  core bridge : http://127.0.0.1:${port}`);
console.log('  renderer    : http://localhost:5173');

run('core', 'npx', ['vite-node', '--config', 'vitest.config.ts', 'tools/dev-bridge.mts'], {
  DENTIVA_DEV_BRIDGE_PORT: port,
});
run('ui', 'npx', ['vite', '--config', 'vite.config.renderer.ts'], {
  DENTIVA_DEV_BRIDGE_PORT: port,
});
