/**
 * Dentists.
 *
 * A dentist carries the designations, qualifications and certifications that
 * appear under the signature on printed prescriptions, plus the signature image
 * itself. Exactly one dentist can be the practice default (used to pre-fill new
 * prescriptions).
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { requirePermission } from '../context';
import type { Dentist, DentistCredential, DentistInput } from '@shared/types';
import { AppError } from '@shared/errors';
import { resolveDateRange } from '@shared/dates';
import { asNumber, fromBoolInt } from '../db/sql';
import type { AttachmentService } from './attachment-service';

interface DentistRow {
  id: number;
  name: string;
  phone: string;
  email: string;
  photo_path: string | null;
  signature_path: string | null;
  registration_number: string;
  visiting_hours: string;
  is_active: number;
  is_default: number;
}

export class DentistService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly attachments: AttachmentService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  list(includeInactive = false): Dentist[] {
    requirePermission(this.context(), 'staff.view');
    return this.listInternal(includeInactive);
  }

  /**
   * Trusted read used by the setup wizard, which runs before the administrator
   * account exists and therefore has no session to check.
   */
  listInternal(includeInactive = false): Dentist[] {
    const clauses = includeInactive ? 'WHERE d.deleted_at IS NULL' : 'WHERE d.deleted_at IS NULL AND d.is_active = 1';
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id =` +
          ` d.id AND a.deleted_at IS NULL AND a.date = @today) AS today_count,
                (SELECT COUNT(*) FROM visits v WHERE v.dentist_id = d.id AND` +
          ` v.deleted_at IS NULL AND substr(v.visit_date, 1, 7) = @month) AS month_count
           FROM dentists d ${clauses}
          ORDER BY d.is_default DESC, d.is_active DESC, d.name`,
      )
      .all({
        today: this.context().today(),
        month: this.context().today().slice(0, 7),
      }) as Array<DentistRow & { today_count: number; month_count: number }>;
    return rows.map((row) => this.map(row));
  }

  get(id: number): Dentist {
    requirePermission(this.context(), 'staff.view');
    const row = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id AND a.deleted_at IS NULL AND a.date = ?) AS today_count,
                (SELECT COUNT(*) FROM visits v WHERE v.dentist_id = d.id AND` +
          ` v.deleted_at IS NULL AND substr(v.visit_date, 1, 7) = ?) AS month_count
           FROM dentists d WHERE d.id = ? AND d.deleted_at IS NULL`,
      )
      .get(this.context().today(), this.context().today().slice(0, 7), id) as
      | (DentistRow & { today_count: number; month_count: number })
      | undefined;
    if (!row) throw AppError.notFound('Dentist');
    return this.map(row);
  }

  private map(row: DentistRow & { today_count: number; month_count: number }): Dentist {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      photoPath: row.photo_path,
      signaturePath: row.signature_path,
      registrationNumber: row.registration_number,
      visitingHours: row.visiting_hours,
      isActive: fromBoolInt(row.is_active),
      isDefault: fromBoolInt(row.is_default),
      credentials: this.credentials(row.id),
      todayAppointmentCount: asNumber(row.today_count),
      monthVisitCount: asNumber(row.month_count),
    };
  }

  credentials(dentistId: number): DentistCredential[] {
    const rows = this.db
      .prepare(`SELECT * FROM dentist_credentials WHERE dentist_id = ? ORDER BY type, sort_order, id`)
      .all(dentistId) as Array<{
      id: number;
      dentist_id: number;
      type: string;
      title: string;
      institution: string;
      year: number | null;
      sort_order: number;
      show_on_prescription: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      dentistId: row.dentist_id,
      type: row.type as DentistCredential['type'],
      title: row.title,
      institution: row.institution,
      year: row.year === null ? null : asNumber(row.year),
      sortOrder: asNumber(row.sort_order),
      showOnPrescription: fromBoolInt(row.show_on_prescription),
    }));
  }

  async save(
    id: number | null,
    input: DentistInput,
    photoSourcePath?: string | null,
    signatureSourcePath?: string | null,
  ): Promise<{ id: number }> {
    requirePermission(this.context(), 'dentist.manage');
    return this.saveInternal(id, input, photoSourcePath, signatureSourcePath);
  }

  /**
   * Trusted write used by the setup wizard, which runs before the
   * administrator account exists and therefore has no session to check.
   */
  async saveInternal(
    id: number | null,
    input: DentistInput,
    photoSourcePath?: string | null,
    signatureSourcePath?: string | null,
  ): Promise<{ id: number }> {
    this.validate(input, id);
    const ctx = this.context();
    const now = ctx.instant();

    const photoPath =
      photoSourcePath === undefined
        ? undefined
        : photoSourcePath === null
          ? null
          : await this.attachments.storeProfileImage({ sourcePath: photoSourcePath, kind: 'dentist' });
    const signaturePath =
      signatureSourcePath === undefined
        ? undefined
        : signatureSourcePath === null
          ? null
          : await this.attachments.storeProfileImage({ sourcePath: signatureSourcePath, kind: 'dentist_signature' });

    const dentistId = this.db.transaction(() => {
      let targetId: number;
      if (id) {
        const before = this.db.prepare(`SELECT * FROM dentists WHERE id = ? AND deleted_at IS NULL`).get(id) as DentistRow | undefined;
        if (!before) throw AppError.notFound('Dentist');
        this.db
          .prepare(
            `UPDATE dentists SET name = @name, phone = @phone, email = @email, registration_number = @registration,
               visiting_hours = @visitingHours, is_active = @isActive, photo_path = COALESCE(@photoPath, photo_path),
               signature_path = COALESCE(@signaturePath, signature_path), updated_at = @now
             WHERE id = @id`,
          )
          .run({
            id,
            name: input.name.trim(),
            phone: input.phone.trim(),
            email: input.email.trim(),
            registration: input.registrationNumber.trim(),
            visitingHours: input.visitingHours.trim(),
            isActive: input.isActive ? 1 : 0,
            photoPath: photoPath ?? null,
            signaturePath: signaturePath ?? null,
            now,
          });
        targetId = id;
        ctx.audit.record({
          action: 'update',
          entityType: 'dentist',
          entityId: id,
          entityLabel: input.name.trim(),
          detail: 'Dentist profile updated',
          before: { name: before.name, isActive: fromBoolInt(before.is_active) },
          after: { name: input.name.trim(), isActive: input.isActive },
        });
      } else {
        const inserted = this.db
          .prepare(
            `INSERT INTO dentists (name, phone, email, photo_path, signature_path, registration_number, visiting_hours,
               is_active, is_default, created_at, updated_at)
             VALUES (@name, @phone, @email, @photoPath, @signaturePath, @registration, @visitingHours, @isActive, 0, @now, @now)`,
          )
          .run({
            name: input.name.trim(),
            phone: input.phone.trim(),
            email: input.email.trim(),
            photoPath: photoPath ?? null,
            signaturePath: signaturePath ?? null,
            registration: input.registrationNumber.trim(),
            visitingHours: input.visitingHours.trim(),
            isActive: input.isActive ? 1 : 0,
            now,
          });
        targetId = Number(inserted.lastInsertRowid);
        ctx.audit.record({
          action: 'create',
          entityType: 'dentist',
          entityId: targetId,
          entityLabel: input.name.trim(),
          detail: 'Dentist added',
        });
      }

      // Credentials are replaced as a set: they are ordered and edited together.
      this.db.prepare(`DELETE FROM dentist_credentials WHERE dentist_id = ?`).run(targetId);
      const insertCredential = this.db.prepare(
        `INSERT INTO dentist_credentials (dentist_id, type, title, institution, year, sort_order, show_on_prescription)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      input.credentials.forEach((credential, index) => {
        insertCredential.run(
          targetId,
          credential.type,
          credential.title.trim(),
          credential.institution.trim(),
          credential.year,
          credential.sortOrder ?? index,
          credential.showOnPrescription ? 1 : 0,
        );
      });

      if (input.isDefault) this.setDefaultInternal(targetId);
      if (photoPath === null) this.db.prepare(`UPDATE dentists SET photo_path = NULL WHERE id = ?`).run(targetId);
      if (signaturePath === null) this.db.prepare(`UPDATE dentists SET signature_path = NULL WHERE id = ?`).run(targetId);
      return targetId;
    })();

    if (photoPath === null && id) {
      const previous = this.previousPath(id, 'photo_path');
      if (previous && previous !== photoPath) await this.attachments.removeProfileImage(previous);
    }
    if (signaturePath === null && id) {
      const previous = this.previousPath(id, 'signature_path');
      if (previous && previous !== signaturePath) await this.attachments.removeProfileImage(previous);
    }
    return { id: dentistId };
  }

  private previousPath(id: number, column: 'photo_path' | 'signature_path'): string | null {
    const row = this.db.prepare(`SELECT ${column} AS path FROM dentists WHERE id = ?`).get(id) as { path: string | null } | undefined;
    return row?.path ?? null;
  }

  private setDefaultInternal(dentistId: number): void {
    this.db.prepare(`UPDATE dentists SET is_default = 0 WHERE id <> ?`).run(dentistId);
    this.db.prepare(`UPDATE dentists SET is_default = 1 WHERE id = ?`).run(dentistId);
  }

  setDefault(dentistId: number): void {
    requirePermission(this.context(), 'dentist.manage');
    const dentist = this.db.prepare(`SELECT name, is_active FROM dentists WHERE id = ? AND deleted_at IS NULL`).get(dentistId) as
      | { name: string; is_active: number }
      | undefined;
    if (!dentist) throw AppError.notFound('Dentist');
    if (!fromBoolInt(dentist.is_active)) throw AppError.precondition('An inactive dentist cannot be the practice default.');
    const ctx = this.context();
    this.db.transaction(() => {
      this.setDefaultInternal(dentistId);
      ctx.audit.record({
        action: 'update',
        entityType: 'dentist',
        entityId: dentistId,
        entityLabel: dentist.name,
        detail: 'Set as the default dentist for new prescriptions',
      });
    })();
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'dentist.manage');
    const row = this.db.prepare(`SELECT name, is_default FROM dentists WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { name: string; is_default: number }
      | undefined;
    if (!row) throw AppError.notFound('Dentist');
    if (confirmText?.trim() !== row.name) {
      throw AppError.validation(`Type the name (${row.name}) to confirm deletion.`, { confirmText: `Type ${row.name} to confirm.` });
    }
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for removing this dentist.', { reason: 'Reason is required.' });
    const used = asNumber(
      (
        this.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM visits v WHERE v.dentist_id = ?) + (SELECT COUNT(*) FROM prescriptions p WHERE p.dentist_id = ?) +
                    (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = ?) AS total`,
          )
          .get(id, id, id) as { total: number }
      ).total,
    );
    const ctx = this.context();
    this.db.transaction(() => {
      if (used > 0) {
        // Never orphan clinical history: deactivate instead of removing.
        this.db.prepare(`UPDATE dentists SET is_active = 0, is_default = 0, updated_at = ? WHERE id = ?`).run(ctx.instant(), id);
        ctx.audit.record({
          action: 'update',
          entityType: 'dentist',
          entityId: id,
          entityLabel: row.name,
          detail: `Dentist deactivated — linked to ${used} record(s). Reason: ${reason.trim()}`,
          severity: 'warning',
        });
      } else {
        this.db.prepare(`UPDATE dentists SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ctx.instant(), ctx.instant(), id);
        ctx.audit.record({
          action: 'delete',
          entityType: 'dentist',
          entityId: id,
          entityLabel: row.name,
          detail: `Dentist removed. Reason: ${reason.trim()}`,
          severity: 'critical',
        });
      }
    })();
  }

  /** Per-dentist workload and revenue for the reporting screen. */
  statistics(options: { preset?: string; from?: string; to?: string } = {}): Array<{
    dentistId: number;
    dentistName: string;
    appointments: number;
    completed: number;
    noShows: number;
    visits: number;
    prescriptions: number;
    treatments: number;
    revenuePaisa: number | null;
  }> {
    requirePermission(this.context(), 'report.operational.view');
    const range = resolveDateRange((options.preset ?? 'this_month') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const canSeeRevenue = this.canSeeFinancials();
    const rows = this.db
      .prepare(
        `SELECT d.id AS dentist_id, d.name AS dentist_name,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id` +
          ` AND a.deleted_at IS NULL AND a.date BETWEEN @from AND @to) AS appointments,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id AND a.deleted_at` +
          ` IS NULL AND a.status = 'completed' AND a.date BETWEEN @from AND @to) AS completed,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id AND` +
          ` a.deleted_at IS NULL AND a.status = 'no_show' AND a.date BETWEEN @from AND @to) AS no_shows,
                (SELECT COUNT(*) FROM visits v WHERE v.dentist_id = d.id AND` +
          ` v.deleted_at IS NULL AND v.visit_date BETWEEN @from AND @to) AS visits,
                (SELECT COUNT(*) FROM prescriptions p WHERE p.dentist_id = d.id` +
          ` AND p.deleted_at IS NULL AND p.date BETWEEN @from AND @to) AS prescriptions,
                (SELECT COUNT(*) FROM treatment_records t WHERE t.dentist_id = d.id AND` +
          ` t.deleted_at IS NULL AND substr(t.performed_at, 1, 10) BETWEEN @from AND @to) AS treatments,
                (SELECT COALESCE(SUM(ii.line_total_paisa), 0) FROM invoice_items ii
                   JOIN invoices i ON i.id = ii.invoice_id
                  WHERE i.dentist_id = d.id AND i.deleted_at IS NULL AND i.is_void = 0 AND i.date BETWEEN @from AND @to) AS revenue
           FROM dentists d WHERE d.deleted_at IS NULL ORDER BY appointments DESC, d.name`,
      )
      .all({ from: range.from, to: range.to }) as Array<{
      dentist_id: number;
      dentist_name: string;
      appointments: number;
      completed: number;
      no_shows: number;
      visits: number;
      prescriptions: number;
      treatments: number;
      revenue: number;
    }>;
    return rows.map((row) => ({
      dentistId: row.dentist_id,
      dentistName: row.dentist_name,
      appointments: asNumber(row.appointments),
      completed: asNumber(row.completed),
      noShows: asNumber(row.no_shows),
      visits: asNumber(row.visits),
      prescriptions: asNumber(row.prescriptions),
      treatments: asNumber(row.treatments),
      revenuePaisa: canSeeRevenue ? asNumber(row.revenue) : null,
    }));
  }

  private canSeeFinancials(): boolean {
    const user = this.context().session.currentUser();
    if (!user) return false;
    if (user.isOwner) return true;
    return user.permissions.some(
      (permission) => permission === '*' || permission.startsWith('report.financial') || permission.startsWith('dashboard.financial'),
    );
  }

  /** Pickers / dropdowns. */
  options(includeInactive = false): Array<{ value: number; label: string; meta: string }> {
    return this.list(includeInactive).map((dentist) => ({
      value: dentist.id,
      label: dentist.name,
      meta: [dentist.registrationNumber, dentist.visitingHours].filter((part) => part !== '').join(' · '),
    }));
  }

  /** Default dentist for new prescriptions/invoices. */
  defaultDentist(): Dentist | null {
    const row = this.db.prepare(`SELECT id FROM dentists WHERE is_default = 1 AND is_active = 1 AND deleted_at IS NULL LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (row) return this.get(row.id);
    const first = this.db.prepare(`SELECT id FROM dentists WHERE is_active = 1 AND deleted_at IS NULL ORDER BY name LIMIT 1`).get() as
      | { id: number }
      | undefined;
    return first ? this.get(first.id) : null;
  }

  /** Credentials that must appear under the signature on printed documents. */
  prescriptionCredentials(dentistId: number): { designations: string[]; qualifications: string[]; certifications: string[] } {
    const credentials = this.credentials(dentistId).filter((credential) => credential.showOnPrescription);
    return {
      designations: credentials.filter((credential) => credential.type === 'designation').map((credential) => credential.title),
      qualifications: credentials.filter((credential) => credential.type === 'qualification').map((credential) => credential.title),
      certifications: credentials.filter((credential) => credential.type === 'certification').map((credential) => credential.title),
    };
  }

  private validate(input: DentistInput, existingId: number | null): void {
    const fieldErrors: Record<string, string> = {};
    if (input.name.trim().length < 2) fieldErrors['name'] = 'Enter the dentist’s name.';
    if (input.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))
      fieldErrors['email'] = 'Enter a valid email address.';
    if (input.phone.trim() !== '' && !/^[0-9+\-\s()]{6,20}$/.test(input.phone.trim())) fieldErrors['phone'] = 'Enter a valid phone number.';
    const allowedTypes: readonly string[] = ['designation', 'qualification', 'certification'];
    input.credentials.forEach((credential, index) => {
      if (!allowedTypes.includes(credential.type)) {
        fieldErrors[`credential-${index}`] = 'Choose a designation, qualification or certification.';
      }
      if (credential.title.trim().length < 2) fieldErrors[`credential-${index}`] = 'Every qualification needs a title.';
      if (credential.year !== null && (credential.year < 1940 || credential.year > new Date().getFullYear() + 1)) {
        fieldErrors[`credential-${index}`] = 'Enter a valid year.';
      }
    });
    const duplicate = this.db
      .prepare(`SELECT id FROM dentists WHERE lower(name) = lower(?) AND deleted_at IS NULL${existingId ? ' AND id <> ?' : ''}`)
      .get(...(existingId ? [input.name.trim(), existingId] : [input.name.trim()])) as { id: number } | undefined;
    if (duplicate) fieldErrors['name'] = 'A dentist with this name already exists.';
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  /** Full name list for dropdowns where only the id matters. */
  nameById(id: number): string {
    const row = this.db.prepare(`SELECT name FROM dentists WHERE id = ?`).get(id) as { name: string } | undefined;
    return row?.name ?? 'Unassigned';
  }

  /** Count for the data summary screen. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM dentists WHERE deleted_at IS NULL`).get() as { total: number };
    return asNumber(row.total);
  }
}
