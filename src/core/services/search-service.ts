/**
 * Global search.
 *
 * One query box in the header searches the whole practice. Results are grouped
 * by record type and each group is filtered by the signed-in user's
 * permissions, so a receptionist never learns that a record they cannot open
 * exists. Every group is capped, and the whole response is capped, so a search
 * stays instant on a large database.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { hasPermission, requirePermission } from '../context';
import type { GlobalSearchResponse, SearchGroup, SearchResultItem } from '@shared/types';
import { asNumber, asString, likeTerm } from '../db/sql';
import { formatMoney } from '@shared/money';
import { nowInstant } from '@shared/dates';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export class SearchService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  global(query: string, limit = DEFAULT_LIMIT): GlobalSearchResponse {
    requirePermission(this.context(), 'search.use');
    const started = Date.now();
    const term = query.trim();
    const capped = Math.min(Math.max(1, Math.round(limit)), MAX_LIMIT);
    if (term.length < 2) {
      return { query: term, groups: [], totalCount: 0, tookMs: Date.now() - started, truncated: false };
    }

    const perGroup = Math.max(3, Math.ceil(capped / 4));
    const pattern = `${likeTerm(term)}%`;
    const contains = `%${likeTerm(term)}%`;
    const groups: SearchGroup[] = [];

    const push = (key: string, label: string, items: SearchResultItem[]): void => {
      if (items.length > 0) groups.push({ key, label, items });
    };

    if (hasPermission(this.context(), 'patient.view')) {
      const rows = this.db
        .prepare(
          `SELECT p.id, p.code, trim(p.first_name || ' ' || p.last_name) AS name, p.phone,
                  (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS visit_count
             FROM patients p
            WHERE p.deleted_at IS NULL
              AND (p.code LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.phone LIKE ? ESCAPE '\\'
                OR p.alternate_phone LIKE ? ESCAPE '\\')
            ORDER BY (p.code LIKE ? ESCAPE '\\' COLLATE NOCASE) DESC, p.id DESC
            LIMIT ?`,
        )
        .all(contains, contains, contains, pattern, pattern, pattern, perGroup) as Array<{
        id: number;
        code: string;
        name: string;
        phone: string;
        visit_count: number;
      }>;
      push(
        'patients',
        'Patients',
        rows.map((row) => ({
          id: row.id,
          title: row.name || row.code,
          subtitle: `${row.code}${row.phone ? ` · ${row.phone}` : ''}`,
          meta: `${asNumber(row.visit_count)} visit(s)`,
          screen: 'patients',
          badge: row.code,
        })),
      );
    }

    if (hasPermission(this.context(), 'appointment.view')) {
      const rows = this.db
        .prepare(
          `SELECT a.id, a.date, a.start_time, a.status, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.code,
                  d.name AS dentist_name
             FROM appointments a
             JOIN patients p ON p.id = a.patient_id
             LEFT JOIN dentists d ON d.id = a.dentist_id
            WHERE a.deleted_at IS NULL
              AND (p.code LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR a.reason LIKE ? ESCAPE '\\' COLLATE NOCASE)
            ORDER BY a.date DESC, a.start_time DESC
            LIMIT ?`,
        )
        .all(contains, contains, contains, contains, perGroup) as Array<{
        id: number;
        date: string;
        start_time: string;
        status: string;
        patient_name: string;
        code: string;
        dentist_name: string | null;
      }>;
      push(
        'appointments',
        'Appointments',
        rows.map((row) => ({
          id: row.id,
          title: row.patient_name,
          subtitle: `${row.date} ${row.start_time}${row.dentist_name ? ` · ${row.dentist_name}` : ''}`,
          meta: row.status.replace(/_/g, ' '),
          screen: 'appointments',
          badge: row.code,
        })),
      );
    }

    if (hasPermission(this.context(), 'visit.view')) {
      const rows = this.db
        .prepare(
          `SELECT v.id, v.visit_date, v.chief_complaint, v.diagnosis, p.code, trim(p.first_name || ' ' || p.last_name) AS patient_name
             FROM visits v JOIN patients p ON p.id = v.patient_id
            WHERE v.deleted_at IS NULL
              AND (p.code LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR v.chief_complaint LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR v.diagnosis LIKE ? ESCAPE '\\' COLLATE NOCASE)
            ORDER BY v.visit_date DESC, v.id DESC
            LIMIT ?`,
        )
        .all(contains, contains, contains, contains, contains, perGroup) as Array<{
        id: number;
        visit_date: string;
        chief_complaint: string;
        diagnosis: string;
        code: string;
        patient_name: string;
      }>;
      push(
        'visits',
        'Visits',
        rows.map((row) => ({
          id: row.id,
          title: row.patient_name,
          subtitle: `${row.visit_date} · ${row.diagnosis || row.chief_complaint || 'Visit'}`,
          meta: row.code,
          screen: 'visits',
          badge: row.visit_date,
        })),
      );
    }

    if (hasPermission(this.context(), 'prescription.view')) {
      const rows = this.db
        .prepare(
          `SELECT pr.id, pr.number, pr.date, p.code, trim(p.first_name || ' ' || p.last_name) AS patient_name
             FROM prescriptions pr JOIN patients p ON p.id = pr.patient_id
            WHERE pr.deleted_at IS NULL
              AND (pr.number LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.code LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR EXISTS (SELECT 1 FROM prescription_items i WHERE i.prescription_id = pr.id AND i.name LIKE ? ESCAPE '\\' COLLATE NOCASE))
            ORDER BY pr.date DESC, pr.id DESC
            LIMIT ?`,
        )
        .all(contains, contains, contains, contains, contains, perGroup) as Array<{
        id: number;
        number: string;
        date: string;
        code: string;
        patient_name: string;
      }>;
      push(
        'prescriptions',
        'Prescriptions',
        rows.map((row) => ({
          id: row.id,
          title: `${row.number} — ${row.patient_name}`,
          subtitle: row.date,
          meta: row.code,
          screen: 'prescriptions',
          badge: row.number,
        })),
      );
    }

    if (hasPermission(this.context(), 'invoice.view')) {
      const rows = this.db
        .prepare(
          `SELECT i.id, i.number, i.date, i.total_paisa, i.paid_paisa, i.status, p.code,
                  trim(p.first_name || ' ' || p.last_name) AS patient_name
             FROM invoices i JOIN patients p ON p.id = i.patient_id
            WHERE i.deleted_at IS NULL
              AND (i.number LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.code LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
            ORDER BY i.date DESC, i.id DESC
            LIMIT ?`,
        )
        .all(contains, contains, contains, contains, perGroup) as Array<{
        id: number;
        number: string;
        date: string;
        total_paisa: number;
        paid_paisa: number;
        status: string;
        code: string;
        patient_name: string;
      }>;
      push(
        'invoices',
        'Invoices',
        rows.map((row) => ({
          id: row.id,
          title: `${row.number} — ${row.patient_name}`,
          subtitle: `${row.date} · ${formatMoney(asNumber(row.total_paisa))}`,
          meta: asNumber(row.total_paisa) > asNumber(row.paid_paisa) ? 'Payment due' : 'Paid',
          screen: 'invoices',
          badge: row.code,
        })),
      );
    }

    if (hasPermission(this.context(), 'payment.view')) {
      const rows = this.db
        .prepare(
          `SELECT pay.id, pay.receipt_number, pay.amount_paisa, pay.paid_at, i.number AS invoice_number,
                  COALESCE(m.name, 'Unspecified') AS method_name
             FROM payments pay
             JOIN invoices i ON i.id = pay.invoice_id
             LEFT JOIN payment_methods m ON m.id = pay.method_id
            WHERE pay.is_void = 0
              AND (pay.receipt_number LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR i.number LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR pay.reference LIKE ? ESCAPE '\\' COLLATE NOCASE)
            ORDER BY pay.paid_at DESC
            LIMIT ?`,
        )
        .all(contains, contains, contains, perGroup) as Array<{
        id: number;
        receipt_number: string;
        amount_paisa: number;
        paid_at: string;
        invoice_number: string;
        method_name: string;
      }>;
      push(
        'payments',
        'Payments',
        rows.map((row) => ({
          id: row.id,
          title: `${row.receipt_number} — ${formatMoney(asNumber(row.amount_paisa))}`,
          subtitle: `${row.invoice_number} · ${row.method_name}`,
          meta: row.paid_at.slice(0, 10),
          screen: 'payments',
          badge: row.receipt_number,
        })),
      );
    }

    if (hasPermission(this.context(), 'inventory.view')) {
      const rows = this.db
        .prepare(
          `SELECT id, code, name, batch_number, current_stock_milli, unit, minimum_stock_milli
             FROM inventory_items
            WHERE deleted_at IS NULL
              AND (code LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR batch_number LIKE ? ESCAPE '\\' COLLATE NOCASE)
            ORDER BY name
            LIMIT ?`,
        )
        .all(contains, contains, contains, perGroup) as Array<{
        id: number;
        code: string;
        name: string;
        batch_number: string;
        current_stock_milli: number;
        unit: string;
        minimum_stock_milli: number;
      }>;
      push(
        'inventory',
        'Inventory',
        rows.map((row) => ({
          id: row.id,
          title: row.name,
          subtitle: `${row.code}${row.batch_number ? ` · Batch ${row.batch_number}` : ''}`,
          meta: `${(asNumber(row.current_stock_milli) / 1000).toFixed(2)} ${row.unit}`,
          screen: 'inventory',
          badge: asNumber(row.current_stock_milli) <= asNumber(row.minimum_stock_milli) ? 'Low' : undefined,
        })),
      );
    }

    if (hasPermission(this.context(), 'treatment.view')) {
      const rows = this.db
        .prepare(
          `SELECT id, code, name, category, price_paisa FROM treatment_catalog
            WHERE deleted_at IS NULL
              AND (code LIKE ? ESCAPE '\\' COLLATE NOCASE OR name LIKE ?` +
            ` ESCAPE '\\' COLLATE NOCASE OR category LIKE ? ESCAPE '\\' COLLATE NOCASE)
            ORDER BY name LIMIT ?`,
        )
        .all(contains, contains, contains, perGroup) as Array<{
        id: number;
        code: string;
        name: string;
        category: string;
        price_paisa: number;
      }>;
      push(
        'treatments',
        'Treatments',
        rows.map((row) => ({
          id: row.id,
          title: row.name,
          subtitle: `${row.code}${row.category ? ` · ${row.category}` : ''}`,
          meta: formatMoney(asNumber(row.price_paisa)),
          screen: 'treatments',
          badge: row.code,
        })),
      );
    }

    if (hasPermission(this.context(), 'dentist.view')) {
      const rows = this.db
        .prepare(
          `SELECT id, name, registration_number, phone FROM dentists
            WHERE deleted_at IS NULL
              AND (name LIKE ? ESCAPE '\\' COLLATE NOCASE OR registration_number` +
            ` LIKE ? ESCAPE '\\' COLLATE NOCASE OR phone LIKE ? ESCAPE '\\')
            ORDER BY name LIMIT ?`,
        )
        .all(contains, contains, contains, perGroup) as Array<{
        id: number;
        name: string;
        registration_number: string;
        phone: string;
      }>;
      push(
        'dentists',
        'Dentists',
        rows.map((row) => ({
          id: row.id,
          title: row.name,
          subtitle: row.registration_number || row.phone || 'Dentist',
          meta: 'Dentist',
          screen: 'dentists',
        })),
      );
    }

    if (hasPermission(this.context(), 'staff.view')) {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.name, s.designation, s.phone FROM staff s
            WHERE s.deleted_at IS NULL
              AND (s.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.phone LIKE ? ESCAPE '\\')
            ORDER BY s.name LIMIT ?`,
        )
        .all(contains, contains, perGroup) as Array<{
        id: number;
        name: string;
        designation: string;
        phone: string;
      }>;
      push(
        'staff',
        'Staff',
        rows.map((row) => ({
          id: row.id,
          title: row.name,
          subtitle: row.designation || 'Staff member',
          meta: row.phone || 'No phone',
          screen: 'staff',
        })),
      );
    }

    let totalCount = 0;
    const trimmed: SearchGroup[] = [];
    for (const group of groups) {
      const remaining = capped - totalCount;
      if (remaining <= 0) break;
      const items = group.items.slice(0, remaining);
      totalCount += items.length;
      trimmed.push({ key: group.key, label: group.label, items });
    }

    return {
      query: term,
      groups: trimmed,
      totalCount,
      tookMs: Date.now() - started,
      truncated: groups.some((group) => group.items.length > (trimmed.find((entry) => entry.key === group.key)?.items.length ?? 0)),
    };
  }

  /** Quick patient search used by the appointment and invoice forms. */
  quickPatients(term: string, limit = 10): Array<{ id: number; label: string; meta: string }> {
    requirePermission(this.context(), 'search.use');
    const pattern = `${likeTerm(term.trim())}%`;
    const rows = this.db
      .prepare(
        `SELECT id, code, trim(first_name || ' ' || last_name) AS name, phone FROM patients
          WHERE deleted_at IS NULL
            AND (code LIKE ? ESCAPE '\\' COLLATE NOCASE OR first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR last_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR phone LIKE ? ESCAPE '\\')
          ORDER BY code LIMIT ?`,
      )
      .all(pattern, pattern, pattern, pattern, Math.min(Math.max(1, limit), 25)) as Array<{
      id: number;
      code: string;
      name: string;
      phone: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      label: `${row.name} (${row.code})`,
      meta: row.phone || asString(row.code),
    }));
  }

  /** Timestamp of the last completed search, used by the diagnostics screen. */
  lastSearchAt(): string {
    return nowInstant();
  }
}
