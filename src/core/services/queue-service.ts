/**
 * Patient queue.
 *
 * The queue is per business day; numbers come from the day's running count
 * (`nextQueueNumber`) inside the caller's transaction. Reception can reorder
 * waiting patients, and every transition is audited so the waiting-room display
 * can be trusted.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type { QueueEntry, QueueInput } from '@shared/types';
import type { QueuePriority, QueueStatus } from '@shared/constants';
import { AppError } from '@shared/errors';
import {} from '@shared/dates';
import { nextQueueNumber } from '../util/ids';
import { asNumber, buildWhere } from '../db/sql';

interface QueueRow {
  id: number;
  date: string;
  queue_number: number;
  patient_id: number;
  patient_code: string;
  patient_name: string;
  patient_phone: string;
  appointment_id: number | null;
  visit_id: number | null;
  dentist_id: number | null;
  dentist_name: string | null;
  arrival_time: string;
  status: string;
  priority: string;
  notes: string;
  called_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  waited_minutes: number | null;
}

const SELECT = `
  SELECT q.*, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.phone AS patient_phone,
         d.name AS dentist_name,
         CAST((julianday('now') - julianday(q.date || ' ' || q.arrival_time)) * 24 * 60 AS INTEGER) AS waited_minutes
    FROM queue_entries q
    JOIN patients p ON p.id = q.patient_id
    LEFT JOIN dentists d ON d.id = q.dentist_id
`;

const ORDER = `ORDER BY CASE q.status
     WHEN 'in_consultation' THEN 0
     WHEN 'called' THEN 1
     WHEN 'waiting' THEN 2
     WHEN 'completed' THEN 3
     ELSE 4 END,
   CASE q.priority WHEN 'urgent' THEN 0 ELSE 1 END,
   q.queue_number`;

const ALLOWED_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  waiting: ['called', 'in_consultation', 'cancelled', 'completed'],
  called: ['in_consultation', 'waiting', 'cancelled', 'completed'],
  in_consultation: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['waiting'],
};

export class QueueService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private prefix(): string {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = 'queuePrefix'`).get() as { value: string } | undefined;
    if (!row) return 'Q';
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return typeof parsed === 'string' && parsed.trim() !== '' ? parsed.trim() : 'Q';
    } catch {
      return 'Q';
    }
  }

  private map(row: QueueRow): QueueEntry {
    return {
      id: row.id,
      queueNumber: asNumber(row.queue_number),
      queueLabel: `${this.prefix()}${row.queue_number}`,
      patientId: row.patient_id,
      patientCode: row.patient_code,
      patientName: row.patient_name,
      patientPhone: row.patient_phone,
      dentistId: row.dentist_id,
      dentistName: row.dentist_name ?? 'Unassigned',
      appointmentId: row.appointment_id,
      date: row.date,
      arrivalTime: row.arrival_time,
      status: row.status as QueueStatus,
      priority: row.priority as QueuePriority,
      notes: row.notes,
      calledAt: row.called_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      visitId: row.visit_id,
      waitingMinutes: row.status === 'waiting' && row.waited_minutes !== null ? Math.max(0, Number(row.waited_minutes)) : null,
    };
  }

  list(date: string, includeClosed = false, dentistId: number | null = null): QueueEntry[] {
    requirePermission(this.context(), 'queue.view');
    this.assertDate(date);
    const clauses: string[] = ['q.date = ?'];
    const params: unknown[] = [date];
    if (!includeClosed) clauses.push(`q.status IN ('waiting','called','in_consultation')`);
    if (dentistId) {
      clauses.push('q.dentist_id = ?');
      params.push(dentistId);
    }
    const where = buildWhere(clauses);
    const rows = this.db.prepare(`${SELECT}${where} ${ORDER}`).all(...params) as QueueRow[];
    return rows.map((row) => this.map(row));
  }

  get(id: number): QueueEntry {
    requirePermission(this.context(), 'queue.view');
    const row = this.db.prepare(`${SELECT} WHERE q.id = ?`).get(id) as QueueRow | undefined;
    if (!row) throw AppError.notFound('Queue entry');
    return this.map(row);
  }

  add(input: QueueInput, date: string): { id: number; queueNumber: number; queueLabel: string } {
    requirePermission(this.context(), 'queue.manage');
    const patient = this.db.prepare(`SELECT id FROM patients WHERE id = ? AND deleted_at IS NULL`).get(input.patientId);
    if (!patient) throw AppError.validation('Select a patient.', { patientId: 'Select a patient.' });
    const ctx = this.context();
    const arrivalTime = this.localTime();
    const result = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id, queue_number FROM queue_entries WHERE date = ? AND patient_id = ? AND status IN ('waiting','called','in_consultation')`,
        )
        .get(date, input.patientId) as { id: number; queue_number: number } | undefined;
      if (existing) throw AppError.conflict(`This patient is already in the queue as number ${existing.queue_number}.`);
      const queueNumber = nextQueueNumber(this.db, date);
      const inserted = this.db
        .prepare(
          `INSERT INTO queue_entries (date, queue_number, patient_id, appointment_id, dentist_id, arrival_time, status, priority, notes, created_by, created_at)
           VALUES (@date, @queueNumber, @patientId, @appointmentId, @dentistId, @arrivalTime, 'waiting', @priority, @notes, @createdBy, @createdAt)`,
        )
        .run({
          date,
          queueNumber,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          dentistId: input.dentistId,
          arrivalTime,
          priority: input.priority,
          notes: input.notes.trim(),
          createdBy: currentUserId(ctx),
          createdAt: ctx.instant(),
        });
      const id = Number(inserted.lastInsertRowid);
      ctx.audit.record({
        action: 'create',
        entityType: 'queue_entry',
        entityId: id,
        entityLabel: `#${queueNumber}`,
        detail: `Added to the ${date} queue as number ${queueNumber} (${input.priority})`,
      });
      return { id, queueNumber, queueLabel: `${this.prefix()}${queueNumber}` };
    })();
    ctx.notify?.('queue.changed', { date });
    return result;
  }

  setStatus(id: number, status: QueueStatus, note?: string): QueueEntry {
    requirePermission(this.context(), 'queue.manage');
    const entry = this.db.prepare(`SELECT id, date, queue_number, status FROM queue_entries WHERE id = ?`).get(id) as
      | { id: number; date: string; queue_number: number; status: string }
      | undefined;
    if (!entry) throw AppError.notFound('Queue entry');
    if (entry.status === status) return this.get(id);
    const allowed = ALLOWED_TRANSITIONS[entry.status as QueueStatus] ?? [];
    if (!allowed.includes(status)) {
      throw AppError.precondition(
        `A ${entry.status.replace('_', ' ')} patient cannot be moved to ${status.replace('_', ' ')}. Refresh the queue and try again.`,
      );
    }
    const trimmedNote = (note ?? '').trim();
    if (status === 'cancelled' && trimmedNote.length < 3) {
      throw AppError.validation('Please note why the patient left the queue.', { note: 'Reason is required.' });
    }
    const now = this.context().instant();
    const ctx = this.context();
    this.db.transaction(() => {
      const column = status === 'called' ? 'called_at' : status === 'in_consultation' ? 'started_at' : status === 'completed' ? 'completed_at' : null;
      const assignments = ['status = @status'];
      const params: Record<string, unknown> = { id, status };
      if (column) assignments.push(`${column} = @now`);
      if (trimmedNote !== '') assignments.push(`notes = @notes`);
      if (column) params['now'] = now;
      if (trimmedNote !== '') params['notes'] = trimmedNote;
      this.db.prepare(`UPDATE queue_entries SET ${assignments.join(', ')} WHERE id = @id`).run(params);
      ctx.audit.record({
        action: 'update',
        entityType: 'queue_entry',
        entityId: id,
        entityLabel: `#${entry.queue_number}`,
        detail: `Queue status changed from ${entry.status} to ${status}${trimmedNote ? ` (${trimmedNote})` : ''}`,
        before: { status: entry.status },
        after: { status },
      });
    })();
    ctx.notify?.('queue.changed', { date: entry.date });
    return this.get(id);
  }

  /**
   * Reorder the waiting list. Queue numbers are the ordering key, so a move
   * swaps the numbers of the two neighbours (negation first keeps the unique
   * index happy inside the transaction).
   */
  move(id: number, direction: 'up' | 'down'): QueueEntry[] {
    requirePermission(this.context(), 'queue.manage');
    const entry = this.db.prepare(`SELECT id, date, queue_number, status, priority FROM queue_entries WHERE id = ?`).get(id) as
      | { id: number; date: string; queue_number: number; status: string; priority: string }
      | undefined;
    if (!entry) throw AppError.notFound('Queue entry');
    if (entry.status !== 'waiting') throw AppError.precondition('Only waiting patients can be reordered.');
    const ctx = this.context();
    this.db.transaction(() => {
      const neighbourSql =
        direction === 'up'
          ? `SELECT id, queue_number FROM queue_entries
              WHERE date = ? AND status = 'waiting' AND priority = ?
                AND (queue_number < ? OR (queue_number = ? AND id < ?))
              ORDER BY queue_number DESC, id DESC LIMIT 1`
          : `SELECT id, queue_number FROM queue_entries
              WHERE date = ? AND status = 'waiting' AND priority = ?
                AND (queue_number > ? OR (queue_number = ? AND id > ?))
              ORDER BY queue_number ASC, id ASC LIMIT 1`;
      const neighbour = this.db.prepare(neighbourSql).get(
        entry.date,
        entry.priority,
        entry.queue_number,
        entry.queue_number,
        entry.id,
      ) as { id: number; queue_number: number } | undefined;
      if (!neighbour) return;
      this.db.prepare(`UPDATE queue_entries SET queue_number = -? WHERE id = ?`).run(entry.queue_number, entry.id);
      this.db.prepare(`UPDATE queue_entries SET queue_number = ? WHERE id = ?`).run(entry.queue_number, neighbour.id);
      this.db.prepare(`UPDATE queue_entries SET queue_number = ? WHERE id = ?`).run(neighbour.queue_number, entry.id);
      ctx.audit.record({
        action: 'update',
        entityType: 'queue_entry',
        entityId: entry.id,
        entityLabel: `#${entry.queue_number}`,
        detail: `Moved ${direction} in the queue`,
        before: { queueNumber: entry.queue_number },
        after: { queueNumber: neighbour.queue_number },
      });
    })();
    return this.list(entry.date);
  }

  setPriority(id: number, priority: QueuePriority): QueueEntry {
    requirePermission(this.context(), 'queue.manage');
    const entry = this.db.prepare(`SELECT date, queue_number, priority, status FROM queue_entries WHERE id = ?`).get(id) as
      | { date: string; queue_number: number; priority: string; status: string }
      | undefined;
    if (!entry) throw AppError.notFound('Queue entry');
    if (entry.status !== 'waiting') throw AppError.precondition('Priority can only be changed while the patient is waiting.');
    const ctx = this.context();
    this.db.prepare(`UPDATE queue_entries SET priority = ? WHERE id = ?`).run(priority, id);
    ctx.audit.record({
      action: 'update',
      entityType: 'queue_entry',
      entityId: id,
      entityLabel: `#${entry.queue_number}`,
      detail: `Priority changed from ${entry.priority} to ${priority}`,
      before: { priority: entry.priority },
      after: { priority },
    });
    ctx.notify?.('queue.changed', { date: entry.date });
    return this.get(id);
  }

  assignDentist(id: number, dentistId: number | null): QueueEntry {
    requirePermission(this.context(), 'queue.manage');
    const entry = this.db.prepare(`SELECT date, queue_number FROM queue_entries WHERE id = ?`).get(id) as
      | { date: string; queue_number: number }
      | undefined;
    if (!entry) throw AppError.notFound('Queue entry');
    if (dentistId !== null) {
      const dentist = this.db.prepare(`SELECT id FROM dentists WHERE id = ? AND is_active = 1 AND deleted_at IS NULL`).get(dentistId);
      if (!dentist) throw AppError.validation('Select an active dentist.', { dentistId: 'Unknown dentist.' });
    }
    this.db.prepare(`UPDATE queue_entries SET dentist_id = ? WHERE id = ?`).run(dentistId, id);
    this.context().audit.record({
      action: 'update',
      entityType: 'queue_entry',
      entityId: id,
      entityLabel: `#${entry.queue_number}`,
      detail: dentistId === null ? 'Treating dentist cleared' : 'Treating dentist assigned',
    });
    return this.get(id);
  }

  addNote(id: number, note: string): QueueEntry {
    requirePermission(this.context(), 'queue.manage');
    const entry = this.db.prepare(`SELECT date, queue_number, notes FROM queue_entries WHERE id = ?`).get(id) as
      | { date: string; queue_number: number; notes: string }
      | undefined;
    if (!entry) throw AppError.notFound('Queue entry');
    const trimmed = note.trim();
    if (trimmed.length === 0) throw AppError.validation('Write a note first.', { note: 'Note is empty.' });
    if (trimmed.length > 500) throw AppError.validation('Keep the note under 500 characters.', { note: 'Note is too long.' });
    const combined = entry.notes.trim() === '' ? trimmed : `${entry.notes.trim()}\n${trimmed}`;
    this.db.prepare(`UPDATE queue_entries SET notes = ? WHERE id = ?`).run(combined, id);
    this.context().audit.record({
      action: 'update',
      entityType: 'queue_entry',
      entityId: id,
      entityLabel: `#${entry.queue_number}`,
      detail: 'Queue note added',
    });
    return this.get(id);
  }

  remove(id: number, reason?: string): void {
    requirePermission(this.context(), 'queue.manage');
    const entry = this.db.prepare(`SELECT date, queue_number, visit_id, status FROM queue_entries WHERE id = ?`).get(id) as
      | { date: string; queue_number: number; visit_id: number | null; status: string }
      | undefined;
    if (!entry) throw AppError.notFound('Queue entry');
    if (entry.visit_id !== null || entry.status === 'completed' || entry.status === 'in_consultation') {
      throw AppError.precondition('This patient has already been seen — cancel the entry instead of removing it.');
    }
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM queue_entries WHERE id = ?`).run(id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'queue_entry',
        entityId: id,
        entityLabel: `#${entry.queue_number}`,
        detail: reason && reason.trim() !== '' ? `Queue entry removed. Reason: ${reason.trim()}` : 'Queue entry removed (added by mistake)',
        severity: 'warning',
      });
    })();
    ctx.notify?.('queue.changed', { date: entry.date });
  }

  statistics(date: string): {
    waiting: number;
    called: number;
    inConsultation: number;
    completed: number;
    cancelled: number;
    averageWaitMinutes: number | null;
    longestWaitMinutes: number | null;
  } {
    requirePermission(this.context(), 'queue.view');
    this.assertDate(date);
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM queue_entries WHERE date = ? GROUP BY status`)
      .all(date) as Array<{ status: string; count: number }>;
    const countFor = (status: string): number => asNumber(rows.find((row) => row.status === status)?.count);
    const waitRow = this.db
      .prepare(
        `SELECT AVG((julianday(called_at) - julianday(date || ' ' || arrival_time)) * 24 * 60) AS avg_wait,
                MAX((julianday(called_at) - julianday(date || ' ' || arrival_time)) * 24 * 60) AS max_wait
           FROM queue_entries WHERE date = ? AND called_at IS NOT NULL`,
      )
      .get(date) as { avg_wait: number | null; max_wait: number | null };
    const average = waitRow.avg_wait === null || !Number.isFinite(waitRow.avg_wait) ? null : Math.max(0, Math.round(waitRow.avg_wait));
    const longestClosed = waitRow.max_wait === null || !Number.isFinite(waitRow.max_wait) ? null : Math.max(0, Math.round(waitRow.max_wait));
    const stillWaiting = this.db
      .prepare(
        `SELECT MAX(CAST((julianday('now') - julianday(date || ' ' || arrival_time)) * 24 * 60 AS INTEGER)) AS minutes
           FROM queue_entries WHERE date = ? AND status IN ('waiting','called')`,
      )
      .get(date) as { minutes: number | null };
    const longest = Math.max(longestClosed ?? 0, Math.max(0, asNumber(stillWaiting.minutes)));
    return {
      waiting: countFor('waiting'),
      called: countFor('called'),
      inConsultation: countFor('in_consultation'),
      completed: countFor('completed'),
      cancelled: countFor('cancelled'),
      averageWaitMinutes: average,
      longestWaitMinutes: longest === 0 && longestClosed === null && stillWaiting.minutes === null ? null : longest,
    };
  }

  /** Next patient to call, honouring priority then arrival order. */
  nextUp(date: string, dentistId?: number | null): QueueEntry | null {
    requirePermission(this.context(), 'queue.view');
    const clauses: string[] = ['q.date = ?', `q.status = 'waiting'`];
    const params: unknown[] = [date];
    if (dentistId) {
      clauses.push('(q.dentist_id = ? OR q.dentist_id IS NULL)');
      params.push(dentistId);
    }
    const row = this.db
      .prepare(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY CASE q.priority WHEN 'urgent' THEN 0 ELSE 1 END, q.queue_number LIMIT 1`)
      .get(...params) as QueueRow | undefined;
    return row ? this.map(row) : null;
  }

  /** Link the consultation visit once a visit record exists. */
  linkVisit(id: number, visitId: number): void {
    this.db.prepare(`UPDATE queue_entries SET visit_id = ? WHERE id = ?`).run(visitId, id);
  }

  /** Called by the visit service when a consultation finishes. */
  completeForVisit(visitId: number, completedAt: string | null): void {
    const row = this.db
      .prepare(`SELECT id, date FROM queue_entries WHERE visit_id = ? AND status IN ('waiting','called','in_consultation')`)
      .get(visitId) as { id: number; date: string } | undefined;
    if (!row) return;
    this.db
      .prepare(`UPDATE queue_entries SET status = 'completed', completed_at = COALESCE(?, completed_at) WHERE id = ?`)
      .run(completedAt, row.id);
    this.context().notify?.('queue.changed', { date: row.date });
  }

  /** Live entries for a day (used by the dashboard and the waiting-room board). */
  live(date: string): QueueEntry[] {
    return this.list(date, false);
  }

  countForPatient(patientId: number): number {
    return asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM queue_entries WHERE patient_id = ?`).get(patientId) as { total: number }).total);
  }

  /**
   * Day-end housekeeping: unfinished entries from earlier days are closed so the
   * board and the statistics never claim patients are still waiting overnight.
   */
  closeOpenEntries(beforeDate: string, note = 'Closed automatically at day end'): number {
    const result = this.db
      .prepare(
        `UPDATE queue_entries SET status = 'cancelled', notes = trim(notes || char(10) || ?)
          WHERE date < ? AND status IN ('waiting','called','in_consultation')`,
      )
      .run(note, beforeDate);
    return result.changes;
  }

  private localTime(): string {
    const ctx = this.context();
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

  private assertDate(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw AppError.validation('Select a valid queue date.', { date: 'Select a valid date.' });
  }

  /** Statuses that keep a patient in the clinic. */
  static readonly liveStatuses: readonly QueueStatus[] = ['waiting', 'called', 'in_consultation'];
}
