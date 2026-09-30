/**
 * Appointment calendar and status workflow.
 *
 * The appointment slot is protected by a partial unique index (dentist + date +
 * start time for live appointments), so a double booking is rejected by the
 * database as well as by the validation in this service.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type { Appointment, AppointmentInput, AppointmentListQuery, Paged } from '@shared/types';
import type { AppointmentStatus } from '@shared/constants';
import { ACTIVE_APPOINTMENT_STATUSES } from '@shared/constants';
import { AppError } from '@shared/errors';
import { addDays, durationMinutes, endOfMonth, endOfWeek, resolveDateRange, startOfMonth, startOfWeek, timeToMinutes, timesOverlap, todayIso } from '@shared/dates';
import { asNumber, buildWhere, pageCount, paginate } from '../db/sql';

interface AppointmentRow {
  id: number;
  patient_id: number;
  patient_code: string;
  patient_name: string;
  patient_phone: string;
  dentist_id: number | null;
  dentist_name: string | null;
  date: string;
  start_time: string;
  end_time: string;
  reason: string;
  notes: string;
  status: string;
  reminder_note: string;
  visit_id: number | null;
  created_at: string;
  updated_at: string;
  queue_entry_id?: number | null;
}

const SELECT = `
  SELECT a.*, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.phone AS patient_phone,
         d.name AS dentist_name,
         (SELECT q.id FROM queue_entries q WHERE q.appointment_id = a.id AND q.status IN ('waiting','called','in_consultation') LIMIT 1) AS queue_entry_id
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN dentists d ON d.id = a.dentist_id
`;

export class AppointmentService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private map(row: AppointmentRow): Appointment {
    return {
      id: row.id,
      patientId: row.patient_id,
      patientCode: row.patient_code,
      patientName: row.patient_name,
      patientPhone: row.patient_phone,
      dentistId: row.dentist_id,
      dentistName: row.dentist_name ?? 'Unassigned',
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      reason: row.reason,
      notes: row.notes,
      status: row.status as AppointmentStatus,
      queueEntryId: row.queue_entry_id ?? null,
      visitId: row.visit_id,
      reminderNote: row.reminder_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(query: AppointmentListQuery): Paged<Appointment> {
    requirePermission(this.context(), 'appointment.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = ['a.deleted_at IS NULL'];
    const params: unknown[] = [];

    let from = query.from;
    let to = query.to;
    if (query.view === 'day' && query.date) {
      from = query.date;
      to = query.date;
    } else if (query.view === 'week' && query.date) {
      from = startOfWeek(query.date);
      to = endOfWeek(query.date);
    } else if (query.view === 'month' && query.date) {
      from = startOfMonth(query.date);
      to = endOfMonth(query.date);
    } else if (query.preset && query.preset !== 'all') {
      const range = resolveDateRange(query.preset as Parameters<typeof resolveDateRange>[0], { custom: { from: query.from, to: query.to } });
      from = range.from;
      to = range.to;
    }
    if (from) {
      clauses.push('a.date >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('a.date <= ?');
      params.push(to);
    }
    if (query.status && query.status.length > 0) {
      clauses.push(`a.status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    if (query.dentistId) {
      clauses.push('a.dentist_id = ?');
      params.push(query.dentistId);
    }
    if (query.patientId) {
      clauses.push('a.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(p.code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' OR a.reason LIKE ? ESCAPE '\\')`);
      params.push(term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM appointments a JOIN patients p ON p.id = a.patient_id${where}`).get(...params) as {
        total: number;
      }).total,
    );
    const rows = this.db
      .prepare(`${SELECT}${where} ORDER BY a.date ASC, a.start_time ASC, a.id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AppointmentRow[];
    return { items: rows.map((row) => this.map(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): Appointment {
    requirePermission(this.context(), 'appointment.view');
    const row = this.db.prepare(`${SELECT} WHERE a.id = ? AND a.deleted_at IS NULL`).get(id) as AppointmentRow | undefined;
    if (!row) throw AppError.notFound('Appointment');
    return this.map(row);
  }

  byRange(input: { from: string; to: string; dentistId?: number | null; statuses?: string[] }): Appointment[] {
    requirePermission(this.context(), 'appointment.view');
    const clauses: string[] = ['a.deleted_at IS NULL', 'a.date BETWEEN ? AND ?'];
    const params: unknown[] = [input.from, input.to];
    if (input.dentistId) {
      clauses.push('a.dentist_id = ?');
      params.push(input.dentistId);
    }
    if (input.statuses && input.statuses.length > 0) {
      clauses.push(`a.status IN (${input.statuses.map(() => '?').join(', ')})`);
      params.push(...input.statuses);
    }
    const rows = this.db
      .prepare(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.date, a.start_time`)
      .all(...params) as AppointmentRow[];
    return rows.map((row) => this.map(row));
  }

  byPatient(patientId: number, limit = 50): Appointment[] {
    requirePermission(this.context(), 'appointment.view');
    const rows = this.db
      .prepare(`${SELECT} WHERE a.patient_id = ? AND a.deleted_at IS NULL ORDER BY a.date DESC, a.start_time DESC LIMIT ?`)
      .all(patientId, limit) as AppointmentRow[];
    return rows.map((row) => this.map(row));
  }

  create(input: AppointmentInput): { id: number } {
    requirePermission(this.context(), 'appointment.create');
    this.validate(input);
    const ctx = this.context();
    const id = this.db.transaction(() => {
      this.assertSlotAvailable(input, null);
      const now = ctx.instant();
      const result = this.db
        .prepare(
          `INSERT INTO appointments (patient_id, dentist_id, date, start_time, end_time, reason, notes, status, reminder_note, created_by, created_at, updated_at)
           VALUES (@patientId, @dentistId, @date, @startTime, @endTime, @reason, @notes, @status, @reminderNote, @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          patientId: input.patientId,
          dentistId: input.dentistId,
          date: input.date,
          startTime: input.startTime,
          endTime: input.endTime,
          reason: input.reason.trim(),
          notes: input.notes.trim(),
          status: input.status,
          reminderNote: input.reminderNote.trim(),
          createdBy: currentUserId(ctx),
          createdAt: now,
          updatedAt: now,
        });
      const newId = Number(result.lastInsertRowid);
      ctx.audit.record({
        action: 'create',
        entityType: 'appointment',
        entityId: newId,
        entityLabel: `${input.date} ${input.startTime}`,
        detail: `Appointment booked for patient #${input.patientId}`,
        after: { date: input.date, startTime: input.startTime, status: input.status },
      });
      return newId;
    })();
    ctx.notify?.('appointments.changed', { id });
    return { id };
  }

  update(id: number, input: AppointmentInput): void {
    requirePermission(this.context(), 'appointment.edit');
    this.validate(input);
    const before = this.db.prepare(`SELECT * FROM appointments WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { date: string; start_time: string; status: string; dentist_id: number | null }
      | undefined;
    if (!before) throw AppError.notFound('Appointment');
    const ctx = this.context();
    this.db.transaction(() => {
      if (ACTIVE_APPOINTMENT_STATUSES.includes(input.status)) this.assertSlotAvailable(input, id);
      this.db
        .prepare(
          `UPDATE appointments SET patient_id = @patientId, dentist_id = @dentistId, date = @date, start_time = @startTime,
             end_time = @endTime, reason = @reason, notes = @notes, status = @status, reminder_note = @reminderNote,
             updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          patientId: input.patientId,
          dentistId: input.dentistId,
          date: input.date,
          startTime: input.startTime,
          endTime: input.endTime,
          reason: input.reason.trim(),
          notes: input.notes.trim(),
          status: input.status,
          reminderNote: input.reminderNote.trim(),
          updatedAt: ctx.instant(),
        });
      ctx.audit.record({
        action: 'update',
        entityType: 'appointment',
        entityId: id,
        entityLabel: `${input.date} ${input.startTime}`,
        detail: 'Appointment updated',
        before: { date: before.date, startTime: before.start_time, status: before.status },
        after: { date: input.date, startTime: input.startTime, status: input.status },
      });
    })();
    ctx.notify?.('appointments.changed', { id });
  }

  delete(id: number, reason?: string): void {
    requirePermission(this.context(), 'appointment.delete');
    const row = this.db.prepare(`SELECT date, start_time FROM appointments WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { date: string; start_time: string }
      | undefined;
    if (!row) throw AppError.notFound('Appointment');
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE appointments SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ctx.instant(), ctx.instant(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'appointment',
        entityId: id,
        entityLabel: `${row.date} ${row.start_time}`,
        detail: reason ? `Appointment removed. Reason: ${reason.trim()}` : 'Appointment removed',
        severity: 'warning',
      });
    })();
    ctx.notify?.('appointments.changed', { id });
  }

  /**
   * Move an appointment through the clinical workflow. Arriving puts the patient
   * in the queue automatically, which is what reception actually needs.
   */
  setStatus(id: number, status: AppointmentStatus, note?: string): void {
    const appointment = this.db.prepare(`SELECT * FROM appointments WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { id: number; patient_id: number; dentist_id: number | null; date: string; start_time: string; status: string; reason: string }
      | undefined;
    if (!appointment) throw AppError.notFound('Appointment');
    const permission = status === 'cancelled' || status === 'no_show' ? 'appointment.edit' : 'appointment.status';
    requirePermission(this.context(), permission);
    if (status === 'cancelled' && (note ?? '').trim().length < 3) {
      throw AppError.validation('Please record why the appointment was cancelled.', { note: 'Reason is required.' });
    }
    const ctx = this.context();
    const now = ctx.instant();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE appointments SET status = ?, cancelled_reason = ?, updated_at = ? WHERE id = ?`).run(
        status,
        status === 'cancelled' ? (note ?? '').trim() : '',
        now,
        id,
      );
      if (status === 'arrived' || status === 'in_queue') {
        const existing = this.db
          .prepare(`SELECT id FROM queue_entries WHERE appointment_id = ? AND date = ?`)
          .get(id, appointment.date) as { id: number } | undefined;
        if (!existing) {
          const nextNumber = asNumber(
            (
              this.db.prepare(`SELECT COALESCE(MAX(queue_number), 0) + 1 AS next FROM queue_entries WHERE date = ?`).get(appointment.date) as {
                next: number;
              }
            ).next,
            1,
          );
          this.db
            .prepare(
              `INSERT INTO queue_entries (date, queue_number, patient_id, appointment_id, dentist_id, arrival_time, status, priority, notes, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'waiting', 'normal', ?, ?, ?)`,
            )
            .run(
              appointment.date,
              nextNumber,
              appointment.patient_id,
              id,
              appointment.dentist_id,
              ctx.today() === appointment.date ? nowTime(ctx) : appointment.start_time,
              appointment.reason,
              currentUserId(ctx),
              now,
            );
        }
      }
      if (status === 'cancelled' || status === 'no_show') {
        this.db
          .prepare(`UPDATE queue_entries SET status = 'cancelled' WHERE appointment_id = ? AND status IN ('waiting','called')`)
          .run(id);
      }
      ctx.audit.record({
        action: 'update',
        entityType: 'appointment',
        entityId: id,
        entityLabel: `${appointment.date} ${appointment.start_time}`,
        detail: `Status changed from ${appointment.status} to ${status}${note ? ` (${note.trim()})` : ''}`,
        before: { status: appointment.status },
        after: { status },
      });
    })();
    ctx.notify?.('appointments.changed', { id });
  }

  availability(input: { dentistId: number | null; date: string; excludeId?: number | null }): Array<{ startTime: string; endTime: string; appointmentId: number; patientName: string; status: string }> {
    requirePermission(this.context(), 'appointment.view');
    const clauses: string[] = ['a.deleted_at IS NULL', 'a.date = ?', `a.status NOT IN ('cancelled','no_show')`];
    const params: unknown[] = [input.date];
    if (input.dentistId) {
      clauses.push('a.dentist_id = ?');
      params.push(input.dentistId);
    }
    if (input.excludeId) {
      clauses.push('a.id <> ?');
      params.push(input.excludeId);
    }
    const rows = this.db
      .prepare(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.start_time`)
      .all(...params) as AppointmentRow[];
    return rows.map((row) => ({
      startTime: row.start_time,
      endTime: row.end_time,
      appointmentId: row.id,
      patientName: row.patient_name,
      status: row.status,
    }));
  }

  statistics(options: { preset?: string; from?: string; to?: string; dentistId?: number | null } = {}): {
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    byStatus: Array<{ label: string; value: number }>;
    byDay: Array<{ date: string; count: number }>;
    byDentist: Array<{ dentistId: number | null; dentistName: string; count: number }>;
  } {
    requirePermission(this.context(), 'appointment.view');
    const range = resolveDateRange((options.preset ?? 'last_30_days') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const params: unknown[] = [range.from, range.to];
    let dentistClause = '';
    if (options.dentistId) {
      dentistClause = ' AND a.dentist_id = ?';
      params.push(options.dentistId);
    }
    const base = `FROM appointments a WHERE a.deleted_at IS NULL AND a.date BETWEEN ? AND ?${dentistClause}`;
    const totals = this.db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show ${base}`).get(...params) as {
      total: number;
      completed: number | null;
      cancelled: number | null;
      no_show: number | null;
    };
    const byStatus = (
      this.db.prepare(`SELECT status AS label, COUNT(*) AS value ${base} GROUP BY status ORDER BY value DESC`).all(...params) as Array<{
        label: string;
        value: number;
      }>
    ).map((row) => ({ label: row.label, value: asNumber(row.value) }));
    const byDay = (
      this.db.prepare(`SELECT a.date AS date, COUNT(*) AS count ${base} GROUP BY date ORDER BY date`).all(...params) as Array<{
        date: string;
        count: number;
      }>
    ).map((row) => ({ date: row.date, count: asNumber(row.count) }));
    const byDentist = (
      this.db
        .prepare(`SELECT a.dentist_id, COALESCE(d.name,'Unassigned') AS dentist_name, COUNT(*) AS count ${base.replace('FROM appointments a', 'FROM appointments a LEFT JOIN dentists d ON d.id = a.dentist_id')} GROUP BY a.dentist_id ORDER BY count DESC`)
        .all(...params) as Array<{ dentist_id: number | null; dentist_name: string; count: number }>
    ).map((row) => ({ dentistId: row.dentist_id, dentistName: row.dentist_name, count: asNumber(row.count) }));
    return {
      total: asNumber(totals.total),
      completed: asNumber(totals.completed),
      cancelled: asNumber(totals.cancelled),
      noShow: asNumber(totals.no_show),
      byStatus,
      byDay,
      byDentist,
    };
  }

  private assertSlotAvailable(input: AppointmentInput, excludeId: number | null): void {
    const params: unknown[] = [input.date, input.dentistId, input.startTime];
    let exclude = '';
    if (excludeId) {
      exclude = ' AND id <> ?';
      params.push(excludeId);
    }
    const conflict = this.db
      .prepare(
        `SELECT id, start_time, end_time FROM appointments
          WHERE deleted_at IS NULL AND date = ? AND dentist_id IS ? AND start_time = ? AND status NOT IN ('cancelled','no_show')${exclude}`,
      )
      .get(...params) as { id: number; start_time: string; end_time: string } | undefined;
    if (conflict) {
      throw AppError.conflict(`That time slot is already booked (${conflict.start_time}–${conflict.end_time}). Choose another time.`);
    }
    if (input.dentistId) {
      const overlapping = this.db
        .prepare(
          `SELECT id, start_time, end_time FROM appointments
            WHERE deleted_at IS NULL AND date = ? AND dentist_id = ? AND status NOT IN ('cancelled','no_show')${excludeId ? ' AND id <> ?' : ''}`,
        )
        .all(...(excludeId ? [input.date, input.dentistId, excludeId] : [input.date, input.dentistId])) as Array<{
        id: number;
        start_time: string;
        end_time: string;
      }>;
      for (const row of overlapping) {
        if (timesOverlap(input.startTime, input.endTime, row.start_time, row.end_time)) {
          throw AppError.conflict(
            `This dentist already has an appointment from ${row.start_time} to ${row.end_time}. Choose a different time or dentist.`,
          );
        }
      }
    }
  }

  private validate(input: AppointmentInput): void {
    const fieldErrors: Record<string, string> = {};
    if (!input.patientId) fieldErrors.patientId = 'Select a patient.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fieldErrors.date = 'Select a valid date.';
    if (!/^\d{2}:\d{2}$/.test(input.startTime)) fieldErrors.startTime = 'Select a start time.';
    if (!/^\d{2}:\d{2}$/.test(input.endTime)) fieldErrors.endTime = 'Select an end time.';
    if (fieldErrors.startTime === undefined && fieldErrors.endTime === undefined) {
      const minutes = durationMinutes(input.startTime, input.endTime);
      if (minutes <= 0) fieldErrors.endTime = 'The end time must be after the start time.';
      else if (minutes > 8 * 60) fieldErrors.endTime = 'An appointment cannot be longer than 8 hours.';
      else if (minutes < 5) fieldErrors.endTime = 'An appointment must be at least 5 minutes long.';
    }
    if (timeToMinutes(input.startTime) < timeToMinutes('00:00')) fieldErrors.startTime = 'Enter a valid time.';
    if (input.date < addDays(todayIso(), -3650)) fieldErrors.date = 'This date is too far in the past.';
    if (input.reason.trim().length > 300) fieldErrors.reason = 'Keep the reason under 300 characters.';
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  /** Today's appointments with the statuses the dashboard shows. */
  today(today: string): { all: Appointment[]; upcoming: Appointment[]; noShows: number; completed: number } {
    const appointments = this.byRange({ from: today, to: today });
    const byTime = [...appointments].sort((a, b) => a.startTime.localeCompare(b.startTime));
    return {
      all: byTime,
      upcoming: byTime.filter((appointment) => ['scheduled', 'confirmed', 'arrived', 'in_queue', 'in_treatment'].includes(appointment.status)),
      noShows: byTime.filter((appointment) => appointment.status === 'no_show').length,
      completed: byTime.filter((appointment) => appointment.status === 'completed').length,
    };
  }
}

function nowTime(ctx: CoreContext): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ctx.timeZone(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(ctx.now());
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour === '24' ? '00' : hour}:${minute}`;
}
