/**
 * Playwright configuration for the packaged-application test.
 *
 * This suite drives the real Electron application — the built `dist/` bundle,
 * not a component harness — so it runs the packaged main process, the packaged
 * preload bridge and the packaged renderer.
 *
 * It needs the Electron binary, which the release pipeline installs. On a
 * machine where dependencies were installed with `--ignore-scripts` (or where
 * the Electron download was blocked) the suite skips itself instead of failing.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'off',
    video: 'off',
  },
});
