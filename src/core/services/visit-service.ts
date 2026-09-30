/**
 * Visit records — the core clinical history.
 *
 * A visit is append-only in spirit: editing updates the current visit and is
 * fully audited, while previous visits are never overwritten. Saving a visit can
 * create treatment records, dental findings and (via the prescription service)
 * link a prescription to the visit.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type { Paged, ToothFinding, TreatmentRecord, TreatmentRecordInput, VisitDetail, VisitInput, VisitSummary } from '@shared/types';
import { AppError } from '@shared/errors';
import { resolveDateRange, todayIso } from '@shared/dates';
import { asNumber, asString, buildWhere, pageCount, paginate, parseJsonArray, toJsonArray } from '../db/sql';
import type { DentalService } from './dental-service';

interface VisitRow {
  id: number;
  patient_id: number;
  patient_code: string;
  patient_name: string;
  dentist_id: number | null;
  dentist_name: string | null;
  visit_date: string;
  visit_time: string;
  chief_complaint: string;
  history: string;
  examination: string;
  diagnosis: string;
  advice: string;
  notes: string;
  follow_up_date: string | null;
  cc_options: string;
  oe_options: string;
  re_options: string;
  advice_options: string;
  created_at: string;
  treatment_count?: number;
  prescription_count?: number;
  invoice_id?: number | null;
  invoice_number?: string | null;
  invoice_total?: number | null;
}

const VISIT_SELECT = `
  SELECT v.*, p.code AS patient_code,
         trim(p.first_name || ' ' || p.last_name) AS patient_name,
         d.name AS dentist_name,
         (SELECT COUNT(*) FROM treatment_records tr WHERE tr.visit_id = v.id AND tr.deleted_at IS NULL) AS treatment_count,
         (SELECT COUNT(*) FROM prescriptions pr WHERE pr.visit_id = v.id AND pr.deleted_at IS NULL) AS prescription_count,
         (SELECT i.id FROM invoices i WHERE i.visit_id = v.id AND i.deleted_at IS NULL ORDER BY i.id LIMIT 1) AS invoice_id,
         (SELECT i.number FROM invoices i WHERE i.visit_id = v.id AND i.deleted_at IS NULL ORDER BY i.id LIMIT 1) AS invoice_number,
         (SELECT i.total_paisa FROM invoices i WHERE i.visit_id = v.id AND i.deleted_at IS NULL ORDER BY i.id LIMIT 1) AS invoice_total
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN dentists d ON d.id = v.dentist_id
`;

export class VisitService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly dental: DentalService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private mapSummary(row: VisitRow): VisitSummary {
    const invoiceTotal = row.invoice_total === null || row.invoice_total === undefined ? null : asNumber(row.invoice_total);
    return {
      id: row.id,
      patientId: row.patient_id,
      patientCode: row.patient_code,
      patientName: row.patient_name,
      dentistId: row.dentist_id,
      dentistName: row.dentist_name ?? 'Unassigned',
      visitDate: row.visit_date,
      visitTime: row.visit_time,
      chiefComplaint: row.chief_complaint,
      diagnosis: row.diagnosis,
      treatmentCount: asNumber(row.treatment_count),
      hasPrescription: asNumber(row.prescription_count) > 0,
      invoiceId: row.invoice_id ?? null,
      invoiceNumber: row.invoice_number ?? null,
      invoiceTotalPaisa: invoiceTotal,
      followUpDate: row.follow_up_date,
      createdAt: row.created_at,
    };
  }

  list(query: {
    page?: number;
    pageSize?: number;
    search?: string;
    sort?: string;
    direction?: 'asc' | 'desc';
    preset?: string;
    from?: string;
    to?: string;
    patientId?: number;
    dentistId?: number | null;
  }): Paged<VisitSummary> {
    requirePermission(this.context(), 'visit.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const params: unknown[] = [];
    const clauses: string[] = ['v.deleted_at IS NULL'];
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    const range = preset ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } }) : { from: query.from, to: query.to };
    if (range.from) {
      clauses.push('v.visit_date >= ?');
      params.push(range.from);
    }
    if (range.to) {
      clauses.push('v.visit_date <= ?');
      params.push(range.to);
    }
    if (query.patientId) {
      clauses.push('v.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.dentistId) {
      clauses.push('v.dentist_id = ?');
      params.push(query.dentistId);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(p.code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR p.first_name || ' ' || p.last_name LIKE ? ESCAPE '\\'
                    OR v.chief_complaint LIKE ? ESCAPE '\\' OR v.diagnosis LIKE ? ESCAPE '\\')`);
      params.push(term, term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db.prepare(`SELECT COUNT(*) AS total FROM visits v JOIN patients p ON p.id = v.patient_id${where}`).get(...params) as {
          total: number;
        }
      ).total,
    );
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(`${VISIT_SELECT}${where} ORDER BY v.visit_date ${direction}, v.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as VisitRow[];
    return { items: rows.map((row) => this.mapSummary(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): VisitDetail {
    requirePermission(this.context(), 'visit.view');
    const row = this.db.prepare(`${VISIT_SELECT} WHERE v.id = ? AND v.deleted_at IS NULL`).get(id) as VisitRow | undefined;
    if (!row) throw AppError.notFound('Visit');
    const treatments = this.treatmentRecordsForVisit(id);
    const findings = this.db
      .prepare(
        `SELECT tf.*, u.full_name AS recorded_by_name, v.visit_date
           FROM tooth_findings tf
           LEFT JOIN users u ON u.id = tf.recorded_by
           LEFT JOIN visits v ON v.id = tf.visit_id
          WHERE tf.visit_id = ? AND tf.is_active = 1
          ORDER BY tf.tooth_fdi`,
      )
      .all(id) as Array<Record<string, unknown>>;
    const prescriptionIds = (
      this.db.prepare(`SELECT id FROM prescriptions WHERE visit_id = ? AND deleted_at IS NULL ORDER BY id`).all(id) as Array<{ id: number }>
    ).map((entry) => entry.id);
    const referralIds = (this.db.prepare(`SELECT id FROM referrals WHERE visit_id = ? ORDER BY id`).all(id) as Array<{ id: number }>).map(
      (entry) => entry.id,
    );
    const attachmentIds = (
      this.db
        .prepare(`SELECT id FROM attachments WHERE entity_type = 'visit' AND entity_id = ? AND deleted_at IS NULL ORDER BY id`)
        .all(id) as Array<{ id: number }>
    ).map((entry) => entry.id);
    const summary = this.mapSummary(row);
    return {
      ...summary,
      history: row.history,
      examination: row.examination,
      advice: row.advice,
      notes: row.notes,
      ccOptions: parseJsonArray(row.cc_options),
      oeOptions: parseJsonArray(row.oe_options),
      reOptions: parseJsonArray(row.re_options),
      adviceOptions: parseJsonArray(row.advice_options),
      findings: findings.map((finding) => this.dental.mapFindingRow(finding)),
      treatments,
      prescriptionIds,
      referralIds,
      attachmentIds,
    };
  }

  private treatmentRecordsForVisit(visitId: number): TreatmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT tr.*, d.name AS dentist_name FROM treatment_records tr
          LEFT JOIN dentists d ON d.id = tr.dentist_id
         WHERE tr.visit_id = ? AND tr.deleted_at IS NULL ORDER BY tr.id`,
      )
      .all(visitId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      visitId: row['visit_id'] === null ? null : asNumber(row['visit_id']),
      patientId: asNumber(row['patient_id']),
      treatmentId: row['treatment_id'] === null ? null : asNumber(row['treatment_id']),
      code: asString(row['code']),
      description: asString(row['description']),
      toothCodes: parseJsonArray(row['tooth_codes']),
      quantity: asNumber(row['quantity'], 1),
      unitPricePaisa: asNumber(row['unit_price_paisa']),
      discountPaisa: asNumber(row['discount_paisa']),
      totalPaisa: asNumber(row['total_paisa']),
      dentistId: row['dentist_id'] === null ? null : asNumber(row['dentist_id']),
      dentistName: asString(row['dentist_name'], 'Unassigned'),
      performedAt: asString(row['performed_at']),
      invoiceItemId: row['invoice_item_id'] === null ? null : asNumber(row['invoice_item_id']),
      notes: asString(row['notes']),
    }));
  }

  byPatient(patientId: number, limit = 50): VisitSummary[] {
    requirePermission(this.context(), 'visit.view');
    const rows = this.db
      .prepare(`${VISIT_SELECT} WHERE v.patient_id = ? AND v.deleted_at IS NULL ORDER BY v.visit_date DESC, v.id DESC LIMIT ?`)
      .all(patientId, limit) as VisitRow[];
    return rows.map((row) => this.mapSummary(row));
  }

  create(input: VisitInput): { id: number } {
    requirePermission(this.context(), 'visit.create');
    this.validate(input);
    const ctx = this.context();
    const id = this.db.transaction(() => {
      const now = ctx.instant();
      const result = this.db
        .prepare(
          `INSERT INTO visits (
             patient_id, dentist_id, visit_date, visit_time, chief_complaint, history, examination, diagnosis,
             advice, notes, follow_up_date, cc_options, oe_options, re_options, advice_options, created_by, created_at, updated_at
           ) VALUES (
             @patientId, @dentistId, @visitDate, @visitTime, @chiefComplaint, @history, @examination, @diagnosis,
             @advice, @notes, @followUpDate, @ccOptions, @oeOptions, @reOptions, @adviceOptions, @createdBy, @createdAt, @updatedAt
           )`,
        )
        .run({
          patientId: input.patientId,
          dentistId: input.dentistId,
          visitDate: input.visitDate,
          visitTime: input.visitTime,
          chiefComplaint: input.chiefComplaint.trim(),
          history: input.history.trim(),
          examination: input.examination.trim(),
          diagnosis: input.diagnosis.trim(),
          advice: input.advice.trim(),
          notes: input.notes.trim(),
          followUpDate: input.followUpDate,
          ccOptions: toJsonArray(input.ccOptions),
          oeOptions: toJsonArray(input.oeOptions),
          reOptions: toJsonArray(input.reOptions),
          adviceOptions: toJsonArray(input.adviceOptions),
          createdBy: currentUserId(ctx),
          createdAt: now,
          updatedAt: now,
        });
      const visitId = Number(result.lastInsertRowid);
      this.saveTreatments(visitId, input.patientId, input.dentistId, input.visitDate, input.treatments);
      if (input.dentalFindings.length > 0) {
        this.dental.saveFindingsInternal({
          patientId: input.patientId,
          dentition: 'permanent',
          findings: input.dentalFindings,
          visitId,
          clearTeeth: [],
          userId: currentUserId(ctx),
        });
      }
      if (input.prescriptionId) {
        const exists = this.db.prepare(`SELECT id FROM prescriptions WHERE id = ? AND deleted_at IS NULL`).get(input.prescriptionId);
        if (!exists) throw AppError.notFound('Prescription');
        this.db
          .prepare(`UPDATE prescriptions SET visit_id = ?, updated_at = ? WHERE id = ?`)
          .run(visitId, ctx.instant(), input.prescriptionId);
      }
      this.db
        .prepare(
          `UPDATE queue_entries SET visit_id = ?, status = 'completed',` +
            ` completed_at = ? WHERE patient_id = ? AND status = 'in_consultation'`,
        )
        .run(visitId, ctx.instant(), input.patientId);
      this.db
        .prepare(
          `UPDATE appointments SET visit_id = ?, status = 'completed', updated_at = ? WHERE` +
            ` patient_id = ? AND date = ? AND status IN ('arrived','in_queue','in_treatment')`,
        )
        .run(visitId, ctx.instant(), input.patientId, input.visitDate);
      ctx.audit.record({
        action: 'create',
        entityType: 'visit',
        entityId: visitId,
        entityLabel: `Visit ${input.visitDate}`,
        detail: `Visit recorded for patient #${input.patientId}`,
        after: { date: input.visitDate, diagnosis: input.diagnosis, treatments: input.treatments.length },
      });
      return visitId;
    })();
    ctx.notify?.('visits.changed', { id });
    return { id };
  }

  update(id: number, input: VisitInput): void {
    requirePermission(this.context(), 'visit.edit');
    this.validate(input);
    const ctx = this.context();
    const before = this.db.prepare(`SELECT * FROM visits WHERE id` + ` = ? AND deleted_at IS NULL`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!before) throw AppError.notFound('Visit');
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE visits SET
             dentist_id = @dentistId, visit_date = @visitDate, visit_time = @visitTime, chief_complaint = @chiefComplaint,
             history = @history, examination = @examination, diagnosis = @diagnosis, advice = @advice, notes = @notes,
             follow_up_date = @followUpDate, cc_options = @ccOptions, oe_options = @oeOptions, re_options = @reOptions,
             advice_options = @adviceOptions, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          dentistId: input.dentistId,
          visitDate: input.visitDate,
          visitTime: input.visitTime,
          chiefComplaint: input.chiefComplaint.trim(),
          history: input.history.trim(),
          examination: input.examination.trim(),
          diagnosis: input.diagnosis.trim(),
          advice: input.advice.trim(),
          notes: input.notes.trim(),
          followUpDate: input.followUpDate,
          ccOptions: toJsonArray(input.ccOptions),
          oeOptions: toJsonArray(input.oeOptions),
          reOptions: toJsonArray(input.reOptions),
          adviceOptions: toJsonArray(input.adviceOptions),
          updatedAt: ctx.instant(),
        });
      this.saveTreatments(id, input.patientId, input.dentistId, input.visitDate, input.treatments);
      if (input.dentalFindings.length > 0) {
        this.dental.saveFindingsInternal({
          patientId: input.patientId,
          dentition: 'permanent',
          findings: input.dentalFindings,
          visitId: id,
          clearTeeth: [],
          userId: currentUserId(ctx),
        });
      }
      ctx.audit.record({
        action: 'update',
        entityType: 'visit',
        entityId: id,
        entityLabel: `Visit ${input.visitDate}`,
        detail: 'Visit record updated',
        before: {
          diagnosis: before['diagnosis'],
          chiefComplaint: before['chief_complaint'],
          notes: before['notes'],
          followUpDate: before['follow_up_date'],
        },
        after: { diagnosis: input.diagnosis, chiefComplaint: input.chiefComplaint, notes: input.notes, followUpDate: input.followUpDate },
      });
    })();
    ctx.notify?.('visits.changed', { id });
  }

  private saveTreatments(
    visitId: number,
    patientId: number,
    dentistId: number | null,
    performedAt: string,
    treatments: readonly TreatmentRecordInput[],
  ): void {
    const ctx = this.context();
    for (const treatment of treatments) {
      const quantity = Math.max(1, Math.round(treatment.quantity));
      const unitPrice = Math.max(0, Math.round(treatment.unitPricePaisa));
      const discount = Math.max(0, Math.min(Math.round(treatment.discountPaisa), unitPrice * quantity));
      const total = unitPrice * quantity - discount;
      const payload = {
        patientId,
        visitId,
        treatmentId: treatment.treatmentId,
        code: treatment.code ?? '',
        description: treatment.description.trim(),
        toothCodes: toJsonArray(treatment.toothCodes),
        quantity,
        unitPrice,
        discount,
        total,
        dentistId,
        performedAt,
        notes: treatment.notes.trim(),
      };
      if (treatment.id) {
        const invoiceItem = this.db.prepare(`SELECT invoice_item_id FROM treatment_records WHERE id = ?`).get(treatment.id) as
          | { invoice_item_id: number | null }
          | undefined;
        if (invoiceItem?.invoice_item_id) {
          throw AppError.precondition(
            'This treatment is already on an invoice and cannot be changed from the visit. Amend the invoice instead.',
          );
        }
        this.db
          .prepare(
            `UPDATE treatment_records SET treatment_id = @treatmentId, code = @code, description = @description,
               tooth_codes = @toothCodes, quantity = @quantity, unit_price_paisa = @unitPrice, discount_paisa = @discount,
               total_paisa = @total, dentist_id = @dentistId, performed_at = @performedAt, notes = @notes
             WHERE id = @id`,
          )
          .run({ ...payload, id: treatment.id });
        ctx.audit.record({
          action: 'update',
          entityType: 'treatment_record',
          entityId: treatment.id,
          entityLabel: treatment.description,
          detail: 'Treatment updated',
          before: { total: treatment.unitPricePaisa * quantity },
          after: { total },
        });
      } else {
        const result = this.db
          .prepare(
            `INSERT INTO treatment_records (
               patient_id, visit_id, treatment_id, code, description, tooth_codes, quantity, unit_price_paisa,
               discount_paisa, total_paisa, dentist_id, performed_at, notes, created_by, created_at
             ) VALUES (
               @patientId, @visitId, @treatmentId, @code, @description, @toothCodes, @quantity, @unitPrice,
               @discount, @total, @dentistId, @performedAt, @notes, @createdBy, @createdAt
             )`,
          )
          .run({ ...payload, createdBy: currentUserId(ctx), createdAt: ctx.instant() });
        const newId = Number(result.lastInsertRowid);
        ctx.audit.record({
          action: 'create',
          entityType: 'treatment_record',
          entityId: newId,
          entityLabel: treatment.description,
          detail: 'Treatment recorded during a visit',
          after: { total },
        });
      }
    }
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'visit.delete');
    const visit = this.db.prepare(`SELECT id, patient_id, visit_date FROM visits WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { id: number; patient_id: number; visit_date: string }
      | undefined;
    if (!visit) throw AppError.notFound('Visit');
    if (reason.trim().length < 3) {
      throw AppError.validation('Please give a reason for removing this visit.', { reason: 'Reason is required.' });
    }
    if (confirmText?.trim() !== 'DELETE') {
      throw AppError.validation('Type DELETE to confirm removing this clinical record.', { confirmText: 'Type DELETE to confirm.' });
    }
    const ctx = this.context();
    this.db.transaction(() => {
      const now = ctx.instant();
      this.db.prepare(`UPDATE visits SET deleted_at = ?, deleted_reason = ? WHERE id = ?`).run(now, reason.trim(), id);
      this.db
        .prepare(`UPDATE treatment_records SET deleted_at =` + ` ?, deleted_reason = ? WHERE visit_id = ?`)
        .run(now, `Visit removed: ${reason.trim()}`, id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'visit',
        entityId: id,
        entityLabel: `Visit ${visit.visit_date}`,
        detail: `Visit removed. Reason: ${reason.trim()}`,
        severity: 'critical',
        before: { deleted: false },
        after: { deleted: true, reason: reason.trim() },
      });
    })();
    ctx.notify?.('visits.changed', { id });
  }

  statistics(options: { preset?: string; from?: string; to?: string; dentistId?: number | null } = {}): {
    total: number;
    byDentist: Array<{ dentistId: number | null; dentistName: string; count: number }>;
    byDay: Array<{ date: string; count: number }>;
    topDiagnoses: Array<{ label: string; value: number }>;
  } {
    requirePermission(this.context(), 'visit.view');
    const range = resolveDateRange((options.preset ?? 'last_30_days') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const params: unknown[] = [range.from, range.to];
    let dentistClause = '';
    if (options.dentistId) {
      dentistClause = ' AND v.dentist_id = ?';
      params.push(options.dentistId);
    }
    const total = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM visits v WHERE v.deleted_at IS NULL AND v.visit_date BETWEEN ? AND ?${dentistClause}`)
          .get(...params) as { total: number }
      ).total,
    );
    const byDentist = (
      this.db
        .prepare(
          `SELECT v.dentist_id, COALESCE(d.name, 'Unassigned') AS dentist_name, COUNT(*) AS count
             FROM visits v LEFT JOIN dentists d ON d.id = v.dentist_id
            WHERE v.deleted_at IS NULL AND v.visit_date BETWEEN ? AND ?${dentistClause}
            GROUP BY v.dentist_id ORDER BY count DESC`,
        )
        .all(...params) as Array<{ dentist_id: number | null; dentist_name: string; count: number }>
    ).map((row) => ({ dentistId: row.dentist_id, dentistName: row.dentist_name, count: asNumber(row.count) }));
    const byDay = (
      this.db
        .prepare(
          `SELECT v.visit_date AS date, COUNT(*) AS count FROM visits v
            WHERE v.deleted_at IS NULL AND v.visit_date BETWEEN ? AND ?${dentistClause}
            GROUP BY date ORDER BY date`,
        )
        .all(...params) as Array<{ date: string; count: number }>
    ).map((row) => ({ date: row.date, count: asNumber(row.count) }));
    const topDiagnoses = (
      this.db
        .prepare(
          `SELECT trim(v.diagnosis) AS label, COUNT(*) AS value FROM visits v
            WHERE v.deleted_at IS NULL AND trim(v.diagnosis) <> '' AND v.visit_date BETWEEN ? AND ?
            GROUP BY lower(trim(v.diagnosis)) ORDER BY value DESC LIMIT 10`,
        )
        .all(range.from, range.to) as Array<{ label: string; value: number }>
    ).map((row) => ({ label: row.label, value: asNumber(row.value) }));
    return { total, byDentist, byDay, topDiagnoses };
  }

  private validate(input: VisitInput): void {
    const fieldErrors: Record<string, string> = {};
    if (!input.patientId) fieldErrors.patientId = 'Select a patient.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.visitDate)) fieldErrors.visitDate = 'Select a valid visit date.';
    if (!/^\d{2}:\d{2}$/.test(input.visitTime)) fieldErrors.visitTime = 'Select a valid visit time.';
    if (input.visitDate > todayIso() && !input.followUpDate) {
      // A future visit is allowed (planned treatment) but worth validating the date.
    }
    if (input.followUpDate && input.followUpDate < input.visitDate) {
      fieldErrors.followUpDate = 'Follow-up cannot be before the visit date.';
    }
    if (
      input.chiefComplaint.trim() === '' &&
      input.diagnosis.trim() === '' &&
      input.treatments.length === 0 &&
      input.dentalFindings.length === 0
    ) {
      fieldErrors.chiefComplaint = 'Record at least the chief complaint, a diagnosis, a treatment or a chart finding.';
    }
    for (const treatment of input.treatments) {
      if (treatment.description.trim() === '') {
        fieldErrors.treatments = 'Every treatment line needs a description.';
        break;
      }
      if (treatment.quantity <= 0 || !Number.isFinite(treatment.quantity)) {
        fieldErrors.treatments = 'Treatment quantity must be greater than zero.';
        break;
      }
      if (treatment.unitPricePaisa < 0) {
        fieldErrors.treatments = 'Treatment price cannot be negative.';
        break;
      }
    }
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  /** Findings attached to a visit (used by the print/report layer). */
  findingsForVisit(visitId: number): ToothFinding[] {
    const rows = this.db
      .prepare(
        `SELECT tf.*, u.full_name AS recorded_by_name, v.visit_date FROM tooth_findings tf
           LEFT JOIN users u ON u.id = tf.recorded_by
           LEFT JOIN visits v ON v.id = tf.visit_id
          WHERE tf.visit_id = ? AND tf.is_active = 1 ORDER BY tf.tooth_fdi`,
      )
      .all(visitId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.dental.mapFindingRow(row));
  }
}
