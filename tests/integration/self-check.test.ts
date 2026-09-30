/**
 * The installation self-check that the release pipeline runs against the
 * packaged application (`Dentiva Pro.exe --self-check`).
 *
 * The report has to be readable before anybody signs in — that is the whole
 * point of it — so it may not borrow a user's permissions, and it may not
 * change anything. Both properties are asserted here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCoreContainer } from '@core/container';
import { collectSelfCheck } from '@main/self-check';
import { LATEST_SCHEMA_VERSION } from '@core/db/schema';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, DEFAULT_TIME_ZONE } from '@shared/app-info';
import { createTestApp, type TestApp } from './harness';

const apps: TestApp[] = [];

function app(options: Parameters<typeof createTestApp>[0] = {}): TestApp {
  const created = createTestApp(options);
  apps.push(created);
  return created;
}

const runtime = { packaged: true, platform: 'win32', arch: 'x64', version: '1.0.0', build: '1000' };

async function completeSetup(test: TestApp): Promise<void> {
  const { setup } = test.services;
  await setup.saveClinic({
    name: 'Smile Dental Care',
    address: '12 Mirpur Road, Dhaka 1205',
    phone: '01711111111',
    email: 'frontdesk@example.com',
    website: '',
    logoSourcePath: null,
  });
  await setup.saveDentists([
    {
      name: 'Dr. Ayesha Rahman',
      phone: '01722222222',
      email: '',
      registrationNumber: 'BDS-4471',
      visitingHours: 'Sat–Thu, 5–10 pm',
      isActive: true,
      isDefault: true,
      credentials: [
        {
          type: 'qualification',
          title: 'BDS',
          institution: 'Dhaka Dental College',
          year: 2016,
          sortOrder: 10,
          showOnPrescription: true,
        },
      ],
    },
  ]);
  setup.savePreferences({
    dateFormat: DEFAULT_DATE_FORMAT,
    timeFormat: DEFAULT_TIME_FORMAT,
    timeZone: DEFAULT_TIME_ZONE,
    numberGrouping: 'international',
    autoLockMinutes: 10,
    backupFolder: test.paths.backupsDir,
    backupIntervalDays: 7,
    defaultPrinterName: 'Microsoft Print to PDF',
  });
  await setup.createAdministrator({ username: 'owner', fullName: 'Clinic Owner', password: 'Clinic-Secret-2026' });
  setup.complete();
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.cleanup();
});

describe('installation self-check', () => {
  it('reports a healthy installation that has not been activated yet', () => {
    const test = app();
    const report = collectSelfCheck(test.container, runtime);

    expect(report.ok).toBe(true);
    expect(report.state).toBe('activation_required');
    expect(report.licenceActivated).toBe(false);
    expect(report.setupComplete).toBe(false);
    expect(report.databaseOk).toBe(true);
    expect(report.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(report.databaseFile).toBe(test.paths.databasePath);
    expect(report.integrityOk).toBe(true);
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.problems).toEqual([]);
    expect(report.packaged).toBe(true);
    expect(report.version).toBe('1.0.0');
    expect(report.build).toBe(1000);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs without a session even though the settings screen needs one', () => {
    const test = app();
    // The permission-carrying version of the same check must refuse…
    expect(() => test.container.services.system.integrityCheck()).toThrow();
    // …while the self-check, which runs before sign-in, still gets its report.
    expect(() => collectSelfCheck(test.container, runtime)).not.toThrow();
  });

  it('reports the ready clinic after activation and setup, and changes nothing', async () => {
    const test = app();
    test.activateLicense();
    // Activation alone is not a completed installation.
    const half = collectSelfCheck(test.container, runtime);
    expect(half.state).toBe('setup_required');
    expect(half.licenceActivated).toBe(true);
    expect(half.setupComplete).toBe(false);

    const db = test.container.db;
    const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;

    await completeSetup(test);
    const before = { patients: count('patients'), notifications: count('notifications'), audit: count('audit_logs') };

    const report = collectSelfCheck(test.container, runtime);
    expect(report.state).toBe('locked');
    expect(report.licenceActivated).toBe(true);
    expect(report.setupComplete).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.attachmentCount).toBe(0);

    // Reading the installation must not write to it: no audit entry, no extra
    // patient, no notification — the self-check is a report, not an event.
    expect(count('patients')).toBe(before.patients);
    expect(count('notifications')).toBe(before.notifications);
    expect(count('audit_logs')).toBe(before.audit);
  });
});

describe('an unusable data folder', () => {
  it('is refused, so the self-check can report a failure instead of a false success', () => {
    // The pipeline relies on this: a broken installation must end with exit code 1
    // and a report that names the problem, never a stack trace and never "ok".
    const root = mkdtempSync(path.join(tmpdir(), 'dentiva-blocked-'));
    const blocked = path.join(root, 'blocked');
    writeFileSync(blocked, 'not a folder', 'utf8');
    const dataDir = path.join(blocked, 'data');

    try {
      expect(() =>
        createCoreContainer({
          machineGuid: 'blocked-machine',
          paths: {
            root: dataDir,
            dataDir,
            databasePath: path.join(dataDir, 'dentiva.sqlite'),
            attachmentsDir: path.join(dataDir, 'attachments'),
            backupsDir: path.join(dataDir, 'backups'),
            logsDir: path.join(dataDir, 'logs'),
            configDir: path.join(dataDir, 'config'),
            tempDir: path.join(dataDir, 'tmp'),
            exportsDir: path.join(dataDir, 'exports'),
          },
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
