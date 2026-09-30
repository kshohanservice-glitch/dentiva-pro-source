import { describe, expect, it } from 'vitest';
import { API_METHOD_NAMES, SCREEN_ROUTES, resolveScreenPath } from '@shared/api';
import { serializeError, AppError } from '@shared/errors';
import { SCHEMAS } from '@main/ipc/schemas';

describe('IPC schemas', () => {
  it('covers every method exactly once', () => {
    expect(new Set(API_METHOD_NAMES).size).toBe(API_METHOD_NAMES.length);
    for (const method of API_METHOD_NAMES) {
      expect(SCHEMAS[method], `schema for ${method}`).toBeDefined();
    }
    expect(Object.keys(SCHEMAS).sort()).toEqual([...API_METHOD_NAMES].sort());
  });

  it('accepts the payload for a fully populated patient', () => {
    const result = SCHEMAS['patients.create']!.safeParse({
      input: {
        firstName: 'Rahim',
        lastName: 'Uddin',
        gender: 'male',
        dob: '1990-04-02',
        ageYears: null,
        bloodGroup: 'B+',
        phone: '01712345678',
        alternatePhone: '',
        email: 'rahim@example.com',
        address: 'Tangail',
        city: 'Tangail',
        emergencyContactName: '',
        emergencyPhone: '',
        chiefComplaint: 'Pain in the lower right molar',
        previousProblems: '',
        medicalNotes: '',
        allergies: 'Penicillin',
        notes: '',
        preferredContact: 'mobile',
        status: 'active',
        referredBy: '',
        tagIds: [1, 2],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects bad values with a field-level message', () => {
    const result = SCHEMAS['patients.create']!.safeParse({ input: { firstName: '', gender: 'robot', tagIds: [-1] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('input.gender');
      expect(paths).toContain('input.firstName');
      expect(paths).toContain('input.tagIds.0');
    }
  });

  it('validates money, dates and enums on invoices', () => {
    const base = {
      input: {
        patientId: 1,
        visitId: null,
        dentistId: null,
        date: '2026-09-30',
        notes: '',
        items: [
          { treatmentId: null, code: 'X', description: 'Filling', toothCodes: ['16'], quantity: 1, unitPricePaisa: 120_000, discountType: 'none', discountValue: 0, sortOrder: 1 },
        ],
      },
    };
    expect(SCHEMAS['invoices.create']!.safeParse(base).success).toBe(true);
    expect(SCHEMAS['invoices.create']!.safeParse({ input: { ...base.input, date: '30-09-2026' } }).success).toBe(false);
    expect(SCHEMAS['invoices.create']!.safeParse({ input: { ...base.input, items: [] } }).success).toBe(true);
    expect(SCHEMAS['invoices.create']!.safeParse({ input: { ...base.input, items: [{ ...base.input.items[0], unitPricePaisa: -1 }] } }).success).toBe(false);
    expect(SCHEMAS['invoices.create']!.safeParse({ input: { ...base.input, items: [{ ...base.input.items[0], discountType: 'free' }] } }).success).toBe(false);
  });

  it('keeps destructive confirmations mandatory where they matter', () => {
    expect(SCHEMAS['patients.delete']!.safeParse({ id: 1, reason: 'Duplicate record' }).success).toBe(true);
    expect(SCHEMAS['patients.delete']!.safeParse({ id: 1 }).success).toBe(false);
    expect(SCHEMAS['system.deleteBusiness']!.safeParse({ password: 'x', confirmText: 'DELETE', backupFirst: true }).success).toBe(true);
    expect(SCHEMAS['system.deleteBusiness']!.safeParse({ password: 'x', confirmText: '', backupFirst: true }).success).toBe(false);
    expect(SCHEMAS['backup.restore']!.safeParse({ filePath: '/tmp/a.dentivabak', confirmText: 'RESTORE', restoreAttachments: true }).success).toBe(true);
    expect(SCHEMAS['backup.restore']!.safeParse({ filePath: '/tmp/a.dentivabak', restoreAttachments: true }).success).toBe(false);
  });

  it('strips unknown keys instead of forwarding them', () => {
    const result = SCHEMAS['auth.login']!.safeParse({ username: 'owner', password: 'secret', isOwner: true });
    expect(result.success).toBe(true);
    if (result.success) expect(Object.keys(result.data as object)).toEqual(['username', 'password']);
  });

  it('rejects enum values that are not in the shared constants', () => {
    expect(SCHEMAS['appointments.setStatus']!.safeParse({ id: 1, status: 'cancelled' }).success).toBe(true);
    expect(SCHEMAS['appointments.setStatus']!.safeParse({ id: 1, status: 'confirmed_by_phone' }).success).toBe(false);
    expect(SCHEMAS['settings.update']!.safeParse({ patch: { autoLockMinutes: 7 } }).success).toBe(false);
    expect(SCHEMAS['settings.update']!.safeParse({ patch: { autoLockMinutes: 15, theme: 'dark' } }).success).toBe(true);
  });

  it('accepts the undefined payloads for read-only methods', () => {
    for (const method of ['app.bootstrap', 'dashboard.get', 'notifications.unreadCount', 'reports.catalogue'] as const) {
      expect(SCHEMAS[method]!.safeParse(undefined).success, method).toBe(true);
    }
  });
});

describe('error serialisation', () => {
  it('keeps the code and field errors, and hides unknown failures', () => {
    const shaped = serializeError(AppError.validation('Nope', { name: 'Required' }));
    expect(shaped).toEqual({ code: 'VALIDATION', message: 'Nope', fieldErrors: { name: 'Required' } });

    const unknown = serializeError(new Error('SELECT * FROM secrets failed'));
    expect(unknown.code).toBe('UNKNOWN');
    expect(unknown.message).not.toContain('SELECT');
  });
});

describe('screen routing', () => {
  it('resolves every declared route', () => {
    expect(resolveScreenPath('patients')).toBe('/patients');
    expect(resolveScreenPath('patient', 42)).toBe('/patients/42');
    expect(resolveScreenPath('patient', null)).toBe('/patients');
    expect(resolveScreenPath('nope')).toBe(SCREEN_ROUTES.dashboard);
  });
});
