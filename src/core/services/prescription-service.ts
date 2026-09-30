/**
 * Prescriptions.
 *
 * A prescription is an issued clinical document: once saved it is never
 * silently rewritten. Editing requires the explicit `prescription.edit`
 * permission and is audited; a prescription that must change after printing is
 * superseded by a new one which links back to the original.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type {
  ClinicalOption,
  Medication,
  MedicationInput,
  MedicationListQuery,
  Paged,
  PrescriptionDetail,
  PrescriptionInput,
  PrescriptionItem,
  PrescriptionItemInput,
  PrescriptionSummary,
} from '@shared/types';
import type { ClinicalOptionCategory, Gender, MedicationForm } from '@shared/constants';
import { MAX_DURATION_DAYS, MAX_DOSES_PER_SLOT, MAX_MEDICATIONS_PER_PRESCRIPTION } from '@shared/constants';
import { AppError } from '@shared/errors';
import {} from '@shared/dates';
import { asNumber, asString, buildWhere, fromBoolInt, pageCount, paginate, parseJsonArray, toBoolInt, toJsonArray } from '../db/sql';
import { nextPrescriptionNumber } from '../util/ids';

interface PrescriptionRow {
  id: number;
  number: string;
  patient_id: number;
  patient_code: string;
  patient_name: string;
  patient_gender?: string;
  patient_dob?: string | null;
  patient_age_years?: number | null;
  patient_phone?: string;
  patient_address?: string;
  dentist_id: number | null;
  dentist_name: string | null;
  visit_id: number | null;
  date: string;
  cc: string;
  oe: string;
  re: string;
  advice: string;
  notes: string;
  is_void: number;
  void_reason: string;
  printed_at: string | null;
  superseded_by_id: number | null;
  created_by: number | null;
  created_at: string;
  item_count?: number;
  created_by_name?: string | null;
}

const PRESCRIPTION_SELECT = `
  SELECT pr.*, p.code AS patient_code, p.gender AS patient_gender, p.dob AS patient_dob, p.age_years AS patient_age_years,
         p.phone AS patient_phone, p.address AS patient_address,
         trim(p.first_name || ' ' || p.last_name) AS patient_name,
         d.name AS dentist_name,
         (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = pr.id) AS item_count,
         (SELECT full_name FROM users u WHERE u.id = pr.created_by) AS created_by_name
    FROM prescriptions pr
    JOIN patients p ON p.id = pr.patient_id
    LEFT JOIN dentists d ON d.id = pr.dentist_id
`;

export class PrescriptionService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private mapSummary(row: PrescriptionRow): PrescriptionSummary {
    return {
      id: row.id,
      number: row.number,
      patientId: row.patient_id,
      patientCode: row.patient_code,
      patientName: row.patient_name,
      dentistId: row.dentist_id,
      dentistName: row.dentist_name ?? 'Unassigned',
      date: row.date,
      itemCount: asNumber(row.item_count),
      diagnosis: row.notes,
      isVoid: fromBoolInt(row.is_void),
      printedAt: row.printed_at,
      visitId: row.visit_id,
    };
  }

  list(query: { page?: number; pageSize?: number; search?: string; preset?: string; from?: string; to?: string; patientId?: number; dentistId?: number | null; includeVoid?: boolean }): Paged<PrescriptionSummary> {
    requirePermission(this.context(), 'prescription.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = ['pr.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (!query.includeVoid) clauses.push('pr.is_void = 0');
    if (query.from) {
      clauses.push('pr.date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      clauses.push('pr.date <= ?');
      params.push(query.to);
    }
    if (query.patientId) {
      clauses.push('pr.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.dentistId) {
      clauses.push('pr.dentist_id = ?');
      params.push(query.dentistId);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(
        `(pr.number LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM prescription_items pi WHERE pi.prescription_id = pr.id AND pi.name LIKE ? ESCAPE '\\'))`,
      );
      params.push(term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM prescriptions pr JOIN patients p ON p.id = pr.patient_id${where}`)
          .get(...params) as { total: number }
      ).total,
    );
    const rows = this.db
      .prepare(`${PRESCRIPTION_SELECT}${where} ORDER BY pr.date DESC, pr.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as PrescriptionRow[];
    return { items: rows.map((row) => this.mapSummary(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): PrescriptionDetail {
    requirePermission(this.context(), 'prescription.view');
    const row = this.db.prepare(`${PRESCRIPTION_SELECT} WHERE pr.id = ? AND pr.deleted_at IS NULL`).get(id) as PrescriptionRow | undefined;
    if (!row) throw AppError.notFound('Prescription');
    const items = this.items(id);
    return {
      ...this.mapSummary(row),
      patientGender: (row.patient_gender ?? 'other') as Gender,
      patientAgeText: row.patient_dob ? `${row.patient_dob}` : row.patient_age_years ? `${row.patient_age_years} years` : '—',
      patientPhone: row.patient_phone ?? '',
      patientAddress: row.patient_address ?? '',
      cc: parseJsonArray(row.cc),
      oe: parseJsonArray(row.oe),
      re: parseJsonArray(row.re),
      advice: parseJsonArray(row.advice),
      notes: row.notes,
      items,
      createdByName: row.created_by_name ?? '—',
      createdAt: row.created_at,
      voidReason: row.void_reason,
      supersededById: row.superseded_by_id,
    };
  }

  private items(prescriptionId: number): PrescriptionItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order, id`)
      .all(prescriptionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      medicationId: row['medication_id'] === null ? null : asNumber(row['medication_id']),
      name: asString(row['name']),
      resolveName: asString(row['name']),
      form: asString(row['form'], 'tablet') as MedicationForm,
      strength: asString(row['strength']),
      doseMorning: asNumber(row['dose_morning']),
      doseNoon: asNumber(row['dose_noon']),
      doseNight: asNumber(row['dose_night']),
      foodTiming: asString(row['food_timing'], 'after_food') as PrescriptionItem['foodTiming'],
      durationDays: row['duration_days'] === null ? null : asNumber(row['duration_days']),
      quantity: row['quantity'] === null ? null : asNumber(row['quantity']),
      instructions: asString(row['instructions']),
      sortOrder: asNumber(row['sort_order']),
    }));
  }

  byPatient(patientId: number, limit = 50): PrescriptionSummary[] {
    requirePermission(this.context(), 'prescription.view');
    const rows = this.db
      .prepare(`${PRESCRIPTION_SELECT} WHERE pr.patient_id = ? AND pr.deleted_at IS NULL ORDER BY pr.date DESC, pr.id DESC LIMIT ?`)
      .all(patientId, limit) as PrescriptionRow[];
    return rows.map((row) => this.mapSummary(row));
  }

  create(input: PrescriptionInput): { id: number; number: string } {
    requirePermission(this.context(), 'prescription.create');
    this.validate(input);
    const ctx = this.context();
    const id = this.db.transaction(() => {
      const number = nextPrescriptionNumber(this.db, input.date);
      const result = this.db
        .prepare(
          `INSERT INTO prescriptions
             (number, patient_id, dentist_id, visit_id, date, cc, oe, re, advice, notes, created_by, created_at, updated_at)
           VALUES (@number, @patientId, @dentistId, @visitId, @date, @cc, @oe, @re, @advice, @notes, @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          number,
          patientId: input.patientId,
          dentistId: input.dentistId,
          visitId: input.visitId,
          date: input.date,
          cc: toJsonArray(input.cc),
          oe: toJsonArray(input.oe),
          re: toJsonArray(input.re),
          advice: toJsonArray(input.advice),
          notes: input.notes.trim(),
          createdBy: currentUserId(ctx),
          createdAt: ctx.instant(),
          updatedAt: ctx.instant(),
        });
      const prescriptionId = Number(result.lastInsertRowid);
      this.saveItems(prescriptionId, input.items);
      ctx.audit.record({
        action: 'create',
        entityType: 'prescription',
        entityId: prescriptionId,
        entityLabel: number,
        detail: `Prescription issued with ${input.items.length} medication(s)`,
        after: { number, items: input.items.map((item) => item.name) },
      });
      return prescriptionId;
    })();
    ctx.notify?.('prescriptions.changed', { id });
    return { id, number: this.numberOf(id) };
  }

  update(id: number, input: PrescriptionInput): void {
    requirePermission(this.context(), 'prescription.edit');
    this.validate(input);
    const ctx = this.context();
    const before = this.db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string; is_void: number; printed_at: string | null }
      | undefined;
    if (!before) throw AppError.notFound('Prescription');
    if (fromBoolInt(before.is_void)) throw AppError.precondition('This prescription has been voided and cannot be edited.');
    if (before.printed_at) {
      ctx.audit.record({
        action: 'update',
        entityType: 'prescription',
        entityId: id,
        entityLabel: before.number,
        detail: 'Printed prescription edited after printing',
        severity: 'warning',
      });
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE prescriptions SET dentist_id = @dentistId, visit_id = @visitId, date = @date, cc = @cc, oe = @oe,
             re = @re, advice = @advice, notes = @notes, updated_at = @updatedAt WHERE id = @id`,
        )
        .run({
          id,
          dentistId: input.dentistId,
          visitId: input.visitId,
          date: input.date,
          cc: toJsonArray(input.cc),
          oe: toJsonArray(input.oe),
          re: toJsonArray(input.re),
          advice: toJsonArray(input.advice),
          notes: input.notes.trim(),
          updatedAt: ctx.instant(),
        });
      this.db.prepare(`DELETE FROM prescription_items WHERE prescription_id = ?`).run(id);
      this.saveItems(id, input.items);
      ctx.audit.record({
        action: 'update',
        entityType: 'prescription',
        entityId: id,
        entityLabel: before.number,
        detail: 'Prescription amended',
        before: { printedAt: before.printed_at },
        after: { items: input.items.map((item) => `${item.name} ${item.strength}`.trim()) },
      });
    })();
    ctx.notify?.('prescriptions.changed', { id });
  }

  /** Issue a corrected prescription that references the original. */
  supersede(id: number, input: PrescriptionInput, reason: string): { id: number; number: string } {
    requirePermission(this.context(), 'prescription.edit');
    const original = this.db.prepare(`SELECT number FROM prescriptions WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string }
      | undefined;
    if (!original) throw AppError.notFound('Prescription');
    if (reason.trim().length < 3) throw AppError.validation('Please describe why the prescription is being replaced.', { reason: 'Reason is required.' });
    const created = this.create(input);
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE prescriptions SET superseded_by_id = ?, updated_at = ? WHERE id = ?`).run(created.id, ctx.instant(), id);
      ctx.audit.record({
        action: 'update',
        entityType: 'prescription',
        entityId: id,
        entityLabel: original.number,
        detail: `Replaced by ${created.number}. Reason: ${reason.trim()}`,
        severity: 'warning',
      });
    })();
    return created;
  }

  void(id: number, reason: string): void {
    requirePermission(this.context(), 'prescription.edit');
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for voiding this prescription.', { reason: 'Reason is required.' });
    const ctx = this.context();
    const prescription = this.db.prepare(`SELECT number FROM prescriptions WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string }
      | undefined;
    if (!prescription) throw AppError.notFound('Prescription');
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE prescriptions SET is_void = 1, void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?`)
        .run(reason.trim(), ctx.instant(), currentUserId(ctx), ctx.instant(), id);
      ctx.audit.record({
        action: 'update',
        entityType: 'prescription',
        entityId: id,
        entityLabel: prescription.number,
        detail: `Prescription voided. Reason: ${reason.trim()}`,
        severity: 'warning',
      });
    })();
  }

  delete(id: number, reason: string): void {
    requirePermission(this.context(), 'prescription.delete');
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for deleting this prescription.', { reason: 'Reason is required.' });
    const ctx = this.context();
    const prescription = this.db.prepare(`SELECT number FROM prescriptions WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string }
      | undefined;
    if (!prescription) throw AppError.notFound('Prescription');
    this.db.transaction(() => {
      this.db.prepare(`UPDATE prescriptions SET deleted_at = ?, deleted_reason = ? WHERE id = ?`).run(ctx.instant(), reason.trim(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'prescription',
        entityId: id,
        entityLabel: prescription.number,
        detail: `Prescription deleted. Reason: ${reason.trim()}`,
        severity: 'critical',
      });
    })();
  }

  markPrinted(id: number): void {
    this.db
      .prepare(`UPDATE prescriptions SET printed_at = COALESCE(printed_at, ?), print_count = print_count + 1 WHERE id = ?`)
      .run(this.context().instant(), id);
  }

  private numberOf(id: number): string {
    const row = this.db.prepare(`SELECT number FROM prescriptions WHERE id = ?`).get(id) as { number: string } | undefined;
    return row?.number ?? '';
  }

  private saveItems(prescriptionId: number, items: readonly PrescriptionItemInput[]): void {
    const insert = this.db.prepare(
      `INSERT INTO prescription_items
         (prescription_id, medication_id, name, form, strength, dose_morning, dose_noon, dose_night, food_timing,
          duration_days, quantity, instructions, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item, index) => {
      insert.run(
        prescriptionId,
        item.medicationId,
        item.name.trim(),
        item.form,
        item.strength.trim(),
        Math.min(Math.max(Math.round(item.doseMorning), 0), MAX_DOSES_PER_SLOT),
        Math.min(Math.max(Math.round(item.doseNoon), 0), MAX_DOSES_PER_SLOT),
        Math.min(Math.max(Math.round(item.doseNight), 0), MAX_DOSES_PER_SLOT),
        item.foodTiming,
        item.durationDays,
        item.quantity,
        item.instructions.trim(),
        item.sortOrder ?? index,
      );
    });
  }

  private validate(input: PrescriptionInput): void {
    const fieldErrors: Record<string, string> = {};
    if (!input.patientId) fieldErrors.patientId = 'Select a patient.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fieldErrors.date = 'Select a valid date.';
    if (input.items.length === 0) fieldErrors.items = 'Add at least one medication.';
    if (input.items.length > MAX_MEDICATIONS_PER_PRESCRIPTION) {
      fieldErrors.items = `A prescription cannot hold more than ${MAX_MEDICATIONS_PER_PRESCRIPTION} medications.`;
    }
    input.items.forEach((item, index) => {
      const label = `item-${index}`;
      if (item.name.trim().length < 2) fieldErrors[label] = 'Medication name is required.';
      if (item.doseMorning < 0 || item.doseNoon < 0 || item.doseNight < 0) {
        fieldErrors[label] = 'Doses cannot be negative.';
      }
      if (item.doseMorning > MAX_DOSES_PER_SLOT || item.doseNoon > MAX_DOSES_PER_SLOT || item.doseNight > MAX_DOSES_PER_SLOT) {
        fieldErrors[label] = `A dose cannot exceed ${MAX_DOSES_PER_SLOT}.`;
      }
      if (!item.doseMorning && !item.doseNoon && !item.doseNight && item.instructions.trim() === '') {
        fieldErrors[label] = 'Enter a dose or an instruction for this medication.';
      }
      if (item.durationDays !== null && item.durationDays !== undefined) {
        if (item.durationDays <= 0 || item.durationDays > MAX_DURATION_DAYS) {
          fieldErrors[label] = `Duration must be between 1 and ${MAX_DURATION_DAYS} days.`;
        }
      }
      if (item.quantity !== null && item.quantity !== undefined && item.quantity <= 0) {
        fieldErrors[label] = 'Quantity must be greater than zero.';
      }
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
    }
  }

  // --- Medication catalog -------------------------------------------------

  medications(query: MedicationListQuery = {}): Paged<Medication> {
    requirePermission(this.context(), 'prescription.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize ?? 100);
    const clauses: string[] = ['m.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (!query.includeInactive) clauses.push('m.is_active = 1');
    if (query.form && query.form.length > 0) {
      clauses.push(`m.form IN (${query.form.map(() => '?').join(', ')})`);
      params.push(...query.form);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(m.name LIKE ? ESCAPE '\\' OR m.strength LIKE ? ESCAPE '\\')`);
      params.push(term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM medications m${where}`).get(...params) as { total: number }).total);
    const rows = this.db
      .prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM prescription_items pi WHERE pi.medication_id = m.id) AS usage_count
           FROM medications m${where} ORDER BY m.name LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => this.mapMedication(row)),
      total,
      page,
      pageSize,
      pageCount: pageCount(total, pageSize),
    };
  }

  private mapMedication(row: Record<string, unknown>): Medication {
    return {
      id: asNumber(row['id']),
      name: asString(row['name']),
      form: asString(row['form'], 'tablet') as MedicationForm,
      strength: asString(row['strength']),
      defaultDoseMorning: asNumber(row['default_dose_morning']),
      defaultDoseNoon: asNumber(row['default_dose_noon']),
      defaultDoseNight: asNumber(row['default_dose_night']),
      defaultFoodTiming: asString(row['default_food_timing'], 'after_food') as Medication['defaultFoodTiming'],
      defaultDurationDays: row['default_duration_days'] === null ? null : asNumber(row['default_duration_days']),
      isActive: fromBoolInt(row['is_active']),
      usageCount: asNumber(row['usage_count']),
    };
  }

  saveMedication(id: number | null, input: MedicationInput): { id: number } {
    requirePermission(this.context(), 'prescription.create');
    if (input.name.trim().length < 2) throw AppError.validation('Medication name is too short.', { name: 'Enter the medication name.' });
    const now = this.context().instant();
    if (id) {
      const result = this.db
        .prepare(
          `UPDATE medications SET name = ?, form = ?, strength = ?, default_dose_morning = ?, default_dose_noon = ?,
             default_dose_night = ?, default_food_timing = ?, default_duration_days = ?, is_active = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(
          input.name.trim(),
          input.form,
          input.strength.trim(),
          input.defaultDoseMorning,
          input.defaultDoseNoon,
          input.defaultDoseNight,
          input.defaultFoodTiming,
          input.defaultDurationDays,
          toBoolInt(input.isActive),
          now,
          id,
        );
      if (result.changes === 0) throw AppError.notFound('Medication');
      this.syncMedicationFts(id);
      this.context().audit.record({ action: 'update', entityType: 'medication', entityId: id, entityLabel: input.name, detail: 'Medication updated' });
      return { id };
    }
    const duplicate = this.db
      .prepare(`SELECT id FROM medications WHERE lower(name) = lower(?) AND lower(form) = lower(?) AND lower(strength) = lower(?) AND deleted_at IS NULL`)
      .get(input.name.trim(), input.form, input.strength.trim()) as { id: number } | undefined;
    if (duplicate) throw AppError.conflict('This medication already exists in the catalog.');
    const result = this.db
      .prepare(
        `INSERT INTO medications (name, form, strength, default_dose_morning, default_dose_noon, default_dose_night,
           default_food_timing, default_duration_days, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name.trim(),
        input.form,
        input.strength.trim(),
        input.defaultDoseMorning,
        input.defaultDoseNoon,
        input.defaultDoseNight,
        input.defaultFoodTiming,
        input.defaultDurationDays,
        toBoolInt(input.isActive),
        now,
        now,
      );
    const newId = Number(result.lastInsertRowid);
    this.syncMedicationFts(newId);
    this.context().audit.record({ action: 'create', entityType: 'medication', entityId: newId, entityLabel: input.name, detail: 'Medication added to catalog' });
    return { id: newId };
  }

  deleteMedication(id: number): void {
    requirePermission(this.context(), 'prescription.create');
    const used = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM prescription_items WHERE medication_id = ?`).get(id) as { total: number }).total,
    );
    const ctx = this.context();
    if (used > 0) {
      // Never break issued prescriptions: deactivate instead of deleting.
      this.db.prepare(`UPDATE medications SET is_active = 0, updated_at = ? WHERE id = ?`).run(this.context().instant(), id);
      ctx.audit.record({
        action: 'update',
        entityType: 'medication',
        entityId: id,
        detail: `Medication deactivated (used by ${used} prescription line(s))`,
        severity: 'warning',
      });
      return;
    }
    this.db.prepare(`UPDATE medications SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(this.context().instant(), this.context().instant(), id);
    this.db.prepare(`DELETE FROM medications_fts WHERE rowid = ?`).run(id);
    ctx.audit.record({ action: 'delete', entityType: 'medication', entityId: id, detail: 'Medication removed from catalog' });
  }

  searchMedications(term: string, limit = 20): Medication[] {
    return this.medications({ search: term, pageSize: limit }).items;
  }

  private syncMedicationFts(id: number): void {
    const row = this.db.prepare(`SELECT id, name, strength, deleted_at, is_active FROM medications WHERE id = ?`).get(id) as
      | { id: number; name: string; strength: string; deleted_at: string | null; is_active: number }
      | undefined;
    this.db.prepare(`DELETE FROM medications_fts WHERE rowid = ?`).run(id);
    if (!row || row.deleted_at) return;
    this.db.prepare(`INSERT INTO medications_fts (rowid, name, strength) VALUES (?, ?, ?)`).run(row.id, row.name, row.strength);
  }

  // --- Clinical option sets (C/C, O/E, R/E, advice) ------------------------

  clinicalOptions(category?: ClinicalOptionCategory, includeInactive = false): ClinicalOption[] {
    requirePermission(this.context(), 'prescription.view');
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (!includeInactive) clauses.push('is_active = 1');
    if (category) {
      clauses.push('category = ?');
      params.push(category);
    }
    const rows = this.db
      .prepare(
        `SELECT *, (SELECT COUNT(*) FROM clinical_options co2 WHERE co2.id = clinical_options.id) AS usage_count
           FROM clinical_options WHERE ${clauses.join(' AND ')} ORDER BY category, sort_order, label`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      category: asString(row['category']) as ClinicalOptionCategory,
      label: asString(row['label']),
      sortOrder: asNumber(row['sort_order']),
      isActive: fromBoolInt(row['is_active']),
      usageCount: asNumber(row['usage_count']),
    }));
  }

  saveClinicalOption(id: number | null, input: { category: ClinicalOptionCategory; label: string; sortOrder: number; isActive: boolean }): { id: number } {
    requirePermission(this.context(), 'clinical_option.manage');
    const label = input.label.trim();
    if (label.length < 2) throw AppError.validation('Option text is too short.', { label: 'Enter the option text.' });
    const now = this.context().instant();
    if (id) {
      const result = this.db
        .prepare(`UPDATE clinical_options SET category = ?, label = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(input.category, label, input.sortOrder, toBoolInt(input.isActive), now, id);
      if (result.changes === 0) throw AppError.notFound('Clinical option');
      return { id };
    }
    const duplicate = this.db
      .prepare(`SELECT id FROM clinical_options WHERE category = ? AND lower(label) = lower(?) AND deleted_at IS NULL`)
      .get(input.category, label) as { id: number } | undefined;
    if (duplicate) throw AppError.conflict('This option already exists in that section.');
    const result = this.db
      .prepare(`INSERT INTO clinical_options (category, label, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.category, label, input.sortOrder, toBoolInt(input.isActive), now, now);
    const newId = Number(result.lastInsertRowid);
    this.context().audit.record({ action: 'create', entityType: 'clinical_option', entityId: newId, entityLabel: label, detail: 'Clinical option added' });
    return { id: newId };
  }

  /** Everything the print layer needs, in one call. */
  forPrint(id: number): {
    prescription: PrescriptionDetail;
    clinic: { name: string; address: string; phone: string; email: string; logoPath: string | null; clinicMessage: string };
    dentist: {
      name: string;
      designations: string[];
      qualifications: string[];
      certifications: string[];
      registrationNumber: string;
      visitingHours: string;
      signaturePath: string | null;
      phone: string;
      email: string;
    } | null;
  } {
    const prescription = this.get(id);
    const clinicRow = this.db.prepare(`SELECT * FROM clinic WHERE id = 1`).get() as
      | { name: string; address: string; phone: string; email: string; logo_path: string | null; clinic_message: string }
      | undefined;
    const dentistRow = prescription.dentistId
      ? (this.db
          .prepare(`SELECT * FROM dentists WHERE id = ?`)
          .get(prescription.dentistId) as
          | { id: number; name: string; phone: string; email: string; registration_number: string; visiting_hours: string; signature_path: string | null }
          | undefined)
      : undefined;
    const credentials = dentistRow
      ? (this.db
          .prepare(`SELECT type, title FROM dentist_credentials WHERE dentist_id = ? AND show_on_prescription = 1 ORDER BY type, sort_order, id`)
          .all(dentistRow.id) as Array<{ type: string; title: string }>)
      : [];
    return {
      prescription,
      clinic: {
        name: clinicRow?.name ?? '',
        address: clinicRow?.address ?? '',
        phone: clinicRow?.phone ?? '',
        email: clinicRow?.email ?? '',
        logoPath: clinicRow?.logo_path ?? null,
        clinicMessage: clinicRow?.clinic_message ?? '',
      },
      dentist: dentistRow
        ? {
            name: dentistRow.name,
            designations: credentials.filter((entry) => entry.type === 'designation').map((entry) => entry.title),
            qualifications: credentials.filter((entry) => entry.type === 'qualification').map((entry) => entry.title),
            certifications: credentials.filter((entry) => entry.type === 'certification').map((entry) => entry.title),
            registrationNumber: dentistRow.registration_number,
            visitingHours: dentistRow.visiting_hours,
            signaturePath: dentistRow.signature_path,
            phone: dentistRow.phone,
            email: dentistRow.email,
          }
        : null,
    };
  }

  /** True when the prescription may still be edited by this user. */
  canEdit(id: number): boolean {
    const row = this.db.prepare(`SELECT is_void, printed_at FROM prescriptions WHERE id = ?`).get(id) as
      | { is_void: number; printed_at: string | null }
      | undefined;
    if (!row) return false;
    return !fromBoolInt(row.is_void);
  }
}
