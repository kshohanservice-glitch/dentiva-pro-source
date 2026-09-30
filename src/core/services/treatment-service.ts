/**
 * Treatment records and treatment plans.
 *
 * The treatment *catalog* (codes, names, prices) is maintained through the
 * generic resource API; this service owns the clinical side: what was actually
 * performed on a patient, and the multi-session plan for the future.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type {
  Paged,
  Treatment,
  TreatmentPlan,
  TreatmentPlanInput,
  TreatmentPlanItem,
  TreatmentPlanItemInput,
  TreatmentRecord,
} from '@shared/types';
import { AppError } from '@shared/errors';
import { asNumber, asString, buildWhere, pageCount, paginate, parseJsonArray, toJsonArray } from '../db/sql';

export class TreatmentService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  // --- Records ------------------------------------------------------------

  private mapRecord(row: Record<string, unknown>): TreatmentRecord {
    return {
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
    };
  }

  recordsByPatient(patientId: number, limit = 100): TreatmentRecord[] {
    requirePermission(this.context(), 'treatment.view');
    const rows = this.db
      .prepare(
        `SELECT tr.*, d.name AS dentist_name FROM treatment_records tr
           LEFT JOIN dentists d ON d.id = tr.dentist_id
          WHERE tr.patient_id = ? AND tr.deleted_at IS NULL
          ORDER BY tr.performed_at DESC, tr.id DESC LIMIT ?`,
      )
      .all(patientId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRecord(row));
  }

  recordsByVisit(visitId: number): TreatmentRecord[] {
    requirePermission(this.context(), 'treatment.view');
    const rows = this.db
      .prepare(
        `SELECT tr.*, d.name AS dentist_name FROM treatment_records tr
           LEFT JOIN dentists d ON d.id = tr.dentist_id
          WHERE tr.visit_id = ? AND tr.deleted_at IS NULL ORDER BY tr.id`,
      )
      .all(visitId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRecord(row));
  }

  deleteRecord(id: number, reason: string): void {
    requirePermission(this.context(), 'visit.edit');
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for removing this treatment.', { reason: 'Reason is required.' });
    const record = this.db.prepare(`SELECT * FROM treatment_records WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { invoice_item_id: number | null; description: string; total_paisa: number }
      | undefined;
    if (!record) throw AppError.notFound('Treatment record');
    if (record.invoice_item_id) {
      throw AppError.precondition(
        'This treatment is included on an invoice. Remove it from the invoice first so the billing history stays consistent.',
      );
    }
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE treatment_records SET deleted_at = ?, deleted_reason = ? WHERE id = ?`).run(ctx.instant(), reason.trim(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'treatment_record',
        entityId: id,
        entityLabel: record.description,
        detail: `Treatment removed from the visit record. Reason: ${reason.trim()}`,
        severity: 'warning',
        before: { totalPaisa: record.total_paisa },
      });
    })();
  }

  /** Catalog options for pickers, ranked by usage. */
  catalogOptions(search: string, limit = 25): Array<{ value: number; label: string; meta: string }> {
    requirePermission(this.context(), 'treatment.view');
    const clauses: string[] = ['t.deleted_at IS NULL', 't.is_active = 1'];
    const params: unknown[] = [];
    if (search.trim() !== '') {
      const term = `%${search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(t.name LIKE ? ESCAPE '\\' OR t.code LIKE ? ESCAPE '\\' OR t.category LIKE ? ESCAPE '\\')`);
      params.push(term, term, term);
    }
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.code, t.category, t.price_paisa,
                (SELECT COUNT(*) FROM treatment_records tr WHERE tr.treatment_id = t.id AND tr.deleted_at IS NULL) AS usage_count
           FROM treatment_catalog t
          WHERE ${clauses.join(' AND ')}
          ORDER BY usage_count DESC, t.name LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: number;
      name: string;
      code: string;
      category: string;
      price_paisa: number;
      usage_count: number;
    }>;
    return rows.map((row) => ({
      value: row.id,
      label: row.name,
      meta: `${row.code} · ${(asNumber(row.price_paisa) / 100).toFixed(2)} BDT${row.category ? ` · ${row.category}` : ''}`,
    }));
  }

  catalogCategories(): string[] {
    requirePermission(this.context(), 'treatment.view');
    const rows = this.db
      .prepare(`SELECT DISTINCT category FROM treatment_catalog WHERE deleted_at IS NULL AND trim(category) <> '' ORDER BY category`)
      .all() as Array<{ category: string }>;
    return rows.map((row) => row.category);
  }

  // --- Plans --------------------------------------------------------------

  listPlans(query: { patientId?: number; status?: string; page?: number; pageSize?: number } = {}): Paged<TreatmentPlan> {
    requirePermission(this.context(), 'treatment.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = ['tp.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.patientId) {
      clauses.push('tp.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.status) {
      clauses.push('tp.status = ?');
      params.push(query.status);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM treatment_plans tp${where}`).get(...params) as { total: number }).total,
    );
    const rows = this.db
      .prepare(`SELECT tp.id FROM treatment_plans tp${where} ORDER BY tp.created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ id: number }>;
    return {
      items: rows.map((row) => this.getPlan(row.id)),
      total,
      page,
      pageSize,
      pageCount: pageCount(total, pageSize),
    };
  }

  getPlan(id: number): TreatmentPlan {
    requirePermission(this.context(), 'treatment.view');
    const row = this.db
      .prepare(
        `SELECT tp.*, trim(p.first_name || ' ' || p.last_name) AS patient_name, u.full_name AS created_by_name
           FROM treatment_plans tp
           JOIN patients p ON p.id = tp.patient_id
           LEFT JOIN users u ON u.id = tp.created_by
          WHERE tp.id = ? AND tp.deleted_at IS NULL`,
      )
      .get(id) as
      | {
          id: number;
          patient_id: number;
          patient_name: string;
          title: string;
          status: TreatmentPlan['status'];
          notes: string;
          created_at: string;
          created_by_name: string | null;
        }
      | undefined;
    if (!row) throw AppError.notFound('Treatment plan');
    const items = this.planItems(id);
    const estimated = items.reduce((sum, item) => sum + item.estimatedPaisa, 0);
    return {
      id: row.id,
      patientId: row.patient_id,
      patientName: row.patient_name,
      title: row.title,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      createdByName: row.created_by_name ?? '—',
      estimatedTotalPaisa: estimated,
      completedItems: items.filter((item) => item.status === 'completed').length,
      items,
    };
  }

  private planItems(planId: number): TreatmentPlanItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM treatment_plan_items WHERE plan_id = ? ORDER BY session_number, sort_order, id`)
      .all(planId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      planId: asNumber(row['plan_id']),
      treatmentId: row['treatment_id'] === null ? null : asNumber(row['treatment_id']),
      description: asString(row['description']),
      toothCodes: parseJsonArray(row['tooth_codes']),
      sessionNumber: asNumber(row['session_number'], 1),
      estimatedPaisa: asNumber(row['estimated_paisa']),
      status: asString(row['status'], 'pending') as TreatmentPlanItem['status'],
      notes: asString(row['notes']),
      completedVisitId: row['completed_visit_id'] === null ? null : asNumber(row['completed_visit_id']),
    }));
  }

  createPlan(input: TreatmentPlanInput): { id: number } {
    requirePermission(this.context(), 'treatment.view');
    if (input.title.trim().length < 2) throw AppError.validation('Give the plan a title.', { title: 'Title is required.' });
    const patient = this.db.prepare(`SELECT id FROM patients WHERE id = ? AND deleted_at IS NULL`).get(input.patientId);
    if (!patient) throw AppError.notFound('Patient');
    const ctx = this.context();
    const now = this.context().instant();
    const result = this.db
      .prepare(
        `INSERT INTO treatment_plans (patient_id, title, status, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.patientId, input.title.trim(), input.status, input.notes.trim(), currentUserId(ctx), now, now);
    const id = Number(result.lastInsertRowid);
    ctx.audit.record({
      action: 'create',
      entityType: 'treatment_plan',
      entityId: id,
      entityLabel: input.title,
      detail: `Treatment plan created for patient #${input.patientId}`,
    });
    return { id };
  }

  updatePlan(id: number, input: TreatmentPlanInput): void {
    requirePermission(this.context(), 'treatment.view');
    const result = this.db
      .prepare(`UPDATE treatment_plans SET title = ?, status = ?, notes = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(input.title.trim(), input.status, input.notes.trim(), this.context().instant(), id);
    if (result.changes === 0) throw AppError.notFound('Treatment plan');
    this.context().audit.record({
      action: 'update',
      entityType: 'treatment_plan',
      entityId: id,
      entityLabel: input.title,
      detail: 'Treatment plan updated',
    });
  }

  deletePlan(id: number, reason?: string): void {
    requirePermission(this.context(), 'treatment.view');
    const result = this.db
      .prepare(`UPDATE treatment_plans SET deleted_at = ?, notes = trim(notes || ?) WHERE id = ? AND deleted_at IS NULL`)
      .run(this.context().instant(), reason ? `\n[Removed: ${reason.trim()}]` : '', id);
    if (result.changes === 0) throw AppError.notFound('Treatment plan');
    this.context().audit.record({
      action: 'soft_delete',
      entityType: 'treatment_plan',
      entityId: id,
      detail: reason ? `Treatment plan removed. Reason: ${reason.trim()}` : 'Treatment plan removed',
      severity: 'warning',
    });
  }

  savePlanItem(planId: number, input: TreatmentPlanItemInput): { id: number } {
    requirePermission(this.context(), 'treatment.view');
    const plan = this.db.prepare(`SELECT id FROM treatment_plans WHERE id = ? AND deleted_at IS NULL`).get(planId);
    if (!plan) throw AppError.notFound('Treatment plan');
    if (input.description.trim() === '')
      throw AppError.validation('Describe the planned treatment.', { description: 'Description is required.' });
    if (!Number.isFinite(input.estimatedPaisa) || input.estimatedPaisa < 0) {
      throw AppError.validation('Estimated amount cannot be negative.', { estimatedPaisa: 'Enter a positive amount.' });
    }
    const planStatuses: readonly string[] = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!planStatuses.includes(input.status)) {
      throw AppError.validation('Choose a valid plan item status.', { status: 'Unsupported status.' });
    }
    const sessionNumber = Number.isFinite(input.sessionNumber) ? Math.max(1, Math.round(input.sessionNumber)) : 1;
    if (input.id) {
      const result = this.db
        .prepare(
          `UPDATE treatment_plan_items SET treatment_id = ?, description = ?, tooth_codes = ?, session_number = ?,
             estimated_paisa = ?, status = ?, notes = ?, completed_visit_id = ? WHERE id = ? AND plan_id = ?`,
        )
        .run(
          input.treatmentId,
          input.description.trim(),
          toJsonArray(input.toothCodes),
          sessionNumber,
          Math.round(input.estimatedPaisa),
          input.status,
          input.notes.trim(),
          input.completedVisitId ?? null,
          input.id,
          planId,
        );
      if (result.changes === 0) throw AppError.notFound('Plan item');
      return { id: input.id };
    }
    const nextOrder = asNumber(
      (
        this.db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM treatment_plan_items WHERE plan_id = ?`).get(planId) as {
          next: number;
        }
      ).next,
      1,
    );
    const result = this.db
      .prepare(
        `INSERT INTO treatment_plan_items
           (plan_id, treatment_id, description, tooth_codes, session_number, estimated_paisa, status, notes, completed_visit_id, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        planId,
        input.treatmentId,
        input.description.trim(),
        toJsonArray(input.toothCodes),
        sessionNumber,
        Math.round(input.estimatedPaisa),
        input.status,
        input.notes.trim(),
        input.completedVisitId ?? null,
        nextOrder,
      );
    return { id: Number(result.lastInsertRowid) };
  }

  deletePlanItem(id: number, reason?: string): void {
    requirePermission(this.context(), 'treatment.view');
    const item = this.db.prepare(`SELECT plan_id, status FROM treatment_plan_items WHERE id = ?`).get(id) as
      | { plan_id: number; status: string }
      | undefined;
    if (!item) throw AppError.notFound('Plan item');
    if (item.status === 'completed') {
      throw AppError.precondition('Completed plan items are part of the patient history and cannot be deleted.');
    }
    this.db.prepare(`DELETE FROM treatment_plan_items WHERE id = ?`).run(id);
    this.context().audit.record({
      action: 'delete',
      entityType: 'treatment_plan_item',
      entityId: id,
      entityLabel: `Plan item #${id}`,
      detail: reason ? `Plan item removed. Reason: ${reason.trim()}` : 'Plan item removed',
    });
  }

  completePlanItem(id: number, visitId: number | null): void {
    requirePermission(this.context(), 'treatment.view');
    const result = this.db
      .prepare(`UPDATE treatment_plan_items SET status = 'completed', completed_visit_id = ? WHERE id = ?`)
      .run(visitId, id);
    if (result.changes === 0) throw AppError.notFound('Plan item');
    this.context().audit.record({ action: 'update', entityType: 'treatment_plan_item', entityId: id, detail: 'Plan item marked complete' });
  }

  // --- Reporting helpers ---------------------------------------------------

  /** Most performed treatments in a date range (used by reports and dashboard). */
  usageRanking(from: string, to: string, limit = 10): Array<{ label: string; value: number; amountPaisa: number }> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(trim(tr.description), ''), 'Treatment') AS label,
                COUNT(*) AS value, COALESCE(SUM(tr.total_paisa), 0) AS amount
           FROM treatment_records tr
          WHERE tr.deleted_at IS NULL AND tr.performed_at BETWEEN ? AND ?
          GROUP BY lower(label) ORDER BY value DESC LIMIT ?`,
      )
      .all(from, to, limit) as Array<{ label: string; value: number; amount: number }>;
    return rows.map((row) => ({ label: row.label, value: asNumber(row.value), amountPaisa: asNumber(row.amount) }));
  }

  catalog(search: string, page = 1, pageSize = 25, category?: string | null): Paged<Treatment> {
    requirePermission(this.context(), 'treatment.view');
    const { limit, offset } = paginate(page, pageSize);
    const clauses: string[] = ['t.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (search.trim() !== '') {
      const term = `%${search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(t.name LIKE ? ESCAPE '\\' OR t.code LIKE ? ESCAPE '\\')`);
      params.push(term, term);
    }
    if (category) {
      clauses.push('t.category = ?');
      params.push(category);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM treatment_catalog t${where}`).get(...params) as { total: number }).total,
    );
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM treatment_records tr WHERE tr.treatment_id = t.id AND tr.deleted_at IS NULL) AS usage_count
           FROM treatment_catalog t${where} ORDER BY t.category, t.name LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({
        id: asNumber(row['id']),
        code: asString(row['code']),
        name: asString(row['name']),
        category: asString(row['category']),
        description: asString(row['description']),
        pricePaisa: asNumber(row['price_paisa']),
        durationMinutes: asNumber(row['duration_minutes'], 30),
        isActive: row['is_active'] === 1 || row['is_active'] === true,
        usageCount: asNumber(row['usage_count']),
      })),
      total,
      page,
      pageSize,
      pageCount: pageCount(total, pageSize),
    };
  }
}
