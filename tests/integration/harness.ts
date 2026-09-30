/**
 * Integration-test harness.
 *
 * Builds the real core container against a throwaway folder on disk — a real
 * SQLite file, real migrations, real seeding, real Argon2id hashing — so the
 * tests exercise the same code paths the packaged application runs, without
 * needing Electron.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorePaths } from '@core/context';
import { createCoreContainer, type CoreContainer } from '@core/container';
import type { PrintHostPort } from '@core/services/print-service';
import { hashPassword } from '@core/security/password';
import { activationDigestForTests, activationSignature, machineFingerprint, machineIdentity } from '@core/security/activation';
import { createLogger } from '@core/util/logger';
import { APP_BUILD_NUMBER, APP_VERSION } from '@shared/app-info';
import { toInstant } from '@shared/dates';

export interface FakePrintHost extends PrintHostPort {
  /** HTML handed to the last render/print call, for assertions. */
  lastHtml: string;
  readonly jobs: Array<{ kind: 'pdf' | 'print'; jobName: string; printerName: string; copies: number }>;
}

export interface TestApp {
  readonly container: CoreContainer;
  readonly printHost: FakePrintHost;
  readonly paths: CorePaths;
  readonly root: string;
  readonly services: CoreContainer['services'];
  /** Stop the clock at a fixed instant (defaults to the real clock). */
  setNow(fixed: Date | null): void;
  /** Record the machine activation exactly as a licensed installation has it. */
  activateLicense(): void;
  /** Insert an owner without going through the RBAC guard (setup wizard path). */
  bootstrapOwner(input?: { username?: string; password?: string; fullName?: string }): Promise<number>;
  /** Start a session for a user that already exists. */
  signIn(userId: number): void;
  cleanup(): void;
}

export function createTestPaths(root: string): CorePaths {
  const paths: CorePaths = {
    root,
    dataDir: join(root, 'data'),
    databasePath: join(root, 'data', 'dentiva.sqlite'),
    attachmentsDir: join(root, 'attachments'),
    backupsDir: join(root, 'backups'),
    logsDir: join(root, 'logs'),
    configDir: join(root, 'config'),
    tempDir: join(root, 'temp'),
    exportsDir: join(root, 'exports'),
  };
  for (const directory of [
    paths.dataDir,
    paths.attachmentsDir,
    paths.backupsDir,
    paths.logsDir,
    paths.configDir,
    paths.tempDir,
    paths.exportsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return paths;
}

/** Write the activation record the way a licensed installation has it. */
function writeActivation(container: CoreContainer, at: Date): void {
  const activatedAt = toInstant(at);
  const machineHash = machineFingerprint(machineIdentity('TEST-MACHINE-GUID-0001'));
  container.db
    .prepare(
      `INSERT INTO activation (id, activated_at, code_hash, machine_hash, signature, attempts, last_error)
       VALUES (1, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT (id) DO UPDATE SET activated_at = excluded.activated_at, code_hash = excluded.code_hash,
         machine_hash = excluded.machine_hash, signature = excluded.signature, attempts = 0, last_error = NULL`,
    )
    .run(activatedAt, activationDigestForTests(), machineHash, activationSignature(activationDigestForTests(), machineHash, activatedAt));
  container.services.settings.saveSetupStep('activation', true, 1);
}

export function createTestApp(options: { seed?: boolean; logToFile?: boolean; keepFolder?: boolean } = {}): TestApp {
  const root = mkdtempSync(join(tmpdir(), 'dentiva-it-'));
  const paths = createTestPaths(root);
  const logger = options.logToFile
    ? createLogger({ directory: paths.logsDir, minLevel: 'debug', mirrorToConsole: false })
    : createLogger({ directory: paths.logsDir, minLevel: 'error' });

  let now: Date | null = null;
  let renderedFiles = 0;

  const printHost: FakePrintHost = {
    lastHtml: '',
    jobs: [],
    listPrinters: async () => [
      {
        name: 'Dentiva-Test-Printer',
        displayName: 'Dentiva Test Printer',
        description: 'Fake printer',
        status: 0,
        isDefault: true,
        options: {},
      },
      {
        name: 'Microsoft Print to PDF',
        displayName: 'Microsoft Print to PDF',
        description: 'PDF writer',
        status: 0,
        isDefault: false,
        options: {},
      },
    ],
    toPdf: async (html, printOptions) => {
      printHost.lastHtml = html;
      printHost.jobs.push({
        kind: 'pdf',
        jobName: printOptions.jobName,
        printerName: printOptions.printerName,
        copies: printOptions.copies,
      });
      renderedFiles += 1;
      const path = join(paths.tempDir, `render-${renderedFiles}.pdf`);
      writeFileSync(path, '%PDF-1.4 fake render for tests');
      return { path, pageCount: 1, bytes: 32 };
    },
    send: async (html, printOptions) => {
      printHost.lastHtml = html;
      printHost.jobs.push({
        kind: 'print',
        jobName: printOptions.jobName,
        printerName: printOptions.printerName,
        copies: printOptions.copies,
      });
      return { pageCount: 1, bytes: 32 };
    },
    reveal: async () => undefined,
  };

  const container = createCoreContainer({
    paths,
    machineGuid: 'TEST-MACHINE-GUID-0001',
    appVersion: APP_VERSION,
    appBuild: APP_BUILD_NUMBER,
    logger,
    now: () => now ?? new Date(),
    seed: options.seed !== false,
    printHost,
  });

  const app: TestApp = {
    container,
    printHost,
    paths,
    root,
    services: container.services,
    setNow: (fixed) => {
      now = fixed;
    },
    activateLicense: () => writeActivation(container, now ?? new Date()),
    bootstrapOwner: async (input) => {
      const username = input?.username ?? 'owner';
      const password = input?.password ?? 'OwnerPass123';
      const fullName = input?.fullName ?? 'Clinic Owner';
      const passwordHash = await hashPassword(password);
      const ownerRoleId = container.services.users.roleIdByKey('owner');
      if (ownerRoleId === null) throw new Error('Owner role was not seeded.');
      const timestamp = toInstant(now ?? new Date());
      const result = container.db
        .prepare(
          `INSERT INTO users (username, password_hash, full_name, email, phone, is_active, must_change_password,
             failed_attempts, created_at, updated_at, last_password_change_at)
           VALUES (?, ?, ?, '', '', 1, 0, 0, ?, ?, ?)`,
        )
        .run(username, passwordHash, fullName, timestamp, timestamp, timestamp);
      const userId = Number(result.lastInsertRowid);
      container.db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(userId, ownerRoleId);
      // A clinic copy of Dentiva Pro is activated before it is set up.
      writeActivation(container, now ?? new Date());
      return userId;
    },
    signIn: (userId) => {
      container.session.start(container.services.users.buildSessionUser(userId));
    },
    cleanup: () => {
      try {
        container.close();
      } catch {
        // Already closed by the test.
      }
      if (!options.keepFolder) rmSync(root, { recursive: true, force: true });
    },
  };

  return app;
}

/** Register a patient through the service layer (used by several suites). */
export function createPatient(
  app: TestApp,
  overrides: Partial<Parameters<TestApp['services']['patients']['create']>[0]> = {},
): { id: number; code: string } {
  return app.services.patients.create({
    firstName: 'Test',
    lastName: 'Patient',
    gender: 'male',
    dob: null,
    ageYears: 30,
    bloodGroup: 'unknown',
    phone: '01700000000',
    alternatePhone: '',
    email: '',
    address: 'Dhaka',
    city: 'Dhaka',
    emergencyContactName: '',
    emergencyPhone: '',
    chiefComplaint: '',
    previousProblems: '',
    medicalNotes: '',
    allergies: '',
    notes: '',
    preferredContact: 'mobile',
    status: 'active',
    referredBy: '',
    tagIds: [],
    ...overrides,
  });
}
