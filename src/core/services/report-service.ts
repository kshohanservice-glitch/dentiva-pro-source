/**
 * Reporting.
 *
 * Twenty-two reports share one shape: a title, a column list, plain rows and a
 * few summary figures, so the renderer can draw any report with a single table
 * component and the print layer can paginate any of them without knowing what
 * the report is about. Two rules hold everywhere in this file:
 *
 *  - Every report is date-ranged, and the range is inclusive on both ends.
 *  - Money never leaves as a float. Rows carry integer paisa and the column
 *    type tells the renderer to format them; the summary carries formatted
 *    strings for the printed sheet.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserName, hasPermission, requirePermission } from '../context';
import { AppError } from '@shared/errors';
import { addDays, compareIsoDate, formatDate, isIsoDate, startOfMonth, startOfWeek, todayIso } from '@shared/dates';
import type { IsoDate } from '@shared/dates';
import { asNumber, asString } from '../db/sql';
import { formatMoney } from '@shared/money';
import type { ReportCatalogueEntry, ReportColumn, ReportKey, ReportRequest, ReportResult } from '@shared/types';
import { ensureDir } from '../util/files';

export interface ReportPrinterPort {
  renderReport(request: ReportRequest, output: 'pdf' | 'print'): Promise<{ path: string | null; printed: boolean }>;
}

interface ReportSeed {
  readonly key: ReportKey;
  readonly title: string;
  readonly description: string;
  readonly group: 'Patients' | 'Clinical' | 'Billing' | 'Inventory' | 'Administration';
  readonly requiresFinancialPermission: boolean;
  readonly requiresProfitPermission?: boolean;
  readonly requiresAuditPermission?: boolean;
}

export const REPORT_CATALOGUE: readonly ReportSeed[] = [
  {
    key: 'patients_registered',
    title: 'Patient registrations',
    description: 'How many patients joined the practice in the period, shown as a trend.',
    group: 'Patients',
    requiresFinancialPermission: false,
  },
  {
    key: 'patient_register_detail',
    title: 'Patient register',
    description: 'Every registered patient with contact details and current status.',
    group: 'Patients',
    requiresFinancialPermission: false,
  },
  {
    key: 'appointments',
    title: 'Appointments',
    description: 'Booked slots in the period with status, dentist and reason.',
    group: 'Clinical',
    requiresFinancialPermission: false,
  },
  {
    key: 'no_shows',
    title: 'No-shows & cancellations',
    description: 'Appointments that were cancelled or missed, with the recorded reason.',
    group: 'Clinical',
    requiresFinancialPermission: false,
  },
  {
    key: 'visits',
    title: 'Visits',
    description: 'Attendance with diagnosis and any follow-up date set.',
    group: 'Clinical',
    requiresFinancialPermission: false,
  },
  {
    key: 'treatments',
    title: 'Treatments performed',
    description: 'Treatment lines recorded in the period, by tooth and dentist.',
    group: 'Clinical',
    requiresFinancialPermission: false,
  },
  {
    key: 'prescriptions',
    title: 'Prescriptions',
    description: 'Prescriptions written in the period with item counts.',
    group: 'Clinical',
    requiresFinancialPermission: false,
  },
  {
    key: 'referrals',
    title: 'Referrals',
    description: 'Patients referred to specialists, with status and follow-up.',
    group: 'Clinical',
    requiresFinancialPermission: false,
  },
  {
    key: 'revenue',
    title: 'Revenue',
    description: 'Invoiced, discounted, collected and outstanding amounts by period.',
    group: 'Billing',
    requiresFinancialPermission: true,
  },
  {
    key: 'payments',
    title: 'Payments received',
    description: 'Every receipt in the period with the method used.',
    group: 'Billing',
    requiresFinancialPermission: true,
  },
  {
    key: 'outstanding',
    title: 'Outstanding balances',
    description: 'Invoices that still carry a balance, oldest first.',
    group: 'Billing',
    requiresFinancialPermission: true,
  },
  {
    key: 'expenses',
    title: 'Expenses',
    description: 'Money paid out, grouped by category.',
    group: 'Billing',
    requiresFinancialPermission: true,
    requiresProfitPermission: true,
  },
  {
    key: 'income',
    title: 'Other income',
    description: 'Income recorded outside patient invoicing.',
    group: 'Billing',
    requiresFinancialPermission: true,
    requiresProfitPermission: true,
  },
  {
    key: 'profit',
    title: 'Profit & loss',
    description: 'Income against expenses for the period.',
    group: 'Billing',
    requiresFinancialPermission: true,
    requiresProfitPermission: true,
  },
  {
    key: 'daybook',
    title: 'Daybook',
    description: 'Cash book of every income and expense entry with a running balance.',
    group: 'Billing',
    requiresFinancialPermission: true,
  },
  {
    key: 'inventory_stock',
    title: 'Stock on hand',
    description: 'Current quantities, minimum levels and stock value.',
    group: 'Inventory',
    requiresFinancialPermission: false,
  },
  {
    key: 'inventory_low_stock',
    title: 'Low stock',
    description: 'Items at or below their minimum level.',
    group: 'Inventory',
    requiresFinancialPermission: false,
  },
  {
    key: 'inventory_expiry',
    title: 'Expiry watch',
    description: 'Batches that expire inside the period (or already have).',
    group: 'Inventory',
    requiresFinancialPermission: false,
  },
  {
    key: 'inventory_movements',
    title: 'Stock movements',
    description: 'Every receipt, issue, adjustment and write-off.',
    group: 'Inventory',
    requiresFinancialPermission: false,
  },
  {
    key: 'dentist_activity',
    title: 'Dentist activity',
    description: 'Appointments, visits and treatment volume per dentist.',
    group: 'Administration',
    requiresFinancialPermission: false,
  },
  {
    key: 'staff_activity',
    title: 'Staff activity',
    description: 'What each user account did, taken from the audit trail.',
    group: 'Administration',
    requiresFinancialPermission: false,
    requiresAuditPermission: true,
  },
  {
    key: 'audit_summary',
    title: 'Audit summary',
    description: 'Audit entries grouped by action, with severity counts.',
    group: 'Administration',
    requiresFinancialPermission: false,
    requiresAuditPermission: true,
  },
];

const DATE_COLUMNS: Record<ReportKey, string> = {
  patients_registered: 'substr(p.created_at, 1, 10)',
  patient_register_detail: 'substr(p.created_at, 1, 10)',
  appointments: 'a.date',
  no_shows: 'a.date',
  visits: 'v.visit_date',
  treatments: 'substr(t.performed_at, 1, 10)',
  prescriptions: 'pr.date',
  referrals: 'r.date',
  revenue: 'i.date',
  payments: 'pay.paid_date',
  outstanding: 'i.date',
  expenses: 'tr.date',
  income: 'tr.date',
  profit: 'tr.date',
  daybook: 'tr.date',
  inventory_stock: 'substr(i.created_at, 1, 10)',
  inventory_low_stock: 'substr(i.created_at, 1, 10)',
  inventory_expiry: 'COALESCE(i.expiry_date, i.created_at)',
  inventory_movements: 'm.moved_date',
  dentist_activity: 'a.date',
  staff_activity: 'substr(l.created_at, 1, 10)',
  audit_summary: 'substr(l.created_at, 1, 10)',
};

export class ReportService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly printer?: ReportPrinterPort,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private seed(reportKey: ReportKey): ReportSeed {
    const found = REPORT_CATALOGUE.find((entry) => entry.key === reportKey);
    if (!found) throw AppError.notFound('Report');
    return found;
  }

  catalogue(): ReportCatalogueEntry[] {
    requirePermission(this.context(), 'report.operational.view');
    const ctx = this.context();
    return REPORT_CATALOGUE.filter(
      (entry) => !entry.requiresProfitPermission || hasPermission(ctx, 'report.profit.view') || hasPermission(ctx, 'report.financial.view'),
    ).map((entry) => ({
      key: entry.key,
      title: entry.title,
      description: entry.description,
      group: entry.group,
      requiresFinancialPermission: entry.requiresFinancialPermission || entry.requiresProfitPermission === true,
    }));
  }

  /** Permission needed for a single report, used by the UI to hide what it cannot open. */
  permissionFor(reportKey: ReportKey): string {
    const seed = this.seed(reportKey);
    if (seed.requiresAuditPermission) return 'audit.view';
    if (seed.requiresProfitPermission) return 'report.profit.view';
    if (seed.requiresFinancialPermission) return 'report.financial.view';
    return 'report.operational.view';
  }

  run(request: ReportRequest): ReportResult {
    const seed = this.seed(request.reportKey);
    const ctx = this.context();
    requirePermission(ctx, this.permissionFor(request.reportKey));

    const from = isIsoDate(request.from) ? request.from : todayIso(new Date(), ctx.timeZone());
    const to = isIsoDate(request.to) ? request.to : from;
    if (compareIsoDate(from, to) > 0) {
      throw AppError.validation('The start date must be on or before the end date.', {
        from: 'The range is the wrong way round.',
      });
    }
    const dates = { from, to };
    const financial = seed.requiresFinancialPermission && hasPermission(ctx, 'report.financial.view');
    const profit = seed.requiresProfitPermission === true && hasPermission(ctx, 'report.profit.view');
    if (seed.requiresFinancialPermission && !financial && !profit) {
      throw AppError.forbidden('Your role cannot open financial reports. Ask for the “report.financial.view” permission.');
    }

    const body = this.build(request, dates, { financial, profit, groupBy: request.groupBy ?? 'day' });
    return {
      reportKey: request.reportKey,
      title: seed.title,
      subtitle: body.subtitle,
      range: dates,
      columns: body.columns,
      rows: body.rows,
      totals: body.totals,
      summary: body.summary,
      chart: body.chart,
      generatedAt: ctx.instant(),
      rowCount: body.rows.length,
      requiresFinancialPermission: seed.requiresFinancialPermission || seed.requiresProfitPermission === true,
    };
  }

  // --- CSV -----------------------------------------------------------------

  async exportCsv(request: ReportRequest, outputDirectory: string): Promise<{ path: string; rowCount: number }> {
    requirePermission(this.context(), 'report.export');
    const result = this.run(request);
    const lines = [result.columns.map((column) => csvCell(column.label)).join(',')];
    for (const row of result.rows) {
      lines.push(
        result.columns
          .map((column) => {
            const value = row[column.key];
            if (value === null || value === undefined) return '';
            if (column.type === 'money') return (asNumber(value) / 100).toFixed(2);
            return csvCell(String(value));
          })
          .join(','),
      );
    }
    if (Object.keys(result.totals).length > 0) {
      lines.push('');
      lines.push(['Totals', ...result.columns.slice(1).map((column) => {
        const total = result.totals[column.key];
        if (total === undefined) return '';
        return column.type === 'money' ? (total / 100).toFixed(2) : String(total);
      })].join(','));
    }
    await ensureDir(outputDirectory);
    const stamp = this.context().instant().replace(/[:.]/g, '-');
    const path = join(outputDirectory, `dentiva-${result.reportKey}-${stamp}.csv`);
    // A byte-order mark keeps Bengali text readable when the file opens in Excel.
    await writeFile(path, `\uFEFF${lines.join('\r\n')}`, 'utf8');
    this.context().audit.record({
      action: 'export',
      entityType: 'report',
      entityLabel: result.title,
      detail: `${result.title} exported to CSV (${result.rowCount} row(s), ${formatDate(result.range.from)} – ${formatDate(result.range.to)})`,
      severity: 'warning',
    });
    return { path, rowCount: result.rowCount };
  }

  async export(request: ReportRequest, format: 'csv' | 'pdf' | 'print'): Promise<{ path: string | null; printed: boolean; rowCount: number }> {
    if (format === 'csv') {
      const csv = await this.exportCsv(request, this.context().paths.exportsDir);
      return { path: csv.path, printed: false, rowCount: csv.rowCount };
    }
    requirePermission(this.context(), 'report.export');
    if (!this.printer) throw AppError.precondition('Printing is not available in this build.');
    const result = await this.printer.renderReport(request, format);
    return { path: result.path, printed: result.printed, rowCount: this.run(request).rowCount };
  }

  // --- Report bodies -------------------------------------------------------

  private build(
    request: ReportRequest,
    dates: { from: IsoDate; to: IsoDate },
    options: { financial: boolean; profit: boolean; groupBy: NonNullable<ReportRequest['groupBy']> },
  ): {
    subtitle: string;
    columns: ReportColumn[];
    rows: Array<Record<string, string | number | null>>;
    totals: Record<string, number>;
    summary: ReportResult['summary'];
    chart: ReportResult['chart'];
  } {
    switch (request.reportKey) {
      case 'patients_registered':
        return this.patientsRegistered(dates, options);
      case 'patient_register_detail':
        return this.patientRegister(dates, request);
      case 'appointments':
        return this.appointmentReport(dates, request);
      case 'no_shows':
        return this.noShowReport(dates, request);
      case 'visits':
        return this.visitReport(dates, request);
      case 'treatments':
        return this.treatmentReport(dates, request, options);
      case 'prescriptions':
        return this.prescriptionReport(dates, request);
      case 'referrals':
        return this.referralReport(dates, request);
      case 'revenue':
        return this.revenueReport(dates, options);
      case 'payments':
        return this.paymentReport(dates, request);
      case 'outstanding':
        return this.outstandingReport(dates, request);
      case 'expenses':
        return this.accountingReport('expense', dates, request);
      case 'income':
        return this.accountingReport('income', dates, request);
      case 'profit':
        return this.profitReport(dates, options);
      case 'daybook':
        return this.daybookReport(dates, request);
      case 'inventory_stock':
        return this.stockReport(dates, request, options);
      case 'inventory_low_stock':
        return this.lowStockReport(dates, request);
      case 'inventory_expiry':
        return this.expiryReport(dates, request);
      case 'inventory_movements':
        return this.movementReport(dates, request);
      case 'dentist_activity':
        return this.dentistActivityReport(dates, options);
      case 'staff_activity':
        return this.staffActivityReport(dates);
      case 'audit_summary':
        return this.auditSummaryReport(dates);
      default:
        throw AppError.notFound('Report');
    }
  }

  private patientsRegistered(dates: { from: IsoDate; to: IsoDate }, options: { groupBy: NonNullable<ReportRequest['groupBy']> }): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS registrations,
                SUM(CASE WHEN gender = 'female' THEN 1 ELSE 0 END) AS female,
                SUM(CASE WHEN gender = 'male' THEN 1 ELSE 0 END) AS male
           FROM patients WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?
          GROUP BY day ORDER BY day`,
      )
      .all(dates.from, dates.to) as Array<{ day: string; registrations: number; female: number; male: number }>;

    const series = rows.map((row) => ({
      date: row.day,
      registrations: Number(row.registrations),
      female: Number(row.female),
      male: Number(row.male),
    }));
    const buckets = foldSeries(series, options.groupBy, (bucket) => ({
      date: bucket.date,
      registrations: bucket.values.reduce((sum, value) => sum + value.registrations, 0),
      female: bucket.values.reduce((sum, value) => sum + value.female, 0),
      male: bucket.values.reduce((sum, value) => sum + value.male, 0),
    }));

    let running = 0;
    const output = buckets.map((bucket) => {
      running += bucket.registrations;
      return { date: bucket.date, registrations: bucket.registrations, female: bucket.female, male: bucket.male, runningTotal: running };
    });
    const total = output.reduce((sum, row) => sum + row.registrations, 0);
    return {
      subtitle: `${total} new patient${total === 1 ? '' : 's'} registered`,
      columns: [
        { key: 'date', label: 'Period', align: 'left', type: 'date' },
        { key: 'registrations', label: 'New patients', align: 'right', type: 'number' },
        { key: 'male', label: 'Male', align: 'right', type: 'number' },
        { key: 'female', label: 'Female', align: 'right', type: 'number' },
        { key: 'runningTotal', label: 'Running total', align: 'right', type: 'number' },
      ],
      rows: output,
      totals: { registrations: total, male: output.reduce((sum, row) => sum + row.male, 0), female: output.reduce((sum, row) => sum + row.female, 0) },
      summary: [
        { label: 'New patients', value: String(total), tone: 'success' as const },
        { label: 'Average per day', value: averagePerDay(total, dates.from, dates.to) },
      ],
      chart: output.map((row) => ({ label: formatDate(row.date, 'DD MMM'), value: row.registrations })),
    };
  }

  private patientRegister(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const status = request.filters?.status ?? null;
    const rows = this.db
      .prepare(
        `SELECT p.code, trim(p.first_name || ' ' || p.last_name) AS name, p.gender,
                COALESCE(p.age_years, 0) AS age, p.dob, p.phone, p.alternate_phone, p.city, p.status,
                substr(p.created_at, 1, 10) AS registered
           FROM patients p
          WHERE p.deleted_at IS NULL AND substr(p.created_at, 1, 10) BETWEEN ? AND ?
            ${status ? 'AND p.status = ?' : ''}
          ORDER BY p.code`,
      )
      .all(...(status ? [dates.from, dates.to, status] : [dates.from, dates.to])) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      code: asString(row['code']),
      name: asString(row['name']),
      gender: asString(row['gender']),
      age: row['dob'] ? '' : asNumber(row['age']),
      phone: asString(row['phone']) || asString(row['alternate_phone']),
      city: asString(row['city']),
      status: asString(row['status']),
      registered: asString(row['registered']),
    }));
    return {
      subtitle: `${output.length} patient record${output.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'code', label: 'Code', align: 'left', type: 'text', widthMm: 22 },
        { key: 'name', label: 'Patient', align: 'left', type: 'text' },
        { key: 'gender', label: 'Gender', align: 'left', type: 'text', widthMm: 20 },
        { key: 'age', label: 'Age', align: 'right', type: 'number', widthMm: 14 },
        { key: 'phone', label: 'Phone', align: 'left', type: 'text', widthMm: 32 },
        { key: 'city', label: 'City', align: 'left', type: 'text', widthMm: 30 },
        { key: 'status', label: 'Status', align: 'left', type: 'status', widthMm: 20 },
        { key: 'registered', label: 'Registered', align: 'left', type: 'date', widthMm: 24 },
      ],
      rows: output,
      totals: {},
      summary: [
        { label: 'Patients', value: String(output.length) },
        { label: 'Active', value: String(output.filter((row) => row.status === 'active').length) },
      ],
      chart: null,
    };
  }

  private appointmentReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const filters: string[] = [];
    const params: unknown[] = [dates.from, dates.to];
    if (request.filters?.dentistId) {
      filters.push('a.dentist_id = ?');
      params.push(request.filters.dentistId);
    }
    if (request.filters?.status) {
      filters.push('a.status = ?');
      params.push(request.filters.status);
    }
    const rows = this.db
      .prepare(
        `SELECT a.date, a.start_time, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                COALESCE(d.name, 'Unassigned') AS dentist_name, a.status, a.reason
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           LEFT JOIN dentists d ON d.id = a.dentist_id
          WHERE a.deleted_at IS NULL AND a.date BETWEEN ? AND ? ${filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''}
          ORDER BY a.date, a.start_time`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      date: asString(row['date']),
      time: asString(row['start_time']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      dentist: asString(row['dentist_name']),
      status: asString(row['status']),
      reason: asString(row['reason']),
    }));
    const byStatus = countBy(output, (row) => row.status);
    return {
      subtitle: `${output.length} appointment${output.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'time', label: 'Time', align: 'left', type: 'text', widthMm: 18 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'dentist', label: 'Dentist', align: 'left', type: 'text', widthMm: 34 },
        { key: 'status', label: 'Status', align: 'left', type: 'status', widthMm: 22 },
        { key: 'reason', label: 'Reason', align: 'left', type: 'text' },
      ],
      rows: output,
      totals: {},
      summary: Object.entries(byStatus).map(([label, value]) => ({ label, value: String(value) })),
      chart: Object.entries(byStatus).map(([label, value]) => ({ label, value })),
    };
  }

  private noShowReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT a.date, a.start_time, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                COALESCE(d.name, 'Unassigned') AS dentist_name, a.status, a.cancelled_reason, a.reason, p.phone
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           LEFT JOIN dentists d ON d.id = a.dentist_id
          WHERE a.deleted_at IS NULL AND a.date BETWEEN ? AND ? AND a.status IN ('no_show', 'cancelled')
            ${request.filters?.dentistId ? 'AND a.dentist_id = ?' : ''}
          ORDER BY a.date DESC, a.start_time`,
      )
      .all(...(request.filters?.dentistId ? [dates.from, dates.to, request.filters.dentistId] : [dates.from, dates.to])) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      date: asString(row['date']),
      time: asString(row['start_time']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      phone: asString(row['phone']),
      dentist: asString(row['dentist_name']),
      status: asString(row['status']),
      reason: asString(row['cancelled_reason']) || asString(row['reason']),
    }));
    const noShows = output.filter((row) => row.status === 'no_show').length;
    return {
      subtitle: `${noShows} missed, ${output.length - noShows} cancelled`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'time', label: 'Time', align: 'left', type: 'text', widthMm: 18 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'phone', label: 'Phone', align: 'left', type: 'text', widthMm: 30 },
        { key: 'dentist', label: 'Dentist', align: 'left', type: 'text', widthMm: 34 },
        { key: 'status', label: 'Status', align: 'left', type: 'status', widthMm: 22 },
        { key: 'reason', label: 'Reason', align: 'left', type: 'text' },
      ],
      rows: output,
      totals: {},
      summary: [
        { label: 'No-shows', value: String(noShows), tone: noShows > 0 ? ('warning' as const) : ('default' as const) },
        { label: 'Cancellations', value: String(output.length - noShows) },
      ],
      chart: null,
    };
  }

  private visitReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT v.visit_date, v.visit_time, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                COALESCE(d.name, 'Unassigned') AS dentist_name, v.diagnosis, v.chief_complaint, v.follow_up_date,
                (SELECT COUNT(*) FROM treatment_records tr WHERE tr.visit_id = v.id AND tr.deleted_at IS NULL) AS treatment_count
           FROM visits v
           JOIN patients p ON p.id = v.patient_id
           LEFT JOIN dentists d ON d.id = v.dentist_id
          WHERE v.deleted_at IS NULL AND v.visit_date BETWEEN ? AND ?
            ${request.filters?.dentistId ? 'AND v.dentist_id = ?' : ''}
            ${request.filters?.patientId ? 'AND v.patient_id = ?' : ''}
          ORDER BY v.visit_date, v.visit_time`,
      )
      .all(
        ...[dates.from, dates.to, ...(request.filters?.dentistId ? [request.filters.dentistId] : []), ...(request.filters?.patientId ? [request.filters.patientId] : [])],
      ) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      date: asString(row['visit_date']),
      time: asString(row['visit_time']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      dentist: asString(row['dentist_name']),
      diagnosis: asString(row['diagnosis']) || asString(row['chief_complaint']),
      treatments: asNumber(row['treatment_count']),
      followUp: asString(row['follow_up_date']) || '',
    }));
    const withFollowUp = output.filter((row) => row.followUp !== '').length;
    return {
      subtitle: `${output.length} visit${output.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'time', label: 'Time', align: 'left', type: 'text', widthMm: 18 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'dentist', label: 'Dentist', align: 'left', type: 'text', widthMm: 32 },
        { key: 'diagnosis', label: 'Diagnosis', align: 'left', type: 'text' },
        { key: 'treatments', label: 'Treatments', align: 'right', type: 'number', widthMm: 20 },
        { key: 'followUp', label: 'Follow-up', align: 'left', type: 'date', widthMm: 24 },
      ],
      rows: output,
      totals: { treatments: output.reduce((sum, row) => sum + row.treatments, 0) },
      summary: [
        { label: 'Visits', value: String(output.length) },
        { label: 'Follow-ups booked', value: String(withFollowUp) },
      ],
      chart: null,
    };
  }

  private treatmentReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest, options: { financial: boolean }): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT substr(t.performed_at, 1, 10) AS date, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                COALESCE(d.name, 'Unassigned') AS dentist_name, t.code AS treatment_code, t.description, t.tooth_codes,
                t.quantity, t.unit_price_paisa, t.total_paisa
           FROM treatment_records t
           JOIN patients p ON p.id = t.patient_id
           LEFT JOIN dentists d ON d.id = t.dentist_id
          WHERE t.deleted_at IS NULL AND substr(t.performed_at, 1, 10) BETWEEN ? AND ?
            ${request.filters?.dentistId ? 'AND t.dentist_id = ?' : ''}
            ${request.filters?.patientId ? 'AND t.patient_id = ?' : ''}
          ORDER BY date, p.code`,
      )
      .all(
        ...[dates.from, dates.to, ...(request.filters?.dentistId ? [request.filters.dentistId] : []), ...(request.filters?.patientId ? [request.filters.patientId] : [])],
      ) as Array<Record<string, unknown>>;

    const output = rows.map((row) => {
      const base: Record<string, string | number | null> = {
        date: asString(row['date']),
        patientCode: asString(row['patient_code']),
        patient: asString(row['patient_name']),
        dentist: asString(row['dentist_name']),
        treatment: asString(row['description']) || asString(row['treatment_code']),
        teeth: parseTeeth(asString(row['tooth_codes'])),
        quantity: asNumber(row['quantity']),
      };
      if (options.financial) {
        base['unitPrice'] = asNumber(row['unit_price_paisa']);
        base['total'] = asNumber(row['total_paisa']);
      }
      return base;
    });

    const columns: ReportColumn[] = [
      { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
      { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
      { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
      { key: 'dentist', label: 'Dentist', align: 'left', type: 'text', widthMm: 32 },
      { key: 'treatment', label: 'Treatment', align: 'left', type: 'text' },
      { key: 'teeth', label: 'Teeth', align: 'left', type: 'text', widthMm: 26 },
      { key: 'quantity', label: 'Qty', align: 'right', type: 'number', widthMm: 14 },
    ];
    const totals: Record<string, number> = { quantity: output.reduce((sum, row) => sum + asNumber(row['quantity']), 0) };
    if (options.financial) {
      columns.push({ key: 'unitPrice', label: 'Unit price', align: 'right', type: 'money', widthMm: 26 });
      columns.push({ key: 'total', label: 'Total', align: 'right', type: 'money', widthMm: 28 });
      totals['total'] = output.reduce((sum, row) => sum + asNumber(row['total']), 0);
    }

    return {
      subtitle: `${output.length} treatment line${output.length === 1 ? '' : 's'}`,
      columns,
      rows: output,
      totals,
      summary: [
        { label: 'Treatment lines', value: String(output.length) },
        ...(options.financial ? [{ label: 'Value', value: formatMoney(totals['total'] ?? 0) }] : []),
      ],
      chart: null,
    };
  }

  private prescriptionReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT pr.number, pr.date, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                COALESCE(d.name, 'Unassigned') AS dentist_name, pr.is_void,
                (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = pr.id) AS item_count
           FROM prescriptions pr
           JOIN patients p ON p.id = pr.patient_id
           LEFT JOIN dentists d ON d.id = pr.dentist_id
          WHERE pr.deleted_at IS NULL AND pr.date BETWEEN ? AND ?
            ${request.filters?.dentistId ? 'AND pr.dentist_id = ?' : ''}
            ${request.filters?.patientId ? 'AND pr.patient_id = ?' : ''}
          ORDER BY pr.date DESC, pr.number DESC`,
      )
      .all(
        ...[dates.from, dates.to, ...(request.filters?.dentistId ? [request.filters.dentistId] : []), ...(request.filters?.patientId ? [request.filters.patientId] : [])],
      ) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      number: asString(row['number']),
      date: asString(row['date']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      dentist: asString(row['dentist_name']),
      items: asNumber(row['item_count']),
      status: asNumber(row['is_void']) === 1 ? 'void' : 'issued',
    }));
    return {
      subtitle: `${output.length} prescription${output.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'number', label: 'Number', align: 'left', type: 'text', widthMm: 34 },
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'dentist', label: 'Dentist', align: 'left', type: 'text', widthMm: 32 },
        { key: 'items', label: 'Medicines', align: 'right', type: 'number', widthMm: 20 },
        { key: 'status', label: 'Status', align: 'left', type: 'status', widthMm: 20 },
      ],
      rows: output,
      totals: { items: output.reduce((sum, row) => sum + row.items, 0) },
      summary: [
        { label: 'Prescriptions', value: String(output.length) },
        { label: 'Voided', value: String(output.filter((row) => row.status === 'void').length), tone: output.some((row) => row.status === 'void') ? 'warning' : 'default' },
      ],
      chart: null,
    };
  }

  private referralReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT r.date, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                r.doctor_name, r.specialty, r.organisation, r.reason, r.status, r.follow_up_date
           FROM referrals r
           JOIN patients p ON p.id = r.patient_id
          WHERE r.date BETWEEN ? AND ?
            ${request.filters?.patientId ? 'AND r.patient_id = ?' : ''}
          ORDER BY r.date DESC`,
      )
      .all(...(request.filters?.patientId ? [dates.from, dates.to, request.filters.patientId] : [dates.from, dates.to])) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      date: asString(row['date']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      doctor: asString(row['doctor_name']),
      specialty: asString(row['specialty']),
      organisation: asString(row['organisation']),
      reason: asString(row['reason']),
      status: asString(row['status']),
      followUp: asString(row['follow_up_date']) || '',
    }));
    const pending = output.filter((row) => row.status === 'pending' || row.status === 'scheduled').length;
    return {
      subtitle: `${output.length} referral${output.length === 1 ? '' : 's'}, ${pending} still open`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'doctor', label: 'Referred to', align: 'left', type: 'text' },
        { key: 'specialty', label: 'Specialty', align: 'left', type: 'text', widthMm: 30 },
        { key: 'reason', label: 'Reason', align: 'left', type: 'text' },
        { key: 'status', label: 'Status', align: 'left', type: 'status', widthMm: 22 },
        { key: 'followUp', label: 'Follow-up', align: 'left', type: 'date', widthMm: 24 },
      ],
      rows: output,
      totals: {},
      summary: [
        { label: 'Referrals', value: String(output.length) },
        { label: 'Open', value: String(pending), tone: pending > 0 ? ('warning' as const) : ('default' as const) },
      ],
      chart: countToChart(output, (row) => row.status),
    };
  }

  private revenueReport(dates: { from: IsoDate; to: IsoDate }, options: { groupBy: NonNullable<ReportRequest['groupBy']> }): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT i.date AS day, COUNT(*) AS invoices, SUM(i.subtotal_paisa) AS gross, SUM(i.discount_paisa) AS discount,
                SUM(i.total_paisa) AS net, SUM(i.paid_paisa) AS collected
           FROM invoices i
          WHERE i.deleted_at IS NULL AND i.is_void = 0 AND i.date BETWEEN ? AND ?
          GROUP BY day ORDER BY day`,
      )
      .all(dates.from, dates.to) as Array<Record<string, unknown>>;

    const series = rows.map((row) => ({
      date: asString(row['day']),
      invoices: asNumber(row['invoices']),
      gross: asNumber(row['gross']),
      discount: asNumber(row['discount']),
      net: asNumber(row['net']),
      collected: asNumber(row['collected']),
    }));
    const buckets = foldSeries(
      series,
      options.groupBy,
      (bucket) => ({
        date: bucket.date,
        invoices: bucket.values.reduce((sum, value) => sum + value.invoices, 0),
        gross: bucket.values.reduce((sum, value) => sum + value.gross, 0),
        discount: bucket.values.reduce((sum, value) => sum + value.discount, 0),
        net: bucket.values.reduce((sum, value) => sum + value.net, 0),
        collected: bucket.values.reduce((sum, value) => sum + value.collected, 0),
      }),
    );

    const output = buckets.map((bucket) => ({ ...bucket, outstanding: bucket.net - bucket.collected }));
    const totals = {
      invoices: output.reduce((sum, row) => sum + row.invoices, 0),
      gross: output.reduce((sum, row) => sum + row.gross, 0),
      discount: output.reduce((sum, row) => sum + row.discount, 0),
      net: output.reduce((sum, row) => sum + row.net, 0),
      collected: output.reduce((sum, row) => sum + row.collected, 0),
      outstanding: output.reduce((sum, row) => sum + row.outstanding, 0),
    };
    return {
      subtitle: `${total2(totals.net)} invoiced across ${totals.invoices} invoice${totals.invoices === 1 ? '' : 's'}`,
      columns: [
        { key: 'date', label: 'Period', align: 'left', type: 'date' },
        { key: 'invoices', label: 'Invoices', align: 'right', type: 'number', widthMm: 20 },
        { key: 'gross', label: 'Gross', align: 'right', type: 'money' },
        { key: 'discount', label: 'Discount', align: 'right', type: 'money' },
        { key: 'net', label: 'Net billed', align: 'right', type: 'money' },
        { key: 'collected', label: 'Collected', align: 'right', type: 'money' },
        { key: 'outstanding', label: 'Outstanding', align: 'right', type: 'money' },
      ],
      rows: output,
      totals,
      summary: [
        { label: 'Net billed', value: formatMoney(totals.net) },
        { label: 'Collected', value: formatMoney(totals.collected), tone: 'success' as const },
        { label: 'Outstanding', value: formatMoney(totals.outstanding), tone: totals.outstanding > 0 ? ('warning' as const) : ('default' as const) },
        { label: 'Discounts given', value: formatMoney(totals.discount) },
      ],
      chart: output.map((row) => ({ label: formatDate(row.date, 'DD MMM'), value: row.net })),
    };
  }

  private paymentReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const filters: string[] = [];
    const params: unknown[] = [dates.from, dates.to];
    if (request.filters?.paymentMethodId) {
      filters.push('pay.method_id = ?');
      params.push(request.filters.paymentMethodId);
    }
    const rows = this.db
      .prepare(
        `SELECT pay.receipt_number, pay.paid_date, pay.paid_at, p.code AS patient_code,
                trim(p.first_name || ' ' || p.last_name) AS patient_name, i.number AS invoice_number,
                COALESCE(m.name, 'Unspecified') AS method_name, pay.amount_paisa, pay.reference, COALESCE(u.full_name, '') AS received_by
           FROM payments pay
           JOIN patients p ON p.id = pay.patient_id
           JOIN invoices i ON i.id = pay.invoice_id
           LEFT JOIN payment_methods m ON m.id = pay.method_id
           LEFT JOIN users u ON u.id = pay.received_by
          WHERE pay.is_void = 0 AND pay.paid_date BETWEEN ? AND ? ${filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''}
          ORDER BY pay.paid_at`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      receipt: asString(row['receipt_number']),
      date: asString(row['paid_date']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      invoice: asString(row['invoice_number']),
      method: asString(row['method_name']),
      reference: asString(row['reference']),
      amount: asNumber(row['amount_paisa']),
      receivedBy: asString(row['received_by']),
    }));
    const byMethod = new Map<string, number>();
    for (const row of output) byMethod.set(row.method, (byMethod.get(row.method) ?? 0) + row.amount);
    const total = output.reduce((sum, row) => sum + row.amount, 0);
    return {
      subtitle: `${formatMoney(total)} collected in ${output.length} receipt${output.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'receipt', label: 'Receipt', align: 'left', type: 'text', widthMm: 34 },
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'invoice', label: 'Invoice', align: 'left', type: 'text', widthMm: 32 },
        { key: 'method', label: 'Method', align: 'left', type: 'text', widthMm: 26 },
        { key: 'reference', label: 'Reference', align: 'left', type: 'text', widthMm: 30 },
        { key: 'amount', label: 'Amount', align: 'right', type: 'money' },
      ],
      rows: output,
      totals: { amount: total },
      summary: [
        { label: 'Total collected', value: formatMoney(total), tone: 'success' as const },
        ...[...byMethod.entries()].map(([method, amount]) => ({ label: method, value: formatMoney(amount) })),
      ],
      chart: [...byMethod.entries()].map(([label, value]) => ({ label, value })),
    };
  }

  private outstandingReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT i.number, i.date, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                p.phone, i.total_paisa, i.paid_paisa, (i.total_paisa - i.paid_paisa) AS balance
           FROM invoices i
           JOIN patients p ON p.id = i.patient_id
          WHERE i.deleted_at IS NULL AND i.is_void = 0 AND i.date BETWEEN ? AND ?
            AND i.total_paisa > i.paid_paisa
            ${request.filters?.patientId ? 'AND i.patient_id = ?' : ''}
          ORDER BY i.date, i.number`,
      )
      .all(...(request.filters?.patientId ? [dates.from, dates.to, request.filters.patientId] : [dates.from, dates.to])) as Array<Record<string, unknown>>;

    const today = todayIso(new Date(), this.context().timeZone());
    const output = rows.map((row) => ({
      number: asString(row['number']),
      date: asString(row['date']),
      patientCode: asString(row['patient_code']),
      patient: asString(row['patient_name']),
      phone: asString(row['phone']),
      total: asNumber(row['total_paisa']),
      paid: asNumber(row['paid_paisa']),
      balance: asNumber(row['balance']),
      ageDays: Math.max(0, daysBetween(asString(row['date']), today)),
    }));
    const balance = output.reduce((sum, row) => sum + row.balance, 0);
    const overdue = output.filter((row) => row.ageDays > 30);
    return {
      subtitle: `${output.length} invoice${output.length === 1 ? '' : 's'} with a balance`,
      columns: [
        { key: 'number', label: 'Invoice', align: 'left', type: 'text', widthMm: 34 },
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'patientCode', label: 'Code', align: 'left', type: 'text', widthMm: 20 },
        { key: 'patient', label: 'Patient', align: 'left', type: 'text' },
        { key: 'phone', label: 'Phone', align: 'left', type: 'text', widthMm: 30 },
        { key: 'total', label: 'Billed', align: 'right', type: 'money' },
        { key: 'paid', label: 'Paid', align: 'right', type: 'money' },
        { key: 'balance', label: 'Balance', align: 'right', type: 'money' },
        { key: 'ageDays', label: 'Age (days)', align: 'right', type: 'number', widthMm: 22 },
      ],
      rows: output,
      totals: { total: output.reduce((sum, row) => sum + row.total, 0), paid: output.reduce((sum, row) => sum + row.paid, 0), balance },
      summary: [
        { label: 'Outstanding', value: formatMoney(balance), tone: balance > 0 ? ('warning' as const) : ('default' as const) },
        { label: 'Over 30 days', value: String(overdue.length), tone: overdue.length > 0 ? ('danger' as const) : ('default' as const) },
        { label: 'Oldest', value: output.length > 0 ? formatDate(output[0]!.date) : '—' },
      ],
      chart: null,
    };
  }

  private accountingReport(direction: 'income' | 'expense', dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT tr.date, COALESCE(c.name, 'Uncategorised') AS category, COALESCE(m.name, '') AS method,
                tr.amount_paisa, tr.reference, tr.note, COALESCE(u.full_name, '') AS recorded_by, tr.source_type
           FROM accounting_transactions tr
           LEFT JOIN accounting_categories c ON c.id = tr.category_id
           LEFT JOIN payment_methods m ON m.id = tr.payment_method_id
           LEFT JOIN users u ON u.id = tr.created_by
          WHERE tr.is_void = 0 AND tr.direction = ? AND tr.date BETWEEN ? AND ?
            ${request.filters?.categoryId ? 'AND tr.category_id = ?' : ''}
            ${request.filters?.paymentMethodId ? 'AND tr.payment_method_id = ?' : ''}
          ORDER BY tr.date, tr.id`,
      )
      .all(
        ...[direction, dates.from, dates.to, ...(request.filters?.categoryId ? [request.filters.categoryId] : []), ...(request.filters?.paymentMethodId ? [request.filters.paymentMethodId] : [])],
      ) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      date: asString(row['date']),
      category: asString(row['category']),
      method: asString(row['method']),
      reference: asString(row['reference']),
      note: asString(row['note']),
      source: asString(row['source_type']),
      amount: asNumber(row['amount_paisa']),
    }));
    const total = output.reduce((sum, row) => sum + row.amount, 0);
    const byCategory = new Map<string, number>();
    for (const row of output) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amount);
    return {
      subtitle: `${direction === 'income' ? 'Income' : 'Expenses'} of ${formatMoney(total)}`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'category', label: 'Category', align: 'left', type: 'text' },
        { key: 'method', label: 'Method', align: 'left', type: 'text', widthMm: 28 },
        { key: 'reference', label: 'Reference', align: 'left', type: 'text', widthMm: 32 },
        { key: 'note', label: 'Note', align: 'left', type: 'text' },
        { key: 'amount', label: 'Amount', align: 'right', type: 'money' },
      ],
      rows: output,
      totals: { amount: total },
      summary: [
        { label: direction === 'income' ? 'Total income' : 'Total expenses', value: formatMoney(total), tone: direction === 'income' ? ('success' as const) : ('warning' as const) },
        { label: 'Entries', value: String(output.length) },
        ...[...byCategory.entries()].slice(0, 4).map(([category, amount]) => ({ label: category, value: formatMoney(amount) })),
      ],
      chart: [...byCategory.entries()].map(([label, value]) => ({ label, value })),
    };
  }

  private profitReport(dates: { from: IsoDate; to: IsoDate }, options: { groupBy: NonNullable<ReportRequest['groupBy']> }): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT tr.date AS day, tr.direction, SUM(tr.amount_paisa) AS amount
           FROM accounting_transactions tr
          WHERE tr.is_void = 0 AND tr.date BETWEEN ? AND ?
          GROUP BY day, tr.direction ORDER BY day`,
      )
      .all(dates.from, dates.to) as Array<{ day: string; direction: string; amount: number }>;

    const byDay = new Map<string, { income: number; expense: number }>();
    for (const row of rows) {
      const entry = byDay.get(row.day) ?? { income: 0, expense: 0 };
      if (row.direction === 'income') entry.income += Number(row.amount);
      else entry.expense += Number(row.amount);
      byDay.set(row.day, entry);
    }
    const series = [...byDay.entries()].map(([day, value]) => ({ date: day, income: value.income, expense: value.expense }));
    const bucketed = foldSeries(
      series,
      options.groupBy,
      (bucket) => ({
        date: bucket.date,
        income: bucket.values.reduce((sum, value) => sum + value.income, 0),
        expense: bucket.values.reduce((sum, value) => sum + value.expense, 0),
      }),
    );
    const output = bucketed.map((bucket) => ({ ...bucket, net: bucket.income - bucket.expense }));
    const totals = {
      income: output.reduce((sum, row) => sum + row.income, 0),
      expense: output.reduce((sum, row) => sum + row.expense, 0),
    };
    const net = totals.income - totals.expense;
    const margin = totals.income === 0 ? 0 : Math.round((net / totals.income) * 1000) / 10;
    return {
      subtitle: `Net ${formatMoney(net)} for the period`,
      columns: [
        { key: 'date', label: 'Period', align: 'left', type: 'date' },
        { key: 'income', label: 'Income', align: 'right', type: 'money' },
        { key: 'expense', label: 'Expenses', align: 'right', type: 'money' },
        { key: 'net', label: 'Net', align: 'right', type: 'money' },
      ],
      rows: output,
      totals: { ...totals, net },
      summary: [
        { label: 'Income', value: formatMoney(totals.income), tone: 'success' as const },
        { label: 'Expenses', value: formatMoney(totals.expense), tone: 'warning' as const },
        { label: 'Net', value: formatMoney(net), tone: net >= 0 ? ('success' as const) : ('danger' as const) },
        { label: 'Margin', value: `${margin}%` },
      ],
      chart: output.map((row) => ({ label: formatDate(row.date, 'DD MMM'), value: row.net })),
    };
  }

  private daybookReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT tr.date, tr.direction, COALESCE(c.name, 'Uncategorised') AS category, COALESCE(m.name, '') AS method,
                COALESCE(pay.number, '') AS invoice_number, tr.reference, tr.note, tr.amount_paisa, tr.source_type
           FROM accounting_transactions tr
           LEFT JOIN accounting_categories c ON c.id = tr.category_id
           LEFT JOIN payment_methods m ON m.id = tr.payment_method_id
           LEFT JOIN payments p ON tr.source_type = 'payment' AND p.id = tr.source_id
           LEFT JOIN invoices pay ON pay.id = p.invoice_id
          WHERE tr.is_void = 0 AND tr.date BETWEEN ? AND ?
            ${request.filters?.direction ? 'AND tr.direction = ?' : ''}
          ORDER BY tr.date, tr.id`,
      )
      .all(...(request.filters?.direction ? [dates.from, dates.to, request.filters.direction] : [dates.from, dates.to])) as Array<Record<string, unknown>>;

    let running = 0;
    const output = rows.map((row) => {
      const direction = asString(row['direction']);
      const amount = asNumber(row['amount_paisa']);
      running += direction === 'income' ? amount : -amount;
      return {
        date: asString(row['date']),
        category: asString(row['category']),
        method: asString(row['method']),
        reference: asString(row['reference']) || asString(row['invoice_number']),
        note: asString(row['note']),
        income: direction === 'income' ? amount : null,
        expense: direction === 'expense' ? amount : null,
        balance: running,
      };
    });
    const income = output.reduce((sum, row) => sum + (row.income ?? 0), 0);
    const expense = output.reduce((sum, row) => sum + (row.expense ?? 0), 0);
    return {
      subtitle: `${output.length} entr${output.length === 1 ? 'y' : 'ies'} in the daybook`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'category', label: 'Category', align: 'left', type: 'text' },
        { key: 'reference', label: 'Reference', align: 'left', type: 'text', widthMm: 30 },
        { key: 'note', label: 'Note', align: 'left', type: 'text' },
        { key: 'income', label: 'Money in', align: 'right', type: 'money' },
        { key: 'expense', label: 'Money out', align: 'right', type: 'money' },
        { key: 'balance', label: 'Balance', align: 'right', type: 'money' },
      ],
      rows: output,
      totals: { income, expense, balance: running },
      summary: [
        { label: 'Money in', value: formatMoney(income), tone: 'success' as const },
        { label: 'Money out', value: formatMoney(expense), tone: 'warning' as const },
        { label: 'Closing balance', value: formatMoney(running), tone: running >= 0 ? ('default' as const) : ('danger' as const) },
      ],
      chart: null,
    };
  }

  private stockReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest, options: { financial: boolean }): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT i.code, i.name, COALESCE(c.name, '') AS category, COALESCE(s.name, '') AS supplier, i.unit,
                i.current_stock_milli, i.minimum_stock_milli, i.reorder_level_milli, i.purchase_price_paisa,
                i.batch_number, i.expiry_date, i.storage_location
           FROM inventory_items i
           LEFT JOIN inventory_categories c ON c.id = i.category_id
           LEFT JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.deleted_at IS NULL
            ${request.filters?.categoryId ? 'AND i.category_id = ?' : ''}
            ${request.filters?.supplierId ? 'AND i.supplier_id = ?' : ''}
          ORDER BY i.name`,
      )
      .all(...(request.filters?.categoryId ? [request.filters.categoryId] : []).concat(request.filters?.supplierId ? [request.filters.supplierId] : [])) as Array<Record<string, unknown>>;

    const output = rows.map((row) => {
      const stock = asNumber(row['current_stock_milli']) / 1000;
      const base: Record<string, string | number | null> = {
        code: asString(row['code']),
        name: asString(row['name']),
        category: asString(row['category']),
        supplier: asString(row['supplier']),
        unit: asString(row['unit']),
        stock: round3(stock),
        minimum: round3(asNumber(row['minimum_stock_milli']) / 1000),
        reorder: round3(asNumber(row['reorder_level_milli']) / 1000),
        batch: asString(row['batch_number']),
        expiry: asString(row['expiry_date']) || '',
      };
      if (options.financial) {
        const unitPrice = asNumber(row['purchase_price_paisa']);
        base['unitPrice'] = unitPrice;
        base['stockValue'] = Math.round((stock * unitPrice) / 1);
      }
      return base;
    });

    const columns: ReportColumn[] = [
      { key: 'code', label: 'Code', align: 'left', type: 'text', widthMm: 24 },
      { key: 'name', label: 'Item', align: 'left', type: 'text' },
      { key: 'category', label: 'Category', align: 'left', type: 'text', widthMm: 28 },
      { key: 'unit', label: 'Unit', align: 'left', type: 'text', widthMm: 18 },
      { key: 'stock', label: 'On hand', align: 'right', type: 'number', widthMm: 20 },
      { key: 'minimum', label: 'Minimum', align: 'right', type: 'number', widthMm: 20 },
      { key: 'reorder', label: 'Reorder at', align: 'right', type: 'number', widthMm: 22 },
      { key: 'batch', label: 'Batch', align: 'left', type: 'text', widthMm: 24 },
      { key: 'expiry', label: 'Expiry', align: 'left', type: 'date', widthMm: 24 },
    ];
    const totals: Record<string, number> = {};
    if (options.financial) {
      columns.splice(5, 0, { key: 'unitPrice', label: 'Unit cost', align: 'right', type: 'money', widthMm: 26 });
      columns.push({ key: 'stockValue', label: 'Stock value', align: 'right', type: 'money', widthMm: 28 });
      totals['stockValue'] = output.reduce((sum, row) => sum + asNumber(row['stockValue']), 0);
    }
    void dates;
    return {
      subtitle: `${output.length} item${output.length === 1 ? '' : 's'} in stock`,
      columns,
      rows: output,
      totals,
      summary: [
        { label: 'Items', value: String(output.length) },
        { label: 'At or below minimum', value: String(output.filter((row) => asNumber(row['stock']) <= asNumber(row['minimum'])).length) },
        ...(options.financial ? [{ label: 'Stock value', value: formatMoney(totals['stockValue'] ?? 0) }] : []),
      ],
      chart: null,
    };
  }

  private lowStockReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT i.code, i.name, COALESCE(c.name, '') AS category, COALESCE(s.name, '') AS supplier, i.unit,
                i.current_stock_milli, i.minimum_stock_milli, i.reorder_level_milli, i.expiry_date
           FROM inventory_items i
           LEFT JOIN inventory_categories c ON c.id = i.category_id
           LEFT JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.deleted_at IS NULL AND i.is_active = 1 AND i.current_stock_milli <= i.minimum_stock_milli
            ${request.filters?.categoryId ? 'AND i.category_id = ?' : ''}
            ${request.filters?.supplierId ? 'AND i.supplier_id = ?' : ''}
          ORDER BY (i.minimum_stock_milli - i.current_stock_milli) DESC, i.name`,
      )
      .all(...(request.filters?.categoryId ? [request.filters.categoryId] : []).concat(request.filters?.supplierId ? [request.filters.supplierId] : [])) as Array<Record<string, unknown>>;

    const output = rows.map((row) => {
      const stock = asNumber(row['current_stock_milli']) / 1000;
      const minimum = asNumber(row['minimum_stock_milli']) / 1000;
      return {
        code: asString(row['code']),
        name: asString(row['name']),
        category: asString(row['category']),
        supplier: asString(row['supplier']),
        unit: asString(row['unit']),
        stock: round3(stock),
        minimum: round3(minimum),
        shortfall: round3(Math.max(0, minimum - stock)),
        expiry: asString(row['expiry_date']) || '',
      };
    });
    void dates;
    return {
      subtitle: `${output.length} item${output.length === 1 ? '' : 's'} need restocking`,
      columns: [
        { key: 'code', label: 'Code', align: 'left', type: 'text', widthMm: 24 },
        { key: 'name', label: 'Item', align: 'left', type: 'text' },
        { key: 'category', label: 'Category', align: 'left', type: 'text', widthMm: 28 },
        { key: 'supplier', label: 'Supplier', align: 'left', type: 'text', widthMm: 34 },
        { key: 'unit', label: 'Unit', align: 'left', type: 'text', widthMm: 18 },
        { key: 'stock', label: 'On hand', align: 'right', type: 'number', widthMm: 20 },
        { key: 'minimum', label: 'Minimum', align: 'right', type: 'number', widthMm: 20 },
        { key: 'shortfall', label: 'Short by', align: 'right', type: 'number', widthMm: 22 },
        { key: 'expiry', label: 'Expiry', align: 'left', type: 'date', widthMm: 24 },
      ],
      rows: output,
      totals: {},
      summary: [
        { label: 'Items to reorder', value: String(output.length), tone: output.length > 0 ? ('warning' as const) : ('success' as const) },
      ],
      chart: null,
    };
  }

  private expiryReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT i.code, i.name, COALESCE(c.name, '') AS category, i.unit, i.batch_number, i.expiry_date,
                i.current_stock_milli
           FROM inventory_items i
           LEFT JOIN inventory_categories c ON c.id = i.category_id
          WHERE i.deleted_at IS NULL AND i.expiry_date IS NOT NULL AND i.expiry_date <= ?
            ${request.filters?.categoryId ? 'AND i.category_id = ?' : ''}
          ORDER BY i.expiry_date`,
      )
      .all(...(request.filters?.categoryId ? [dates.to, request.filters.categoryId] : [dates.to])) as Array<Record<string, unknown>>;

    const today = todayIso(new Date(), this.context().timeZone());
    const output = rows.map((row) => {
      const expiry = asString(row['expiry_date']);
      return {
        code: asString(row['code']),
        name: asString(row['name']),
        category: asString(row['category']),
        batch: asString(row['batch_number']),
        expiry,
        daysLeft: daysBetween(today, expiry),
        stock: round3(asNumber(row['current_stock_milli']) / 1000),
      };
    });
    const expired = output.filter((row) => row.daysLeft < 0);
    return {
      subtitle: `${output.length} batch${output.length === 1 ? '' : 'es'} expiring by ${formatDate(dates.to)}`,
      columns: [
        { key: 'code', label: 'Code', align: 'left', type: 'text', widthMm: 24 },
        { key: 'name', label: 'Item', align: 'left', type: 'text' },
        { key: 'category', label: 'Category', align: 'left', type: 'text', widthMm: 28 },
        { key: 'batch', label: 'Batch', align: 'left', type: 'text', widthMm: 24 },
        { key: 'expiry', label: 'Expiry', align: 'left', type: 'date', widthMm: 24 },
        { key: 'daysLeft', label: 'Days left', align: 'right', type: 'number', widthMm: 22 },
        { key: 'stock', label: 'Stock', align: 'right', type: 'number', widthMm: 18 },
      ],
      rows: output,
      totals: {},
      summary: [
        { label: 'Batches in range', value: String(output.length) },
        { label: 'Already expired', value: String(expired.length), tone: expired.length > 0 ? ('danger' as const) : ('success' as const) },
      ],
      chart: null,
    };
  }

  private movementReport(dates: { from: IsoDate; to: IsoDate }, request: ReportRequest): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT m.moved_date, i.code, i.name, i.unit, m.type, m.quantity_milli, m.balance_after_milli,
                m.reason, m.reference, COALESCE(u.full_name, '') AS moved_by, m.batch_number, m.expiry_date
           FROM stock_movements m
           JOIN inventory_items i ON i.id = m.item_id
           LEFT JOIN users u ON u.id = m.moved_by
          WHERE m.moved_date BETWEEN ? AND ?
            ${request.filters?.itemId ? 'AND m.item_id = ?' : ''}
          ORDER BY m.moved_date, m.id`,
      )
      .all(...(request.filters?.itemId ? [dates.from, dates.to, request.filters.itemId] : [dates.from, dates.to])) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      date: asString(row['moved_date']),
      item: `${asString(row['code'])} — ${asString(row['name'])}`,
      type: asString(row['type']),
      quantity: round3(asNumber(row['quantity_milli']) / 1000),
      balance: round3(asNumber(row['balance_after_milli']) / 1000),
      unit: asString(row['unit']),
      reason: asString(row['reason']),
      reference: asString(row['reference']),
      movedBy: asString(row['moved_by']),
    }));
    const inTotal = output.filter((row) => row.quantity > 0).reduce((sum, row) => sum + row.quantity, 0);
    const outTotal = output.filter((row) => row.quantity < 0).reduce((sum, row) => sum + row.quantity, 0);
    return {
      subtitle: `${output.length} movement${output.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'date', label: 'Date', align: 'left', type: 'date', widthMm: 24 },
        { key: 'item', label: 'Item', align: 'left', type: 'text' },
        { key: 'type', label: 'Type', align: 'left', type: 'text', widthMm: 24 },
        { key: 'quantity', label: 'Change', align: 'right', type: 'number', widthMm: 20 },
        { key: 'balance', label: 'Balance', align: 'right', type: 'number', widthMm: 20 },
        { key: 'unit', label: 'Unit', align: 'left', type: 'text', widthMm: 16 },
        { key: 'reason', label: 'Reason', align: 'left', type: 'text' },
        { key: 'reference', label: 'Reference', align: 'left', type: 'text', widthMm: 28 },
        { key: 'movedBy', label: 'By', align: 'left', type: 'text', widthMm: 28 },
      ],
      rows: output,
      totals: {},
      summary: [
        { label: 'Received', value: String(round3(inTotal)) },
        { label: 'Issued', value: String(round3(Math.abs(outTotal))) },
      ],
      chart: null,
    };
  }

  private dentistActivityReport(dates: { from: IsoDate; to: IsoDate }, options: { financial: boolean }): ReturnType<ReportService['build']> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id AND a.deleted_at IS NULL AND a.date BETWEEN ? AND ?) AS appointments,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id AND a.deleted_at IS NULL AND a.date BETWEEN ? AND ? AND a.status = 'completed') AS completed,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_id = d.id AND a.deleted_at IS NULL AND a.date BETWEEN ? AND ? AND a.status = 'no_show') AS no_shows,
                (SELECT COUNT(*) FROM visits v WHERE v.dentist_id = d.id AND v.deleted_at IS NULL AND v.visit_date BETWEEN ? AND ?) AS visits,
                (SELECT COUNT(*) FROM prescriptions pr WHERE pr.dentist_id = d.id AND pr.deleted_at IS NULL AND pr.date BETWEEN ? AND ?) AS prescriptions,
                (SELECT COUNT(*) FROM treatment_records t WHERE t.dentist_id = d.id AND t.deleted_at IS NULL AND substr(t.performed_at, 1, 10) BETWEEN ? AND ?) AS treatments,
                (SELECT COALESCE(SUM(i.total_paisa), 0) FROM invoices i WHERE i.dentist_id = d.id AND i.deleted_at IS NULL AND i.is_void = 0 AND i.date BETWEEN ? AND ?) AS revenue
           FROM dentists d
          WHERE d.deleted_at IS NULL
          ORDER BY d.name`,
      )
      .all(...Array.from({ length: 8 }, () => [dates.from, dates.to]).flat()) as Array<Record<string, unknown>>;

    const output = rows.map((row) => {
      const base: Record<string, string | number | null> = {
        dentist: asString(row['name']),
        appointments: asNumber(row['appointments']),
        completed: asNumber(row['completed']),
        noShows: asNumber(row['no_shows']),
        visits: asNumber(row['visits']),
        prescriptions: asNumber(row['prescriptions']),
        treatments: asNumber(row['treatments']),
      };
      if (options.financial) base['revenue'] = asNumber(row['revenue']);
      return base;
    });
    const columns: ReportColumn[] = [
      { key: 'dentist', label: 'Dentist', align: 'left', type: 'text' },
      { key: 'appointments', label: 'Appointments', align: 'right', type: 'number', widthMm: 26 },
      { key: 'completed', label: 'Completed', align: 'right', type: 'number', widthMm: 24 },
      { key: 'noShows', label: 'No-shows', align: 'right', type: 'number', widthMm: 22 },
      { key: 'visits', label: 'Visits', align: 'right', type: 'number', widthMm: 18 },
      { key: 'prescriptions', label: 'Prescriptions', align: 'right', type: 'number', widthMm: 26 },
      { key: 'treatments', label: 'Treatments', align: 'right', type: 'number', widthMm: 24 },
    ];
    const totals: Record<string, number> = {
      appointments: output.reduce((sum, row) => sum + asNumber(row['appointments']), 0),
      completed: output.reduce((sum, row) => sum + asNumber(row['completed']), 0),
      noShows: output.reduce((sum, row) => sum + asNumber(row['noShows']), 0),
      visits: output.reduce((sum, row) => sum + asNumber(row['visits']), 0),
      prescriptions: output.reduce((sum, row) => sum + asNumber(row['prescriptions']), 0),
      treatments: output.reduce((sum, row) => sum + asNumber(row['treatments']), 0),
    };
    if (options.financial) {
      columns.push({ key: 'revenue', label: 'Invoiced', align: 'right', type: 'money', widthMm: 28 });
      totals['revenue'] = output.reduce((sum, row) => sum + asNumber(row['revenue']), 0);
    }
    return {
      subtitle: `${output.length} dentist${output.length === 1 ? '' : 's'} active in the period`,
      columns,
      rows: output,
      totals,
      summary: [
        { label: 'Appointments', value: String(totals['appointments']) },
        { label: 'Completed', value: String(totals['completed']), tone: 'success' as const },
        { label: 'No-shows', value: String(totals['noShows']), tone: totals['noShows']! > 0 ? ('warning' as const) : ('default' as const) },
        ...(options.financial ? [{ label: 'Invoiced', value: formatMoney(totals['revenue'] ?? 0) }] : []),
      ],
      chart: output.map((row) => ({ label: asString(row['dentist']), value: asNumber(row['treatments']) })),
    };
  }

  private staffActivityReport(dates: { from: IsoDate; to: IsoDate }): ReturnType<ReportService['build']> {
    requirePermission(this.context(), 'audit.view');
    const rows = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(l.user_name, ''), 'system') AS user_name,
                COUNT(*) AS actions,
                SUM(CASE WHEN l.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
                SUM(CASE WHEN l.severity = 'warning' THEN 1 ELSE 0 END) AS warnings,
                MAX(l.created_at) AS last_at
           FROM audit_logs l
          WHERE substr(l.created_at, 1, 10) BETWEEN ? AND ?
          GROUP BY user_name ORDER BY actions DESC`,
      )
      .all(dates.from, dates.to) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      user: asString(row['user_name']),
      actions: asNumber(row['actions']),
      critical: asNumber(row['critical']),
      warnings: asNumber(row['warnings']),
      lastAt: asString(row['last_at']),
    }));
    return {
      subtitle: `${output.length} user account${output.length === 1 ? '' : 's'} recorded activity`,
      columns: [
        { key: 'user', label: 'User', align: 'left', type: 'text' },
        { key: 'actions', label: 'Actions', align: 'right', type: 'number', widthMm: 22 },
        { key: 'critical', label: 'Critical', align: 'right', type: 'number', widthMm: 22 },
        { key: 'warnings', label: 'Warnings', align: 'right', type: 'number', widthMm: 22 },
        { key: 'lastAt', label: 'Last action', align: 'left', type: 'datetime', widthMm: 40 },
      ],
      rows: output,
      totals: { actions: output.reduce((sum, row) => sum + row.actions, 0) },
      summary: [
        { label: 'Audit entries', value: String(output.reduce((sum, row) => sum + row.actions, 0)) },
        { label: 'Critical actions', value: String(output.reduce((sum, row) => sum + row.critical, 0)), tone: 'warning' as const },
      ],
      chart: null,
    };
  }

  private auditSummaryReport(dates: { from: IsoDate; to: IsoDate }): ReturnType<ReportService['build']> {
    requirePermission(this.context(), 'audit.view');
    const rows = this.db
      .prepare(
        `SELECT l.action, COUNT(*) AS total,
                SUM(CASE WHEN l.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
                SUM(CASE WHEN l.severity = 'warning' THEN 1 ELSE 0 END) AS warnings,
                MIN(l.created_at) AS first_at, MAX(l.created_at) AS last_at
           FROM audit_logs l
          WHERE substr(l.created_at, 1, 10) BETWEEN ? AND ?
          GROUP BY l.action ORDER BY total DESC`,
      )
      .all(dates.from, dates.to) as Array<Record<string, unknown>>;

    const output = rows.map((row) => ({
      action: prettifyAction(asString(row['action'])),
      total: asNumber(row['total']),
      critical: asNumber(row['critical']),
      warnings: asNumber(row['warnings']),
      firstAt: asString(row['first_at']),
      lastAt: asString(row['last_at']),
    }));
    const total = output.reduce((sum, row) => sum + row.total, 0);
    return {
      subtitle: `${total} audit entr${total === 1 ? 'y' : 'ies'}`,
      columns: [
        { key: 'action', label: 'Action', align: 'left', type: 'text' },
        { key: 'total', label: 'Entries', align: 'right', type: 'number', widthMm: 22 },
        { key: 'critical', label: 'Critical', align: 'right', type: 'number', widthMm: 22 },
        { key: 'warnings', label: 'Warnings', align: 'right', type: 'number', widthMm: 22 },
        { key: 'lastAt', label: 'Most recent', align: 'left', type: 'datetime', widthMm: 40 },
      ],
      rows: output,
      totals: { total },
      summary: [
        { label: 'Audit entries', value: String(total) },
        { label: 'Critical', value: String(output.reduce((sum, row) => sum + row.critical, 0)), tone: 'warning' as const },
      ],
      chart: output.slice(0, 8).map((row) => ({ label: row.action, value: row.total })),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function total2(paisa: number): string {
  return formatMoney(paisa);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function averagePerDay(total: number, from: IsoDate, to: IsoDate): string {
  const days = Math.max(1, daysBetween(from, to) + 1);
  return (total / days).toFixed(1);
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function countToChart<T>(items: readonly T[], key: (item: T) => string): Array<{ label: string; value: number }> {
  return Object.entries(countBy(items, key)).map(([label, value]) => ({ label, value }));
}

/** Group a per-day series into day/week/month buckets. */
function foldSeries<T extends { date: string }, TBucket>(
  values: readonly T[],
  groupBy: 'day' | 'week' | 'month' | 'category' | 'dentist' | 'patient' | 'method',
  toBucket: (bucket: { date: string; values: T[] }) => TBucket,
): TBucket[] {
  if (groupBy !== 'week' && groupBy !== 'month') {
    return values.map((value) => toBucket({ date: value.date, values: [value] }));
  }
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const bucketDate = groupBy === 'week' ? startOfWeek(value.date) : startOfMonth(value.date);
    const bucket = grouped.get(bucketDate) ?? [];
    bucket.push(value);
    grouped.set(bucketDate, bucket);
  }
  return [...grouped.entries()]
    .sort((a, b) => compareIsoDate(a[0], b[0]))
    .map(([date, bucketValues]) => toBucket({ date, values: bucketValues }));
}

function parseTeeth(json: string): string {
  try {
    const parsed = JSON.parse(json || '[]') as unknown;
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string').join(', ');
  } catch {
    // Ignore malformed history — an empty tooth list is safer than a crash.
  }
  return '';
}

function prettifyAction(action: string): string {
  const words = action.replace(/[._]/g, ' ').trim();
  if (words === '') return 'Other';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export { addDays };
