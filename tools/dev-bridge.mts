/**
 * Runs the Dentiva Pro core services over HTTP for the browser preview.
 *
 * Started by `npm run dev` (see tools/dev.mjs) and by the UI test harness.
 * It owns a real SQLite database in `.dentiva-dev/`, so what you click in the
 * browser behaves exactly like the packaged application.
 */
import { resolve } from 'node:path';
import { startDevBridge } from '../src/main/dev-bridge';

const port = Number(process.env['DENTIVA_DEV_BRIDGE_PORT'] ?? 4319);
const dataDir = resolve(process.env['DENTIVA_DEV_DATA'] ?? '.dentiva-dev');

const bridge = await startDevBridge({ port, dataDir, verbose: process.env['DENTIVA_DEV_VERBOSE'] === '1' });

async function shutdown(): Promise<void> {
  await bridge.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
