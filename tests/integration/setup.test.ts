/**
 * Setup, seeding, authentication and the audit trail, exercised against a real
 * SQLite file (no mocks, no Electron).
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { schemaVersion } from '@core/db/connection';
import { LATEST_SCHEMA_VERSION } from '@core/db/schema';
import { AppError } from '@shared/errors';
import { PASSWORD_MIN_LENGTH } from '@shared/constants';
import { ALL_PERMISSION_KEYS } from '@shared/permissions';
import { createTestApp, type TestApp } from './harness';

const apps: TestApp[] = [];

function app(options: Parameters<typeof createTestApp>[0] = {}): TestApp {
  const created = createTestApp(options);
  apps.push(created);
  return created;
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.cleanup();
});

describe('database bootstrap', () => {
  it('creates the schema at the latest migration version', () => {
    const test = app();
    expect(existsSync(test.paths.databasePath)).toBe(true);
    expect(schemaVersion(test.container.db)).toBe(LATEST_SCHEMA_VERSION);

    const tables = test.container.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toContain('patients');
    expect(names).toContain('invoices');
    expect(names).toContain('stock_movements');
    expect(names).toContain('patients_fts');
  });

  it('uses STRICT tables so a wrong value type is rejected by SQLite itself', () => {
    const test = app();
    expect(() =>
      test.container.db.prepare(`INSERT INTO sequences (name, value) VALUES (?, ?)`).run('bad_sequence', 'not-a-number'),
    ).toThrow();
  });

  it('is idempotent: re-running migrations changes nothing', () => {
    const test = app();
    const before = schemaVersion(test.container.db);
    const setup = test.container.services.settings.getSetupState();
    expect(before).toBe(LATEST_SCHEMA_VERSION);
    expect(setup.completedAt).toBeNull();
    expect(setup.activationComplete).toBe(false);
  });
});

describe('reference data seeding', () => {
  it('seeds catalogs, categories, printer profiles and templates', () => {
    const test = app();
    const db = test.container.db;
    const total = (table: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
      return row.total;
    };

    expect(total('roles')).toBeGreaterThanOrEqual(7);
    expect(total('payment_methods')).toBe(8);
    expect(total('medications')).toBe(18);
    expect(total('treatment_catalog')).toBe(23);
    expect(total('inventory_categories')).toBe(12);
    expect(total('accounting_categories')).toBe(18);
    expect(total('printer_profiles')).toBe(5);
    expect(total('print_templates')).toBe(4);
    expect(total('clinic')).toBe(1);

    const clinicalOptions = db
      .prepare(`SELECT category, COUNT(*) AS total FROM clinical_options GROUP BY category`)
      .all() as Array<{ category: string; total: number }>;
    expect(clinicalOptions.map((row) => row.category).sort()).toEqual(['advice', 'cc', 'oe', 're']);
    expect(clinicalOptions.reduce((sum, row) => sum + row.total, 0)).toBeGreaterThan(30);

    const ownerRole = db.prepare(`SELECT id FROM roles WHERE key = 'owner'`).get() as { id: number };
    const ownerPermissions = db.prepare(`SELECT COUNT(*) AS total FROM role_permissions WHERE role_id = ?`).get(ownerRole.id) as {
      total: number;
    };
    expect(ownerPermissions.total).toBe(ALL_PERMISSION_KEYS.length);
  });

  it('keeps a default printer profile for every document kind', () => {
    const test = app();
    const rows = test.container.db
      .prepare(`SELECT kind, COUNT(*) AS total FROM printer_profiles WHERE is_default = 1 GROUP BY kind`)
      .all() as Array<{ kind: string; total: number }>;
    expect(rows.map((row) => row.kind).sort()).toEqual(['invoice', 'patient_summary', 'prescription', 'report']);
  });

  it('does not overwrite clinic edits on the next start-up', () => {
    const test = app();
    const { settings } = test.container.services;
    settings.updateSettingsInternal({});
    settings.updateClinicInternal({
      name: 'Smile Dental Care',
      address: 'Tangail',
      phone: '01711111111',
      email: 'smile@example.com',
      website: '',
      clinicMessage: 'Welcome',
      visitingHours: '10:00 - 20:00',
      registrationNumber: '',
    });

    // A second container over the same database simulates the next launch.
    const second = createTestApp({ seed: true });
    apps.push(second);
    expect(second.container.services.settings.getClinic().name).toBe('');
    test.container.refreshContext();
    expect(settings.getClinic().name).toBe('Smile Dental Care');
  });
});

describe('users and authentication', () => {
  it('hashes passwords with Argon2id and signs the owner in', async () => {
    const test = app();
    const userId = await test.bootstrapOwner({ username: 'owner', password: 'OwnerPass123' });
    const row = test.container.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as {
      password_hash: string;
    };
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);

    const { auth, users } = test.container.services;
    expect(auth.hasAnyUser()).toBe(true);
    const result = await auth.login('owner', 'OwnerPass123');
    expect(result.user.isOwner).toBe(true);
    expect(result.user.permissions.slice().sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
    expect(users.activeOwnerCount()).toBe(1);

    const audit = test.container.db
      .prepare(`SELECT action FROM audit_logs WHERE action = 'login' ORDER BY id DESC LIMIT 1`)
      .get() as { action: string } | undefined;
    expect(audit?.action).toBe('login');
  });

  it('rejects a wrong password with a generic message and records the attempt', async () => {
    const test = app();
    await test.bootstrapOwner({ password: 'OwnerPass123' });
    const { auth } = test.container.services;

    await expect(auth.login('owner', 'WrongPass123')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const attempts = test.container.db.prepare(`SELECT COUNT(*) AS total FROM login_attempts`).get() as { total: number };
    expect(attempts.total).toBe(1);
    const failed = test.container.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'login_failed'`)
      .get() as { total: number };
    expect(failed.total).toBe(1);
  });

  it('locks the account after five failures and refuses further sign-ins', async () => {
    const test = app();
    await test.bootstrapOwner({ password: 'OwnerPass123' });
    const { auth } = test.container.services;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login('owner', 'WrongPass123')).rejects.toBeInstanceOf(AppError);
    }
    const locked = test.container.db.prepare(`SELECT locked_until, failed_attempts FROM users WHERE username = 'owner'`).get() as {
      locked_until: string | null;
      failed_attempts: number;
    };
    expect(locked.failed_attempts).toBe(5);
    expect(locked.locked_until).not.toBeNull();

    await expect(auth.login('owner', 'OwnerPass123')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('enforces the password policy when changing a password', async () => {
    const test = app();
    await test.bootstrapOwner({ password: 'OwnerPass123' });
    test.signIn(1);
    const { auth } = test.container.services;
    await expect(auth.changePassword('OwnerPass123', 'short')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(auth.changePassword('OwnerPass123', 'allletterslong')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(auth.changePassword('OwnerPass123', 'ClinicSecret456')).resolves.toBeUndefined();
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    const changed = await auth.login('owner', 'ClinicSecret456');
    expect(changed.user.username).toBe('owner');
  });

  it('locks and unlocks the running session', async () => {
    const test = app();
    await test.bootstrapOwner({ password: 'OwnerPass123' });
    const { auth } = test.container.services;
    await auth.login('owner', 'OwnerPass123');
    expect(test.container.session.isLocked()).toBe(false);

    auth.lock('manual');
    expect(test.container.session.isLocked()).toBe(true);
    await expect(auth.unlock('WrongPass123')).rejects.toBeInstanceOf(AppError);
    const user = await auth.unlock('OwnerPass123');
    expect(user.username).toBe('owner');
    expect(test.container.session.isLocked()).toBe(false);
  });

  it('refuses service calls without a session (business-layer RBAC)', () => {
    const test = app();
    expect(() => test.container.services.patients.list({ page: 1, pageSize: 10 })).toThrowError(/signed in|session/i);
    expect(() => test.container.services.settings.updateSettings({ theme: 'dark' })).toThrowError();
  });

  it('lets a role-restricted user reach only permitted services', async () => {
    const test = app();
    const ownerId = await test.bootstrapOwner({ username: 'owner', password: 'OwnerPass123' });
    test.signIn(ownerId);
    const { users, patients } = test.container.services;
    const assistantRole = users.roleIdByKey('assistant');
    expect(assistantRole).not.toBeNull();
    const created = await users.create({
      username: 'assistant1',
      fullName: 'Chair Side',
      email: '',
      phone: '',
      isActive: true,
      mustChangePassword: false,
      roleIds: [assistantRole as number],
      password: 'AssistPass123',
    });

    test.container.session.end();
    test.signIn(created.id);
    expect(() => patients.list({ page: 1, pageSize: 10 })).not.toThrow();
    expect(() => users.list({ page: 1, pageSize: 10 })).toThrowError(/permission/i);
  });
});
