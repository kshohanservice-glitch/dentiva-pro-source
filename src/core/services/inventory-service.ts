/**
 * Inventory: consumables, stock movements and purchases.
 *
 * Quantities are stored in thousandths of a unit (`*_milli`) so a fraction of a
 * vial or a length of wire can be recorded exactly; the UI formats them back
 * with `formatQuantity`. Stock changes always go through a movement row, which
 * carries the resulting balance — the ledger is the source of truth and the
 * item's `current_stock_milli` is a cached total kept in step inside the same
 * transaction.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requireAnyPermission, requirePermission } from '../context';
import type {
  InventoryAlerts,
  InventoryItem,
  InventoryItemInput,
  InventoryPurchase,
  InventoryPurchaseInput,
  InventoryPurchaseItem,
  InventoryStats,
  Paged,
  StockMovement,
  StockMovementInput,
} from '@shared/types';
import type { InventoryUnit, StockMovementType } from '@shared/constants';
import { STOCK_DECREASE_TYPES, STOCK_INCREASE_TYPES } from '@shared/constants';
import { AppError } from '@shared/errors';
import { resolveDateRange, todayIso } from '@shared/dates';
import { formatMoney } from '@shared/money';
import { asNumber, asString, buildWhere, fromBoolInt, pageCount, paginate } from '../db/sql';
import { nextItemCode, nextPurchaseReference } from '../util/ids';
import type { AccountingService } from './accounting-service';
import type { SettingsService } from './settings-service';

/** Movement payload used internally (purchases and visit consumption). */
interface InternalMovementInput {
  type: StockMovementType;
  quantityMilli: number;
  unitCostPaisa: number | null;
  reason: string;
  reference: string;
  batchNumber?: string;
  expiryDate?: string | null;
  relatedPurchaseId?: number | null;
  relatedVisitId?: number | null;
}

interface ItemRow {
  id: number;
  code: string;
  name: string;
  category_id: number | null;
  category_name: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  unit: string;
  purchase_price_paisa: number;
  selling_price_paisa: number | null;
  current_stock_milli: number;
  minimum_stock_milli: number;
  reorder_level_milli: number;
  batch_number: string;
  expiry_date: string | null;
  purchase_date: string | null;
  storage_location: string;
  notes: string;
  is_active: number;
  created_at: string;
}

const ITEM_SELECT = `
  SELECT i.*, c.name AS category_name, s.name AS supplier_name
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON c.id = i.category_id
    LEFT JOIN suppliers s ON s.id = i.supplier_id
`;

export class InventoryService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly accounting: AccountingService,
    private readonly settings: SettingsService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  // --- Formatting helpers -------------------------------------------------

  /** 1500 → "1.5 pieces". */
  formatQuantity(milli: number, unit: InventoryUnit | string): string {
    const value = milli / 1000;
    const rounded = Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(value % 1 === 0 ? 0 : 3).replace(/0+$/, '').replace(/\.$/, '');
    const unitLabel = rounded === '1' || rounded === '-1' ? unit : `${unit}${unit.endsWith('s') ? '' : 's'}`;
    return `${rounded} ${unitLabel}`;
  }

  private signedQuantity(type: StockMovementType, quantityMilli: number): number {
    const magnitude = Math.abs(Math.round(quantityMilli));
    if (STOCK_INCREASE_TYPES.includes(type)) return magnitude;
    if (STOCK_DECREASE_TYPES.includes(type)) return -magnitude;
    throw AppError.validation(`Unknown stock movement type “${type}”.`);
  }

  // --- Items --------------------------------------------------------------

  private mapItem(row: ItemRow): InventoryItem {
    const settings = this.settings.getSettings();
    const today = this.context().today();
    const stock = asNumber(row.current_stock_milli);
    const minimum = asNumber(row.minimum_stock_milli);
    const reorder = asNumber(row.reorder_level_milli);
    const threshold = Math.max(minimum, Math.round(reorder * Math.max(0.1, settings.lowStockWarningFactor)));
    const expiry = row.expiry_date;
    const warningDate = (() => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + settings.expiryWarningDays);
      return date.toISOString().slice(0, 10);
    })();
    const unit = asString(row.unit, 'piece') as InventoryUnit;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      categoryId: row.category_id,
      categoryName: row.category_name ?? 'Uncategorised',
      supplierId: row.supplier_id,
      supplierName: row.supplier_name ?? '—',
      unit,
      purchasePricePaisa: asNumber(row.purchase_price_paisa),
      sellingPricePaisa: row.selling_price_paisa === null ? null : asNumber(row.selling_price_paisa),
      currentStockMilli: stock,
      currentStockText: this.formatQuantity(stock, unit),
      minimumStockMilli: minimum,
      reorderLevelMilli: reorder,
      batchNumber: row.batch_number,
      expiryDate: expiry,
      purchaseDate: row.purchase_date,
      storageLocation: row.storage_location,
      notes: row.notes,
      isActive: fromBoolInt(row.is_active),
      isLowStock: stock <= threshold,
      isExpiringSoon: expiry !== null && expiry >= today && expiry <= warningDate,
      isExpired: expiry !== null && expiry < today,
      stockValuePaisa: Math.round((stock / 1000) * asNumber(row.purchase_price_paisa)),
      createdAt: row.created_at,
    };
  }

  list(query: {
    page?: number;
    pageSize?: number;
    search?: string;
    categoryId?: number | null;
    supplierId?: number | null;
    lowStockOnly?: boolean;
    expiringOnly?: boolean;
    includeInactive?: boolean;
  } = {}): Paged<InventoryItem> {
    requirePermission(this.context(), 'inventory.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize ?? 50);
    const settings = this.settings.getSettings();
    const clauses: string[] = ['i.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (!query.includeInactive) clauses.push('i.is_active = 1');
    if (query.categoryId) {
      clauses.push('i.category_id = ?');
      params.push(query.categoryId);
    }
    if (query.supplierId) {
      clauses.push('i.supplier_id = ?');
      params.push(query.supplierId);
    }
    if (query.lowStockOnly) {
      clauses.push('i.current_stock_milli <= MAX(i.minimum_stock_milli, i.reorder_level_milli)');
    }
    if (query.expiringOnly) {
      clauses.push(`i.expiry_date IS NOT NULL AND i.expiry_date <= date(?, '+' || ? || ' days')`);
      params.push(this.context().today(), settings.expiryWarningDays);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(i.name LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\' OR i.batch_number LIKE ? ESCAPE '\\' OR i.storage_location LIKE ? ESCAPE '\\')`);
      params.push(term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM inventory_items i${where}`).get(...params) as { total: number }).total);
    const rows = this.db
      .prepare(`${ITEM_SELECT}${where} ORDER BY (i.current_stock_milli <= i.minimum_stock_milli) DESC, i.name LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ItemRow[];
    return { items: rows.map((row) => this.mapItem(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): InventoryItem {
    requirePermission(this.context(), 'inventory.view');
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`).get(id) as ItemRow | undefined;
    if (!row) throw AppError.notFound('Inventory item');
    return this.mapItem(row);
  }

  save(id: number | null, input: InventoryItemInput, openingStockMilli?: number): { id: number } {
    requireAnyPermission(this.context(), ['inventory.manage', 'inventory.adjust']);
    this.validate(input, id);
    const ctx = this.context();
    const now = ctx.instant();
    const itemId = this.db.transaction(() => {
      if (id) {
        const before = this.db.prepare(`SELECT * FROM inventory_items WHERE id = ? AND deleted_at IS NULL`).get(id) as ItemRow | undefined;
        if (!before) throw AppError.notFound('Inventory item');
        this.db
          .prepare(
            `UPDATE inventory_items SET code = @code, name = @name, category_id = @categoryId, supplier_id = @supplierId,
               unit = @unit, purchase_price_paisa = @purchasePrice, selling_price_paisa = @sellingPrice,
               minimum_stock_milli = @minimum, reorder_level_milli = @reorder, batch_number = @batch,
               expiry_date = @expiry, purchase_date = @purchaseDate, storage_location = @location, notes = @notes,
               is_active = @isActive, updated_at = @now
             WHERE id = @id`,
          )
          .run({
            id,
            code: input.code.trim(),
            name: input.name.trim(),
            categoryId: input.categoryId,
            supplierId: input.supplierId,
            unit: input.unit,
            purchasePrice: Math.round(input.purchasePricePaisa),
            sellingPrice: input.sellingPricePaisa === null ? null : Math.round(input.sellingPricePaisa),
            minimum: Math.round(input.minimumStockMilli),
            reorder: Math.round(input.reorderLevelMilli),
            batch: input.batchNumber.trim(),
            expiry: input.expiryDate,
            purchaseDate: input.purchaseDate,
            location: input.storageLocation.trim(),
            notes: input.notes.trim(),
            isActive: input.isActive ? 1 : 0,
            now,
          });
        ctx.audit.record({
          action: 'update',
          entityType: 'inventory_item',
          entityId: id,
          entityLabel: `${input.code.trim()} ${input.name.trim()}`,
          detail: 'Inventory item updated',
          before: { name: before.name, unit: before.unit, purchasePrice: before.purchase_price_paisa },
          after: { name: input.name.trim(), unit: input.unit, purchasePrice: Math.round(input.purchasePricePaisa) },
        });
        return id;
      }
      const code = input.code.trim() === '' ? nextItemCode(this.db) : input.code.trim();
      const inserted = this.db
        .prepare(
          `INSERT INTO inventory_items (code, name, category_id, supplier_id, unit, purchase_price_paisa, selling_price_paisa,
             current_stock_milli, minimum_stock_milli, reorder_level_milli, batch_number, expiry_date, purchase_date,
             storage_location, notes, is_active, created_at, updated_at)
           VALUES (@code, @name, @categoryId, @supplierId, @unit, @purchasePrice, @sellingPrice, 0, @minimum, @reorder,
             @batch, @expiry, @purchaseDate, @location, @notes, @isActive, @now, @now)`,
        )
        .run({
          code,
          name: input.name.trim(),
          categoryId: input.categoryId,
          supplierId: input.supplierId,
          unit: input.unit,
          purchasePrice: Math.round(input.purchasePricePaisa),
          sellingPrice: input.sellingPricePaisa === null ? null : Math.round(input.sellingPricePaisa),
          minimum: Math.round(input.minimumStockMilli),
          reorder: Math.round(input.reorderLevelMilli),
          batch: input.batchNumber.trim(),
          expiry: input.expiryDate,
          purchaseDate: input.purchaseDate,
          location: input.storageLocation.trim(),
          notes: input.notes.trim(),
          isActive: input.isActive ? 1 : 0,
          now,
        });
      const newId = Number(inserted.lastInsertRowid);
      ctx.audit.record({
        action: 'create',
        entityType: 'inventory_item',
        entityId: newId,
        entityLabel: `${code} ${input.name.trim()}`,
        detail: 'Inventory item created',
      });
      if (openingStockMilli !== undefined && openingStockMilli !== null && openingStockMilli !== 0) {
        this.applyMovementInternal(newId, {
          type: 'opening',
          quantityMilli: openingStockMilli,
          unitCostPaisa: Math.round(input.purchasePricePaisa),
          reason: 'Opening stock',
          reference: '',
          batchNumber: input.batchNumber.trim(),
          expiryDate: input.expiryDate,
        });
      }
      return newId;
    })();
    return { id: itemId };
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'inventory.manage');
    const row = this.db.prepare(`SELECT code, name FROM inventory_items WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { code: string; name: string }
      | undefined;
    if (!row) throw AppError.notFound('Inventory item');
    const label = `${row.code} ${row.name}`;
    if (confirmText?.trim() !== row.code) {
      throw AppError.validation(`Type the item code (${row.code}) to confirm deletion.`, { confirmText: `Type ${row.code} to confirm.` });
    }
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for removing this item.', { reason: 'Reason is required.' });
    const movements = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM stock_movements WHERE item_id = ?`).get(id) as { total: number }).total,
    );
    const ctx = this.context();
    this.db.transaction(() => {
      if (movements > 0) {
        this.db.prepare(`UPDATE inventory_items SET is_active = 0, updated_at = ? WHERE id = ?`).run(ctx.instant(), id);
        ctx.audit.record({
          action: 'update',
          entityType: 'inventory_item',
          entityId: id,
          entityLabel: label,
          detail: `Item deactivated — it has ${movements} stock movement(s). Reason: ${reason.trim()}`,
          severity: 'warning',
        });
      } else {
        this.db.prepare(`UPDATE inventory_items SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ctx.instant(), ctx.instant(), id);
        ctx.audit.record({
          action: 'delete',
          entityType: 'inventory_item',
          entityId: id,
          entityLabel: label,
          detail: `Inventory item deleted. Reason: ${reason.trim()}`,
          severity: 'critical',
        });
      }
    })();
  }

  options(): Array<{ value: number; label: string; meta: string }> {
    requirePermission(this.context(), 'inventory.view');
    const rows = this.db
      .prepare(
        `SELECT id, code, name, unit, current_stock_milli, purchase_price_paisa FROM inventory_items
          WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name`,
      )
      .all() as Array<{ id: number; code: string; name: string; unit: string; current_stock_milli: number; purchase_price_paisa: number }>;
    return rows.map((row) => ({
      value: row.id,
      label: row.name,
      meta: `${row.code} · ${this.formatQuantity(asNumber(row.current_stock_milli), row.unit)} · ${formatMoney(asNumber(row.purchase_price_paisa))}`,
    }));
  }

  // --- Movements ----------------------------------------------------------

  private mapMovement(row: Record<string, unknown>): StockMovement {
    const type = asString(row['type']) as StockMovementType;
    const quantity = asNumber(row['quantity_milli']);
    const unit = asString(row['unit'], 'piece') as InventoryUnit;
    return {
      id: asNumber(row['id']),
      itemId: asNumber(row['item_id']),
      itemName: asString(row['item_name']),
      itemCode: asString(row['item_code']),
      type,
      quantityMilli: quantity,
      quantityText: this.formatQuantity(quantity, unit),
      signedQuantityMilli: this.signedQuantity(type, quantity),
      balanceAfterMilli: asNumber(row['balance_after_milli']),
      unitCostPaisa: row['unit_cost_paisa'] === null ? null : asNumber(row['unit_cost_paisa']),
      reason: asString(row['reason']),
      reference: asString(row['reference']),
      relatedPurchaseId: row['related_purchase_id'] === null ? null : asNumber(row['related_purchase_id']),
      relatedVisitId: row['related_visit_id'] === null ? null : asNumber(row['related_visit_id']),
      movedAt: asString(row['moved_at']),
      movedDate: asString(row['moved_date']),
      movedByName: asString(row['moved_by_name'], '—'),
    };
  }

  movements(query: { page?: number; pageSize?: number; search?: string; itemId?: number; type?: string[]; preset?: string; from?: string; to?: string } = {}): Paged<StockMovement> {
    requirePermission(this.context(), 'inventory.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize ?? 50);
    const clauses: string[] = ['m.is_reversed = 0'];
    const params: unknown[] = [];
    if (query.itemId) {
      clauses.push('m.item_id = ?');
      params.push(query.itemId);
    }
    if (query.type && query.type.length > 0) {
      clauses.push(`m.type IN (${query.type.map(() => '?').join(', ')})`);
      params.push(...query.type);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(i.name LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\' OR m.reason LIKE ? ESCAPE '\\' OR m.reference LIKE ? ESCAPE '\\')`);
      params.push(term, term, term, term);
    }
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    if (preset || query.from || query.to) {
      const range = preset
        ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } })
        : { from: query.from ?? '1900-01-01', to: query.to ?? '2999-12-31' };
      clauses.push('m.moved_date BETWEEN ? AND ?');
      params.push(range.from, range.to);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id${where}`)
          .get(...params) as { total: number }
      ).total,
    );
    const rows = this.db
      .prepare(
        `SELECT m.*, i.name AS item_name, i.code AS item_code, i.unit AS unit,
                (SELECT full_name FROM users u WHERE u.id = m.moved_by) AS moved_by_name
           FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
           ${where}
          ORDER BY m.moved_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return { items: rows.map((row) => this.mapMovement(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  createMovement(input: StockMovementInput): { id: number; balanceAfterMilli: number } {
    requireAnyPermission(this.context(), ['inventory.adjust', 'inventory.manage']);
    const run = this.db.transaction(() => this.applyMovementInternal(input.itemId, input));
    return run();
  }

  /**
   * Reversing a movement never deletes history: a counter-entry is written and
   * the original is flagged, so the stock ledger still explains every unit.
   */
  deleteMovement(id: number, reason: string): void {
    requireAnyPermission(this.context(), ['inventory.adjust', 'inventory.manage']);
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for reversing this movement.', { reason: 'Reason is required.' });
    const movement = this.db.prepare(`SELECT * FROM stock_movements WHERE id = ?`).get(id) as
      | {
          id: number;
          item_id: number;
          type: string;
          quantity_milli: number;
          is_reversed: number;
          reason: string;
          related_purchase_id: number | null;
        }
      | undefined;
    if (!movement) throw AppError.notFound('Stock movement');
    if (fromBoolInt(movement.is_reversed)) throw AppError.precondition('This movement has already been reversed.');
    if (movement.type === 'opening') {
      throw AppError.precondition('Opening stock cannot be reversed — correct the item instead.');
    }
    if (movement.related_purchase_id !== null) {
      throw AppError.precondition('This movement came from a purchase. Reverse the purchase instead so the supplier record stays consistent.');
    }
    const ctx = this.context();
    this.db.transaction(() => {
      const opposite: StockMovementInput = {
        itemId: movement.item_id,
        type: STOCK_INCREASE_TYPES.includes(movement.type as StockMovementType) ? 'adjustment_out' : 'adjustment_in',
        quantityMilli: Math.abs(asNumber(movement.quantity_milli)),
        unitCostPaisa: null,
        reason: `Reversal of movement #${movement.id}: ${reason.trim()}`,
        reference: '',
      };
      const applied = this.applyMovementInternal(movement.item_id, opposite);
      this.db.prepare(`UPDATE stock_movements SET is_reversed = 1, reversed_by_id = ? WHERE id = ?`).run(applied.id, id);
      ctx.audit.record({
        action: 'update',
        entityType: 'stock_movement',
        entityId: id,
        entityLabel: `Movement #${id}`,
        detail: `Stock movement reversed by #${applied.id}. Reason: ${reason.trim()}`,
        severity: 'warning',
        before: { type: movement.type, quantityMilli: asNumber(movement.quantity_milli), reason: movement.reason },
      });
    })();
  }

  private applyMovementInternal(
    itemId: number,
    input: StockMovementInput | InternalMovementInput,
  ): { id: number; balanceAfterMilli: number } {
    const ctx = this.context();
    const item = this.db.prepare(`SELECT id, name, code, unit, current_stock_milli FROM inventory_items WHERE id = ? AND deleted_at IS NULL`).get(itemId) as
      | { id: number; name: string; code: string; unit: string; current_stock_milli: number }
      | undefined;
    if (!item) throw AppError.notFound('Inventory item');
    const delta = this.signedQuantity(input.type, input.quantityMilli);
    if (delta === 0) throw AppError.validation('Enter a quantity greater than zero.', { quantityMilli: 'Quantity must be greater than zero.' });
    if (input.type === 'adjustment_in' || input.type === 'adjustment_out') {
      if ((input.reason ?? '').trim().length < 3) {
        throw AppError.validation('Stock adjustments need a reason.', { reason: 'Reason is required.' });
      }
    }
    const balanceBefore = asNumber(item.current_stock_milli);
    const balanceAfter = balanceBefore + delta;
    if (balanceAfter < 0) {
      throw AppError.precondition(
        `Only ${this.formatQuantity(balanceBefore, item.unit)} of ${item.name} is in stock — this movement would make it negative.`,
      );
    }
    const today = ctx.today();
    const inserted = this.db
      .prepare(
        `INSERT INTO stock_movements (item_id, type, quantity_milli, balance_after_milli, unit_cost_paisa, reason, reference,
           related_purchase_id, related_visit_id, batch_number, expiry_date, moved_at, moved_date, moved_by, created_at, is_reversed)
         VALUES (@itemId, @type, @quantity, @balanceAfter, @unitCost, @reason, @reference, @purchaseId, @visitId, @batch, @expiry,
           @movedAt, @movedDate, @movedBy, @createdAt, 0)`,
      )
      .run({
        itemId,
        type: input.type,
        quantity: Math.abs(Math.round(input.quantityMilli)),
        balanceAfter,
        unitCost: input.unitCostPaisa === null ? null : Math.round(input.unitCostPaisa),
        reason: (input.reason ?? '').trim(),
        reference: (input.reference ?? '').trim(),
        purchaseId: (input as InternalMovementInput).relatedPurchaseId ?? null,
        visitId: (input as InternalMovementInput).relatedVisitId ?? null,
        batch: (input.batchNumber ?? '').trim(),
        expiry: input.expiryDate ?? null,
        movedAt: ctx.instant(),
        movedDate: today,
        movedBy: currentUserId(ctx),
        createdAt: ctx.instant(),
      });
    const id = Number(inserted.lastInsertRowid);
    this.db
      .prepare(`UPDATE inventory_items SET current_stock_milli = ?, expiry_date = COALESCE(?, expiry_date), updated_at = ? WHERE id = ?`)
      .run(balanceAfter, input.expiryDate ?? null, ctx.instant(), itemId);
    ctx.audit.record({
      action: 'update',
      entityType: 'stock_movement',
      entityId: id,
      entityLabel: `${item.code} ${item.name}`,
      detail: `Stock ${delta > 0 ? 'increased' : 'decreased'} by ${this.formatQuantity(Math.abs(delta), item.unit)} (${input.type})${(input.reason ?? '').trim() ? `: ${(input.reason ?? '').trim()}` : ''}`,
      after: { balanceAfterMilli: balanceAfter, type: input.type, quantityMilli: Math.abs(Math.round(input.quantityMilli)) },
    });
    return { id, balanceAfterMilli: balanceAfter };
  }

  /** Consume supplies against a visit (called from the visit screen). */
  consumeForVisit(visitId: number, items: Array<{ itemId: number; quantityMilli: number; note: string }>): void {
    requirePermission(this.context(), 'inventory.adjust');
    const visit = this.db.prepare(`SELECT id, visit_date, patient_id FROM visits WHERE id = ? AND deleted_at IS NULL`).get(visitId) as
      | { id: number; visit_date: string; patient_id: number }
      | undefined;
    if (!visit) throw AppError.notFound('Visit');
    if (items.length === 0) throw AppError.validation('Add at least one item to consume.');
    this.db.transaction(() => {
      for (const entry of items) {
        if (entry.quantityMilli <= 0) throw AppError.validation('Consumed quantities must be greater than zero.');
        const applied = this.applyMovementInternal(entry.itemId, {
          type: 'consumption',
          quantityMilli: entry.quantityMilli,
          unitCostPaisa: null,
          reason: entry.note.trim() === '' ? `Consumed during visit #${visitId}` : entry.note.trim(),
          reference: `Visit #${visitId}`,
          relatedVisitId: visitId,
        });
        this.db.prepare(`UPDATE stock_movements SET related_visit_id = ? WHERE id = ?`).run(visitId, applied.id);
      }
      this.context().audit.record({
        action: 'update',
        entityType: 'inventory_consumption',
        entityId: visitId,
        entityLabel: `Visit #${visitId}`,
        detail: `Consumed ${items.length} inventory item(s) during the visit`,
      });
    })();
  }

  // --- Purchases ----------------------------------------------------------

  private mapPurchase(row: Record<string, unknown>, items: InventoryPurchaseItem[]): InventoryPurchase {
    return {
      id: asNumber(row['id']),
      reference: asString(row['reference']),
      supplierId: row['supplier_id'] === null ? null : asNumber(row['supplier_id']),
      supplierName: asString(row['supplier_name'], '—'),
      date: asString(row['date']),
      invoiceNumber: asString(row['invoice_number']),
      subtotalPaisa: asNumber(row['subtotal_paisa']),
      discountPaisa: asNumber(row['discount_paisa']),
      totalPaisa: asNumber(row['total_paisa']),
      paidPaisa: asNumber(row['paid_paisa']),
      paymentMethodId: row['payment_method_id'] === null ? null : asNumber(row['payment_method_id']),
      paymentMethodName: asString(row['method_name'], '—'),
      notes: asString(row['notes']),
      createdByName: asString(row['created_by_name'], '—'),
      createdAt: asString(row['created_at']),
      itemCount: items.length,
      items,
    };
  }

  purchases(query: { page?: number; pageSize?: number; search?: string; supplierId?: number | null; preset?: string; from?: string; to?: string } = {}): Paged<InventoryPurchase> {
    requirePermission(this.context(), 'inventory.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize ?? 50);
    const clauses: string[] = ['p.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.supplierId) {
      clauses.push('p.supplier_id = ?');
      params.push(query.supplierId);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(p.reference LIKE ? ESCAPE '\\' OR p.invoice_number LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')`);
      params.push(term, term, term);
    }
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    if (preset || query.from || query.to) {
      const range = preset
        ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } })
        : { from: query.from ?? '1900-01-01', to: query.to ?? '2999-12-31' };
      clauses.push('p.date BETWEEN ? AND ?');
      params.push(range.from, range.to);
    }
    const where = buildWhere(clauses);
    const total = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM inventory_purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id${where}`)
          .get(...params) as { total: number }
      ).total,
    );
    const rows = this.db
      .prepare(
        `SELECT p.*, s.name AS supplier_name, m.name AS method_name,
                (SELECT full_name FROM users u WHERE u.id = p.created_by) AS created_by_name
           FROM inventory_purchases p
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           LEFT JOIN payment_methods m ON m.id = p.payment_method_id
           ${where}
          ORDER BY p.date DESC, p.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => this.mapPurchase(row, this.purchaseItems(asNumber(row['id'])))),
      total,
      page,
      pageSize,
      pageCount: pageCount(total, pageSize),
    };
  }

  private purchaseItems(purchaseId: number): InventoryPurchaseItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM inventory_purchase_items WHERE purchase_id = ? ORDER BY id`)
      .all(purchaseId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const itemId = row['item_id'] === null ? null : asNumber(row['item_id']);
      const unit = itemId ? this.itemUnit(itemId) : 'piece';
      return {
        id: asNumber(row['id']),
        purchaseId: asNumber(row['purchase_id']),
        itemId,
        itemName: asString(row['item_name']),
        quantityMilli: asNumber(row['quantity_milli']),
        quantityText: this.formatQuantity(asNumber(row['quantity_milli']), unit),
        unitPricePaisa: asNumber(row['unit_price_paisa']),
        totalPaisa: asNumber(row['total_paisa']),
        batchNumber: asString(row['batch_number']),
        expiryDate: row['expiry_date'] === null ? null : asString(row['expiry_date']),
      };
    });
  }

  private itemUnit(itemId: number): InventoryUnit {
    const row = this.db.prepare(`SELECT unit FROM inventory_items WHERE id = ?`).get(itemId) as { unit: string } | undefined;
    return (row?.unit ?? 'piece') as InventoryUnit;
  }

  purchase(id: number): InventoryPurchase {
    requirePermission(this.context(), 'inventory.view');
    const row = this.db
      .prepare(
        `SELECT p.*, s.name AS supplier_name, m.name AS method_name,
                (SELECT full_name FROM users u WHERE u.id = p.created_by) AS created_by_name
           FROM inventory_purchases p
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           LEFT JOIN payment_methods m ON m.id = p.payment_method_id
          WHERE p.id = ? AND p.deleted_at IS NULL`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw AppError.notFound('Purchase');
    return this.mapPurchase(row, this.purchaseItems(id));
  }

  createPurchase(input: InventoryPurchaseInput): { id: number; reference: string } {
    requirePermission(this.context(), 'inventory.manage');
    this.validatePurchase(input);
    const ctx = this.context();
    const result = this.db.transaction(() => {
      const reference = nextPurchaseReference(this.db, input.date);
      const subtotalPaisa = Math.round(
        input.items.reduce((sum, item) => sum + (Math.round(item.quantityMilli) * Math.round(item.unitPricePaisa)) / 1000, 0),
      );
      const discount = Math.min(Math.max(0, Math.round(input.discountPaisa)), subtotalPaisa);
      const total = Math.max(0, subtotalPaisa - discount);
      const paid = Math.min(Math.max(0, Math.round(input.paidPaisa)), total);
      const inserted = this.db
        .prepare(
          `INSERT INTO inventory_purchases (reference, supplier_id, date, invoice_number, subtotal_paisa, discount_paisa,
             total_paisa, paid_paisa, payment_method_id, notes, created_by, created_at, updated_at)
           VALUES (@reference, @supplierId, @date, @invoiceNumber, @subtotal, @discount, @total, @paid, @methodId, @notes, @createdBy, @now, @now)`,
        )
        .run({
          reference,
          supplierId: input.supplierId,
          date: input.date,
          invoiceNumber: input.invoiceNumber.trim(),
          subtotal: subtotalPaisa,
          discount,
          total,
          paid,
          methodId: input.paymentMethodId,
          notes: input.notes.trim(),
          createdBy: currentUserId(ctx),
          now: ctx.instant(),
        });
      const purchaseId = Number(inserted.lastInsertRowid);

      const insertItem = this.db.prepare(
        `INSERT INTO inventory_purchase_items (purchase_id, item_id, item_name, quantity_milli, unit_price_paisa, total_paisa, batch_number, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const line of input.items) {
        let itemId = line.itemId;
        if (itemId === null) {
          if (!line.createItemIfMissing) {
            throw AppError.validation(`Choose a stock item for “${line.itemName}” or allow creating it.`, { items: 'Unknown item.' });
          }
          const code = nextItemCode(this.db);
          const createdItem = this.db
            .prepare(
              `INSERT INTO inventory_items (code, name, category_id, supplier_id, unit, purchase_price_paisa, selling_price_paisa,
                 current_stock_milli, minimum_stock_milli, reorder_level_milli, batch_number, expiry_date, purchase_date,
                 storage_location, notes, is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, ?, ?, ?, '', '', 1, ?, ?)`,
            )
            .run(
              code,
              line.itemName.trim(),
              line.categoryId ?? null,
              input.supplierId,
              line.unit,
              Math.round(line.unitPricePaisa),
              line.batchNumber.trim(),
              line.expiryDate,
              input.date,
              ctx.instant(),
              ctx.instant(),
            );
          itemId = Number(createdItem.lastInsertRowid);
          ctx.audit.record({
            action: 'create',
            entityType: 'inventory_item',
            entityId: itemId,
            entityLabel: `${code} ${line.itemName.trim()}`,
            detail: 'Item created automatically from a purchase',
          });
        }
        const quantity = Math.max(1, Math.round(line.quantityMilli));
        const lineTotal = Math.round((quantity * Math.round(line.unitPricePaisa)) / 1000);
        insertItem.run(
          purchaseId,
          itemId,
          line.itemName.trim(),
          quantity,
          Math.round(line.unitPricePaisa),
          lineTotal,
          line.batchNumber.trim(),
          line.expiryDate,
        );
        const applied = this.applyMovementInternal(itemId, {
          type: 'purchase',
          quantityMilli: quantity,
          unitCostPaisa: Math.round(line.unitPricePaisa),
          reason: `Purchase ${reference}${line.batchNumber.trim() ? ` (batch ${line.batchNumber.trim()})` : ''}`,
          reference,
          batchNumber: line.batchNumber.trim(),
          expiryDate: line.expiryDate,
        });
        this.db.prepare(`UPDATE stock_movements SET related_purchase_id = ? WHERE id = ?`).run(purchaseId, applied.id);
        this.db
          .prepare(`UPDATE inventory_items SET purchase_price_paisa = ?, purchase_date = ?, supplier_id = COALESCE(supplier_id, ?), updated_at = ? WHERE id = ?`)
          .run(Math.round(line.unitPricePaisa), input.date, input.supplierId, ctx.instant(), itemId);
      }

      if (input.recordAsExpense && total > 0) {
        const transactionId = this.accounting.recordPurchaseExpense({
          purchaseId,
          date: input.date,
          amountPaisa: total,
          methodId: input.paymentMethodId,
          reference,
          note: `Stock purchase${input.invoiceNumber.trim() ? ` (invoice ${input.invoiceNumber.trim()})` : ''}`,
          categoryName: 'Dental supplies',
        });
        this.db.prepare(`UPDATE inventory_purchases SET accounting_transaction_id = ? WHERE id = ?`).run(transactionId, purchaseId);
      }

      ctx.audit.record({
        action: 'create',
        entityType: 'inventory_purchase',
        entityId: purchaseId,
        entityLabel: reference,
        detail: `Purchase recorded: ${input.items.length} line(s), ${formatMoney(total)}`,
        after: { reference, totalPaisa: total, paidPaisa: paid, supplierId: input.supplierId },
      });
      return { id: purchaseId, reference };
    })();
    ctx.notify?.('inventory.changed', { id: result.id });
    return result;
  }

  /** Reverse every movement of a purchase, void the expense and soft-delete it. */
  deletePurchase(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'inventory.manage');
    const purchase = this.db.prepare(`SELECT reference FROM inventory_purchases WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { reference: string }
      | undefined;
    if (!purchase) throw AppError.notFound('Purchase');
    if (confirmText?.trim() !== purchase.reference) {
      throw AppError.validation(`Type the reference (${purchase.reference}) to confirm.`, { confirmText: `Type ${purchase.reference} to confirm.` });
    }
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for deleting this purchase.', { reason: 'Reason is required.' });
    const ctx = this.context();
    this.db.transaction(() => {
      const movements = this.db
        .prepare(`SELECT id, item_id, quantity_milli FROM stock_movements WHERE related_purchase_id = ? AND is_reversed = 0`)
        .all(id) as Array<{ id: number; item_id: number; quantity_milli: number }>;
      for (const movement of movements) {
        const item = this.db.prepare(`SELECT current_stock_milli FROM inventory_items WHERE id = ?`).get(movement.item_id) as
          | { current_stock_milli: number }
          | undefined;
        if (!item) continue;
        const delta = -Math.abs(asNumber(movement.quantity_milli));
        const balanceAfter = asNumber(item.current_stock_milli) + delta;
        if (balanceAfter < 0) {
          throw AppError.precondition(
            'Some of this stock has already been used, so the purchase cannot be reversed. Record an adjustment instead.',
          );
        }
        const reversal = this.db
          .prepare(
            `INSERT INTO stock_movements (item_id, type, quantity_milli, balance_after_milli, unit_cost_paisa, reason, reference,
               related_purchase_id, batch_number, expiry_date, moved_at, moved_date, moved_by, created_at, is_reversed)
             SELECT item_id, 'return_out', quantity_milli, ?, unit_cost_paisa, ?, reference, related_purchase_id, batch_number,
                    expiry_date, ?, ?, ?, ?, 0 FROM stock_movements WHERE id = ?`,
          )
          .run(balanceAfter, `Reversal of purchase ${purchase.reference}: ${reason.trim()}`, ctx.instant(), ctx.today(), currentUserId(ctx), ctx.instant(), movement.id);
        this.db.prepare(`UPDATE stock_movements SET is_reversed = 1, reversed_by_id = ? WHERE id = ?`).run(Number(reversal.lastInsertRowid), movement.id);
        this.db.prepare(`UPDATE inventory_items SET current_stock_milli = ?, updated_at = ? WHERE id = ?`).run(balanceAfter, ctx.instant(), movement.item_id);
      }
      this.accounting.voidPurchaseExpense(id, `Purchase ${purchase.reference} deleted: ${reason.trim()}`);
      this.db.prepare(`UPDATE inventory_purchases SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ctx.instant(), ctx.instant(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'inventory_purchase',
        entityId: id,
        entityLabel: purchase.reference,
        detail: `Purchase deleted and stock reversed. Reason: ${reason.trim()}`,
        severity: 'critical',
      });
    })();
    ctx.notify?.('inventory.changed', { id });
  }

  private validate(input: InventoryItemInput, existingId: number | null): void {
    const fieldErrors: Record<string, string> = {};
    if (input.name.trim().length < 2) fieldErrors['name'] = 'Enter the item name.';
    if (input.code.trim() !== '' && !/^[A-Za-z0-9._-]{2,24}$/.test(input.code.trim())) {
      fieldErrors['code'] = 'Use 2–24 letters, numbers, dots, hyphens or underscores.';
    }
    if (!Number.isFinite(input.purchasePricePaisa) || input.purchasePricePaisa < 0) fieldErrors['purchasePricePaisa'] = 'Enter a valid purchase price.';
    if (input.sellingPricePaisa !== null && (input.sellingPricePaisa < 0 || !Number.isFinite(input.sellingPricePaisa))) {
      fieldErrors['sellingPricePaisa'] = 'Enter a valid selling price.';
    }
    if (input.minimumStockMilli < 0 || !Number.isFinite(input.minimumStockMilli)) fieldErrors['minimumStockMilli'] = 'Minimum stock cannot be negative.';
    if (input.reorderLevelMilli < 0 || !Number.isFinite(input.reorderLevelMilli)) fieldErrors['reorderLevelMilli'] = 'Reorder level cannot be negative.';
    if (input.expiryDate && input.purchaseDate && input.expiryDate < input.purchaseDate) {
      fieldErrors['expiryDate'] = 'Expiry cannot be before the purchase date.';
    }
    if (input.code.trim() !== '') {
      const duplicate = this.db
        .prepare(`SELECT id FROM inventory_items WHERE lower(code) = lower(?) AND deleted_at IS NULL${existingId ? ' AND id <> ?' : ''}`)
        .get(...(existingId ? [input.code.trim(), existingId] : [input.code.trim()])) as { id: number } | undefined;
      if (duplicate) fieldErrors['code'] = 'That item code is already used.';
    }
    if (input.categoryId !== null) {
      const category = this.db.prepare(`SELECT id FROM inventory_categories WHERE id = ? AND deleted_at IS NULL`).get(input.categoryId);
      if (!category) fieldErrors['categoryId'] = 'Select a valid category.';
    }
    if (input.supplierId !== null) {
      const supplier = this.db.prepare(`SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL`).get(input.supplierId);
      if (!supplier) fieldErrors['supplierId'] = 'Select a valid supplier.';
    }
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  private validatePurchase(input: InventoryPurchaseInput): void {
    const fieldErrors: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fieldErrors['date'] = 'Select a valid date.';
    if (input.date > this.context().today()) fieldErrors['date'] = 'The purchase date cannot be in the future.';
    if (input.items.length === 0) fieldErrors['items'] = 'Add at least one line.';
    input.items.forEach((line, index) => {
      if (line.itemId === null && line.itemName.trim() === '') fieldErrors[`item-${index}`] = 'Choose an item or type its name.';
      if (!Number.isFinite(line.quantityMilli) || Math.round(line.quantityMilli) <= 0) fieldErrors[`item-${index}`] = 'Quantity must be greater than zero.';
      if (!Number.isFinite(line.unitPricePaisa) || Math.round(line.unitPricePaisa) < 0) fieldErrors[`item-${index}`] = 'Enter a valid unit price.';
    });
    if (input.discountPaisa < 0) fieldErrors['discountPaisa'] = 'Discount cannot be negative.';
    if (input.paidPaisa < 0) fieldErrors['paidPaisa'] = 'Paid amount cannot be negative.';
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  // --- Alerts & statistics ------------------------------------------------

  alerts(limit = 50): InventoryAlerts {
    requirePermission(this.context(), 'inventory.view');
    const all = this.list({ pageSize: 500, includeInactive: false }).items;
    return {
      lowStock: all.filter((item) => item.isLowStock).slice(0, limit),
      expiringSoon: all.filter((item) => item.isExpiringSoon).slice(0, limit),
      expired: all.filter((item) => item.isExpired).slice(0, limit),
    };
  }

  lowStockCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM inventory_items
          WHERE deleted_at IS NULL AND is_active = 1 AND current_stock_milli <= MAX(minimum_stock_milli, reorder_level_milli)`,
      )
      .get() as { total: number };
    return asNumber(row.total);
  }

  statistics(options: { preset?: string; from?: string; to?: string } = {}): InventoryStats {
    requirePermission(this.context(), 'inventory.view');
    const range = resolveDateRange((options.preset ?? 'this_month') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const items = this.list({ pageSize: 500, includeInactive: true }).items;
    const stockValuePaisa = items.reduce((sum, item) => sum + item.stockValuePaisa, 0);
    const purchaseRow = this.db
      .prepare(`SELECT COALESCE(SUM(total_paisa), 0) AS total FROM inventory_purchases WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`)
      .get(range.from, range.to) as { total: number };
    const consumptionRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(ABS(m.quantity_milli) * COALESCE(m.unit_cost_paisa, i.purchase_price_paisa, 0)), 0) / 1000 AS value
           FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
          WHERE m.type = 'consumption' AND m.is_reversed = 0 AND m.moved_date BETWEEN ? AND ?`,
      )
      .get(range.from, range.to) as { value: number };
    const topConsumed = this.db
      .prepare(
        `SELECT m.item_id, i.name AS item_name, i.unit AS unit, SUM(ABS(m.quantity_milli)) AS quantity,
                SUM(ABS(m.quantity_milli) * COALESCE(m.unit_cost_paisa, i.purchase_price_paisa, 0)) / 1000 AS value
           FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
          WHERE m.type = 'consumption' AND m.is_reversed = 0 AND m.moved_date BETWEEN ? AND ?
          GROUP BY m.item_id ORDER BY quantity DESC LIMIT 10`,
      )
      .all(range.from, range.to) as Array<{ item_id: number; item_name: string; unit: string; quantity: number; value: number }>;
    return {
      range: { from: range.from, to: range.to },
      stockValuePaisa,
      itemCount: items.length,
      lowStockCount: items.filter((item) => item.isLowStock).length,
      expiredCount: items.filter((item) => item.isExpired).length,
      expiringSoonCount: items.filter((item) => item.isExpiringSoon).length,
      purchaseTotalPaisa: asNumber(purchaseRow.total),
      consumptionValuePaisa: asNumber(consumptionRow.value),
      topConsumed: topConsumed.map((row) => ({
        itemId: row.item_id,
        itemName: row.item_name,
        quantityMilli: asNumber(row.quantity),
        quantityText: this.formatQuantity(asNumber(row.quantity), row.unit),
        valuePaisa: asNumber(row.value),
      })),
    };
  }

  /** Items expiring within the warning window (used by the notification centre). */
  expiringItems(days: number): InventoryItem[] {
    const today = this.context().today();
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() + Math.max(1, days));
    const rows = this.db
      .prepare(`${ITEM_SELECT} WHERE i.deleted_at IS NULL AND i.is_active = 1 AND i.expiry_date IS NOT NULL AND i.expiry_date <= ? ORDER BY i.expiry_date`)
      .all(limit.toISOString().slice(0, 10)) as ItemRow[];
    return rows.map((row) => this.mapItem(row));
  }

  /** Total stock value for the dashboard tile. */
  totalStockValuePaisa(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(current_stock_milli * purchase_price_paisa / 1000), 0) AS value FROM inventory_items WHERE deleted_at IS NULL AND is_active = 1`)
      .get() as { value: number };
    return Math.round(asNumber(row.value));
  }

  /** Count of distinct items, for the data summary. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM inventory_items WHERE deleted_at IS NULL`).get() as { total: number };
    return asNumber(row.total);
  }

  /** Recent movements for the dashboard activity list. */
  recentMovements(limit = 5): StockMovement[] {
    requirePermission(this.context(), 'inventory.view');
    return this.movements({ pageSize: limit }).items;
  }

  /** Supplier options for the purchase form. */
  suppliers(): Array<{ id: number; name: string; contactPerson: string; phone: string }> {
    requirePermission(this.context(), 'inventory.view');
    const rows = this.db
      .prepare(`SELECT id, name, contact_person, phone FROM suppliers WHERE deleted_at IS NULL ORDER BY name`)
      .all() as Array<{ id: number; name: string; contact_person: string; phone: string }>;
    return rows.map((row) => ({ id: row.id, name: row.name, contactPerson: row.contact_person, phone: row.phone }));
  }

  /** Category names for pickers. */
  categories(): Array<{ id: number; name: string }> {
    requirePermission(this.context(), 'inventory.view');
    return this.db.prepare(`SELECT id, name FROM inventory_categories WHERE deleted_at IS NULL ORDER BY name`).all() as Array<{
      id: number;
      name: string;
    }>;
  }

  /** Are there movements for this item? (delete vs deactivate decision) */
  movementCount(itemId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM stock_movements WHERE item_id = ?`).get(itemId) as { total: number };
    return asNumber(row.total);
  }

  /** Current quantity text for a stock line (used by the visit screen). */
  stockText(itemId: number): string {
    const row = this.db.prepare(`SELECT current_stock_milli, unit FROM inventory_items WHERE id = ?`).get(itemId) as
      | { current_stock_milli: number; unit: string }
      | undefined;
    if (!row) return '—';
    return this.formatQuantity(asNumber(row.current_stock_milli), row.unit as InventoryUnit);
  }

  /** Moves recorded for a visit (shown on the visit detail). */
  movementsForVisit(visitId: number): StockMovement[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, i.name AS item_name, i.code AS item_code, i.unit AS unit,
                (SELECT full_name FROM users u WHERE u.id = m.moved_by) AS moved_by_name
           FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
          WHERE m.related_visit_id = ? ORDER BY m.id`,
      )
      .all(visitId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapMovement(row));
  }

  /** Value of stock consumed on a given date (used by the daily report). */
  consumptionValueOn(date: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(ABS(quantity_milli) * COALESCE(unit_cost_paisa, 0)), 0) / 1000 AS value
           FROM stock_movements WHERE type = 'consumption' AND is_reversed = 0 AND moved_date = ?`,
      )
      .get(date) as { value: number };
    return Math.round(asNumber(row.value));
  }

  /** Items list for CSV export. */
  exportRows(from: string | null, to: string | null): Array<Record<string, string>> {
    const rows = this.list({ pageSize: 500, includeInactive: true }).items;
    void from;
    void to;
    return rows.map((item) => ({
      Code: item.code,
      Name: item.name,
      Category: item.categoryName,
      Supplier: item.supplierName,
      Unit: item.unit,
      'Current stock': item.currentStockText,
      'Minimum stock': this.formatQuantity(item.minimumStockMilli, item.unit),
      'Purchase price': formatMoney(item.purchasePricePaisa),
      'Stock value': formatMoney(item.stockValuePaisa),
      Batch: item.batchNumber,
      Expiry: item.expiryDate ?? '',
      Location: item.storageLocation,
      Active: item.isActive ? 'Yes' : 'No',
    }));
  }

  /** Supplier/category counts for the data summary screen. */
  summaryCounts(): { items: number; movements: number; purchases: number; suppliers: number; categories: number } {
    const count = (table: string, where = 'deleted_at IS NULL'): number =>
      asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`).get() as { total: number }).total);
    return {
      items: count('inventory_items'),
      movements: count('stock_movements'),
      purchases: count('inventory_purchases'),
      suppliers: count('suppliers'),
      categories: count('inventory_categories'),
    };
  }

}
