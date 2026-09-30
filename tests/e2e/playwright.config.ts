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
import path from 'node:path';
import process from 'node:process';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // Playwright clears its output folder before every run, so it must not be the
  // `test-results` folder itself: the CI job keeps its step transcripts and the
  // suite's diagnostics there and they have to survive. The path is absolute so
  // the artifacts land in the repository's `test-results` folder whoever starts
  // the suite, instead of beside this config file.
  outputDir: path.join(process.cwd(), 'test-results', 'playwright'),
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // `list` keeps the terminal transcript readable; `html` leaves a browsable
  // report that the pipeline uploads, so a failure can be inspected after the run.
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'off',
    video: 'off',
  },
});
