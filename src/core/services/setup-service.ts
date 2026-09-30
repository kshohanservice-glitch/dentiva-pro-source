/**
 * First-run setup: offline activation and the seven-step wizard.
 *
 * Everything in this service runs *before* an administrator exists, so it is
 * the one trusted, unauthenticated write path in the application. It is
 * therefore fenced in on both sides: activation must be complete before the
 * wizard opens, every step is resumable (the wizard can be closed and reopened
 * at any point), and the whole path shuts permanently the moment setup is
 * completed — afterwards it refuses to touch anything.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { AppError } from '@shared/errors';
import { hashPassword } from '../security/password';
import { activateWithCode, getActivationStatus, MAX_ACTIVATION_ATTEMPTS } from '../security/activation';
import type { ActivationStatus, AppSettings, ClinicProfile, Dentist, DentistInput, SetupStatus } from '@shared/types';
import { validatePassword } from '../security/password';
import type { SettingsService } from './settings-service';
import type { DentistService } from './dentist-service';
import type { AttachmentService } from './attachment-service';
import type { UserService } from './user-service';
import { asString } from '../db/sql';

export interface SetupPreferencesInput {
  dateFormat: string;
  timeFormat: string;
  timeZone: string;
  numberGrouping: AppSettings['numberGrouping'];
  autoLockMinutes: number;
  backupFolder: string;
  backupIntervalDays: number;
  defaultPrinterName: string;
}

export class SetupService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly settings: SettingsService,
    private readonly dentists: DentistService,
    private readonly attachments: AttachmentService,
    private readonly users: UserService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  /** Guard used by every wizard step: no writes once setup is finished. */
  private assertSetupOpen(): void {
    if (this.settings.isSetupComplete()) {
      throw AppError.precondition('Setup has already been completed. Open Settings to change these values.');
    }
  }

  status(): SetupStatus {
    return this.settings.getSetupState();
  }

  // --- Activation ---------------------------------------------------------

  activationStatus(): ActivationStatus {
    return getActivationStatus(this.db, this.context().machineGuid);
  }

  activate(code: string): ActivationStatus {
    const status = this.activationStatus();
    if (status.activated) return status;
    const clean = code.trim();
    if (clean === '') throw AppError.validation('Enter the activation code.', { code: 'The code is required.' });

    const attempts = this.attemptCount();
    if (attempts >= MAX_ACTIVATION_ATTEMPTS) {
      throw AppError.rateLimited(
        `Activation has been blocked after ${MAX_ACTIVATION_ATTEMPTS} failed attempts. Contact your supplier for a new code.`,
      );
    }

    const result = activateWithCode(this.db, clean, this.context().machineGuid);
    const ctx = this.context();
    if (!result.activated) {
      ctx.audit.record({
        action: 'login_failed',
        entityType: 'activation',
        entityLabel: 'activation code',
        detail: `Invalid activation code (attempt ${attempts + 1} of ${MAX_ACTIVATION_ATTEMPTS})`,
        severity: 'warning',
      });
      const remaining = MAX_ACTIVATION_ATTEMPTS - (attempts + 1);
      throw AppError.validation(
        remaining > 0
          ? `That activation code is not valid. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'That activation code is not valid. Activation is now blocked.',
        { code: 'The code is not valid.' },
      );
    }

    ctx.audit.record({
      action: 'update',
      entityType: 'activation',
      entityLabel: 'activation code',
      detail: `Installation activated on this machine (fingerprint ${result.status.machineBound ? 'bound' : 'not bound'})`,
      severity: 'critical',
    });
    this.settings.saveSetupStep('activation', true);
    return result.status;
  }

  private attemptCount(): number {
    const row = this.db.prepare(`SELECT attempts FROM activation WHERE id = 1`).get() as { attempts: number } | undefined;
    return row ? Number(row.attempts) : 0;
  }

  // --- Wizard steps -------------------------------------------------------

  async saveClinic(input: {
    name: string;
    address: string;
    phone: string;
    email: string;
    website: string;
    logoSourcePath?: string | null;
  }): Promise<void> {
    this.assertSetupOpen();
    this.assertActivated();
    const name = input.name.trim();
    if (name.length < 2) throw AppError.validation('Enter the clinic name.', { name: 'Clinic name is required.' });
    if (input.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
      throw AppError.validation('Enter a valid email address.', { email: 'The email address looks incomplete.' });
    }
    const existing = this.settings.getClinic();
    let logoPath = existing.logoPath;
    if (input.logoSourcePath) {
      logoPath = await this.attachments.storeProfileImageInternal({ sourcePath: input.logoSourcePath, kind: 'clinic_logo' });
    }
    this.settings.updateClinicInternal({
      name,
      address: input.address.trim(),
      phone: input.phone.trim(),
      email: input.email.trim(),
      website: input.website.trim(),
      clinicMessage: existing.clinicMessage,
      visitingHours: existing.visitingHours,
      registrationNumber: existing.registrationNumber,
      logoPath,
    });
    this.context().audit.record({
      action: 'update',
      entityType: 'clinic',
      entityLabel: name,
      detail: 'Clinic profile saved during setup',
      severity: 'warning',
    });
    this.settings.saveSetupStep('clinic', true);
  }

  async saveDentists(list: DentistInput[]): Promise<void> {
    this.assertSetupOpen();
    this.assertActivated();
    if (list.length === 0) throw AppError.validation('Add at least one dentist.', { dentists: 'At least one dentist is required.' });
    for (const [index, dentist] of list.entries()) {
      if (dentist.name.trim().length < 2) {
        throw AppError.validation(`Enter the name of dentist ${index + 1}.`, { [`dentist-${index}`]: 'Name is required.' });
      }
    }
    for (const [index, dentist] of list.entries()) {
      await this.dentists.saveInternal(null, { ...dentist, isDefault: dentist.isDefault || index === 0 });
    }
    // Exactly one default dentist.
    const defaultCount = Number(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM dentists WHERE is_default = 1 AND deleted_at IS NULL`).get() as { total: number })
        .total,
    );
    if (defaultCount === 0 && list.length > 0) {
      this.db.prepare(`UPDATE dentists SET is_default = 1 WHERE id = (SELECT MIN(id) FROM dentists WHERE deleted_at IS NULL)`).run();
    }
    this.settings.saveSetupStep('dentists', true);
  }

  savePreferences(input: SetupPreferencesInput): void {
    this.assertSetupOpen();
    this.assertActivated();
    const autoLock = ([0, 5, 10, 15, 30] as number[]).includes(input.autoLockMinutes) ? input.autoLockMinutes : 10;
    const interval = ([0, 7, 15, 30] as number[]).includes(input.backupIntervalDays) ? input.backupIntervalDays : 7;
    const backupFolder = input.backupFolder.trim();
    const patch: Partial<AppSettings> = {
      dateFormat: input.dateFormat.trim() === '' ? 'DD MMM YYYY' : input.dateFormat.trim(),
      timeFormat: input.timeFormat.trim() === '' ? 'hh:mm A' : input.timeFormat.trim(),
      timeZone: input.timeZone.trim() === '' ? 'Asia/Dhaka' : input.timeZone.trim(),
      numberGrouping: input.numberGrouping,
      autoLockMinutes: autoLock as AppSettings['autoLockMinutes'],
      backupIntervalDays: interval as AppSettings['backupIntervalDays'],
      backupFolder,
    };
    this.settings.updateSettingsInternal(patch);
    if (input.defaultPrinterName.trim() !== '') {
      this.db
        .prepare(`UPDATE printer_profiles SET printer_name = ?, updated_at = ? WHERE is_default = 1`)
        .run(input.defaultPrinterName.trim(), this.context().instant());
    }
    this.settings.saveSetupStep('preferences', true);
  }

  async createAdministrator(input: { username: string; fullName: string; password: string }): Promise<void> {
    this.assertSetupOpen();
    this.assertActivated();
    const username = input.username.trim().toLowerCase();
    const fullName = input.fullName.trim();
    const fieldErrors: Record<string, string> = {};
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) {
      fieldErrors['username'] = 'Use 3–24 letters, numbers, dots, hyphens or underscores.';
    }
    if (fullName.length < 2) fieldErrors['fullName'] = 'Enter the administrator’s full name.';
    const policy = validatePassword(input.password, { username, fullName });
    if (!policy.ok) fieldErrors['password'] = policy.problems.join(' ');
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);

    const existing = this.db.prepare(`SELECT id FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL`).get(username) as
      | { id: number }
      | undefined;
    if (existing) throw AppError.conflict('That username is already taken.');

    const passwordHash = await hashPassword(input.password);
    this.users.ensureSystemRoles();
    const ownerRoleId = Number((this.db.prepare(`SELECT id FROM roles WHERE key = 'owner'`).get() as { id: number }).id);
    const ctx = this.context();
    const now = ctx.instant();

    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO users (username, password_hash, full_name, email, phone, is_active, must_change_password,
             failed_attempts, created_at, updated_at, last_password_change_at)
           VALUES (?, ?, ?, '', '', 1, 0, 0, ?, ?, ?)`,
        )
        .run(username, passwordHash, fullName, now, now, now);
      const userId = Number(result.lastInsertRowid);
      this.db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(userId, ownerRoleId);
      ctx.audit.record({
        action: 'create',
        entityType: 'user',
        entityId: userId,
        entityLabel: username,
        detail: 'Owner account created by the setup wizard',
        severity: 'critical',
      });
    })();
    this.settings.saveSetupStep('administrator', true);
  }

  review(): { clinic: ClinicProfile | null; dentists: Dentist[]; preferences: AppSettings | null; administrator: string | null } {
    const clinic = this.settings.getClinic();
    const administratorRow = this.db
      .prepare(
        `SELECT u.username FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE r.key = 'owner' AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1`,
      )
      .get() as { username: string } | undefined;
    return {
      clinic: clinic.name.trim() === '' ? null : clinic,
      dentists: this.dentists.listInternal(false),
      preferences: this.settings.getSettings(),
      administrator: administratorRow ? asString(administratorRow.username) : null,
    };
  }

  /** Close the wizard. Requires every earlier step to be complete. */
  complete(): void {
    this.assertSetupOpen();
    const status = this.settings.getSetupState();
    const missing: string[] = [];
    if (!status.activationComplete) missing.push('activation');
    if (!status.clinicComplete) missing.push('clinic details');
    if (!status.dentistsComplete) missing.push('dentists');
    if (!status.preferencesComplete) missing.push('preferences');
    if (!status.administratorComplete) missing.push('administrator account');
    if (missing.length > 0) {
      throw AppError.precondition(`Finish these steps first: ${missing.join(', ')}.`);
    }
    this.settings.markSetupComplete();
    this.settings.saveSetupStep('review', true);
    this.context().audit.record({
      action: 'update',
      entityType: 'setup',
      entityLabel: 'Setup complete',
      detail: 'The setup wizard finished and the clinic installation is ready',
      severity: 'critical',
    });
  }

  /** True when the application needs the wizard (activation done, setup not). */
  needsSetup(): boolean {
    const activation = this.activationStatus();
    return !activation.activated || !this.settings.isSetupComplete();
  }

  /** Machine-bound activation marker used by the About screen. */
  machineBound(): boolean {
    return this.activationStatus().machineBound;
  }

  private assertActivated(): void {
    if (!this.activationStatus().activated) {
      throw AppError.precondition('Activate this installation before continuing setup.');
    }
  }
}
