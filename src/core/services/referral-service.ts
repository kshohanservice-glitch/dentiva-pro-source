/**
 * Referrals: patients sent to (or received from) other clinicians.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { requirePermission } from '../context';
import type { Paged, Referral, ReferralInput } from '@shared/types';
import type { ReferralStatus } from '@shared/constants';
import { AppError } from '@shared/errors';
import { asNumber, asString, buildWhere, pageCount, paginate } from '../db/sql';

interface ReferralRow {
  id: number;
  patient_id: number;
  patient_code: string;
  patient_name: string;
  visit_id: number | null;
  referral_doctor_id: number | null;
  doctor_name: string;
  specialty: string;
  organisation: string;
  contact: string;
  reason: string;
  date: string;
  follow_up_date: string | null;
  status: string;
  notes: string;
  created_at: string;
  created_by_name: string | null;
}

const SELECT = `
  SELECT r.*, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
         (SELECT full_name FROM users u WHERE u.id = r.created_by) AS created_by_name
    FROM referrals r JOIN patients p ON p.id = r.patient_id
`;

export class ReferralService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private map(row: ReferralRow): Referral {
    return {
      id: row.id,
      patientId: row.patient_id,
      patientCode: row.patient_code,
      patientName: row.patient_name,
      visitId: row.visit_id,
      referralDoctorId: row.referral_doctor_id,
      doctorName: row.doctor_name,
      specialty: row.specialty,
      organisation: row.organisation,
      contact: row.contact,
      reason: row.reason,
      date: row.date,
      followUpDate: row.follow_up_date,
      status: row.status as ReferralStatus,
      notes: row.notes,
      createdByName: row.created_by_name ?? '—',
      createdAt: row.created_at,
    };
  }

  list(
    query: { page?: number; pageSize?: number; patientId?: number; status?: string; search?: string; from?: string; to?: string } = {},
  ): Paged<Referral> {
    requirePermission(this.context(), 'patient.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.patientId) {
      clauses.push('r.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.status) {
      clauses.push('r.status = ?');
      params.push(query.status);
    }
    if (query.from) {
      clauses.push('r.date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      clauses.push('r.date <= ?');
      params.push(query.to);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(
        `(p.code LIKE ? ESCAPE '\\' OR (p.first_name || ' ' || p.last_name)` + ` LIKE ? ESCAPE '\\' OR r.doctor_name LIKE ? ESCAPE '\\')`,
      );
      params.push(term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db.prepare(`SELECT COUNT(*) AS total FROM referrals r JOIN patients p ON p.id = r.patient_id${where}`).get(...params) as {
          total: number;
        }
      ).total,
    );
    const rows = this.db
      .prepare(`${SELECT}${where} ORDER BY r.date DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ReferralRow[];
    return { items: rows.map((row) => this.map(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  byPatient(patientId: number): Referral[] {
    return this.list({ patientId, pageSize: 200 }).items;
  }

  get(id: number): Referral {
    requirePermission(this.context(), 'patient.view');
    const row = this.db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as ReferralRow | undefined;
    if (!row) throw AppError.notFound('Referral');
    return this.map(row);
  }

  save(id: number | null, input: ReferralInput): { id: number } {
    requirePermission(this.context(), 'visit.create');
    const fieldErrors: Record<string, string> = {};
    if (!input.patientId) fieldErrors.patientId = 'Select a patient.';
    if (input.doctorName.trim().length < 2) fieldErrors.doctorName = 'Enter the receiving doctor or clinic.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fieldErrors.date = 'Select a valid date.';
    if (input.followUpDate && input.followUpDate < input.date) fieldErrors.followUpDate = 'Follow-up cannot be before the referral date.';
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);

    const ctx = this.context();
    const now = this.context().instant();
    const payload = {
      patientId: input.patientId,
      visitId: input.visitId,
      referralDoctorId: input.referralDoctorId,
      doctorName: input.doctorName.trim(),
      specialty: input.specialty.trim(),
      organisation: input.organisation.trim(),
      contact: input.contact.trim(),
      reason: input.reason.trim(),
      date: input.date,
      followUpDate: input.followUpDate,
      status: input.status,
      notes: input.notes.trim(),
    };

    if (id) {
      const result = this.db
        .prepare(
          `UPDATE referrals SET patient_id = @patientId, visit_id = @visitId, referral_doctor_id = @referralDoctorId,
             doctor_name = @doctorName, specialty = @specialty, organisation = @organisation, contact = @contact,
             reason = @reason, date = @date, follow_up_date = @followUpDate, status = @status, notes = @notes
           WHERE id = @id`,
        )
        .run({ ...payload, id });
      if (result.changes === 0) throw AppError.notFound('Referral');
      ctx.audit.record({
        action: 'update',
        entityType: 'referral',
        entityId: id,
        entityLabel: payload.doctorName,
        detail: 'Referral' + ' updated',
      });
      return { id };
    }
    const result = this.db
      .prepare(
        `INSERT INTO referrals (patient_id, visit_id, referral_doctor_id, doctor_name, specialty, organisation, contact,
            reason, date, follow_up_date, status, notes, created_by, created_at)
         VALUES (@patientId, @visitId, @referralDoctorId, @doctorName, @specialty, @organisation, @contact,
            @reason, @date, @followUpDate, @status, @notes, @createdBy, @createdAt)`,
      )
      .run({ ...payload, createdBy: ctx.session.currentUser()?.id ?? null, createdAt: now });
    const newId = Number(result.lastInsertRowid);
    ctx.audit.record({
      action: 'create',
      entityType: 'referral',
      entityId: newId,
      entityLabel: payload.doctorName,
      detail: `Patient referred to ${payload.doctorName}${payload.specialty ? ` (${payload.specialty})` : ''}`,
    });
    return { id: newId };
  }

  delete(id: number, reason: string): void {
    requirePermission(this.context(), 'visit.edit');
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for' + ' removing this referral.', { reason: 'Reason is required.' });
    const ctx = this.context();
    const row = this.db.prepare(`SELECT doctor_name FROM referrals WHERE id = ?`).get(id) as { doctor_name: string } | undefined;
    if (!row) throw AppError.notFound('Referral');
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM referrals WHERE id = ?`).run(id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'referral',
        entityId: id,
        entityLabel: row.doctor_name,
        detail: `Referral removed. Reason: ${reason.trim()}`,
        severity: 'warning',
        before: { doctorName: row.doctor_name },
      });
    })();
  }

  statistics(
    from: string,
    to: string,
  ): { total: number; byStatus: Array<{ label: string; value: number }>; bySpecialty: Array<{ label: string; value: number }> } {
    requirePermission(this.context(), 'report.operational.view');
    const rows = this.db.prepare(`SELECT status, specialty FROM referrals WHERE date BETWEEN ? AND ?`).all(from, to) as Array<{
      status: string;
      specialty: string;
    }>;
    const statusCounts = new Map<string, number>();
    const specialtyCounts = new Map<string, number>();
    for (const row of rows) {
      statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
      const specialty = asString(row.specialty, 'Unspecified');
      specialtyCounts.set(specialty, (specialtyCounts.get(specialty) ?? 0) + 1);
    }
    return {
      total: rows.length,
      byStatus: [...statusCounts.entries()].map(([label, value]) => ({ label, value })),
      bySpecialty: [...specialtyCounts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    };
  }
}
