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
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Playwright loads this file as CommonJS, so `import.meta` is not available — with
 * it the whole suite fails to load ("Cannot use 'import.meta' outside a module")
 * and reports "No tests found", which is worse than any assertion failure. The
 * suite is run from the repository root by `npm run test:e2e:electron`, and the
 * manifest check below turns a wrong working directory into a loud failure
 * instead of a silently skipped suite.
 */
const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string };
if (manifest.name !== 'dentiva-pro') {
  throw new Error(`The packaged-application suite must run from the repository root; it was started in ${root}.`);
}

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

/** Append one line, so nothing is lost when a run dies mid-test. */
function record(line: string): void {
  mkdirSync(path.dirname(diagnosticsFile), { recursive: true });
  appendFileSync(diagnosticsFile, `${line}\n`, 'utf8');
}

function note(message: string): void {
  record(`[${new Date().toISOString()}] ${test.info().title} · ${message}`);
}

function watch(app: ElectronApplication): void {
  const child = app.process();
  child.stdout?.on('data', (chunk: Buffer) => record(`[stdout] ${String(chunk).trimEnd()}`));
  child.stderr?.on('data', (chunk: Buffer) => record(`[stderr] ${String(chunk).trimEnd()}`));
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

/**
 * Run the application in its self-check mode and return its exit code and output.
 *
 * The application prints the report and exits immediately, which is exactly what
 * Playwright's Electron API cannot drive: the process is gone before the debugger
 * attaches. Spawning the same binary with the same arguments is the same test the
 * release pipeline performs on a freshly installed copy.
 */
async function runSelfCheck(
  dataDir: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string }> {
  const executable = electronBinary();
  if (!executable) throw new Error('The Electron binary is not installed.');
  const child = spawn(executable, [mainEntry, ...ciSwitches(), '--self-check', ...args], {
    env: { ...process.env, DENTIVA_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    record(`[stderr] ${String(chunk).trimEnd()}`);
  });
  const code = await new Promise<number | null>((resolve) => child.on('exit', (value) => resolve(value)));
  return { code, stdout };
}

const binary = electronBinary();
if (process.env.CI && binary === null) {
  // Skipping in CI would report a green suite that never opened the application.
  throw new Error('The Electron binary is not installed, so the packaged application cannot be tested.');
}
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
    // The reason stays on screen, including how many attempts are left.
    await expect(window.getByText(/not valid/i).first()).toBeVisible();
    await expect(window.getByText(/attempt/i).first()).toBeVisible();

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
    // The self-check is a command, not a window: driving it through Playwright's
    // Electron API fails, because the application exits before Playwright can
    // attach to the debugger. It is started the way the pipeline starts it.
    note('self-check: --self-check and --self-check-file');
    const reportFile = path.join(dataDir, 'self-check.json');
    const { code, stdout } = await runSelfCheck(dataDir, [`--self-check-file=${reportFile}`]);
    note(`self-check exit ${String(code)}: ${stdout.trim()}`);

    expect(stdout).toContain('"ok": true');
    expect(stdout).toContain('"databaseOk": true');
    expect(stdout).toContain('"integrityOk": true');
    expect(stdout).toContain('"version": "1.0.0"');
    expect(code).toBe(0);

    // A packaged Windows build cannot rely on stdout, so the same report must be
    // written to the file the pipeline asks for.
    expect(existsSync(reportFile)).toBe(true);
    const written = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, unknown>;
    expect(written.ok).toBe(true);
    expect(written.databaseOk).toBe(true);
    expect(written.integrityOk).toBe(true);
    // This suite runs the built bundle without an installer, so `packaged` is
    // false here; the installed copy is the one that must report true, and the
    // Windows job asserts exactly that.
    expect(written.packaged).toBe(false);
  });

  test('the self-check honours DENTIVA_SELF_CHECK_FILE and reports a broken installation', async () => {
    // The release pipeline reads the report through the environment variable: on
    // Windows a packaged GUI build cannot rely on its standard output, and the
    // platform does not always pass command-line switches through to `process.argv`.
    note('self-check: healthy run through DENTIVA_SELF_CHECK_FILE');
    const envReport = path.join(dataDir, 'env-self-check.json');
    const healthy = await runSelfCheck(dataDir, [], { DENTIVA_SELF_CHECK_FILE: envReport });

    expect(healthy.code).toBe(0);
    expect(existsSync(envReport)).toBe(true);
    const healthyReport = JSON.parse(readFileSync(envReport, 'utf8')) as Record<string, unknown>;
    expect(healthyReport.ok).toBe(true);

    // A data folder that cannot exist (its parent is a file) must produce a
    // readable failure report and a non-zero exit code, never a crash.
    note('self-check: broken data folder must be reported');
    const blocked = path.join(dataDir, 'blocked');
    writeFileSync(blocked, 'not a folder', 'utf8');
    const brokenReport = path.join(dataDir, 'broken-self-check.json');
    const broken = await runSelfCheck(path.join(blocked, 'data'), [], {
      DENTIVA_SELF_CHECK_FILE: brokenReport,
    });

    expect(broken.code).toBe(1);
    expect(existsSync(brokenReport)).toBe(true);
    const brokenJson = JSON.parse(readFileSync(brokenReport, 'utf8')) as Record<string, unknown>;
    expect(brokenJson.ok).toBe(false);
    expect(String(brokenJson.error ?? '')).not.toBe('');
    note(`broken self-check reported: ${String(brokenJson.error)}`);
  });
});
