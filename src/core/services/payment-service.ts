/**
 * Payments.
 *
 * A payment is an immutable financial event: it is created, and thereafter only
 * voided with a reason (never edited into a different amount without an audit
 * trail, and never deleted). Every mutation recomputes the invoice from the
 * ledger and keeps the accounting income entry in step.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type { Paged, PaymentInput, PaymentMethod, PaymentStats, PaymentSummary } from '@shared/types';
import type { PaymentMethodCategory } from '@shared/constants';
import { AppError } from '@shared/errors';
import { resolveDateRange, todayIso } from '@shared/dates';
import { formatMoney, outstandingPaisa } from '@shared/money';
import { asNumber, asString, buildWhere, fromBoolInt, pageCount, paginate } from '../db/sql';
import { nextReceiptNumber } from '../util/ids';
import type { InvoiceService } from './invoice-service';
import type { AccountingService } from './accounting-service';

export class PaymentService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly invoices: InvoiceService,
    private readonly accounting: AccountingService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private map(row: Record<string, unknown>): PaymentSummary {
    return {
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
      methodCategory: asString(row['method_category'], 'other') as PaymentMethodCategory,
      reference: asString(row['reference']),
      note: asString(row['note']),
      paidAt: asString(row['paid_at']),
      paidDate: asString(row['paid_date']),
      receivedByName: asString(row['received_by_name'], '—'),
      isVoid: fromBoolInt(row['is_void']),
      voidReason: asString(row['void_reason']),
      createdAt: asString(row['created_at']),
    };
  }

  private readonly select = `
    SELECT pay.*, i.number AS invoice_number, p.code AS patient_code,
           trim(p.first_name || ' ' || p.last_name) AS patient_name,
           m.name AS method_name, m.category AS method_category,
           (SELECT full_name FROM users u WHERE u.id = pay.received_by) AS received_by_name
      FROM payments pay
      JOIN invoices i ON i.id = pay.invoice_id
      JOIN patients p ON p.id = pay.patient_id
      LEFT JOIN payment_methods m ON m.id = pay.method_id
  `;

  list(query: { page?: number; pageSize?: number; search?: string; preset?: string; from?: string; to?: string; patientId?: number; invoiceId?: number; methodId?: number | null; includeVoid?: boolean } = {}): Paged<PaymentSummary> {
    requirePermission(this.context(), 'payment.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!query.includeVoid) clauses.push('pay.is_void = 0');
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    const range = preset ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } }) : { from: query.from, to: query.to };
    if (range.from) {
      clauses.push('pay.paid_date >= ?');
      params.push(range.from);
    }
    if (range.to) {
      clauses.push('pay.paid_date <= ?');
      params.push(range.to);
    }
    if (query.patientId) {
      clauses.push('pay.patient_id = ?');
      params.push(query.patientId);
    }
    if (query.invoiceId) {
      clauses.push('pay.invoice_id = ?');
      params.push(query.invoiceId);
    }
    if (query.methodId) {
      clauses.push('pay.method_id = ?');
      params.push(query.methodId);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(pay.receipt_number LIKE ? ESCAPE '\\' OR pay.reference LIKE ? ESCAPE '\\' OR i.number LIKE ? ESCAPE '\\'
                    OR p.code LIKE ? ESCAPE '\\' OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\')`);
      params.push(term, term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM payments pay JOIN invoices i ON i.id = pay.invoice_id JOIN patients p ON p.id = pay.patient_id${where}`)
          .get(...params) as { total: number }
      ).total,
    );
    const rows = this.db
      .prepare(`${this.select}${where} ORDER BY pay.paid_at DESC, pay.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return { items: rows.map((row) => this.map(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): PaymentSummary {
    requirePermission(this.context(), 'payment.view');
    const row = this.db.prepare(`${this.select} WHERE pay.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw AppError.notFound('Payment');
    return this.map(row);
  }

  byInvoice(invoiceId: number): PaymentSummary[] {
    return this.list({ invoiceId, includeVoid: true, pageSize: 200 }).items;
  }

  byPatient(patientId: number, limit = 100): PaymentSummary[] {
    return this.list({ patientId, pageSize: limit, includeVoid: true }).items;
  }

  create(input: PaymentInput): { id: number; receiptNumber: string } {
    requirePermission(this.context(), 'payment.create');
    const ctx = this.context();
    const invoice = this.loadInvoice(input.invoiceId);
    if (fromBoolInt(invoice.is_void)) throw AppError.precondition('This invoice has been voided. Payments cannot be recorded against it.');
    this.assertMethodUsable(input.methodId, input.reference);
    const amount = this.validateAmount(input.amountPaisa);
    const due = outstandingPaisa(asNumber(invoice.total_paisa), asNumber(invoice.paid_paisa));
    if (amount > due) {
      throw AppError.validation(
        `The outstanding balance is ${formatMoney(due)}. Record at most that amount, or correct the invoice total first.`,
        { amountPaisa: `Maximum ${formatMoney(due)}` },
      );
    }

    const result = this.db.transaction(() => {
      const paidAt = input.paidAtInstant ?? ctx.instant();
      const paidDate = input.paidDate ?? todayIso(ctx.now(), ctx.timeZone());
      const receiptNumber = nextReceiptNumber(this.db, paidDate);
      const inserted = this.db
        .prepare(
          `INSERT INTO payments (receipt_number, invoice_id, patient_id, amount_paisa, method_id, reference, note, paid_at, paid_date,
             received_by, is_void, created_at, updated_at)
           VALUES (@receiptNumber, @invoiceId, @patientId, @amount, @methodId, @reference, @note, @paidAt, @paidDate, @receivedBy, 0, @createdAt, @updatedAt)`,
        )
        .run({
          receiptNumber,
          invoiceId: input.invoiceId,
          patientId: invoice.patient_id,
          amount,
          methodId: input.methodId,
          reference: input.reference.trim(),
          note: input.note.trim(),
          paidAt,
          paidDate,
          receivedBy: currentUserId(ctx),
          createdAt: ctx.instant(),
          updatedAt: ctx.instant(),
        });
      const paymentId = Number(inserted.lastInsertRowid);
      const status = this.invoices.recompute(input.invoiceId);
      this.accounting.recordPaymentIncome({
        paymentId,
        date: paidDate,
        amountPaisa: amount,
        methodId: input.methodId,
        reference: receiptNumber,
        note: `Payment for invoice ${invoice.number}`,
      });
      ctx.audit.record({
        action: 'create',
        entityType: 'payment',
        entityId: paymentId,
        entityLabel: receiptNumber,
        detail: `Payment of ${formatMoney(amount)} recorded for invoice ${invoice.number}`,
        after: { receiptNumber, amount, invoiceNumber: invoice.number, invoiceStatus: status.status },
      });
      return { id: paymentId, receiptNumber };
    })();
    ctx.notify?.('payments.changed', { id: result.id, invoiceId: input.invoiceId });
    return result;
  }

  /**
   * Correcting a payment is a permissioned act and always recomputes the
   * invoice; the previous value is preserved in the audit trail.
   */
  update(id: number, input: PaymentInput): void {
    requirePermission(this.context(), 'payment.edit');
    const existing = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as
      | {
          id: number;
          invoice_id: number;
          amount_paisa: number;
          method_id: number | null;
          reference: string;
          note: string;
          paid_at: string;
          paid_date: string;
          is_void: number;
          receipt_number: string;
        }
      | undefined;
    if (!existing) throw AppError.notFound('Payment');
    if (fromBoolInt(existing.is_void)) throw AppError.precondition('A voided payment cannot be edited.');
    const amount = this.validateAmount(input.amountPaisa);
    this.assertMethodUsable(input.methodId, input.reference);

    const invoice = this.loadInvoice(existing.invoice_id);
    const paidExcludingThis = asNumber(
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(amount_paisa),0) AS paid FROM payments WHERE invoice_id = ? AND is_void = 0 AND id <> ?`)
          .get(existing.invoice_id, id) as { paid: number }
      ).paid,
    );
    const allowed = Math.max(0, asNumber(invoice.total_paisa) - paidExcludingThis);
    if (amount > allowed) {
      throw AppError.validation(
        `The remaining balance for this invoice is ${formatMoney(allowed)}. The payment cannot exceed that amount.`,
        { amountPaisa: `Maximum ${formatMoney(allowed)}` },
      );
    }

    const ctx = this.context();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE payments SET amount_paisa = ?, method_id = ?, reference = ?, note = ?, paid_at = ?, paid_date = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          amount,
          input.methodId,
          input.reference.trim(),
          input.note.trim(),
          input.paidAtInstant ?? existing.paid_at,
          input.paidDate ?? existing.paid_date,
          ctx.instant(),
          id,
        );
      const status = this.invoices.recompute(existing.invoice_id);
      this.accounting.updatePaymentIncome(id, {
        date: input.paidDate ?? existing.paid_date,
        amountPaisa: amount,
        methodId: input.methodId,
        note: input.note.trim(),
      });
      ctx.audit.record({
        action: 'update',
        entityType: 'payment',
        entityId: id,
        entityLabel: existing.receipt_number,
        detail: 'Payment corrected',
        severity: 'warning',
        before: { amount: existing.amount_paisa, methodId: existing.method_id, reference: existing.reference },
        after: { amount, methodId: input.methodId, reference: input.reference.trim(), invoiceStatus: status.status },
      });
    })();
    ctx.notify?.('payments.changed', { id });
  }

  /** Reverses a payment while keeping the original record and its audit trail. */
  void(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'payment.delete');
    const existing = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as
      | { id: number; invoice_id: number; amount_paisa: number; receipt_number: string; is_void: number; paid_date: string }
      | undefined;
    if (!existing) throw AppError.notFound('Payment');
    if (fromBoolInt(existing.is_void)) throw AppError.precondition('This payment has already been reversed.');
    if (reason.trim().length < 3) throw AppError.validation('Explain why the payment is being reversed.', { reason: 'Reason is required.' });
    if (confirmText?.trim() !== existing.receipt_number) {
      throw AppError.validation(`Type the receipt number (${existing.receipt_number}) to confirm the reversal.`, {
        confirmText: `Type ${existing.receipt_number} to confirm.`,
      });
    }
    const ctx = this.context();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE payments SET is_void = 1, void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?`)
        .run(reason.trim(), ctx.instant(), currentUserId(ctx), ctx.instant(), id);
      const status = this.invoices.recompute(existing.invoice_id);
      this.accounting.voidPaymentIncome(id, reason.trim());
      ctx.audit.record({
        action: 'delete',
        entityType: 'payment',
        entityId: id,
        entityLabel: existing.receipt_number,
        detail: `Payment of ${formatMoney(asNumber(existing.amount_paisa))} reversed. Reason: ${reason.trim()}`,
        severity: 'critical',
        before: { amount: existing.amount_paisa, invoicedStatusBefore: status.status },
        after: { voided: true, reason: reason.trim(), invoiceStatus: status.status },
      });
    })();
    ctx.notify?.('payments.changed', { id });
  }

  statistics(options: { preset?: string; from?: string; to?: string } = {}): PaymentStats {
    requirePermission(this.context(), 'report.financial.view');
    const range = resolveDateRange((options.preset ?? 'last_30_days') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paisa),0) AS total, COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN m.category = 'cash' THEN pay.amount_paisa ELSE 0 END),0) AS cash,
                COALESCE(SUM(CASE WHEN m.category = 'bank' THEN pay.amount_paisa ELSE 0 END),0) AS bank,
                COALESCE(SUM(CASE WHEN m.category = 'card' THEN pay.amount_paisa ELSE 0 END),0) AS card,
                COALESCE(SUM(CASE WHEN m.category = 'mobile_wallet' THEN pay.amount_paisa ELSE 0 END),0) AS wallet,
                COALESCE(SUM(CASE WHEN m.category IS NULL OR m.category = 'other' THEN pay.amount_paisa ELSE 0 END),0) AS other
           FROM payments pay LEFT JOIN payment_methods m ON m.id = pay.method_id
          WHERE pay.is_void = 0 AND pay.paid_date BETWEEN ? AND ?`,
      )
      .get(range.from, range.to) as { total: number; count: number; cash: number; bank: number; card: number; wallet: number; other: number };
    const byMethod = (
      this.db
        .prepare(
          `SELECT pay.method_id, COALESCE(m.name,'Unspecified') AS method_name, COALESCE(m.category,'other') AS category,
                  SUM(pay.amount_paisa) AS amount, COUNT(*) AS count
             FROM payments pay LEFT JOIN payment_methods m ON m.id = pay.method_id
            WHERE pay.is_void = 0 AND pay.paid_date BETWEEN ? AND ?
            GROUP BY pay.method_id ORDER BY amount DESC`,
        )
        .all(range.from, range.to) as Array<{ method_id: number | null; method_name: string; category: string; amount: number; count: number }>
    ).map((row) => ({
      methodId: asNumber(row.method_id),
      methodName: row.method_name,
      category: row.category as PaymentMethodCategory,
      amountPaisa: asNumber(row.amount),
      count: asNumber(row.count),
    }));
    const daily = (
      this.db
        .prepare(
          `SELECT paid_date AS date, SUM(amount_paisa) AS amount, COUNT(*) AS count FROM payments
            WHERE is_void = 0 AND paid_date BETWEEN ? AND ? GROUP BY paid_date ORDER BY paid_date`,
        )
        .all(range.from, range.to) as Array<{ date: string; amount: number; count: number }>
    ).map((row) => ({ date: row.date, amountPaisa: asNumber(row.amount), count: asNumber(row.count) }));
    const outstanding = asNumber(
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(total_paisa - paid_paisa),0) AS due FROM invoices WHERE deleted_at IS NULL AND is_void = 0 AND total_paisa > paid_paisa`)
          .get() as { due: number }
      ).due,
    );
    const invoiceCount = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM invoices WHERE deleted_at IS NULL AND is_void = 0 AND date BETWEEN ? AND ?`)
          .get(range.from, range.to) as { total: number }
      ).total,
    );
    return {
      range: { from: range.from, to: range.to },
      totalPaisa: asNumber(totals.total),
      cashPaisa: asNumber(totals.cash),
      bankPaisa: asNumber(totals.bank),
      cardPaisa: asNumber(totals.card),
      mobileWalletPaisa: asNumber(totals.wallet),
      otherPaisa: asNumber(totals.other),
      byMethod,
      daily,
      outstandingPaisa: outstanding,
      invoiceCount,
      paymentCount: asNumber(totals.count),
    };
  }

  /** Payment methods available to this clinic (active first). */
  methods(includeInactive = false): PaymentMethod[] {
    const clauses: string[] = ['deleted_at IS NULL'];
    if (!includeInactive) clauses.push('is_active = 1');
    const rows = this.db
      .prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM payments pay WHERE pay.method_id = m.id) AS usage_count
           FROM payment_methods m WHERE ${clauses.join(' AND ')} ORDER BY m.sort_order, m.name`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      code: asString(row['code']),
      name: asString(row['name']),
      category: asString(row['category'], 'other') as PaymentMethodCategory,
      requiresReference: fromBoolInt(row['requires_reference']),
      isActive: fromBoolInt(row['is_active']),
      sortOrder: asNumber(row['sort_order']),
      usageCount: asNumber(row['usage_count']),
    }));
  }

  private loadInvoice(invoiceId: number): { id: number; number: string; total_paisa: number; paid_paisa: number; patient_id: number; is_void: number } {
    const invoice = this.db
      .prepare(`SELECT id, number, total_paisa, paid_paisa, patient_id, is_void FROM invoices WHERE id = ? AND deleted_at IS NULL`)
      .get(invoiceId) as
      | { id: number; number: string; total_paisa: number; paid_paisa: number; patient_id: number; is_void: number }
      | undefined;
    if (!invoice) throw AppError.notFound('Invoice');
    return invoice;
  }

  private assertMethodUsable(methodId: number | null, reference: string): void {
    if (methodId === null) return;
    const method = this.db.prepare(`SELECT id, name, is_active, requires_reference FROM payment_methods WHERE id = ? AND deleted_at IS NULL`).get(methodId) as
      | { id: number; name: string; is_active: number; requires_reference: number }
      | undefined;
    if (!method) throw AppError.validation('Select a valid payment method.', { methodId: 'Unknown payment method.' });
    if (!fromBoolInt(method.is_active)) throw AppError.validation(`${method.name} is no longer available. Choose another method.`, { methodId: 'Method is inactive.' });
    if (fromBoolInt(method.requires_reference) && reference.trim().length < 3) {
      throw AppError.validation(`${method.name} payments need a reference number.`, { reference: 'Reference is required for this method.' });
    }
  }

  private validateAmount(amountPaisa: number): number {
    if (!Number.isFinite(amountPaisa) || !Number.isSafeInteger(Math.round(amountPaisa))) {
      throw AppError.validation('Enter a valid amount.', { amountPaisa: 'Enter a valid amount.' });
    }
    const amount = Math.round(amountPaisa);
    if (amount <= 0) throw AppError.validation('Payment amount must be greater than zero.', { amountPaisa: 'Amount must be greater than zero.' });
    if (amount > 1e15) throw AppError.validation('Payment amount is unrealistically large.', { amountPaisa: 'Amount is too large.' });
    return amount;
  }
}
