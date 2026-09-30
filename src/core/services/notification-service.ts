/**
 * Notification centre.
 *
 * Notifications are derived from real database conditions (appointment timing,
 * stock levels, expiry dates, outstanding balances, backup schedule, security
 * events) — never generated for show. A stable dedupe key guarantees the same
 * condition does not create duplicates.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import type { Notification } from '@shared/types';
import type { NotificationCategory, NotificationSeverity } from '@shared/constants';
import { asNumber, fromBoolInt } from '../db/sql';
import { currentTimeIso, diffDays, nowInstant, timeToMinutes } from '@shared/dates';

export interface NotificationInput {
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  message: string;
  dedupeKey: string;
  entityType?: string;
  entityId?: number | null;
  targetScreen?: string;
  targetId?: number | null;
}

interface NotificationRow {
  id: number;
  category: string;
  severity: string;
  title: string;
  message: string;
  entity_type: string;
  entity_id: number | null;
  target_screen: string;
  target_id: number | null;
  is_read: number;
  is_dismissed: number;
  created_at: string;
}

function toNotification(row: NotificationRow): Notification {
  const hasTarget = row.target_screen !== '';
  return {
    id: row.id,
    category: row.category as Notification['category'],
    severity: row.severity as Notification['severity'],
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    isRead: fromBoolInt(row.is_read),
    isDismissed: fromBoolInt(row.is_dismissed),
    createdAt: row.created_at,
    target: hasTarget ? { screen: row.target_screen, id: row.target_id ?? undefined } : null,
  };
}

export class NotificationService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  /** Create a notification unless an identical one (same dedupe key) exists. */
  create(input: NotificationInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications
           (category, severity, title, message, entity_type, entity_id, target_screen, target_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.category,
        input.severity,
        input.title,
        input.message,
        input.entityType ?? '',
        input.entityId ?? null,
        input.targetScreen ?? '',
        input.targetId ?? null,
        input.dedupeKey,
        this.context().instant(),
      );
    return result.changes > 0;
  }

  /**
   * Re-evaluate the clinic's live conditions and raise notifications for
   * anything that needs attention.
   */
  refresh(): { created: number } {
    const ctx = this.ctx();
    const db = this.db;
    const today = ctx.today();
    const settings = this.db.prepare(`SELECT key, value FROM app_settings`).all() as Array<{ key: string; value: string }>;
    const settingsMap = new Map(settings.map((row) => [row.key, row.value]));
    const numericSetting = (key: string, fallback: number): number => {
      const raw = settingsMap.get(key);
      if (!raw) return fallback;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === 'number' ? parsed : fallback;
      } catch {
        return fallback;
      }
    };
    const expiryWarningDays = numericSetting('expiryWarningDays', 60);
    const backupIntervalDays = numericSetting('backupIntervalDays', 7);
    let created = 0;

    const insert = db.transaction(() => {
      // --- Appointments starting soon (today) -------------------------------
      const nowTime = currentTimeIso(ctx.now(), ctx.timeZone());
      const soonRows = db
        .prepare(
          `SELECT a.id, a.start_time, a.patient_id, p.first_name, p.last_name, p.code
             FROM appointments a JOIN patients p ON p.id = a.patient_id
            WHERE a.deleted_at IS NULL AND a.date = ?
              AND a.status IN ('scheduled', 'confirmed')
              AND a.start_time >= ? AND a.start_time <= ?`,
        )
        .all(today, nowTime, minutesLater(nowTime, 90)) as Array<{
        id: number;
        start_time: string;
        patient_id: number;
        first_name: string;
        last_name: string;
        code: string;
      }>;
      for (const row of soonRows) {
        if (
          this.create({
            category: 'appointment',
            severity: 'info',
            title: `Appointment at ${row.start_time}`,
            message: `${row.first_name} ${row.last_name} (${row.code}) is due at ${row.start_time} today.`,
            dedupeKey: `appointment-soon:${row.id}`,
            entityType: 'appointment',
            entityId: row.id,
            targetScreen: 'appointments',
            targetId: row.id,
          })
        ) {
          created += 1;
        }
      }

      // --- Missed / no-show risk: past slot still marked scheduled ----------
      const missed = db
        .prepare(
          `SELECT a.id, a.start_time, p.first_name, p.last_name, p.code
             FROM appointments a JOIN patients p ON p.id = a.patient_id
            WHERE a.deleted_at IS NULL AND a.date = ?
              AND a.status = 'scheduled' AND a.end_time < ?`,
        )
        .all(today, nowTime) as Array<{ id: number; start_time: string; first_name: string; last_name: string; code: string }>;
      for (const row of missed) {
        if (
          this.create({
            category: 'appointment',
            severity: 'warning',
            title: 'Appointment time has passed',
            message: `${row.first_name} ${row.last_name} (${row.code}) was booked for ${row.start_time} and has not been marked.`,
            dedupeKey: `appointment-missed:${row.id}`,
            entityType: 'appointment',
            entityId: row.id,
            targetScreen: 'appointments',
            targetId: row.id,
          })
        ) {
          created += 1;
        }
      }

      // --- Follow-up visits due --------------------------------------------
      const followUps = db
        .prepare(
          `SELECT v.id, v.follow_up_date, p.id AS patient_id, p.code, p.first_name, p.last_name
             FROM visits v JOIN patients p ON p.id = v.patient_id
            WHERE v.deleted_at IS NULL AND v.follow_up_date IS NOT NULL
              AND v.follow_up_date <= ? AND p.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM visits later
                 WHERE later.patient_id = v.patient_id AND later.deleted_at IS NULL
                   AND later.visit_date > v.visit_date
              )`,
        )
        .all(today) as Array<{ id: number; follow_up_date: string; patient_id: number; code: string; first_name: string; last_name: string }>;
      for (const row of followUps) {
        if (
          this.create({
            category: 'appointment',
            severity: 'info',
            title: 'Follow-up due',
            message: `${row.first_name} ${row.last_name} (${row.code}) was advised to return on ${row.follow_up_date}.`,
            dedupeKey: `follow-up:${row.id}`,
            entityType: 'visit',
            entityId: row.id,
            targetScreen: 'patient',
            targetId: row.patient_id,
          })
        ) {
          created += 1;
        }
      }

      // --- Inventory: low stock --------------------------------------------
      const lowStock = db
        .prepare(
          `SELECT id, name, code, current_stock_milli, reorder_level_milli, minimum_stock_milli, unit
             FROM inventory_items
            WHERE deleted_at IS NULL AND is_active = 1
              AND (current_stock_milli <= minimum_stock_milli
                   OR (reorder_level_milli > 0 AND current_stock_milli <= reorder_level_milli))
            ORDER BY current_stock_milli ASC LIMIT 100`,
        )
        .all() as Array<{ id: number; name: string; code: string; current_stock_milli: number; unit: string }>;
      for (const row of lowStock) {
        if (
          this.create({
            category: 'inventory',
            severity: 'warning',
            title: 'Low stock',
            message: `${row.name} (${row.code}) is down to ${formatQuantity(row.current_stock_milli)} ${row.unit}.`,
            dedupeKey: `stock-low:${row.id}:${today}`,
            entityType: 'inventory_item',
            entityId: row.id,
            targetScreen: 'inventory',
            targetId: row.id,
          })
        ) {
          created += 1;
        }
      }

      // --- Inventory: expiring and expired ---------------------------------
      const expiryRows = db
        .prepare(
          `SELECT id, name, code, expiry_date, current_stock_milli, unit
             FROM inventory_items
            WHERE deleted_at IS NULL AND is_active = 1 AND expiry_date IS NOT NULL
              AND current_stock_milli > 0 AND expiry_date <= ?`,
        )
        .all(addDaysIso(today, expiryWarningDays)) as Array<{
        id: number;
        name: string;
        code: string;
        expiry_date: string;
        current_stock_milli: number;
        unit: string;
      }>;
      for (const row of expiryRows) {
        const expired = row.expiry_date < today;
        if (
          this.create({
            category: 'inventory',
            severity: expired ? 'critical' : 'warning',
            title: expired ? 'Stock expired' : 'Stock expiring soon',
            message: `${row.name} (${row.code}) expires on ${row.expiry_date} with ${formatQuantity(row.current_stock_milli)} ${row.unit} in stock.`,
            dedupeKey: `stock-expiry:${row.id}:${row.expiry_date}`,
            entityType: 'inventory_item',
            entityId: row.id,
            targetScreen: 'inventory',
            targetId: row.id,
          })
        ) {
          created += 1;
        }
      }

      // --- Outstanding balances --------------------------------------------
      const overdue = db
        .prepare(
          `SELECT i.id, i.number, i.date, (i.total_paisa - i.paid_paisa) AS due, p.code, p.first_name, p.last_name
             FROM invoices i JOIN patients p ON p.id = i.patient_id
            WHERE i.deleted_at IS NULL AND i.is_void = 0 AND i.status IN ('unpaid','partially_paid')
              AND (i.total_paisa - i.paid_paisa) > 0 AND i.date <= ?
            ORDER BY due DESC LIMIT 50`,
        )
        .all(addDaysIso(today, -7)) as Array<{ id: number; number: string; date: string; due: number; code: string; first_name: string; last_name: string }>;
      for (const row of overdue) {
        if (
          this.create({
            category: 'payment',
            severity: 'warning',
            title: 'Payment outstanding',
            message: `Invoice ${row.number} for ${row.first_name} ${row.last_name} (${row.code}) has an unpaid balance.`,
            dedupeKey: `invoice-overdue:${row.id}:${today}`,
            entityType: 'invoice',
            entityId: row.id,
            targetScreen: 'invoices',
            targetId: row.id,
          })
        ) {
          created += 1;
        }
      }

      // --- Backup due -------------------------------------------------------
      if (backupIntervalDays > 0) {
        const lastBackup = db
          .prepare(`SELECT created_at FROM backup_records WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`)
          .get() as { created_at: string } | undefined;
        const dueDate = lastBackup ? addDaysIso(lastBackup.created_at.slice(0, 10), backupIntervalDays) : today;
        if (!lastBackup || dueDate <= today) {
          if (
            this.create({
              category: 'backup',
              severity: lastBackup ? 'warning' : 'critical',
              title: 'Backup is due',
              message: lastBackup
                ? `The last backup was created on ${lastBackup.created_at.slice(0, 10)}. Create a new backup now.`
                : 'No backup has been created yet. Create one from Backup & Restore.',
              dedupeKey: `backup-due:${today}`,
              targetScreen: 'backup',
            })
          ) {
            created += 1;
          }
        }
      }

      // --- Subscription-free integrity nudge: expired stock still counted ---
      const expiredWithStock = asNumber(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS total FROM inventory_items
                WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date < ? AND current_stock_milli > 0`,
            )
            .get(today) as { total: number }
        ).total,
      );
      if (expiredWithStock > 0) {
        this.create({
          category: 'inventory',
          severity: 'warning',
          title: 'Expired stock needs write-off',
          message: `${expiredWithStock} item(s) have expired quantities still recorded in stock.`,
          dedupeKey: `stock-expired-pending:${expiredWithStock}:${today}`,
          targetScreen: 'inventory',
        });
      }
    });

    insert();

    // Health information for the dashboard.
    this.purgeOldResolved();

    if (created > 0) ctx.notify?.('notifications.changed');
    return { created };
  }

  list(options: { onlyUnread?: boolean; category?: string | null; limit?: number } = {}): Notification[] {
    const clauses: string[] = ['is_dismissed = 0'];
    const params: unknown[] = [];
    if (options.onlyUnread) clauses.push('is_read = 0');
    if (options.category) {
      clauses.push('category = ?');
      params.push(options.category);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE ${clauses.join(' AND ')}
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
          LIMIT ?`,
      )
      .all(...params, limit) as NotificationRow[];
    return rows.map(toNotification);
  }

  unreadCount(): { total: number; critical: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
           FROM notifications WHERE is_read = 0 AND is_dismissed = 0`,
      )
      .get() as { total: number; critical: number | null };
    return { total: asNumber(row.total), critical: asNumber(row.critical) };
  }

  markRead(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare(`UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?`);
    const now = this.context().instant();
    const run = this.db.transaction(() => {
      for (const id of ids) statement.run(now, id);
    });
    run();
    this.ctx().notify?.('notifications.changed');
  }

  markAllRead(): void {
    this.db.prepare(`UPDATE notifications SET is_read = 1, read_at = ? WHERE is_read = 0`).run(this.context().instant());
    this.ctx().notify?.('notifications.changed');
  }

  dismiss(id: number): void {
    this.db.prepare(`UPDATE notifications SET is_dismissed = 1, is_read = 1, read_at = ? WHERE id = ?`).run(this.context().instant(), id);
    this.ctx().notify?.('notifications.changed');
  }

  clearAll(includeUnread: boolean): void {
    if (includeUnread) {
      this.db.prepare(`DELETE FROM notifications`).run();
    } else {
      this.db.prepare(`DELETE FROM notifications WHERE is_read = 1 OR is_dismissed = 1`).run();
    }
    this.ctx().notify?.('notifications.changed');
  }

  /** Remove read notifications older than the retention window. */
  private purgeOldResolved(): void {
    const cutoff = addDaysIso(this.ctx().today(), -90);
    this.db.prepare(`DELETE FROM notifications WHERE is_read = 1 AND created_at < ?`).run(cutoff);
  }

  /** Remove notifications that no longer reflect a live condition. */
  resolveByDedupePrefix(prefix: string): void {
    this.db.prepare(`DELETE FROM notifications WHERE dedupe_key LIKE ?`).run(`${prefix}%`);
  }

  /** Count of notifications for a given category (used by settings diagnostics). */
  countByCategory(): Array<{ category: string; count: number }> {
    return this.db
      .prepare(`SELECT category, COUNT(*) AS count FROM notifications WHERE is_dismissed = 0 GROUP BY category`)
      .all() as Array<{ category: string; count: number }>;
  }

  /** Days since a date string, used by reports and tests. */
  daysSince(dateIso: string): number {
    return Math.abs(diffDays(dateIso, this.ctx().today()));
  }

  /** True when the given time is within working hours (used by tests). */
  isDuringClinicHours(time: string, open: string, close: string): boolean {
    return timeToMinutes(time) >= timeToMinutes(open) && timeToMinutes(time) <= timeToMinutes(close);
  }
}

function minutesLater(time: string, minutes: number): string {
  const [hours = 0, mins = 0] = time.split(':').map(Number);
  const total = hours * 60 + mins + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function addDaysIso(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatQuantity(milli: number): string {
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
