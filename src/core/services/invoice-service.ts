/**
 * Invoices.
 *
 * Money rules enforced here (never in the UI):
 *  - every amount is integer paisa; totals are exact integer arithmetic
 *  - discounts are clamped to the line/invoice subtotal
 *  - `paid_paisa` and `status` are always recomputed from the payment ledger
 *  - an invoice with payments can never be edited below what has been paid
 *  - voiding keeps the invoice and its payments visible for audit
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type {
  InvoiceDetail,
  InvoiceInput,
  InvoiceItem,
  InvoiceItemInput,
  InvoiceListQuery,
  InvoiceSummary,
  Paged,
  PaymentSummary,
} from '@shared/types';
import type { InvoiceStatus } from '@shared/constants';
import { AppError } from '@shared/errors';
import { resolveDateRange } from '@shared/dates';
import { applyDiscount, formatMoney, outstandingPaisa, type DiscountSpec } from '@shared/money';
import { asNumber, asString, buildWhere, fromBoolInt, pageCount, paginate, parseJsonArray, toJsonArray } from '../db/sql';
import { nextInvoiceNumber } from '../util/ids';

interface InvoiceRow {
  id: number;
  number: string;
  patient_id: number;
  patient_code: string;
  patient_name: string;
  patient_phone?: string;
  patient_address?: string;
  date: string;
  subtotal_paisa: number;
  discount_paisa: number;
  discount_type: string;
  discount_value: number;
  total_paisa: number;
  paid_paisa: number;
  status: string;
  notes: string;
  visit_id: number | null;
  dentist_id: number | null;
  dentist_name?: string | null;
  is_void: number;
  void_reason: string;
  voided_at: string | null;
  created_at: string;
  created_by_name?: string | null;
  item_count?: number;
}

const SELECT = `
  SELECT i.*, p.code AS patient_code, p.phone AS patient_phone, p.address AS patient_address,
         trim(p.first_name || ' ' || p.last_name) AS patient_name,
         d.name AS dentist_name,
         (SELECT full_name FROM users u WHERE u.id = i.created_by) AS created_by_name,
         (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS item_count
    FROM invoices i
    JOIN patients p ON p.id = i.patient_id
    LEFT JOIN dentists d ON d.id = i.dentist_id
`;

export class InvoiceService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private mapSummary(row: InvoiceRow): InvoiceSummary {
    return {
      id: row.id,
      number: row.number,
      patientId: row.patient_id,
      patientCode: row.patient_code,
      patientName: row.patient_name,
      date: row.date,
      subtotalPaisa: asNumber(row.subtotal_paisa),
      discountPaisa: asNumber(row.discount_paisa),
      totalPaisa: asNumber(row.total_paisa),
      paidPaisa: asNumber(row.paid_paisa),
      duePaisa: outstandingPaisa(asNumber(row.total_paisa), asNumber(row.paid_paisa)),
      status: row.status as InvoiceStatus,
      itemCount: asNumber(row.item_count),
      visitId: row.visit_id,
      createdByName: row.created_by_name ?? '—',
      createdAt: row.created_at,
      voidedAt: row.voided_at,
      voidReason: row.void_reason,
    };
  }

  list(query: InvoiceListQuery): Paged<InvoiceSummary> {
    requirePermission(this.context(), 'invoice.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = ['i.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.status && query.status.length > 0) {
      clauses.push(`i.status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    if (query.patientId) {
      clauses.push('i.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.hasOutstanding) {
      clauses.push('i.total_paisa > i.paid_paisa AND i.is_void = 0');
    }
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    const range = preset ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } }) : { from: query.from, to: query.to };
    if (range.from) {
      clauses.push('i.date >= ?');
      params.push(range.from);
    }
    if (range.to) {
      clauses.push('i.date <= ?');
      params.push(range.to);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(i.number LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\'
                    OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\')`);
      params.push(term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db.prepare(`SELECT COUNT(*) AS total FROM invoices i JOIN patients p ON p.id = i.patient_id${where}`).get(...params) as {
          total: number;
        }
      ).total,
    );
    const rows = this.db
      .prepare(`${SELECT}${where} ORDER BY i.date DESC, i.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as InvoiceRow[];
    return { items: rows.map((row) => this.mapSummary(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): InvoiceDetail {
    requirePermission(this.context(), 'invoice.view');
    const row = this.db.prepare(`${SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`).get(id) as InvoiceRow | undefined;
    if (!row) throw AppError.notFound('Invoice');
    const items = this.items(id);
    const payments = this.payments(id);
    return {
      ...this.mapSummary(row),
      patientPhone: row.patient_phone ?? '',
      patientAddress: row.patient_address ?? '',
      notes: row.notes,
      items,
      payments,
      dentistId: row.dentist_id,
      dentistName: row.dentist_name ?? 'Unassigned',
    };
  }

  private items(invoiceId: number): InvoiceItem[] {
    const rows = this.db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id`).all(invoiceId) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      invoiceId: asNumber(row['invoice_id']),
      treatmentId: row['treatment_id'] === null ? null : asNumber(row['treatment_id']),
      treatmentRecordId: row['treatment_record_id'] === null ? null : asNumber(row['treatment_record_id']),
      code: asString(row['code']),
      description: asString(row['description']),
      toothCodes: parseJsonArray(row['tooth_codes']),
      quantity: asNumber(row['quantity'], 1),
      unitPricePaisa: asNumber(row['unit_price_paisa']),
      discountType: asString(row['discount_type'], 'none') as InvoiceItem['discountType'],
      discountValue: asNumber(row['discount_value']),
      discountPaisa: asNumber(row['discount_paisa']),
      lineTotalPaisa: asNumber(row['line_total_paisa']),
      sortOrder: asNumber(row['sort_order']),
    }));
  }

  private payments(invoiceId: number): PaymentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT pay.*, m.name AS method_name, m.category AS method_category, i.number AS invoice_number,
                p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name,
                (SELECT full_name FROM users u WHERE u.id = pay.received_by) AS received_by_name
           FROM payments pay
           JOIN invoices i ON i.id = pay.invoice_id
           JOIN patients p ON p.id = pay.patient_id
           LEFT JOIN payment_methods m ON m.id = pay.method_id
          WHERE pay.invoice_id = ?
          ORDER BY pay.paid_at DESC, pay.id DESC`,
      )
      .all(invoiceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      receiptNumber: asString(row['receipt_number']),
      invoiceId: asNumber(row['invoice_id']),
      invoiceNumber: asString(row['invoice_number']),
      patientId: asNumber(row['patient_id']),
      patientCode: asString(row['patient_code']),
      patientName: asString(row['patient_name']),
      amountPaisa: asNumber(row['amount_paisa']),
      methodId: row['method_id'] === null ? null : asNumber(row['method_id']),
      methodName: asString(row['method_name'], 'Unspecified'),
      methodCategory: asString(row['method_category'], 'other') as PaymentSummary['methodCategory'],
      reference: asString(row['reference']),
      note: asString(row['note']),
      paidAt: asString(row['paid_at']),
      paidDate: asString(row['paid_date']),
      receivedByName: asString(row['received_by_name'], '—'),
      isVoid: fromBoolInt(row['is_void']),
      voidReason: asString(row['void_reason']),
      createdAt: asString(row['created_at']),
    }));
  }

  byPatient(patientId: number, limit = 100): InvoiceSummary[] {
    requirePermission(this.context(), 'invoice.view');
    const rows = this.db
      .prepare(`${SELECT} WHERE i.patient_id = ? AND i.deleted_at IS NULL ORDER BY i.date DESC, i.id DESC LIMIT ?`)
      .all(patientId, limit) as InvoiceRow[];
    return rows.map((row) => this.mapSummary(row));
  }

  create(input: InvoiceInput): { id: number; number: string } {
    requirePermission(this.context(), 'invoice.create');
    const computed = this.computeTotals(input);
    const ctx = this.context();
    const result = this.db.transaction(() => {
      const number = nextInvoiceNumber(this.db, input.date);
      const now = ctx.instant();
      const inserted = this.db
        .prepare(
          `INSERT INTO invoices (number, patient_id, visit_id, dentist_id, date, subtotal_paisa, discount_paisa,
             discount_type, discount_value, total_paisa, paid_paisa, status, notes, created_by, created_at, updated_at)
           VALUES (@number, @patientId, @visitId, @dentistId, @date, @subtotal, @discount, @discountType, @discountValue,
             @total, 0, 'unpaid', @notes, @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          number,
          patientId: input.patientId,
          visitId: input.visitId,
          dentistId: input.dentistId,
          date: input.date,
          subtotal: computed.subtotal,
          discount: computed.discount,
          discountType: input.discountType ?? 'none',
          discountValue: input.discountValue ?? 0,
          total: computed.total,
          notes: input.notes.trim(),
          createdBy: currentUserId(ctx),
          createdAt: now,
          updatedAt: now,
        });
      const invoiceId = Number(inserted.lastInsertRowid);
      this.saveItems(invoiceId, input.items);
      ctx.audit.record({
        action: 'create',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: number,
        detail: `Invoice created for ${formatMoney(computed.total)}`,
        after: { number, total: computed.total, items: input.items.length },
      });
      return { id: invoiceId, number };
    })();
    ctx.notify?.('invoices.changed', { id: result.id });
    return result;
  }

  update(id: number, input: InvoiceInput): void {
    requirePermission(this.context(), 'invoice.edit');
    const before = this.db.prepare(`SELECT * FROM invoices WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string; total_paisa: number; paid_paisa: number; is_void: number; date: string }
      | undefined;
    if (!before) throw AppError.notFound('Invoice');
    if (fromBoolInt(before.is_void)) throw AppError.precondition('This invoice has been voided and cannot be edited.');
    const computed = this.computeTotals(input);
    if (computed.total < asNumber(before.paid_paisa)) {
      throw AppError.precondition(
        `This invoice already has payments of ${formatMoney(asNumber(before.paid_paisa))}. The total cannot be reduced below that amount.`,
      );
    }
    const ctx = this.context();
    this.db.transaction(() => {
      // Detach previous treatment links so they can be re-linked consistently.
      this.db
        .prepare(
          `UPDATE treatment_records SET invoice_item_id = NULL WHERE` +
            ` invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)`,
        )
        .run(id);
      this.db
        .prepare(
          `UPDATE invoices SET visit_id = @visitId, dentist_id = @dentistId, date = @date, subtotal_paisa = @subtotal,
             discount_paisa = @discount, discount_type = @discountType, discount_value = @discountValue, total_paisa = @total,
             notes = @notes, updated_at = @updatedAt WHERE id = @id`,
        )
        .run({
          id,
          visitId: input.visitId,
          dentistId: input.dentistId,
          date: input.date,
          subtotal: computed.subtotal,
          discount: computed.discount,
          discountType: input.discountType ?? 'none',
          discountValue: input.discountValue ?? 0,
          total: computed.total,
          notes: input.notes.trim(),
          updatedAt: ctx.instant(),
        });
      this.db.prepare(`UPDATE invoice_items SET invoice_id = invoice_id WHERE invoice_id = ?`).run(id);
      this.db.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).run(id);
      this.saveItems(id, input.items);
      this.recompute(id);
      ctx.audit.record({
        action: 'update',
        entityType: 'invoice',
        entityId: id,
        entityLabel: before.number,
        detail: 'Invoice amended',
        before: { total: before.total_paisa, paid: before.paid_paisa },
        after: { total: computed.total, paid: before.paid_paisa },
      });
    })();
    ctx.notify?.('invoices.changed', { id });
  }

  void(id: number, reason: string): void {
    requirePermission(this.context(), 'invoice.delete');
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for' + ' voiding this invoice.', { reason: 'Reason is required.' });
    const invoice = this.db.prepare(`SELECT number, paid_paisa FROM invoices WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string; paid_paisa: number }
      | undefined;
    if (!invoice) throw AppError.notFound('Invoice');
    if (asNumber(invoice.paid_paisa) > 0) {
      throw AppError.precondition('This invoice has payments recorded. Void the payments first so the financial history stays auditable.');
    }
    const ctx = this.context();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE invoices SET is_void = 1, status = 'void', void_reason =` +
            ` ?, voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?`,
        )
        .run(reason.trim(), ctx.instant(), currentUserId(ctx), ctx.instant(), id);
      this.db
        .prepare(
          `UPDATE treatment_records SET invoice_item_id = NULL WHERE` +
            ` invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)`,
        )
        .run(id);
      ctx.audit.record({
        action: 'update',
        entityType: 'invoice',
        entityId: id,
        entityLabel: invoice.number,
        detail: `Invoice voided. Reason: ${reason.trim()}`,
        severity: 'critical',
        before: { status: 'active' },
        after: { status: 'void', reason: reason.trim() },
      });
    })();
    ctx.notify?.('invoices.changed', { id });
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'invoice.delete');
    const invoice = this.db.prepare(`SELECT number, paid_paisa FROM invoices WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { number: string; paid_paisa: number }
      | undefined;
    if (!invoice) throw AppError.notFound('Invoice');
    if (asNumber(invoice.paid_paisa) > 0) {
      throw AppError.precondition('An invoice with payments cannot be deleted. Void the payments first.');
    }
    if (confirmText?.trim() !== invoice.number) {
      throw AppError.validation(`Type the invoice number (${invoice.number}) to confirm deletion.`, {
        confirmText: `Type ${invoice.number} to confirm.`,
      });
    }
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for' + ' deleting this invoice.', { reason: 'Reason is required.' });
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE invoices SET deleted_at = ?, deleted_reason = ? WHERE id = ?`).run(ctx.instant(), reason.trim(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'invoice',
        entityId: id,
        entityLabel: invoice.number,
        detail: `Invoice deleted. Reason: ${reason.trim()}`,
        severity: 'critical',
      });
    })();
    ctx.notify?.('invoices.changed', { id });
  }

  /** Reading of a treatment record's invoice link, so the visit screen can warn early. */
  treatmentRecordIsInvoiced(treatmentRecordId: number): boolean {
    const row = this.db.prepare(`SELECT invoice_item_id FROM treatment_records WHERE id = ?`).get(treatmentRecordId) as
      | { invoice_item_id: number | null }
      | undefined;
    return Boolean(row?.invoice_item_id);
  }

  /**
   * Recompute `paid_paisa` and `status` from the live payment ledger.
   * Called after every payment mutation — the ledger is the single source of truth.
   */
  recompute(invoiceId: number): { paid: number; status: InvoiceStatus } {
    const row = this.db.prepare(`SELECT total_paisa, is_void FROM invoices WHERE id = ?`).get(invoiceId) as
      | { total_paisa: number; is_void: number }
      | undefined;
    if (!row) throw AppError.notFound('Invoice');
    const paid = asNumber(
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(amount_paisa), 0) AS paid FROM payments WHERE invoice_id = ? AND is_void = 0`)
          .get(invoiceId) as { paid: number }
      ).paid,
    );
    const total = asNumber(row.total_paisa);
    let status: InvoiceStatus;
    if (fromBoolInt(row.is_void)) status = 'void';
    else if (total > 0 && paid >= total) status = 'paid';
    else if (paid > 0) status = 'partially_paid';
    else status = 'unpaid';
    this.db
      .prepare(`UPDATE invoices SET paid_paisa = ?,` + ` status = ?, updated_at = ? WHERE id = ?`)
      .run(paid, status, this.context().instant(), invoiceId);
    return { paid, status };
  }

  outstanding(query: { page?: number; pageSize?: number; search?: string } = {}): Paged<{
    patientId: number;
    patientCode: string;
    patientName: string;
    phone: string;
    invoiceCount: number;
    totalPaisa: number;
    paidPaisa: number;
    duePaisa: number;
    oldestDueDate: string;
    lastPaymentAt: string | null;
  }> {
    requirePermission(this.context(), 'invoice.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = ['i.deleted_at IS NULL', 'i.is_void = 0', 'i.total_paisa > i.paid_paisa'];
    const params: unknown[] = [];
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(p.code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\')`);
      params.push(term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(DISTINCT i.patient_id) AS total FROM invoices i JOIN patients p ON p.id = i.patient_id${where}`)
          .get(...params) as { total: number }
      ).total,
    );
    const rows = this.db
      .prepare(
        `SELECT i.patient_id, p.code AS patient_code, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.phone,
                COUNT(*) AS invoice_count, SUM(i.total_paisa) AS total, SUM(i.paid_paisa) AS paid,
                SUM(i.total_paisa - i.paid_paisa) AS due, MIN(i.date) AS oldest_due,
                (SELECT MAX(pay.paid_at) FROM payments pay WHERE pay.patient_id = i.patient_id AND pay.is_void = 0) AS last_payment
           FROM invoices i JOIN patients p ON p.id = i.patient_id
           ${where}
          GROUP BY i.patient_id
          ORDER BY due DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
      patient_id: number;
      patient_code: string;
      patient_name: string;
      phone: string;
      invoice_count: number;
      total: number;
      paid: number;
      due: number;
      oldest_due: string;
      last_payment: string | null;
    }>;
    return {
      items: rows.map((row) => ({
        patientId: row.patient_id,
        patientCode: row.patient_code,
        patientName: row.patient_name,
        phone: row.phone,
        invoiceCount: asNumber(row.invoice_count),
        totalPaisa: asNumber(row.total),
        paidPaisa: asNumber(row.paid),
        duePaisa: asNumber(row.due),
        oldestDueDate: row.oldest_due,
        lastPaymentAt: row.last_payment,
      })),
      total,
      page,
      pageSize,
      pageCount: pageCount(total, pageSize),
    };
  }

  statistics(options: { preset?: string; from?: string; to?: string } = {}): {
    invoiceCount: number;
    invoicedPaisa: number;
    collectedPaisa: number;
    outstandingPaisa: number;
    discountPaisa: number;
    byStatus: Array<{ label: string; value: number }>;
    byDay: Array<{ date: string; invoicedPaisa: number; collectedPaisa: number }>;
    topTreatments: Array<{ label: string; value: number; amountPaisa: number }>;
  } {
    requirePermission(this.context(), 'report.financial.view');
    const range = resolveDateRange((options.preset ?? 'last_30_days') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS invoice_count, COALESCE(SUM(total_paisa),0) AS invoiced, COALESCE(SUM(paid_paisa),0) AS collected,
                COALESCE(SUM(discount_paisa),0) AS discount
           FROM invoices WHERE deleted_at IS NULL AND is_void = 0 AND date BETWEEN ? AND ?`,
      )
      .get(range.from, range.to) as { invoice_count: number; invoiced: number; collected: number; discount: number };
    const outstanding = asNumber(
      (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(total_paisa - paid_paisa),0) AS due FROM invoices
              WHERE deleted_at IS NULL AND is_void = 0 AND total_paisa > paid_paisa`,
          )
          .get() as { due: number }
      ).due,
    );
    const byStatus = (
      this.db
        .prepare(
          `SELECT status AS label, COUNT(*) AS value FROM invoices
            WHERE deleted_at IS NULL AND date BETWEEN ? AND ? GROUP BY status`,
        )
        .all(range.from, range.to) as Array<{ label: string; value: number }>
    ).map((row) => ({ label: row.label, value: asNumber(row.value) }));
    const byDay = (
      this.db
        .prepare(
          `SELECT i.date AS date, SUM(i.total_paisa) AS invoiced,
                  COALESCE((SELECT SUM(pay.amount_paisa) FROM payments` +
            ` pay WHERE pay.paid_date = i.date AND pay.is_void = 0), 0) AS collected
             FROM invoices i WHERE i.deleted_at IS NULL AND i.is_void = 0 AND i.date BETWEEN ? AND ?
            GROUP BY i.date ORDER BY i.date`,
        )
        .all(range.from, range.to) as Array<{ date: string; invoiced: number; collected: number }>
    ).map((row) => ({ date: row.date, invoicedPaisa: asNumber(row.invoiced), collectedPaisa: asNumber(row.collected) }));
    const topTreatments = (
      this.db
        .prepare(
          `SELECT COALESCE(NULLIF(trim(ii.description), ''), ii.code) AS label,` +
            ` SUM(ii.quantity) AS value, SUM(ii.line_total_paisa) AS amount
             FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
            WHERE i.deleted_at IS NULL AND i.is_void = 0 AND i.date BETWEEN ? AND ?
            GROUP BY lower(label) ORDER BY amount DESC LIMIT 10`,
        )
        .all(range.from, range.to) as Array<{ label: string; value: number; amount: number }>
    ).map((row) => ({ label: row.label, value: asNumber(row.value), amountPaisa: asNumber(row.amount) }));

    return {
      invoiceCount: asNumber(totals.invoice_count),
      invoicedPaisa: asNumber(totals.invoiced),
      collectedPaisa: asNumber(totals.collected),
      outstandingPaisa: outstanding,
      discountPaisa: asNumber(totals.discount),
      byStatus,
      byDay,
      topTreatments,
    };
  }

  // --- Internals ----------------------------------------------------------

  private computeTotals(input: InvoiceInput): { subtotal: number; discount: number; total: number } {
    if (input.items.length === 0) {
      throw AppError.validation('An invoice needs at least one line item.', { items: 'Add at least one treatment or product.' });
    }
    let subtotal = 0;
    let lineDiscounts = 0;
    for (const [index, item] of input.items.entries()) {
      if (item.description.trim() === '') {
        throw AppError.validation('Every invoice line needs a description.', { [`item-${index}`]: 'Description is required.' });
      }
      if (item.quantity <= 0 || !Number.isFinite(item.quantity)) {
        throw AppError.validation('Line quantity must be greater than zero.', { [`item-${index}`]: 'Quantity must be at least 1.' });
      }
      if (item.unitPricePaisa < 0) {
        throw AppError.validation('Line price cannot be negative.', { [`item-${index}`]: 'Enter a valid price.' });
      }
      const lineSubtotal = Math.round(item.unitPricePaisa) * Math.round(item.quantity);
      const discount = this.itemDiscount(item, lineSubtotal);
      subtotal += lineSubtotal;
      lineDiscounts += discount;
    }
    const invoiceDiscount: DiscountSpec =
      input.discountType === 'percent' && input.discountValue
        ? { type: 'percent', value: this.normaliseDiscountValue(input.discountType, input.discountValue) }
        : input.discountType === 'amount' && input.discountValue
          ? { type: 'amount', value: Math.round(input.discountValue) }
          : { type: 'none' };
    // The subtotal is the gross value of every line; discount_paisa is the sum
    // of the line discounts plus any invoice-level discount, so the figures on
    // an invoice always add up: subtotal − discount = total.
    const result = applyDiscount(subtotal - lineDiscounts, invoiceDiscount);
    return { subtotal, discount: lineDiscounts + result.discount, total: result.total };
  }

  private itemDiscount(item: InvoiceItemInput, lineSubtotal: number): number {
    if (item.discountType === 'percent' && item.discountValue) {
      return applyDiscount(lineSubtotal, { type: 'percent', value: this.normaliseDiscountValue('percent', item.discountValue) }).discount;
    }
    if (item.discountType === 'amount' && item.discountValue) {
      return applyDiscount(lineSubtotal, { type: 'amount', value: Math.round(item.discountValue) }).discount;
    }
    return 0;
  }

  private normaliseDiscountValue(type: 'percent' | 'amount', value: number): number {
    if (!Number.isFinite(value) || value < 0) {
      throw AppError.validation('Discount cannot be negative.', { discountValue: 'Enter a positive discount.' });
    }
    if (type === 'percent' && value > 100) {
      throw AppError.validation('A percentage discount cannot exceed 100%.', { discountValue: 'Maximum is 100%.' });
    }
    return value;
  }

  private saveItems(invoiceId: number, items: readonly InvoiceItemInput[]): void {
    const insert = this.db.prepare(
      `INSERT INTO invoice_items (invoice_id, treatment_id, treatment_record_id, code, description, tooth_codes, quantity,
         unit_price_paisa, discount_type, discount_value, discount_paisa, line_total_paisa, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item, index) => {
      const quantity = Math.max(1, Math.round(item.quantity));
      const unitPrice = Math.max(0, Math.round(item.unitPricePaisa));
      const lineSubtotal = unitPrice * quantity;
      const discountPaisa = this.itemDiscount(item, lineSubtotal);
      const result = insert.run(
        invoiceId,
        item.treatmentId,
        item.treatmentRecordId ?? null,
        item.code,
        item.description.trim(),
        toJsonArray(item.toothCodes),
        quantity,
        unitPrice,
        item.discountType,
        Math.round(item.discountValue),
        discountPaisa,
        lineSubtotal - discountPaisa,
        item.sortOrder ?? index,
      );
      if (item.treatmentRecordId) {
        this.db
          .prepare(`UPDATE treatment_records SET invoice_item_id = ? WHERE id = ? AND invoice_item_id IS NULL`)
          .run(Number(result.lastInsertRowid), item.treatmentRecordId);
      }
    });
  }

  /** Everything the print layer needs for an invoice. */
  forPrint(id: number): {
    invoice: InvoiceDetail;
    clinic: { name: string; address: string; phone: string; email: string; logoPath: string | null; footerNote: string };
  } {
    const invoice = this.get(id);
    const clinicRow = this.db.prepare(`SELECT name, address, phone, email, logo_path FROM clinic WHERE id = 1`).get() as
      | { name: string; address: string; phone: string; email: string; logo_path: string | null }
      | undefined;
    const settingsRow = this.db.prepare(`SELECT value FROM app_settings WHERE key = 'invoiceFooterNote'`).get() as
      | { value: string }
      | undefined;
    let footerNote = '';
    if (settingsRow) {
      try {
        const parsed = JSON.parse(settingsRow.value) as unknown;
        if (typeof parsed === 'string') footerNote = parsed;
      } catch {
        footerNote = '';
      }
    }
    return {
      invoice,
      clinic: {
        name: clinicRow?.name ?? '',
        address: clinicRow?.address ?? '',
        phone: clinicRow?.phone ?? '',
        email: clinicRow?.email ?? '',
        logoPath: clinicRow?.logo_path ?? null,
        footerNote,
      },
    };
  }
}
