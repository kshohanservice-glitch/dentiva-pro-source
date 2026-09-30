/**
 * Data, integrity and destructive operations.
 *
 * Everything here is deliberately careful: the destructive operations require a
 * typed confirmation (and for deleting the business, the owner's password),
 * always offer to take a safety backup first, and record exactly what was
 * removed in the audit log. Nothing in this file deletes a single row without
 * leaving a trace somewhere.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/connection';
import { checkIntegrity, databaseSizeBytes, rebuildSearchIndexes } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, currentUserName, requireAnyPermission, requirePermission } from '../context';
import { AppError } from '@shared/errors';
import type { DataSummary, IntegrityReport } from '@shared/types';
import { asNumber } from '../db/sql';
import { csvText } from '../util/csv';
import { verifyPassword } from '../security/password';
import { ensureDir, listFiles, removeDirIfExists } from '../util/files';
import type { BackupService } from './backup-service';
import type { AttachmentService } from './attachment-service';

export type ExportTarget = 'patients' | 'invoices' | 'payments' | 'inventory' | 'accounting' | 'appointments' | 'visits' | 'prescriptions';
export type ResetScope = 'clinical' | 'financial' | 'all';

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly errors: Array<{ row: number; message: string }>;
  readonly preview: Array<Record<string, string>>;
}

export class SystemService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly backups: BackupService,
    private readonly attachments: AttachmentService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  // --- Reading ------------------------------------------------------------

  dataSummary(): DataSummary {
    requirePermission(this.context(), 'settings.view');
    const count = (table: string, where = ''): number =>
      asNumber(
        (this.db.prepare(`SELECT COUNT(*) AS total` + ` FROM ${table}${where ? ` WHERE ${where}` : ''}`).get() as { total: number }).total,
      );
    const attachmentBytes = asNumber(
      (this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments WHERE deleted_at IS NULL`).get() as { total: number })
        .total,
    );
    const range = this.db
      .prepare(
        `SELECT MIN(d) AS oldest, MAX(d) AS newest FROM (
           SELECT MIN(visit_date) AS d FROM visits WHERE deleted_at IS NULL
           UNION ALL SELECT MIN(date) FROM invoices WHERE deleted_at IS NULL
           UNION ALL SELECT MIN(created_at) FROM patients WHERE deleted_at IS NULL
         )`,
      )
      .get() as { oldest: string | null; newest: string | null };

    return {
      patients: count('patients', 'deleted_at IS NULL'),
      deletedPatients: count('patients', 'deleted_at IS NOT NULL'),
      visits: count('visits', 'deleted_at IS NULL'),
      appointments: count('appointments', 'deleted_at IS NULL'),
      prescriptions: count('prescriptions', 'deleted_at IS NULL'),
      invoices: count('invoices', 'deleted_at IS NULL'),
      payments: count('payments', 'is_void = 0'),
      treatments: count('treatment_records', 'deleted_at IS NULL'),
      inventoryItems: count('inventory_items', 'deleted_at IS NULL'),
      stockMovements: count('stock_movements'),
      accountingTransactions: count('accounting_transactions', 'is_void = 0'),
      attachments: count('attachments', 'deleted_at IS NULL'),
      auditEntries: count('audit_logs'),
      notifications: count('notifications'),
      databaseSizeBytes: databaseSizeBytes(this.db),
      attachmentSizeBytes: attachmentBytes,
      oldestRecordDate: range.oldest ? range.oldest.slice(0, 10) : null,
      newestRecordDate: range.newest ? range.newest.slice(0, 10) : null,
    };
  }

  integrityCheck(): IntegrityReport {
    requirePermission(this.context(), 'settings.view');
    return this.integrityCheckInternal();
  }

  /**
   * The same report without the permission check. The installation self-check
   * runs before anybody has signed in, so it cannot borrow a user's rights.
   */
  integrityCheckInternal(): IntegrityReport {
    const ctx = this.context();
    const integrity = checkIntegrity(this.db);
    const foreignKeys = this.db.pragma('foreign_key_check') as Array<Record<string, unknown>>;

    const checks: Array<{ name: string; ok: boolean; detail: string }> = [
      {
        name: 'SQLite integrity check',
        ok: integrity.ok,
        detail: integrity.ok ? 'The database file is structurally sound.' : integrity.messages.slice(0, 3).join(' '),
      },
      {
        name: 'Foreign keys',
        ok: foreignKeys.length === 0,
        detail: foreignKeys.length === 0 ? 'Every reference points at a record that exists.' : `${foreignKeys.length} broken reference(s).`,
      },
    ];

    const missingFiles = this.attachments.missingFiles();
    const orphanRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM attachments a
          WHERE a.deleted_at IS NULL
            AND ((a.entity_type = 'patient' AND NOT EXISTS (SELECT 1 FROM patients WHERE id = a.entity_id))
              OR (a.entity_type = 'visit' AND NOT EXISTS (SELECT 1 FROM visits WHERE id = a.entity_id))
              OR (a.entity_type = 'prescription' AND NOT EXISTS (SELECT 1 FROM prescriptions WHERE id = a.entity_id))
              OR (a.entity_type = 'invoice' AND NOT EXISTS (SELECT 1 FROM invoices WHERE id = a.entity_id))
              OR (a.entity_type = 'staff' AND NOT EXISTS (SELECT 1 FROM staff WHERE id = a.entity_id))
              OR (a.entity_type = 'dentist' AND NOT EXISTS (SELECT 1 FROM dentists WHERE id = a.entity_id)))`,
      )
      .get() as { total: number };
    const orphanAttachments = asNumber(orphanRow.total);

    checks.push({
      name: 'Attachment files',
      ok: missingFiles.length === 0,
      detail: missingFiles.length === 0 ? 'Every attachment file is present.' : `${missingFiles.length} file(s) are missing from disk.`,
    });
    checks.push({
      name: 'Attachment links',
      ok: orphanAttachments === 0,
      detail:
        orphanAttachments === 0
          ? 'Attachments point at' + ' records that exist.'
          : `${orphanAttachments} attachment(s) point at removed records.`,
    });

    // The search index is derived data: it can always be rebuilt, so a stale
    // index is reported but never presented as data loss.
    let searchOk = true;
    try {
      this.db.prepare(`SELECT rowid FROM patients_fts LIMIT 1`).get();
    } catch {
      searchOk = false;
    }
    checks.push({
      name: 'Search index',
      ok: searchOk,
      detail: searchOk ? 'The full-text index responds.' : 'The search index could not be read and must be rebuilt.',
    });

    return {
      ok: checks.every((check) => check.ok),
      checkedAt: ctx.instant(),
      foreignKeyViolations: foreignKeys.length,
      checks,
      databaseSizeBytes: databaseSizeBytes(this.db),
      orphanAttachments,
      missingAttachments: missingFiles.length,
    };
  }

  /** Repair action offered next to the integrity report. */
  rebuildSearch(): void {
    requirePermission(this.context(), 'settings.manage');
    rebuildSearchIndexes(this.db);
    this.context().audit.record({
      action: 'update',
      entityType: 'search_index',
      entityLabel: 'Search index',
      detail: 'Search index rebuilt from the source tables',
      severity: 'warning',
    });
  }

  vacuum(): { beforeBytes: number; afterBytes: number } {
    requirePermission(this.context(), 'settings.manage');
    const before = databaseSizeBytes(this.db);
    const pages = this.db.pragma('page_count', { simple: true }) as number;
    this.db.exec('VACUUM');
    const after = databaseSizeBytes(this.db);
    this.db.pragma('optimize');
    this.context().audit.record({
      action: 'update',
      entityType: 'database',
      entityLabel: 'Database',
      detail: `Database compacted from ${formatBytes(before)} to ${formatBytes(after)} (${pages} pages before)`,
      severity: 'warning',
    });
    return { beforeBytes: before, afterBytes: after };
  }

  async logFiles(): Promise<Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string }>> {
    requirePermission(this.context(), 'settings.view');
    return listFiles(this.context().paths.logsDir);
  }

  async readLogFile(name: string, maxBytes = 512 * 1024): Promise<string> {
    requirePermission(this.context(), 'settings.view');
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '');
    const path = join(this.context().paths.logsDir, safe);
    if (!existsSync(path)) throw AppError.notFound('Log file');
    const content = await readFile(path, 'utf8');
    return content.length > maxBytes ? content.slice(content.length - maxBytes) : content;
  }

  // --- Exports ------------------------------------------------------------

  async exportCsv(what: ExportTarget, from?: string, to?: string): Promise<{ path: string; rowCount: number }> {
    requireAnyPermission(this.context(), ['report.export', 'settings.manage', 'patient.export']);
    const ctx = this.context();
    const { columns, rows, title } = this.exportData(what, from, to);
    const csv = [
      columns.map(escapeCsv).join(','),
      ...rows.map((row) => columns.map((column) => escapeCsv(csvText(row[column]))).join(',')),
    ].join('\r\n');
    await ensureDir(ctx.paths.exportsDir);
    const stamp = ctx.instant().replace(/[:.]/g, '-');
    const path = join(ctx.paths.exportsDir, `dentiva-${what}-${stamp}.csv`);
    // A BOM keeps Excel from mangling Bengali text.
    await writeFile(path, `\uFEFF${csv}`, 'utf8');
    ctx.audit.record({
      action: 'export',
      entityType: what,
      entityLabel: `${what} export`,
      detail: `${title}: ${rows.length} row(s) exported to CSV`,
      severity: 'warning',
    });
    return { path, rowCount: rows.length };
  }

  private exportData(
    what: ExportTarget,
    from?: string,
    to?: string,
  ): { columns: string[]; rows: Array<Record<string, unknown>>; title: string } {
    const range = (column: string): { clause: string; params: unknown[] } => {
      const parts: string[] = [];
      const params: unknown[] = [];
      if (from) {
        parts.push(`${column} >= ?`);
        params.push(from);
      }
      if (to) {
        parts.push(`${column} <= ?`);
        params.push(to);
      }
      return { clause: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', params };
    };

    switch (what) {
      case 'patients': {
        const filter = range(`substr(p.created_at, 1, 10)`);
        return {
          title: 'Patient register',
          columns: [
            'code',
            'name',
            'gender',
            'dob',
            'age',
            'phone',
            'alternate_phone',
            'email',
            'address',
            'city',
            'blood_group',
            'status',
            'registered_on',
          ],
          rows: this.db
            .prepare(
              `SELECT p.code, trim(p.first_name || ' ' || p.last_name) AS name, p.gender, p.dob, p.age_years AS age,
                      p.phone, p.alternate_phone, p.email, p.address, p.city, p.blood_group, p.status,
                      substr(p.created_at, 1, 10) AS registered_on
                 FROM patients p WHERE p.deleted_at IS NULL${filter.clause} ORDER BY p.code`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      case 'invoices': {
        const filter = range('i.date');
        return {
          title: 'Invoice register',
          columns: ['number', 'date', 'patient_code', 'patient_name', 'subtotal', 'discount', 'total', 'paid', 'due', 'status'],
          rows: this.db
            .prepare(
              `SELECT i.number, i.date, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                      i.subtotal_paisa / 100.0 AS subtotal, i.discount_paisa / 100.0 AS discount, i.total_paisa / 100.0 AS total,
                      i.paid_paisa / 100.0 AS paid, (i.total_paisa - i.paid_paisa) / 100.0 AS due, i.status
                 FROM invoices i JOIN patients p ON p.id = i.patient_id
                WHERE i.deleted_at IS NULL${filter.clause} ORDER BY i.date, i.number`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      case 'payments': {
        const filter = range('substr(pay.paid_at, 1, 10)');
        return {
          title: 'Payment register',
          columns: ['receipt', 'paid_at', 'invoice', 'patient_code', 'patient_name', 'amount', 'method', 'reference', 'collected_by'],
          rows: this.db
            .prepare(
              `SELECT pay.receipt_number AS receipt, pay.paid_at, i.number AS invoice, p.code AS patient_code,
                      trim(p.first_name || ' ' || p.last_name) AS patient_name, pay.amount_paisa / 100.0 AS amount,
                      COALESCE(m.name, 'Unspecified') AS method, pay.reference, COALESCE(u.full_name, '') AS collected_by
                 FROM payments pay
                 JOIN invoices i ON i.id = pay.invoice_id
                 JOIN patients p ON p.id = pay.patient_id
                 LEFT JOIN payment_methods m ON m.id = pay.method_id
                 LEFT JOIN users u ON u.id = pay.received_by
                WHERE pay.is_void = 0${filter.clause} ORDER BY pay.paid_at`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      case 'inventory': {
        return {
          title: 'Stock on hand',
          columns: [
            'code',
            'name',
            'category',
            'supplier',
            'unit',
            'quantity',
            'minimum',
            'reorder_level',
            'purchase_price',
            'stock_value',
            'batch',
            'expiry',
          ],
          rows: this.db
            .prepare(
              `SELECT i.code, i.name, COALESCE(c.name, '') AS category, COALESCE(s.name, '') AS supplier, i.unit,
                      i.quantity_milli / 1000.0 AS quantity, i.minimum_stock_milli / 1000.0 AS minimum,
                      i.reorder_level_milli / 1000.0 AS reorder_level, i.purchase_price_paisa / 100.0 AS purchase_price,
                      (i.quantity_milli * i.purchase_price_paisa) /` +
                ` 100000.0 AS stock_value, i.batch_number AS batch, i.expiry_date AS expiry
                 FROM inventory_items i
                 LEFT JOIN inventory_categories c ON c.id = i.category_id
                 LEFT JOIN suppliers s ON s.id = i.supplier_id
                WHERE i.deleted_at IS NULL ORDER BY i.name`,
            )
            .all() as Array<Record<string, unknown>>,
        };
      }
      case 'accounting': {
        const filter = range('t.date');
        return {
          title: 'Daybook',
          columns: ['date', 'direction', 'category', 'amount', 'method', 'reference', 'description', 'recorded_by'],
          rows: this.db
            .prepare(
              `SELECT t.date, t.direction, COALESCE(c.name, '') AS category, t.amount_paisa / 100.0 AS amount,
                      COALESCE(m.name, '') AS method, t.reference, t.description, COALESCE(u.full_name, '') AS recorded_by
                 FROM accounting_transactions t
                 LEFT JOIN accounting_categories c ON c.id = t.category_id
                 LEFT JOIN payment_methods m ON m.id = t.method_id
                 LEFT JOIN users u ON u.id = t.created_by
                WHERE t.is_void = 0${filter.clause} ORDER BY t.date, t.id`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      case 'appointments': {
        const filter = range('a.date');
        return {
          title: 'Appointment register',
          columns: ['date', 'start_time', 'end_time', 'patient_code', 'patient_name', 'dentist', 'status', 'reason'],
          rows: this.db
            .prepare(
              `SELECT a.date, a.start_time, a.end_time, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                      COALESCE(d.name, '') AS dentist, a.status, a.reason
                 FROM appointments a
                 JOIN patients p ON p.id = a.patient_id
                 LEFT JOIN dentists d ON d.id = a.dentist_id
                WHERE a.deleted_at IS NULL${filter.clause} ORDER BY a.date, a.start_time`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      case 'visits': {
        const filter = range('v.visit_date');
        return {
          title: 'Visit register',
          columns: ['date', 'time', 'patient_code', 'patient_name', 'dentist', 'chief_complaint', 'diagnosis', 'follow_up'],
          rows: this.db
            .prepare(
              `SELECT v.visit_date AS date, v.visit_time AS time, p.code AS patient_code,
                      trim(p.first_name || ' ' || p.last_name) AS patient_name, COALESCE(d.name, '') AS dentist,
                      v.chief_complaint, v.diagnosis, v.follow_up_date AS follow_up
                 FROM visits v
                 JOIN patients p ON p.id = v.patient_id
                 LEFT JOIN dentists d ON d.id = v.dentist_id
                WHERE v.deleted_at IS NULL${filter.clause} ORDER BY v.visit_date, v.visit_time`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      case 'prescriptions': {
        const filter = range('pr.date');
        return {
          title: 'Prescription register',
          columns: ['number', 'date', 'patient_code', 'patient_name', 'dentist', 'void', 'printed'],
          rows: this.db
            .prepare(
              `SELECT pr.number, pr.date, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                      COALESCE(d.name, '') AS dentist, CASE WHEN pr.is_void = 1 THEN 'yes' ELSE 'no' END AS void,
                      CASE WHEN pr.printed_at IS NULL THEN 'no' ELSE 'yes' END AS printed
                 FROM prescriptions pr
                 JOIN patients p ON p.id = pr.patient_id
                 LEFT JOIN dentists d ON d.id = pr.dentist_id
                WHERE pr.deleted_at IS NULL${filter.clause} ORDER BY pr.date, pr.number`,
            )
            .all(...filter.params) as Array<Record<string, unknown>>,
        };
      }
      default:
        throw AppError.notFound('Export');
    }
  }

  // --- Import -------------------------------------------------------------

  /**
   * Import a patient register from a CSV file. Nothing is written until the
   * caller commits, so the wizard can show a preview first.
   */
  async importPatients(filePath: string | null, commit: boolean): Promise<ImportResult> {
    requirePermission(this.context(), 'patient.create');
    if (!filePath || filePath.trim() === '') throw AppError.validation('Choose a CSV file to import.', { file: 'No file selected.' });
    if (!existsSync(filePath)) throw AppError.notFound('Import file');
    const content = await readFile(filePath, 'utf8');
    const lines = content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    if (lines.length < 2) throw AppError.validation('The file has no data rows.', { file: 'The file is empty.' });

    const header = splitCsvLine(lines[0] as string).map((cell) => cell.trim().toLowerCase());
    const index = (...names: string[]): number => names.map((name) => header.indexOf(name)).find((position) => position >= 0) ?? -1;
    const columns = {
      first: index('first_name', 'firstname', 'first name', 'name'),
      last: index('last_name', 'lastname', 'last name'),
      gender: index('gender', 'sex'),
      age: index('age', 'age_years'),
      dob: index('dob', 'date_of_birth', 'birth date'),
      phone: index('phone', 'mobile', 'contact'),
      alternate: index('alternate_phone', 'phone2', 'alternate phone'),
      address: index('address'),
      city: index('city'),
      blood: index('blood_group', 'blood group'),
      notes: index('notes', 'remarks'),
    };
    if (columns.first < 0) {
      throw AppError.validation('The file needs a “Name” or “First name” column.', { file: 'Missing required column.' });
    }

    const errors: Array<{ row: number; message: string }> = [];
    const preview: Array<Record<string, string>> = [];
    const valid: Array<{
      firstName: string;
      lastName: string;
      gender: string;
      ageYears: number | null;
      dob: string | null;
      phone: string;
      alternatePhone: string;
      address: string;
      city: string;
      bloodGroup: string;
      notes: string;
    }> = [];

    for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
      const cells = splitCsvLine(lines[rowIndex] as string);
      const firstNameCell = columns.first >= 0 ? (cells[columns.first] ?? '').trim() : '';
      const lastNameCell = columns.last >= 0 ? (cells[columns.last] ?? '').trim() : '';
      let firstName = firstNameCell;
      let lastName = lastNameCell;
      if (lastName === '' && firstName.includes(' ')) {
        const parts = firstName.split(/\s+/);
        firstName = parts[0] as string;
        lastName = parts.slice(1).join(' ');
      }
      if (firstName === '') {
        errors.push({ row: rowIndex + 1, message: 'The name is empty.' });
        continue;
      }
      const genderCell = (columns.gender >= 0 ? (cells[columns.gender] ?? '') : '').trim().toLowerCase();
      const gender = genderCell.startsWith('f') ? 'female' : genderCell.startsWith('o') ? 'other' : 'male';
      const ageCell = (columns.age >= 0 ? (cells[columns.age] ?? '') : '').trim();
      const age = ageCell === '' ? null : Number(ageCell);
      if (age !== null && (!Number.isFinite(age) || age < 0 || age > 130)) {
        errors.push({ row: rowIndex + 1, message: `The age “${ageCell}” is not a usable number.` });
        continue;
      }
      const dobCell = (columns.dob >= 0 ? (cells[columns.dob] ?? '') : '').trim();
      const bloodCell = (columns.blood >= 0 ? (cells[columns.blood] ?? '') : '').trim().toUpperCase();

      const record = {
        firstName,
        lastName,
        gender,
        ageYears: age === null ? null : Math.round(age),
        dob: /^\d{4}-\d{2}-\d{2}$/.test(dobCell) ? dobCell : null,
        phone: (columns.phone >= 0 ? (cells[columns.phone] ?? '') : '').trim(),
        alternatePhone: (columns.alternate >= 0 ? (cells[columns.alternate] ?? '') : '').trim(),
        address: (columns.address >= 0 ? (cells[columns.address] ?? '') : '').trim(),
        city: (columns.city >= 0 ? (cells[columns.city] ?? '') : '').trim(),
        bloodGroup: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(bloodCell) ? bloodCell : 'unknown',
        notes: (columns.notes >= 0 ? (cells[columns.notes] ?? '') : '').trim(),
      };
      valid.push(record);
      if (preview.length < 10) {
        preview.push({
          row: String(rowIndex + 1),
          name: `${record.firstName} ${record.lastName}`.trim(),
          gender: record.gender,
          age: record.ageYears === null ? '' : String(record.ageYears),
          phone: record.phone,
          address: record.address || record.city,
        });
      }
    }

    if (!commit) {
      return { imported: 0, skipped: errors.length, errors, preview };
    }

    const ctx = this.context();
    const now = ctx.instant();
    let imported = 0;
    let skipped = errors.length;
    const run = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO patients (code, first_name, last_name, gender, dob, age_years, blood_group, phone, alternate_phone,
           email, address, city, emergency_contact_name, emergency_phone, chief_complaint, previous_problems, medical_notes,
           allergies, notes, preferred_contact, status, referred_by, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '', '', '', '', ?, '', ?, 'mobile', 'active', '', ?, ?, ?)`,
      );
      for (const record of valid) {
        // De-duplicate on phone number when one is present.
        if (record.phone !== '') {
          const existing = this.db.prepare(`SELECT id FROM patients WHERE phone = ? AND deleted_at IS NULL`).get(record.phone) as
            | { id: number }
            | undefined;
          if (existing) {
            skipped += 1;
            continue;
          }
        }
        const sequence = this.db
          .prepare(
            `INSERT INTO sequences (name, value) VALUES ('patient', 1)
             ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`,
          )
          .get() as { value: number };
        const code = `P-${String(sequence.value).padStart(6, '0')}`;
        insert.run(
          code,
          record.firstName,
          record.lastName,
          record.gender,
          record.dob,
          record.ageYears,
          record.bloodGroup,
          record.phone,
          record.alternatePhone,
          record.address,
          record.city,
          record.notes,
          record.notes,
          currentUserId(ctx),
          now,
          now,
        );
        imported += 1;
      }
    });
    run();

    ctx.audit.record({
      action: 'import',
      entityType: 'patient',
      entityLabel: 'CSV import',
      detail: `Imported ${imported} patient(s) from CSV; ${skipped} row(s) skipped`,
      severity: 'warning',
    });
    return { imported, skipped, errors, preview };
  }

  // --- Destructive --------------------------------------------------------

  async resetData(input: {
    scope: ResetScope;
    confirmText: string;
    backupFirst: boolean;
  }): Promise<{ backupPath: string | null; deletedCounts: Record<string, number> }> {
    requirePermission(this.context(), 'data.destructive');
    const expected = input.scope === 'all' ? 'RESET ALL' : input.scope === 'financial' ? 'RESET FINANCIAL' : 'RESET CLINICAL';
    if (input.confirmText.trim().toUpperCase() !== expected) {
      throw AppError.validation(`Type “${expected}” to confirm.`, { confirmText: `Type ${expected} to confirm.` });
    }
    const ctx = this.context();
    let backupPath: string | null = null;
    if (input.backupFirst) {
      const backup = await this.backups.create({ kind: 'pre_restore', note: `Safety backup before ${input.scope} data reset` });
      backupPath = backup.filePath;
    }

    const deletedCounts: Record<string, number> = {};
    const tables =
      input.scope === 'clinical'
        ? [
            'queue_entries',
            'appointments',
            'referrals',
            'prescriptions',
            'tooth_findings',
            'perio_records',
            'dental_charts',
            'treatment_plan_items',
            'treatment_plans',
            'treatment_records',
            'visits',
          ]
        : input.scope === 'financial'
          ? ['payments', 'invoice_items', 'invoices', 'accounting_transactions', 'financial_periods']
          : [
              'queue_entries',
              'appointments',
              'referrals',
              'prescriptions',
              'tooth_findings',
              'perio_records',
              'dental_charts',
              'treatment_plan_items',
              'treatment_plans',
              'treatment_records',
              'visits',
              'payments',
              'invoice_items',
              'invoices',
              'stock_movements',
              'inventory_purchase_items',
              'inventory_purchases',
              'accounting_transactions',
              'financial_periods',
              'patient_tag_links',
              'patient_contacts',
              'patients',
              'notifications',
            ];

    this.db.transaction(() => {
      for (const table of tables) {
        const result = this.db.prepare(`DELETE FROM ${table}`).run();
        deletedCounts[table] = result.changes;
      }
      rebuildSearchIndexes(this.db);
    })();

    ctx.audit.record({
      action: 'reset_data',
      entityType: 'database',
      entityLabel: `${input.scope} data reset`,
      detail: `Reset (${input.scope}) removed ${Object.values(deletedCounts).reduce((sum, value) => sum + value, 0)} row(s)${
        backupPath ? ` after taking a safety backup` : ' without a safety backup'
      }`,
      severity: 'critical',
      context: { performedBy: currentUserName(ctx) },
    });
    return { backupPath, deletedCounts };
  }

  async deleteBusiness(input: {
    password: string;
    confirmText: string;
    backupFirst: boolean;
  }): Promise<{ deleted: boolean; backupPath: string | null }> {
    requirePermission(this.context(), 'business.delete');
    if (input.confirmText.trim().toUpperCase() !== 'DELETE BUSINESS') {
      throw AppError.validation('Type “DELETE BUSINESS” to confirm.', { confirmText: 'Type DELETE BUSINESS to confirm.' });
    }
    const ctx = this.context();
    const user = ctx.session.currentUser();
    if (!user) throw AppError.unauthenticated();
    const row = this.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(user.id) as { password_hash: string } | undefined;
    if (!row) throw AppError.notFound('User');
    if (!(await verifyPassword(input.password, row.password_hash))) {
      ctx.audit.record({
        action: 'delete',
        entityType: 'business',
        entityLabel: 'Delete business',
        detail: 'Delete-business attempt rejected: the password did not match',
        severity: 'critical',
      });
      throw AppError.forbidden('The password is not correct. Nothing was deleted.');
    }

    let backupPath: string | null = null;
    if (input.backupFirst) {
      const backup = await this.backups.create({ kind: 'pre_restore', note: 'Final backup taken before deleting the business' });
      backupPath = backup.filePath;
    }

    const tables = [
      'queue_entries',
      'appointments',
      'referrals',
      'prescriptions',
      'tooth_findings',
      'perio_records',
      'dental_charts',
      'treatment_plan_items',
      'treatment_plans',
      'treatment_records',
      'visits',
      'payments',
      'invoice_items',
      'invoices',
      'stock_movements',
      'inventory_purchase_items',
      'inventory_purchases',
      'inventory_items',
      'suppliers',
      'inventory_categories',
      'accounting_transactions',
      'financial_periods',
      'attachments',
      'patient_tag_links',
      'patient_contacts',
      'patients',
      'notifications',
      'login_attempts',
      'user_roles',
      'users',
      'backup_records',
    ];
    this.db.transaction(() => {
      for (const table of tables) this.db.prepare(`DELETE FROM ${table}`).run();
      this.db.prepare(`DELETE FROM setup_state`).run();
      this.db
        .prepare(
          `UPDATE clinic SET name = '', address = '', phone = '', email =` +
            ` '', website = '', logo_path = NULL, updated_at = ? WHERE id = 1`,
        )
        .run(ctx.instant());
      rebuildSearchIndexes(this.db);
    })();

    // Remove attachment files as well, so a deleted business leaves nothing behind.
    for (const folder of ['attachments', 'profiles']) {
      await removeDirIfExists(join(ctx.paths.root, folder));
    }

    ctx.audit.record({
      action: 'delete_business',
      entityType: 'business',
      entityLabel: 'Business deleted',
      detail: `All business data removed by the owner${
        backupPath ? ' (a final backup was kept)' : ''
      }. The application will run setup again.`,
      severity: 'critical',
      context: { performedBy: currentUserName(ctx) },
    });
    return { deleted: true, backupPath };
  }

  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',' || character === ';' || character === '\t') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
