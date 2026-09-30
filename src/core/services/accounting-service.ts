/**
 * Practical clinic accounting: income and expense ledger, categories, daybook
 * and period locking.
 *
 * This is a management ledger for a dental clinic — it is deliberately not
 * presented as a statutory accounting system. Invoice payments and inventory
 * purchases post automatically (with a source link) so the ledger always agrees
 * with the operational records instead of being maintained by hand.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type {
  AccountingCategory,
  AccountingSummary,
  AccountingTransaction,
  AccountingTransactionInput,
  DaybookRow,
  FinancialPeriod,
  Paged,
} from '@shared/types';
import type { AccountingDirection } from '@shared/constants';
import { AppError } from '@shared/errors';
import { addDays, addMonths, endOfMonth, resolveDateRange, startOfMonth } from '@shared/dates';
import { formatMoney } from '@shared/money';
import { asNumber, asString, buildWhere, fromBoolInt, pageCount, paginate } from '../db/sql';
import { deriveIncomeCategoryName } from './accounting-categories';

interface TransactionRow {
  id: number;
  direction: string;
  date: string;
  category_id: number;
  category_name: string;
  amount_paisa: number;
  payment_method_id: number | null;
  method_name: string | null;
  reference: string;
  note: string;
  source_type: string;
  source_id: number | null;
  attachment_count?: number;
  created_by_name: string | null;
  created_at: string;
  is_void: number;
  void_reason: string;
}

const SELECT =
  `
  SELECT t.*, c.name AS category_name, m.name AS method_name,
         (SELECT full_name FROM users u WHERE u.id = t.created_by) AS created_by_name,
         (SELECT COUNT(*) FROM attachments a WHERE a.entity_type = 'accounting_transaction'` +
  ` AND a.entity_id = t.id AND a.deleted_at IS NULL) AS attachment_count
    FROM accounting_transactions t
    JOIN accounting_categories c ON c.id = t.category_id
    LEFT JOIN payment_methods m ON m.id = t.payment_method_id
`;

export class AccountingService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private map(row: TransactionRow): AccountingTransaction {
    return {
      id: row.id,
      direction: row.direction as AccountingDirection,
      date: row.date,
      categoryId: row.category_id,
      categoryName: row.category_name,
      amountPaisa: asNumber(row.amount_paisa),
      paymentMethodId: row.payment_method_id,
      paymentMethodName: row.method_name ?? 'Unspecified',
      reference: row.reference,
      note: row.note,
      sourceType: row.source_type as AccountingTransaction['sourceType'],
      sourceId: row.source_id,
      attachmentCount: asNumber(row.attachment_count),
      createdByName: row.created_by_name ?? '—',
      createdAt: row.created_at,
      isVoid: fromBoolInt(row.is_void),
      voidReason: row.void_reason,
    };
  }

  // --- Categories ---------------------------------------------------------

  categories(direction?: AccountingDirection, includeInactive = false): AccountingCategory[] {
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (!includeInactive) clauses.push('is_active = 1');
    if (direction) {
      clauses.push('direction = ?');
      params.push(direction);
    }
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM accounting_transactions t WHERE t.category_id = c.id AND t.is_void = 0) AS usage_count
           FROM accounting_categories c WHERE ${clauses.join(' AND ')} ORDER BY c.direction, c.name`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      name: asString(row['name']),
      direction: asString(row['direction'], 'expense') as AccountingDirection,
      isActive: fromBoolInt(row['is_active']),
      isSystem: fromBoolInt(row['is_system']),
      usageCount: asNumber(row['usage_count']),
    }));
  }

  saveCategory(id: number | null, input: { name: string; direction: AccountingDirection; isActive: boolean }): { id: number } {
    requirePermission(this.context(), 'accounting.category.manage');
    const name = input.name.trim();
    if (name.length < 2) throw AppError.validation('Category name is too short.', { name: 'Enter a category name.' });
    const now = this.context().instant();
    if (id) {
      const existing = this.db.prepare(`SELECT is_system FROM accounting_categories WHERE id = ? AND deleted_at IS NULL`).get(id) as
        | { is_system: number }
        | undefined;
      if (!existing) throw AppError.notFound('Category');
      const result = this.db
        .prepare(`UPDATE accounting_categories SET name = ?, direction = ?, is_active = ?, updated_at = ? WHERE id = ?`)
        .run(name, input.direction, input.isActive ? 1 : 0, now, id);
      if (result.changes === 0) throw AppError.notFound('Category');
      this.context().audit.record({
        action: 'update',
        entityType: 'accounting_category',
        entityId: id,
        entityLabel: name,
        detail: 'Category updated',
      });
      return { id };
    }
    const duplicate = this.db
      .prepare(`SELECT id FROM accounting_categories WHERE lower(name) = lower(?) AND direction = ? AND deleted_at IS NULL`)
      .get(name, input.direction) as { id: number } | undefined;
    if (duplicate) throw AppError.conflict('That category already exists for this direction.');
    const result = this.db
      .prepare(
        `INSERT INTO accounting_categories (name, direction, is_active,` + ` is_system, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(name, input.direction, input.isActive ? 1 : 0, now, now);
    const newId = Number(result.lastInsertRowid);
    this.context().audit.record({
      action: 'create',
      entityType: 'accounting_category',
      entityId: newId,
      entityLabel: name,
      detail: 'Category created',
    });
    return { id: newId };
  }

  deleteCategory(id: number): void {
    requirePermission(this.context(), 'accounting.category.manage');
    const category = this.db.prepare(`SELECT name, is_system FROM accounting_categories WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { name: string; is_system: number }
      | undefined;
    if (!category) throw AppError.notFound('Category');
    if (fromBoolInt(category.is_system)) {
      throw AppError.precondition('Built-in categories are required by the application and cannot be deleted. Deactivate it instead.');
    }
    const used = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM accounting_transactions WHERE category_id = ?`).get(id) as { total: number }).total,
    );
    const ctx = this.context();
    if (used > 0) {
      this.db.prepare(`UPDATE accounting_categories SET is_active = 0, updated_at = ? WHERE id = ?`).run(this.context().instant(), id);
      ctx.audit.record({
        action: 'update',
        entityType: 'accounting_category',
        entityId: id,
        entityLabel: category.name,
        detail: `Category deactivated (used by ${used} entr(ies))`,
        severity: 'warning',
      });
      return;
    }
    this.db.prepare(`UPDATE accounting_categories SET deleted_at = ? WHERE id = ?`).run(this.context().instant(), id);
    ctx.audit.record({
      action: 'delete',
      entityType: 'accounting_category',
      entityId: id,
      entityLabel: category.name,
      detail: 'Category deleted',
    });
  }

  /** Find or create the category used for a given income/expense label. */
  ensureCategory(name: string, direction: AccountingDirection): number {
    const existing = this.db
      .prepare(`SELECT id FROM accounting_categories WHERE lower(name) = lower(?) AND direction = ? AND deleted_at IS NULL`)
      .get(name, direction) as { id: number } | undefined;
    if (existing) return existing.id;
    const now = this.context().instant();
    const result = this.db
      .prepare(
        `INSERT INTO accounting_categories (name, direction, is_active,` + ` is_system, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)`,
      )
      .run(name, direction, now, now);
    return Number(result.lastInsertRowid);
  }

  // --- Transactions -------------------------------------------------------

  list(
    query: {
      page?: number;
      pageSize?: number;
      search?: string;
      preset?: string;
      from?: string;
      to?: string;
      direction?: AccountingDirection;
      categoryId?: number | null;
      methodId?: number | null;
      includeVoid?: boolean;
    } = {},
  ): Paged<AccountingTransaction> {
    requirePermission(this.context(), 'accounting.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!query.includeVoid) clauses.push('t.is_void = 0');
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    const range = preset ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } }) : { from: query.from, to: query.to };
    if (range.from) {
      clauses.push('t.date >= ?');
      params.push(range.from);
    }
    if (range.to) {
      clauses.push('t.date <= ?');
      params.push(range.to);
    }
    if (query.direction) {
      clauses.push('t.direction = ?');
      params.push(query.direction);
    }
    if (query.categoryId) {
      clauses.push('t.category_id = ?');
      params.push(query.categoryId);
    }
    if (query.methodId) {
      clauses.push('t.payment_method_id = ?');
      params.push(query.methodId);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(t.note LIKE ? ESCAPE '\\' OR t.reference LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
      params.push(term, term, term);
    }
    const where = buildWhere(clauses);
    const totalSql =
      `SELECT COUNT(*) AS total FROM accounting_transactions t JOIN` + ` accounting_categories c ON c.id = t.category_id${where}`;
    const total = asNumber((this.db.prepare(totalSql).get(...params) as { total: number }).total);
    const rows = this.db
      .prepare(`${SELECT}${where} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as TransactionRow[];
    return { items: rows.map((row) => this.map(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  create(input: AccountingTransactionInput): { id: number } {
    requirePermission(this.context(), 'accounting.manage');
    this.validate(input);
    this.assertPeriodOpen(input.date, 'record');
    const ctx = this.context();
    const result = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO accounting_transactions (direction, date, category_id, amount_paisa, payment_method_id, reference, note,
             source_type, source_id, created_by, created_at, updated_at)
           VALUES (@direction, @date, @categoryId, @amount, @methodId,` +
            ` @reference, @note, 'manual', NULL, @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          direction: input.direction,
          date: input.date,
          categoryId: input.categoryId,
          amount: Math.round(input.amountPaisa),
          methodId: input.paymentMethodId,
          reference: input.reference.trim(),
          note: input.note.trim(),
          createdBy: currentUserId(ctx),
          createdAt: ctx.instant(),
          updatedAt: ctx.instant(),
        });
      const id = Number(inserted.lastInsertRowid);
      ctx.audit.record({
        action: 'create',
        entityType: 'accounting_transaction',
        entityId: id,
        entityLabel: `${input.direction === 'income' ? 'Income' : 'Expense'} ${formatMoney(input.amountPaisa)}`,
        detail: `${input.direction === 'income' ? 'Income' : 'Expense'} recorded: ${
          input.note.trim() || input.reference.trim() || 'no description'
        }`,
        after: { direction: input.direction, amount: input.amountPaisa, date: input.date },
      });
      return id;
    })();
    ctx.notify?.('accounting.changed', { id: result });
    return { id: result };
  }

  update(id: number, input: AccountingTransactionInput): void {
    requirePermission(this.context(), 'accounting.manage');
    const existing = this.db.prepare(`SELECT * FROM accounting_transactions WHERE id = ?`).get(id) as
      | {
          date: string;
          amount_paisa: number;
          direction: string;
          source_type: string;
          is_void: number;
          category_id: number;
          note: string;
          reference: string;
        }
      | undefined;
    if (!existing) throw AppError.notFound('Entry');
    if (fromBoolInt(existing.is_void)) throw AppError.precondition('A voided entry cannot be edited.');
    if (existing.source_type !== 'manual') {
      throw AppError.precondition(
        'This entry was created automatically from a payment or purchase. Amend the source record instead so both stay consistent.',
      );
    }
    this.validate(input);
    this.assertPeriodOpen(existing.date, 'change');
    this.assertPeriodOpen(input.date, 'change');
    const ctx = this.context();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE accounting_transactions SET direction = @direction, date = @date, category_id = @categoryId,
             amount_paisa = @amount, payment_method_id = @methodId, reference = @reference, note = @note, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          direction: input.direction,
          date: input.date,
          categoryId: input.categoryId,
          amount: Math.round(input.amountPaisa),
          methodId: input.paymentMethodId,
          reference: input.reference.trim(),
          note: input.note.trim(),
          updatedAt: ctx.instant(),
        });
      ctx.audit.record({
        action: 'update',
        entityType: 'accounting_transaction',
        entityId: id,
        detail: 'Accounting entry updated',
        severity: 'warning',
        before: { date: existing.date, amount: existing.amount_paisa, categoryId: existing.category_id, note: existing.note },
        after: { date: input.date, amount: input.amountPaisa, categoryId: input.categoryId, note: input.note.trim() },
      });
    })();
  }

  void(id: number, reason: string): void {
    requirePermission(this.context(), 'accounting.manage');
    if (reason.trim().length < 3) throw AppError.validation('Explain why the entry is being voided.', { reason: 'Reason is required.' });
    const existing = this.db
      .prepare(`SELECT date, amount_paisa, is_void, source_type FROM accounting_transactions WHERE id = ?`)
      .get(id) as { date: string; amount_paisa: number; is_void: number; source_type: string } | undefined;
    if (!existing) throw AppError.notFound('Entry');
    if (fromBoolInt(existing.is_void)) throw AppError.precondition('This entry is already void.');
    if (existing.source_type !== 'manual') {
      throw AppError.precondition('Automatic entries are voided by reversing their source record.');
    }
    this.assertPeriodOpen(existing.date, 'void');
    const ctx = this.context();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE accounting_transactions SET is_void = 1, void_reason =` + ` ?, voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?`,
        )
        .run(reason.trim(), ctx.instant(), currentUserId(ctx), ctx.instant(), id);
      ctx.audit.record({
        action: 'update',
        entityType: 'accounting_transaction',
        entityId: id,
        detail: `Accounting entry voided (${formatMoney(asNumber(existing.amount_paisa))}). Reason: ${reason.trim()}`,
        severity: 'warning',
        before: { amount: existing.amount_paisa },
        after: { voided: true, reason: reason.trim() },
      });
    })();
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'accounting.delete');
    const existing = this.db.prepare(`SELECT date, amount_paisa, source_type FROM accounting_transactions WHERE id = ?`).get(id) as
      | { date: string; amount_paisa: number; source_type: string }
      | undefined;
    if (!existing) throw AppError.notFound('Entry');
    if (existing.source_type !== 'manual') throw AppError.precondition('Automatic entries cannot be deleted.');
    if (confirmText?.trim() !== 'DELETE') {
      throw AppError.validation('Type DELETE to confirm removing this accounting entry.', { confirmText: 'Type DELETE to confirm.' });
    }
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason.', { reason: 'Reason is required.' });
    this.assertPeriodOpen(existing.date, 'delete');
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM accounting_transactions WHERE id = ?`).run(id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'accounting_transaction',
        entityId: id,
        detail: `Accounting entry deleted (${formatMoney(asNumber(existing.amount_paisa))}). Reason: ${reason.trim()}`,
        severity: 'critical',
        before: { date: existing.date, amount: existing.amount_paisa },
      });
    })();
  }

  private validate(input: AccountingTransactionInput): void {
    const fieldErrors: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fieldErrors.date = 'Select a valid date.';
    if (!Number.isFinite(input.amountPaisa) || Math.round(input.amountPaisa) <= 0) {
      fieldErrors.amountPaisa = 'Amount must be greater than zero.';
    }
    const category = this.db
      .prepare(`SELECT id, direction, is_active FROM accounting_categories` + ` WHERE id = ? AND deleted_at IS NULL`)
      .get(input.categoryId) as { id: number; direction: string; is_active: number } | undefined;
    if (!category) fieldErrors.categoryId = 'Select a category.';
    else if (category.direction !== input.direction) fieldErrors.categoryId = 'This category belongs to the other direction.';
    if (input.note.trim() === '' && input.reference.trim() === '') {
      fieldErrors.note = 'Add a short description or a reference.';
    }
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  // --- Automatic postings (called by payments and inventory) ---------------

  recordPaymentIncome(input: {
    paymentId: number;
    date: string;
    amountPaisa: number;
    methodId: number | null;
    reference: string;
    note: string;
  }): void {
    const categoryId = this.ensureCategory(deriveIncomeCategoryName('payment'), 'income');
    const existing = this.db
      .prepare(`SELECT id FROM accounting_transactions WHERE source_type = 'payment' AND source_id = ?`)
      .get(input.paymentId) as { id: number } | undefined;
    const now = this.context().instant();
    if (existing) {
      this.db
        .prepare(
          `UPDATE accounting_transactions SET direction = 'income', date = ?, category_id = ?, amount_paisa = ?,
             payment_method_id = ?, reference = ?, note = ?, is_void = 0, void_reason = '', voided_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.date, categoryId, Math.round(input.amountPaisa), input.methodId, input.reference, input.note, now, existing.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO accounting_transactions (direction, date, category_id, amount_paisa, payment_method_id, reference, note,
           source_type, source_id, created_by, created_at, updated_at)
         VALUES ('income', ?, ?, ?, ?, ?, ?, 'payment', ?, ?, ?, ?)`,
      )
      .run(
        input.date,
        categoryId,
        Math.round(input.amountPaisa),
        input.methodId,
        input.reference,
        input.note,
        input.paymentId,
        currentUserId(this.context()),
        now,
        now,
      );
  }

  updatePaymentIncome(paymentId: number, input: { date: string; amountPaisa: number; methodId: number | null; note: string }): void {
    this.db
      .prepare(
        `UPDATE accounting_transactions SET date = ?, amount_paisa = ?, payment_method_id = ?, note = ?, updated_at = ?
          WHERE source_type = 'payment' AND source_id = ?`,
      )
      .run(input.date, Math.round(input.amountPaisa), input.methodId, input.note, this.context().instant(), paymentId);
  }

  voidPaymentIncome(paymentId: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE accounting_transactions SET is_void = 1, void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ?
          WHERE source_type = 'payment' AND source_id = ?`,
      )
      .run(reason, this.context().instant(), currentUserId(this.context()), this.context().instant(), paymentId);
  }

  /** Purchase expenses posted from the inventory module. */
  recordPurchaseExpense(input: {
    purchaseId: number;
    date: string;
    amountPaisa: number;
    methodId: number | null;
    reference: string;
    note: string;
    categoryName: string;
  }): number {
    const categoryId = this.ensureCategory(input.categoryName, 'expense');
    const existing = this.db
      .prepare(`SELECT id FROM accounting_transactions WHERE source_type = 'purchase' AND source_id = ?`)
      .get(input.purchaseId) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE accounting_transactions SET date = ?, category_id = ?, amount_paisa = ?, payment_method_id = ?, reference = ?, note = ?,
             is_void = 0, void_reason = '', updated_at = ? WHERE id = ?`,
        )
        .run(
          input.date,
          categoryId,
          Math.round(input.amountPaisa),
          input.methodId,
          input.reference,
          input.note,
          this.context().instant(),
          existing.id,
        );
      return existing.id;
    }
    const result = this.db
      .prepare(
        `INSERT INTO accounting_transactions (direction, date, category_id, amount_paisa, payment_method_id, reference, note,
           source_type, source_id, created_by, created_at, updated_at)
         VALUES ('expense', ?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?)`,
      )
      .run(
        input.date,
        categoryId,
        Math.round(input.amountPaisa),
        input.methodId,
        input.reference,
        input.note,
        input.purchaseId,
        currentUserId(this.context()),
        this.context().instant(),
        this.context().instant(),
      );
    return Number(result.lastInsertRowid);
  }

  voidPurchaseExpense(purchaseId: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE accounting_transactions SET is_void = 1, void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ?
          WHERE source_type = 'purchase' AND source_id = ?`,
      )
      .run(reason, this.context().instant(), currentUserId(this.context()), this.context().instant(), purchaseId);
  }

  // --- Reports ------------------------------------------------------------

  summary(options: { preset?: string; from?: string; to?: string; direction?: AccountingDirection } = {}): AccountingSummary {
    requirePermission(this.context(), 'accounting.view');
    const range = resolveDateRange((options.preset ?? 'this_month') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'income' THEN amount_paisa ELSE 0 END),0) AS income,
                COALESCE(SUM(CASE WHEN direction = 'expense' THEN amount_paisa ELSE 0 END),0) AS expense
           FROM accounting_transactions WHERE is_void = 0 AND date BETWEEN ? AND ?`,
      )
      .get(range.from, range.to) as { income: number; expense: number };
    const collected = asNumber(
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(amount_paisa),0) AS total FROM payments WHERE is_void = 0 AND paid_date BETWEEN ? AND ?`)
          .get(range.from, range.to) as { total: number }
      ).total,
    );
    const outstanding = asNumber(
      (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(total_paisa - paid_paisa),0) AS due FROM invoices` +
              ` WHERE deleted_at IS NULL AND is_void = 0 AND total_paisa > paid_paisa`,
          )
          .get() as { due: number }
      ).due,
    );
    const byCategory = (
      this.db
        .prepare(
          `SELECT c.id AS category_id, c.name AS category_name, t.direction, SUM(t.amount_paisa) AS amount, COUNT(*) AS count
             FROM accounting_transactions t JOIN accounting_categories c ON c.id = t.category_id
            WHERE t.is_void = 0 AND t.date BETWEEN ? AND ?
            GROUP BY t.category_id ORDER BY amount DESC`,
        )
        .all(range.from, range.to) as Array<{
        category_id: number;
        category_name: string;
        direction: string;
        amount: number;
        count: number;
      }>
    ).map((row) => ({
      categoryId: row.category_id,
      categoryName: row.category_name,
      direction: row.direction as AccountingDirection,
      amountPaisa: asNumber(row.amount),
      count: asNumber(row.count),
    }));
    const byMonthRaw = this.db
      .prepare(
        `SELECT substr(date, 1, 7) AS month,
                COALESCE(SUM(CASE WHEN direction = 'income' THEN amount_paisa ELSE 0 END),0) AS income,
                COALESCE(SUM(CASE WHEN direction = 'expense' THEN amount_paisa ELSE 0 END),0) AS expense
           FROM accounting_transactions WHERE is_void = 0 AND date BETWEEN ? AND ?
          GROUP BY month ORDER BY month`,
      )
      .all(range.from, range.to) as Array<{ month: string; income: number; expense: number }>;
    const byMonth = byMonthRaw.map((row) => ({
      month: row.month,
      incomePaisa: asNumber(row.income),
      expensePaisa: asNumber(row.expense),
      netPaisa: asNumber(row.income) - asNumber(row.expense),
    }));
    const byMethod = (
      this.db
        .prepare(
          `SELECT t.payment_method_id AS method_id, COALESCE(m.name, 'Unspecified') AS method_name, SUM(t.amount_paisa) AS amount
             FROM accounting_transactions t LEFT JOIN payment_methods m ON m.id = t.payment_method_id
            WHERE t.is_void = 0 AND t.date BETWEEN ? AND ?
            GROUP BY t.payment_method_id ORDER BY amount DESC`,
        )
        .all(range.from, range.to) as Array<{ method_id: number | null; method_name: string; amount: number }>
    ).map((row) => ({ methodId: row.method_id, methodName: row.method_name, amountPaisa: asNumber(row.amount) }));

    return {
      range: { from: range.from, to: range.to },
      incomePaisa: asNumber(totals.income),
      expensePaisa: asNumber(totals.expense),
      netPaisa: asNumber(totals.income) - asNumber(totals.expense),
      collectedFromInvoicesPaisa: collected,
      outstandingPaisa: outstanding,
      byCategory,
      byMonth,
      byMethod,
    };
  }

  daybook(from: string, to: string): DaybookRow[] {
    requirePermission(this.context(), 'accounting.view');
    const rows = this.db
      .prepare(
        `SELECT date,
                COALESCE(SUM(CASE WHEN direction = 'income' THEN amount_paisa ELSE 0 END),0) AS income,
                COALESCE(SUM(CASE WHEN direction = 'expense' THEN amount_paisa ELSE 0 END),0) AS expense,
                COUNT(*) AS entries
           FROM accounting_transactions WHERE is_void = 0 AND date BETWEEN ? AND ?
          GROUP BY date ORDER BY date`,
      )
      .all(from, to) as Array<{ date: string; income: number; expense: number; entries: number }>;
    const opening = asNumber(
      (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN direction = 'income' THEN amount_paisa ELSE -amount_paisa END),0) AS balance
               FROM accounting_transactions WHERE is_void = 0 AND date < ?`,
          )
          .get(from) as { balance: number }
      ).balance,
    );
    let running = opening;
    return rows.map((row) => {
      const income = asNumber(row.income);
      const expense = asNumber(row.expense);
      const openingBalance = running;
      running += income - expense;
      return {
        date: row.date,
        openingPaisa: openingBalance,
        incomePaisa: income,
        expensePaisa: expense,
        closingPaisa: running,
        entries: asNumber(row.entries),
      };
    });
  }

  // --- Financial periods --------------------------------------------------

  periods(): FinancialPeriod[] {
    requirePermission(this.context(), 'accounting.view');
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT full_name FROM users u WHERE u.id = p.closed_by) AS closed_by_name,
                COALESCE((SELECT SUM(t.amount_paisa) FROM accounting_transactions t
                           WHERE t.is_void = 0 AND t.direction = 'income' AND t.date BETWEEN p.period_start AND p.period_end), 0) AS income,
                COALESCE((SELECT SUM(t.amount_paisa) FROM accounting_transactions t
                           WHERE t.is_void = 0 AND t.direction = 'expense'` +
          ` AND t.date BETWEEN p.period_start AND p.period_end), 0) AS expense
           FROM financial_periods p ORDER BY p.period_start DESC LIMIT 60`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asNumber(row['id']),
      label: asString(row['label']),
      periodStart: asString(row['period_start']),
      periodEnd: asString(row['period_end']),
      isClosed: fromBoolInt(row['is_closed']),
      closedAt: row['closed_at'] === null ? null : asString(row['closed_at']),
      closedByName: row['closed_by_name'] === null ? null : asString(row['closed_by_name']),
      notes: asString(row['notes']),
      incomePaisa: asNumber(row['income']),
      expensePaisa: asNumber(row['expense']),
    }));
  }

  closePeriod(input: { periodStart: string; periodEnd: string; notes: string }): { id: number } {
    requirePermission(this.context(), 'accounting.period.manage');
    if (input.periodStart > input.periodEnd) throw AppError.validation('The period start must be before its end.');
    const overlapping = this.db
      .prepare(`SELECT id FROM financial_periods WHERE period_start <= ? AND period_end >= ?`)
      .get(input.periodEnd, input.periodStart) as { id: number } | undefined;
    if (overlapping) throw AppError.conflict('A financial period already covers part of this range.');
    const ctx = this.context();
    const label = `${input.periodStart} → ${input.periodEnd}`;
    const result = this.db
      .prepare(
        `INSERT INTO financial_periods (label, period_start, period_end, is_closed, closed_at, closed_by, notes, created_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(label, input.periodStart, input.periodEnd, ctx.instant(), currentUserId(ctx), input.notes.trim(), ctx.instant());
    const id = Number(result.lastInsertRowid);
    ctx.audit.record({
      action: 'settings_change',
      entityType: 'financial_period',
      entityId: id,
      entityLabel: label,
      detail: 'Financial period closed — entries in this range can no longer be edited',
      severity: 'warning',
    });
    return { id };
  }

  reopenPeriod(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'accounting.period.manage');
    const period = this.db.prepare(`SELECT label, is_closed FROM financial_periods WHERE id = ?`).get(id) as
      | { label: string; is_closed: number }
      | undefined;
    if (!period) throw AppError.notFound('Financial period');
    if (!fromBoolInt(period.is_closed)) throw AppError.precondition('This period is already open.');
    if (confirmText?.trim() !== 'REOPEN') {
      throw AppError.validation('Type REOPEN to confirm reopening a closed financial period.', { confirmText: 'Type REOPEN to confirm.' });
    }
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for reopening the period.', { reason: 'Reason is required.' });
    const ctx = this.context();
    this.db
      .prepare(`UPDATE financial_periods SET is_closed = 0, notes = trim(notes || ?) WHERE id = ?`)
      .run(`\n[Reopened: ${reason.trim()}]`, id);
    ctx.audit.record({
      action: 'update',
      entityType: 'financial_period',
      entityId: id,
      entityLabel: period.label,
      detail: `Closed period reopened. Reason: ${reason.trim()}`,
      severity: 'critical',
    });
  }

  private assertPeriodOpen(date: string, action: string): void {
    const period = this.db
      .prepare(`SELECT label FROM financial_periods WHERE is_closed = 1 AND ? BETWEEN period_start AND period_end LIMIT 1`)
      .get(date) as { label: string } | undefined;
    if (period) {
      throw AppError.precondition(
        `The financial period ${period.label} is closed. Reopen it (with the` +
          ` permission to do so) before you ${action} an entry in that period.`,
      );
    }
  }

  /** Month buckets used by the charts on the accounting screen. */
  monthRange(monthsBack = 6, today: string): { from: string; to: string } {
    const start = startOfMonth(addMonths(today, -(monthsBack - 1)));
    return { from: start, to: endOfMonth(today) };
  }

  /** Convenience for the reporting layer: expenses within a range. */
  expenses(from: string, to: string): AccountingTransaction[] {
    return this.list({ from, to, direction: 'expense', pageSize: 500 }).items;
  }

  incomeWithin(from: string, to: string): { total: number; entries: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paisa),0) AS total, COUNT(*) AS entries FROM accounting_transactions
          WHERE is_void = 0 AND direction = 'income' AND date BETWEEN ? AND ?`,
      )
      .get(from, to) as { total: number; entries: number };
    return { total: asNumber(row.total), entries: asNumber(row.entries) };
  }

  /** Closing balance for a date (used by the daybook report). */
  balanceAsOf(date: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'income' THEN amount_paisa ELSE -amount_paisa END),0) AS balance
           FROM accounting_transactions WHERE is_void = 0 AND date <= ?`,
      )
      .get(date) as { balance: number };
    return asNumber(row.balance);
  }

  /** Ensures the seeded categories exist (called by the setup service). */
  seedCategories(incomeCategories: readonly string[], expenseCategories: readonly string[]): void {
    const run = this.db.transaction(() => {
      for (const name of incomeCategories) this.ensureCategory(name, 'income');
      for (const name of expenseCategories) this.ensureCategory(name, 'expense');
    });
    run();
  }

  /** Adds a day to a date (exposed for the recurring daybook queries in tests). */
  nextDay(date: string): string {
    return addDays(date, 1);
  }
}
