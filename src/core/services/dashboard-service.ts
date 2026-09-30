/**
 * Role-aware dashboard.
 *
 * Everything the landing screen shows is assembled here in one pass. Financial
 * widgets are only computed for users who hold the financial dashboard
 * permission — the values are never even calculated for anybody else, so a
 * hidden widget can never leak through a cache or a serialised payload.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { hasPermission, requirePermission } from '../context';
import type { DashboardCard, DashboardData } from '@shared/types';
import { asNumber } from '../db/sql';
import { formatMoney } from '@shared/money';
import { addDays } from '@shared/dates';
import type { AppointmentService } from './appointment-service';
import type { BackupService } from './backup-service';
import type { InventoryService } from './inventory-service';
import type { InvoiceService } from './invoice-service';
import type { PrescriptionService } from './prescription-service';
import type { QueueService } from './queue-service';
import type { SettingsService } from './settings-service';

export class DashboardService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly settings: SettingsService,
    private readonly appointments: AppointmentService,
    private readonly queue: QueueService,
    private readonly invoices: InvoiceService,
    private readonly prescriptions: PrescriptionService,
    private readonly inventory: InventoryService,
    private readonly backups: BackupService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private canSeeMoney(): boolean {
    return hasPermission(this.context(), 'dashboard.financial.view') || hasPermission(this.context(), 'report.financial.view');
  }

  get(): DashboardData {
    requirePermission(this.context(), 'dashboard.view');
    const ctx = this.context();
    const today = ctx.today();
    const monthStart = `${today.slice(0, 7)}-01`;
    const financial = this.canSeeMoney();

    const todayBoard = hasPermission(ctx, 'appointment.view')
      ? this.appointments.today(today)
      : { all: [], upcoming: [], noShows: 0, completed: 0 };

    const queueEntries = hasPermission(ctx, 'queue.view') ? this.queue.live(today) : [];

    const newPatientsThisMonth = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM patients WHERE deleted_at IS NULL AND substr(created_at, 1, 10) >= ?`)
          .get(monthStart) as { total: number }
      ).total,
    );

    const followUpsDue = hasPermission(ctx, 'visit.view')
      ? (
          this.db
            .prepare(
              `SELECT v.patient_id, p.code, trim(p.first_name || ' ' || p.last_name) AS patient_name, v.follow_up_date, p.phone
                   FROM visits v JOIN patients p ON p.id = v.patient_id
                  WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL
                    AND v.follow_up_date IS NOT NULL AND v.follow_up_date <= ?
                    AND NOT EXISTS (
                      SELECT 1 FROM visits later
                       WHERE later.patient_id = v.patient_id AND later.deleted_at IS NULL AND later.visit_date > v.visit_date)
                  ORDER BY v.follow_up_date LIMIT 20`,
            )
            .all(addDays(today, 7)) as Array<{
            patient_id: number;
            code: string;
            patient_name: string;
            follow_up_date: string;
            phone: string;
          }>
        ).map((row) => ({
          patientId: row.patient_id,
          patientCode: row.code,
          patientName: row.patient_name,
          followUpDate: row.follow_up_date,
          phone: row.phone,
        }))
      : [];

    const inventoryAlerts = hasPermission(ctx, 'inventory.view') ? this.inventory.alerts(8) : null;

    const recentPrescriptions = hasPermission(ctx, 'prescription.view') ? this.prescriptions.list({ page: 1, pageSize: 5 }).items : [];

    const recentInvoices = hasPermission(ctx, 'invoice.view') ? this.invoices.list({ page: 1, pageSize: 5 }).items : [];

    const outstanding = financial
      ? {
          total: asNumber(
            (
              this.db
                .prepare(
                  `SELECT COALESCE(SUM(total_paisa - paid_paisa), 0) AS due FROM invoices
                    WHERE deleted_at IS NULL AND is_void = 0 AND total_paisa > paid_paisa`,
                )
                .get() as { due: number }
            ).due,
          ),
          count: asNumber(
            (
              this.db
                .prepare(`SELECT COUNT(*) AS total FROM invoices WHERE deleted_at IS NULL AND is_void = 0 AND total_paisa > paid_paisa`)
                .get() as { total: number }
            ).total,
          ),
        }
      : { total: 0, count: 0 };

    const collectedToday = financial
      ? asNumber(
          (
            this.db
              .prepare(
                `SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM payments
                  WHERE is_void = 0 AND substr(paid_at, 1, 10) = ?`,
              )
              .get(today) as { total: number }
          ).total,
        )
      : 0;

    const cards: DashboardCard[] = [];
    cards.push({
      key: 'today_appointments',
      label: "Today's appointments",
      value: String(todayBoard.all.length),
      hint: `${todayBoard.completed} completed · ${todayBoard.noShows} no-show(s)`,
      tone: 'info',
      screen: 'appointments',
      requiresFinancialPermission: false,
    });
    cards.push({
      key: 'queue',
      label: 'In the queue',
      value: String(queueEntries.length),
      hint: queueEntries.length > 0 ? `Next: ${queueEntries[0]?.patientName ?? ''}` : 'Nobody is waiting',
      tone: queueEntries.length > 4 ? 'warning' : 'default',
      screen: 'queue',
      requiresFinancialPermission: false,
    });
    cards.push({
      key: 'new_patients',
      label: 'New patients this month',
      value: String(newPatientsThisMonth),
      hint: 'Registered since the 1st',
      tone: 'default',
      screen: 'patients',
      requiresFinancialPermission: false,
    });
    cards.push({
      key: 'follow_ups',
      label: 'Follow-ups due',
      value: String(followUpsDue.length),
      hint: followUpsDue.length > 0 ? `Earliest ${followUpsDue[0]?.followUpDate ?? ''}` : 'Nothing due',
      tone: followUpsDue.length > 0 ? 'warning' : 'success',
      screen: 'patients',
      requiresFinancialPermission: false,
    });
    if (inventoryAlerts) {
      cards.push({
        key: 'inventory',
        label: 'Stock alerts',
        value: String(inventoryAlerts.lowStock.length + inventoryAlerts.expiringSoon.length),
        hint:
          `${inventoryAlerts.lowStock.length} low · ${inventoryAlerts.expiringSoon.length}` +
          ` expiring · ${inventoryAlerts.expired.length} expired`,
        tone: inventoryAlerts.expired.length > 0 ? 'danger' : inventoryAlerts.lowStock.length > 0 ? 'warning' : 'success',
        screen: 'inventory',
        requiresFinancialPermission: false,
      });
    }
    if (hasPermission(ctx, 'invoice.view')) {
      cards.push({
        key: 'outstanding',
        label: 'Outstanding balance',
        value: financial ? formatMoney(outstanding.total) : '—',
        hint: financial ? `${outstanding.count} invoice(s)` : 'Restricted',
        tone: outstanding.count > 0 ? 'warning' : 'success',
        screen: 'invoices',
        requiresFinancialPermission: true,
      });
      cards.push({
        key: 'collected_today',
        label: 'Collected today',
        value: financial ? formatMoney(collectedToday) : '—',
        hint: 'Cash, card and mobile wallet',
        tone: 'success',
        screen: 'payments',
        requiresFinancialPermission: true,
      });
    }

    const paymentTrend = financial
      ? (
          this.db
            .prepare(
              `SELECT substr(paid_at, 1, 10) AS date, COALESCE(SUM(amount_paisa), 0) AS total
                 FROM payments WHERE is_void = 0 AND substr(paid_at, 1, 10) >= ?
                 GROUP BY date ORDER BY date`,
            )
            .all(addDays(today, -13)) as Array<{ date: string; total: number }>
        ).map((row) => ({ date: row.date, amountPaisa: asNumber(row.total) }))
      : [];

    const dentitionSummary = {
      permanentFindings: asNumber(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS total FROM tooth_findings f JOIN dental_charts c ON c.id = f.chart_id
                WHERE f.is_active = 1 AND c.dentition = 'permanent'`,
            )
            .get() as { total: number }
        ).total,
      ),
      primaryFindings: asNumber(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS total FROM tooth_findings f JOIN dental_charts c ON c.id = f.chart_id
                WHERE f.is_active = 1 AND c.dentition = 'primary'`,
            )
            .get() as { total: number }
        ).total,
      ),
    };

    // Backup state is read straight from the tables: the dashboard must not run
    // a filesystem scan every time the landing screen is opened.
    const backupRow = this.db
      .prepare(`SELECT created_at FROM backup_records WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get() as { created_at: string } | undefined;
    const settings = this.settings.getSettings();
    const backup = {
      lastBackupAt: backupRow?.created_at ?? null,
      isDue:
        settings.backupIntervalDays > 0 &&
        (backupRow === undefined || addDays(backupRow.created_at.slice(0, 10), settings.backupIntervalDays) <= today),
      intervalDays: settings.backupIntervalDays,
      folder: this.backups.folder(),
    };

    return {
      cards,
      todayAppointments: todayBoard.all.slice(0, 12),
      queue: queueEntries,
      upcomingAppointments: todayBoard.upcoming.slice(0, 12),
      noShowsToday: todayBoard.noShows,
      recentPrescriptions: [...recentPrescriptions],
      recentInvoices: [...recentInvoices],
      newPatientsThisMonth,
      followUpsDue,
      inventoryAlerts: {
        lowStock: inventoryAlerts?.lowStock.length ?? 0,
        expiringSoon: inventoryAlerts?.expiringSoon.length ?? 0,
        expired: inventoryAlerts?.expired.length ?? 0,
        items: [...(inventoryAlerts?.lowStock ?? []), ...(inventoryAlerts?.expiringSoon ?? [])].slice(0, 8),
      },
      backup,
      paymentTrend,
      dentitionSummary,
      generatedAt: ctx.instant(),
    };
  }

  /** Short text summary used by the About / support screen. */
  describe(): string {
    const counts = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL) AS patients,
                (SELECT COUNT(*) FROM visits WHERE deleted_at IS NULL) AS visits`,
      )
      .get() as { patients: number; visits: number };
    return `${asNumber(counts.patients)} patient(s), ${asNumber(counts.visits)} visit(s)`;
  }
}
