/**
 * End-to-end test of the real desktop application.
 *
 * Playwright starts the built Electron bundle in a throw-away data folder and
 * drives the actual windows: the activation gate, the seven-step setup wizard,
 * sign-in and the dashboard. It then restarts the application over the same
 * folder to prove the activation and the clinic's records survive a restart —
 * the promise the offline licence model makes.
 *
 * The second test runs the same binary with `--self-check`, the flag the release
 * pipeline uses against the installed copy.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const mainEntry = path.join(root, 'dist', 'main', 'index.cjs');
const LICENSE_CODE = '1516591935015165';
const OWNER_PASSWORD = 'Ayesha-Clinic-2026';

/** The Electron executable inside node_modules, or null when it was not downloaded. */
function electronBinary(): string | null {
  const pathFile = path.join(root, 'node_modules', 'electron', 'path.txt');
  if (!existsSync(pathFile)) return null;
  const binary = path.join(root, 'node_modules', 'electron', 'dist', readFileSync(pathFile, 'utf8').trim());
  return existsSync(binary) ? binary : null;
}

function freshDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dentiva-app-e2e-'));
}

/**
 * Chromium switches a headless CI runner needs: no GPU, a small shared-memory
 * area, and a kernel that restricts the namespace sandbox. They are applied only
 * when `CI` is set, so a local run exercises exactly the shipped configuration.
 */
function ciSwitches(): string[] {
  return process.env.CI ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [];
}

// --- diagnostics ------------------------------------------------------------
//
// The release pipeline stores its logs where they cannot always be read back, so
// every run writes what it did and everything the application printed to
// `test-results/e2e-diagnostics.log`. A failing job turns that file into job
// annotations, which is what a maintainer actually reads.

const diagnosticsFile = path.join(root, 'test-results', 'e2e-diagnostics.log');
const diagnostics: string[] = [];

function note(message: string): void {
  diagnostics.push(`[${new Date().toISOString()}] ${message}`);
}

function watch(app: ElectronApplication): void {
  const child = app.process();
  child.stdout?.on('data', (chunk: Buffer) => diagnostics.push(`[stdout] ${String(chunk).trimEnd()}`));
  child.stderr?.on('data', (chunk: Buffer) => diagnostics.push(`[stderr] ${String(chunk).trimEnd()}`));
}

function flushDiagnostics(): void {
  mkdirSync(path.dirname(diagnosticsFile), { recursive: true });
  writeFileSync(diagnosticsFile, `${diagnostics.join('\n')}\n`, 'utf8');
}

async function launch(dataDir: string, extraArgs: string[] = []): Promise<ElectronApplication> {
  const args = [mainEntry, ...ciSwitches(), ...extraArgs];
  note(`launch: ${args.join(' ')}`);
  const app = await electron.launch({
    executablePath: electronBinary() ?? undefined,
    args,
    env: { ...process.env, DENTIVA_DATA_DIR: dataDir },
  });
  watch(app);
  return app;
}

async function signIn(window: Page, username: string, password: string): Promise<void> {
  await window.getByLabel(/^Username/).fill(username);
  await window.getByLabel(/^Password/).fill(password);
  await window.getByRole('button', { name: /Sign in/ }).click();
}

const binary = electronBinary();
test.skip(binary === null, 'The Electron binary is not installed; run npm install without --ignore-scripts.');
test.skip(!existsSync(mainEntry), 'The application has not been built; run npm run build first.');

test.describe('packaged desktop application', () => {
  let dataDir = '';
  let app: ElectronApplication | null = null;

  test.beforeEach(() => {
    dataDir = freshDataDir();
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = null;
    rmSync(dataDir, { recursive: true, force: true });
    flushDiagnostics();
  });

  test.afterAll(() => {
    flushDiagnostics();
  });

  test('activates, walks the setup wizard, signs in and survives a restart', async () => {
    note('step 1: launch and show the activation gate');
    app = await launch(dataDir);
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // 1. The activation gate refuses to open the clinic without the code.
    await expect(window.getByRole('heading', { name: /activation/i })).toBeVisible();
    await window.getByLabel(/Activation code/).fill('0000000000000000');
    await window.getByRole('button', { name: /Activate this device/ }).click();
    await expect(window.getByText(/not valid/i)).toBeVisible();

    note('step 2: the real activation code opens the setup wizard');
    // 2. The real code opens the setup wizard.
    await window.getByLabel(/Activation code/).fill(LICENSE_CODE);
    await window.getByRole('button', { name: /Activate this device/ }).click();
    await expect(window.getByText('Clinic profile')).toBeVisible();

    note('step 3: clinic profile');
    // 3. Clinic profile.
    await window.getByLabel(/^Clinic name/).fill('Smile Dental Care');
    await window.getByLabel(/^Phone/).fill('01711111111');
    await window.getByLabel(/^Address/).fill('12 Mirpur Road, Tangail');
    await window.getByRole('button', { name: /Save clinic profile/ }).click();
    await expect(window.getByText(/Clinic profile saved/i)).toBeVisible();
    await window.getByRole('button', { name: /Continue/ }).click();

    note('step 4: dentists');
    // 4. Dentists: one consultant with a qualification.
    await expect(window.getByText('Dentists', { exact: true }).first()).toBeVisible();
    await window
      .getByLabel(/^Full name/)
      .first()
      .fill('Dr. Ayesha Rahman');
    await window
      .getByLabel(/^Registration number/)
      .first()
      .fill('BDS-4471');
    await window.getByRole('button', { name: /Save dentists/ }).click();
    await expect(window.getByText(/Dentists saved/i)).toBeVisible();
    await window.getByRole('button', { name: /Continue/ }).click();

    note('step 5: preferences');
    // 5. Preferences keep their validated defaults.
    await expect(window.getByText('Save preferences')).toBeVisible();
    await window.getByRole('button', { name: /Save preferences/ }).click();
    await expect(window.getByText(/Preferences saved/i)).toBeVisible();
    await window.getByRole('button', { name: /Continue/ }).click();

    note('step 6: administrator account');
    // 6. The administrator account.
    await window.getByLabel(/^Username/).fill('owner');
    await window.getByLabel(/^Full name/).fill('Clinic Owner');
    await window.getByLabel(/^Password/).fill(OWNER_PASSWORD);
    await window.getByLabel(/^Repeat password/).fill(OWNER_PASSWORD);
    await window.getByRole('button', { name: /Create administrator/ }).click();
    await expect(window.getByText(/Administrator created/i)).toBeVisible();
    await window.getByRole('button', { name: /Continue/ }).click();

    note('step 7: review and finish');
    // 7. Review, then finish.
    await expect(window.getByText('Smile Dental Care').first()).toBeVisible();
    await window.getByRole('button', { name: /Continue/ }).click();
    await window.getByRole('button', { name: /Complete setup and open Dentiva Pro/ }).click();

    note('step 8: sign in');
    // 8. The clinic is configured: sign in with the account just created.
    await expect(window.getByText(/Sign in/i).first()).toBeVisible();
    await signIn(window, 'owner', OWNER_PASSWORD);
    await expect(window.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const database = path.join(dataDir, 'data', 'dentiva.sqlite');
    expect(existsSync(database)).toBe(true);

    note('step 9: restart over the same data folder');
    // 9. Restarting the machine does not ask for the code or the wizard again.
    await app.close();
    app = await launch(dataDir);
    const restarted = await app.firstWindow();
    await restarted.waitForLoadState('domcontentloaded');
    await expect(restarted.getByRole('heading', { name: /activation/i })).toHaveCount(0);
    await signIn(restarted, 'owner', OWNER_PASSWORD);
    await expect(restarted.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(restarted.getByText('Smile Dental Care').first()).toBeVisible();
  });

  test('--self-check reports a healthy installation and exits 0', async () => {
    note('self-check: launch with --self-check');
    const checked = await electron.launch({
      executablePath: electronBinary() ?? undefined,
      args: [mainEntry, ...ciSwitches(), '--self-check'],
      env: { ...process.env, DENTIVA_DATA_DIR: dataDir },
    });
    watch(checked);
    const child = checked.process();
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await checked.close().catch(() => undefined);
    note(`self-check exit ${String(exitCode)}: ${output.trim()}`);

    expect(output).toContain('"ok": true');
    expect(output).toContain('"databaseOk": true');
    expect(output).toContain('"integrityOk": true');
    expect(exitCode).toBe(0);
  });
});
