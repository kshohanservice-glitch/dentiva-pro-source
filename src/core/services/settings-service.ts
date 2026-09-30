/**
 * Clinic profile, application settings and setup progress.
 *
 * Settings are stored one row per key so a partial update can never clobber
 * unrelated values, and every read merges the stored values over typed defaults.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { requirePermission } from '../context';
import type { AppSettings, ClinicProfile, SetupStatus } from '@shared/types';
import { CLINIC_DEFAULT_MESSAGE, DEFAULT_SECURITY_SETTINGS } from '@shared/constants';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, DEFAULT_TIME_ZONE } from '@shared/app-info';
import { nowInstant, todayIso } from '@shared/dates';
import { asNumber, fromBoolInt, toBoolInt } from '../db/sql';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'light',
  density: 'comfortable',
  dateFormat: DEFAULT_DATE_FORMAT,
  timeFormat: DEFAULT_TIME_FORMAT,
  timeZone: DEFAULT_TIME_ZONE,
  numberGrouping: 'international',
  autoLockMinutes: DEFAULT_SECURITY_SETTINGS.autoLockMinutes,
  passwordMinLength: DEFAULT_SECURITY_SETTINGS.passwordMinLength,
  maxFailedAttempts: DEFAULT_SECURITY_SETTINGS.maxFailedAttempts,
  lockoutMinutes: DEFAULT_SECURITY_SETTINGS.lockoutMinutes,
  backupFolder: '',
  backupIntervalDays: 7,
  lastAutomaticBackupAt: null,
  defaultPrescriptionProfileId: null,
  defaultInvoiceProfileId: null,
  defaultReportProfileId: null,
  defaultToothNumbering: 'fdi',
  defaultDentition: 'permanent',
  appointmentSlotMinutes: 30,
  queuePrefix: 'Q',
  lowStockWarningFactor: 1,
  expiryWarningDays: 60,
  invoiceFooterNote: 'This invoice is valid without a signature. Thank you for your payment.',
  prescriptionFooterNote: 'Please follow the dosage instructions exactly as written.',
  showFinancialWidgetsForStaff: false,
};

interface SettingsRow {
  key: string;
  value: string;
}

export class SettingsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext | null,
  ) {}

  private decode(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare(`SELECT key, value FROM app_settings`).all() as SettingsRow[];
    const merged: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
    for (const row of rows) {
      if (row.key in DEFAULT_APP_SETTINGS) merged[row.key] = this.decode(row.value);
    }
    const settings = merged as unknown as AppSettings;
    return {
      ...settings,
      // Guard against out-of-range values from an older build or manual edit.
      autoLockMinutes: ([0, 5, 10, 15, 30] as number[]).includes(settings.autoLockMinutes) ? settings.autoLockMinutes : 10,
      backupIntervalDays: ([0, 7, 15, 30] as number[]).includes(settings.backupIntervalDays) ? settings.backupIntervalDays : 7,
      appointmentSlotMinutes: Math.min(Math.max(settings.appointmentSlotMinutes || 30, 5), 240),
      expiryWarningDays: Math.min(Math.max(settings.expiryWarningDays || 60, 1), 365),
      lowStockWarningFactor: Math.min(Math.max(settings.lowStockWarningFactor || 1, 0.1), 10),
    };
  }

  /**
   * Change application settings. Trusted main-process callers (automatic
   * backup, the setup wizard) use {@link updateSettingsInternal}; the settings
   * screen goes through this guarded entry point.
   */
  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const ctx = this.ctx();
    if (ctx) requirePermission(ctx, 'settings.manage');
    const settings = this.updateSettingsInternal(patch);
    const keys = Object.keys(patch);
    ctx?.audit.record({
      action: 'update',
      entityType: 'settings',
      entityLabel: 'Application settings',
      detail: keys.length > 0 ? `Updated: ${keys.join(', ')}` : 'Application settings saved',
      severity: 'warning',
      after: patch,
    });
    return settings;
  }

  updateSettingsInternal(patch: Partial<AppSettings>): AppSettings {
    const statement = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const now = this.ctx()?.instant() ?? nowInstant();
    const apply = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [key, value] of entries) {
        if (!(key in DEFAULT_APP_SETTINGS)) continue;
        statement.run(key, JSON.stringify(value ?? null), now);
      }
    });
    apply(Object.entries(patch));
    const settings = this.getSettings();
    const ctx = this.ctx();
    ctx?.session.setAutoLockMinutes(settings.autoLockMinutes);
    return settings;
  }

  getClinic(): ClinicProfile {
    const row = this.db.prepare(`SELECT * FROM clinic WHERE id = 1`).get() as
      | {
          id: number;
          name: string;
          logo_path: string | null;
          address: string;
          phone: string;
          email: string;
          website: string;
          clinic_message: string;
          visiting_hours: string;
          registration_number: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      const now = this.ctx()?.instant() ?? nowInstant();
      this.db
        .prepare(
          `INSERT INTO clinic (id, name, logo_path, address, phone, email, website,` +
            ` clinic_message, visiting_hours, registration_number, created_at, updated_at)
           VALUES (1, '', NULL, '', '', '', '', ?, '', '', ?, ?)`,
        )
        .run(CLINIC_DEFAULT_MESSAGE, now, now);
      return this.getClinic();
    }
    return {
      id: row.id,
      name: row.name,
      logoPath: row.logo_path,
      address: row.address,
      phone: row.phone,
      email: row.email,
      website: row.website,
      clinicMessage: row.clinic_message,
      visitingHours: row.visiting_hours,
      registrationNumber: row.registration_number,
      updatedAt: row.updated_at,
    };
  }

  /** Guarded clinic-profile write (the setup wizard uses the internal form). */
  updateClinic(input: {
    name: string;
    address: string;
    phone: string;
    email: string;
    website: string;
    clinicMessage: string;
    visitingHours: string;
    registrationNumber: string;
    logoPath?: string | null;
  }): ClinicProfile {
    const ctx = this.ctx();
    if (ctx) requirePermission(ctx, 'settings.manage');
    return this.updateClinicInternal(input);
  }

  updateClinicInternal(input: {
    name: string;
    address: string;
    phone: string;
    email: string;
    website: string;
    clinicMessage: string;
    visitingHours: string;
    registrationNumber: string;
    logoPath?: string | null;
  }): ClinicProfile {
    this.getClinic();
    const fields: string[] = [
      'name = @name',
      'address = @address',
      'phone = @phone',
      'email = @email',
      'website = @website',
      'clinic_message = @clinicMessage',
      'visiting_hours = @visitingHours',
      'registration_number = @registrationNumber',
      'updated_at = @updatedAt',
    ];
    const params: Record<string, unknown> = {
      name: input.name,
      address: input.address,
      phone: input.phone,
      email: input.email,
      website: input.website,
      clinicMessage: input.clinicMessage,
      visitingHours: input.visitingHours,
      registrationNumber: input.registrationNumber,
      updatedAt: this.ctx()?.instant() ?? nowInstant(),
    };
    if (input.logoPath !== undefined) {
      fields.push('logo_path = @logoPath');
      params.logoPath = input.logoPath;
    }
    this.db.prepare(`UPDATE clinic SET ${fields.join(', ')} WHERE id = 1`).run(params);
    return this.getClinic();
  }

  // --- Setup progress -----------------------------------------------------

  private ensureSetupRow(): void {
    const exists = this.db.prepare(`SELECT id FROM setup_state WHERE id = 1`).get() as { id: number } | undefined;
    if (!exists) {
      this.db.prepare(`INSERT INTO setup_state (id, draft_json) VALUES (1, '{}')`).run();
    }
  }

  getSetupState(): SetupStatus {
    this.ensureSetupRow();
    const row = this.db.prepare(`SELECT * FROM setup_state WHERE id = 1`).get() as {
      activation_complete: number;
      clinic_complete: number;
      dentists_complete: number;
      preferences_complete: number;
      administrator_complete: number;
      review_complete: number;
      completed_step: number;
      completed_at: string | null;
    };
    return {
      activationComplete: fromBoolInt(row.activation_complete),
      clinicComplete: fromBoolInt(row.clinic_complete),
      dentistsComplete: fromBoolInt(row.dentists_complete),
      preferencesComplete: fromBoolInt(row.preferences_complete),
      administratorComplete: fromBoolInt(row.administrator_complete),
      reviewComplete: fromBoolInt(row.review_complete),
      completedAt: row.completed_at,
      completedStep: asNumber(row.completed_step),
    };
  }

  saveSetupStep(
    step: 'activation' | 'clinic' | 'dentists' | 'preferences' | 'administrator' | 'review',
    completed: boolean,
    stepIndex?: number,
  ): SetupStatus {
    this.ensureSetupRow();
    const columnMap: Record<string, string> = {
      activation: 'activation_complete',
      clinic: 'clinic_complete',
      dentists: 'dentists_complete',
      preferences: 'preferences_complete',
      administrator: 'administrator_complete',
      review: 'review_complete',
    };
    const column = columnMap[step];
    if (!column) throw new Error(`Unknown setup step: ${step}`);
    const index = stepIndex ?? { activation: 1, clinic: 2, dentists: 3, preferences: 4, administrator: 5, review: 6 }[step] ?? 1;
    this.db
      .prepare(`UPDATE setup_state SET ${column} = ?, completed_step = MAX(completed_step, ?) WHERE id = 1`)
      .run(toBoolInt(completed), index);
    return this.getSetupState();
  }

  saveSetupDraft(draft: Record<string, unknown>): void {
    this.ensureSetupRow();
    this.db.prepare(`UPDATE setup_state SET draft_json = ? WHERE id = 1`).run(JSON.stringify(draft));
  }

  getSetupDraft<T extends Record<string, unknown>>(fallback: T): T {
    this.ensureSetupRow();
    const row = this.db.prepare(`SELECT draft_json FROM setup_state WHERE id = 1`).get() as { draft_json: string };
    try {
      const parsed = JSON.parse(row.draft_json) as unknown;
      if (parsed && typeof parsed === 'object') return { ...fallback, ...(parsed as T) };
      return fallback;
    } catch {
      return fallback;
    }
  }

  markSetupComplete(): SetupStatus {
    this.ensureSetupRow();
    this.db
      .prepare(
        `UPDATE setup_state SET completed_at = ?, completed_step = 7,
           activation_complete = 1, clinic_complete = 1, dentists_complete = 1,
           preferences_complete = 1, administrator_complete = 1, review_complete = 1
         WHERE id = 1`,
      )
      .run(this.ctx()?.instant() ?? nowInstant());
    return this.getSetupState();
  }

  isSetupComplete(): boolean {
    const state = this.getSetupState();
    return state.completedAt !== null && state.administratorComplete && state.clinicComplete;
  }

  /** Clinic-local "today" honouring the configured time zone. */
  today(): string {
    return todayIso(new Date(), this.getSettings().timeZone);
  }
}
