/**
 * Generic master-data resources.
 *
 * Eleven simple catalogs (tags, medications, clinical options, payment methods,
 * inventory categories, suppliers, accounting categories, referral doctors,
 * printer profiles, print templates, treatments) share one CRUD surface so the
 * settings screens can be driven by a single table component. Where a service
 * already owns a catalog (medications, clinical options, patient tags) the work
 * is delegated so the business rules live in exactly one place.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { requirePermission } from '../context';
import { AppError } from '@shared/errors';
import { nowInstant } from '@shared/dates';
import { asNumber, asString, buildWhere, likeTerm, pageCount, paginate } from '../db/sql';
import type { Paged } from '@shared/types';
import type { ResourceInput, ResourceName } from '@shared/api';
import type { PrescriptionService } from './prescription-service';
import type { PatientService } from './patient-service';

interface ResourceDefinition {
  readonly singular: string;
  readonly viewPermission: string;
  readonly managePermission: string;
  /** True when saves/deletes must be confirmed with the record name/code. */
  readonly requiresTypedConfirmation: boolean;
}

const DEFINITIONS: Record<ResourceName, ResourceDefinition> = {
  'patient-tags': { singular: 'tag', viewPermission: 'patient.view', managePermission: 'patient.edit', requiresTypedConfirmation: false },
  medications: { singular: 'medication', viewPermission: 'prescription.view', managePermission: 'prescription.create', requiresTypedConfirmation: false },
  'clinical-options': { singular: 'clinical option', viewPermission: 'prescription.view', managePermission: 'clinical_option.manage', requiresTypedConfirmation: false },
  'payment-methods': { singular: 'payment method', viewPermission: 'payment.view', managePermission: 'payment_method.manage', requiresTypedConfirmation: false },
  'inventory-categories': { singular: 'inventory category', viewPermission: 'inventory.view', managePermission: 'inventory.manage', requiresTypedConfirmation: false },
  suppliers: { singular: 'supplier', viewPermission: 'inventory.view', managePermission: 'inventory.manage', requiresTypedConfirmation: false },
  'accounting-categories': { singular: 'accounting category', viewPermission: 'accounting.view', managePermission: 'accounting.category.manage', requiresTypedConfirmation: false },
  'referral-doctors': { singular: 'referral doctor', viewPermission: 'patient.view', managePermission: 'visit.create', requiresTypedConfirmation: false },
  'printer-profiles': { singular: 'printer profile', viewPermission: 'settings.view', managePermission: 'printer.manage', requiresTypedConfirmation: false },
  'print-templates': { singular: 'print template', viewPermission: 'settings.view', managePermission: 'printer.manage', requiresTypedConfirmation: false },
  treatments: { singular: 'treatment', viewPermission: 'treatment.view', managePermission: 'treatment.manage', requiresTypedConfirmation: true },
};

export class ResourceService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly prescriptions: PrescriptionService,
    private readonly patients: PatientService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private definition(resource: ResourceName): ResourceDefinition {
    const definition = DEFINITIONS[resource];
    if (!definition) throw AppError.notFound('Resource');
    return definition;
  }

  requireView(resource: ResourceName): void {
    requirePermission(this.context(), this.definition(resource).viewPermission);
  }

  requireManage(resource: ResourceName): void {
    requirePermission(this.context(), this.definition(resource).managePermission);
  }

  // --- Reads --------------------------------------------------------------

  list(resource: ResourceName, query: { page?: number; pageSize?: number; search?: string; includeInactive?: boolean } = {}): Paged<unknown> {
    this.requireView(resource);
    const search = query.search?.trim() ?? '';
    const includeInactive = query.includeInactive === true;
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);

    switch (resource) {
      case 'patient-tags': {
        const rows = this.patients.listTags().filter((tag) => search === '' || tag.name.toLowerCase().includes(search.toLowerCase()));
        return this.slice(rows, rows.length, page, pageSize);
      }
      case 'medications': {
        const page1 = this.prescriptions.medications({ page, pageSize, search, includeInactive });
        return page1;
      }
      case 'clinical-options': {
        const rows = this.db
          .prepare(
            `SELECT * FROM clinical_options WHERE deleted_at IS NULL${includeInactive ? '' : ' AND is_active = 1'}
              ${search === '' ? '' : 'AND label LIKE ? ESCAPE \'\\\' COLLATE NOCASE'} ORDER BY category, sort_order, id`,
          )
          .all(...(search === '' ? [] : [likeTerm(search)])) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            category: asString(row['category']) as ResourceListItemExtension,
            label: asString(row['label']),
            sortOrder: asNumber(row['sort_order']),
            isActive: asNumber(row['is_active']) === 1,
          })),
          rows.length,
          page,
          pageSize,
        );
      }
      case 'payment-methods': {
        const where = buildWhere([
          'm.deleted_at IS NULL',
          includeInactive ? null : 'm.is_active = 1',
          search === '' ? null : `(m.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR m.code LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
        ]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search), likeTerm(search)];
        const total = asNumber(
          (
            this.db.prepare(`SELECT COUNT(*) AS total FROM payment_methods m ${where}`).get(...params) as { total: number }
          ).total,
        );
        const rows = this.db
          .prepare(
            `SELECT m.*, (SELECT COUNT(*) FROM payments p WHERE p.method_id = m.id) AS usage_count
               FROM payment_methods m ${where} ORDER BY m.sort_order, m.name LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            code: asString(row['code']),
            name: asString(row['name']),
            category: asString(row['category']),
            requiresReference: asNumber(row['requires_reference']) === 1,
            isActive: asNumber(row['is_active']) === 1,
            sortOrder: asNumber(row['sort_order']),
            usageCount: asNumber(row['usage_count']),
          })),
          total,
          page,
          pageSize,
        );
      }
      case 'inventory-categories': {
        const where = buildWhere(['c.deleted_at IS NULL', search === '' ? null : `c.name LIKE ? ESCAPE '\\' COLLATE NOCASE`]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM inventory_categories c ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM inventory_items i WHERE i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
               FROM inventory_categories c ${where} ORDER BY c.name LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            name: asString(row['name']),
            description: asString(row['description']),
            itemCount: asNumber(row['item_count']),
          })),
          total,
          page,
          pageSize,
        );
      }
      case 'suppliers': {
        const where = buildWhere([
          's.deleted_at IS NULL',
          includeInactive ? null : 's.is_active = 1',
          search === '' ? null : `(s.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.contact_person LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.phone LIKE ? ESCAPE '\\')`,
        ]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search), likeTerm(search), likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM suppliers s ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(
            `SELECT s.*,
                    (SELECT COUNT(*) FROM inventory_purchases p WHERE p.supplier_id = s.id) AS purchase_count,
                    (SELECT MAX(p.date) FROM inventory_purchases p WHERE p.supplier_id = s.id) AS last_purchase_date,
                    (SELECT COALESCE(SUM(p.total_paisa), 0) FROM inventory_purchases p WHERE p.supplier_id = s.id) AS total_purchased
               FROM suppliers s ${where} ORDER BY s.name LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            name: asString(row['name']),
            contactPerson: asString(row['contact_person']),
            phone: asString(row['phone']),
            email: asString(row['email']),
            address: asString(row['address']),
            notes: asString(row['notes']),
            isActive: asNumber(row['is_active']) === 1,
            purchaseCount: asNumber(row['purchase_count']),
            lastPurchaseDate: row['last_purchase_date'] === null ? null : asString(row['last_purchase_date']),
            totalPurchasedPaisa: asNumber(row['total_purchased']),
          })),
          total,
          page,
          pageSize,
        );
      }
      case 'accounting-categories': {
        const where = buildWhere([
          'c.deleted_at IS NULL',
          includeInactive ? null : 'c.is_active = 1',
          search === '' ? null : `c.name LIKE ? ESCAPE '\\' COLLATE NOCASE`,
        ]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM accounting_categories c ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM accounting_transactions t WHERE t.category_id = c.id AND t.is_void = 0) AS usage_count
               FROM accounting_categories c ${where} ORDER BY c.direction, c.name LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            name: asString(row['name']),
            direction: asString(row['direction']),
            isActive: asNumber(row['is_active']) === 1,
            isSystem: asNumber(row['is_system']) === 1,
            usageCount: asNumber(row['usage_count']),
          })),
          total,
          page,
          pageSize,
        );
      }
      case 'referral-doctors': {
        const where = buildWhere([
          'd.deleted_at IS NULL',
          includeInactive ? null : 'd.is_active = 1',
          search === '' ? null : `(d.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR d.specialty LIKE ? ESCAPE '\\' COLLATE NOCASE OR d.organisation LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
        ]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search), likeTerm(search), likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM referral_doctors d ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(
            `SELECT d.*, (SELECT COUNT(*) FROM referrals r WHERE r.referral_doctor_id = d.id) AS referral_count
               FROM referral_doctors d ${where} ORDER BY d.name LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            name: asString(row['name']),
            specialty: asString(row['specialty']),
            organisation: asString(row['organisation']),
            phone: asString(row['phone']),
            email: asString(row['email']),
            address: asString(row['address']),
            notes: asString(row['notes']),
            isActive: asNumber(row['is_active']) === 1,
            referralCount: asNumber(row['referral_count']),
          })),
          total,
          page,
          pageSize,
        );
      }
      case 'printer-profiles': {
        const where = buildWhere(['p.deleted_at IS NULL', includeInactive ? null : 'p.is_active = 1', search === '' ? null : `p.name LIKE ? ESCAPE '\\' COLLATE NOCASE`]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM printer_profiles p ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(`SELECT p.* FROM printer_profiles p ${where} ORDER BY p.kind, p.name LIMIT ? OFFSET ?`)
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(rows.map(mapPrinterProfile), total, page, pageSize);
      }
      case 'print-templates': {
        const where = buildWhere(['t.deleted_at IS NULL', search === '' ? null : `t.name LIKE ? ESCAPE '\\' COLLATE NOCASE`]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM print_templates t ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(`SELECT t.* FROM print_templates t ${where} ORDER BY t.kind, t.name LIMIT ? OFFSET ?`)
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(rows.map(mapPrintTemplate), total, page, pageSize);
      }
      case 'treatments': {
        const where = buildWhere([
          't.deleted_at IS NULL',
          includeInactive ? null : 't.is_active = 1',
          search === '' ? null : `(t.code LIKE ? ESCAPE '\\' COLLATE NOCASE OR t.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR t.category LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
        ]);
        const params: unknown[] = search === '' ? [] : [likeTerm(search), likeTerm(search), likeTerm(search)];
        const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM treatment_catalog t ${where}`).get(...params) as { total: number }).total);
        const rows = this.db
          .prepare(`SELECT t.* FROM treatment_catalog t ${where} ORDER BY t.category, t.name LIMIT ? OFFSET ?`)
          .all(...params, limit, offset) as Array<Record<string, unknown>>;
        return this.slice(
          rows.map((row) => ({
            id: asNumber(row['id']),
            code: asString(row['code']),
            name: asString(row['name']),
            category: asString(row['category']),
            description: asString(row['description']),
            pricePaisa: asNumber(row['price_paisa']),
            durationMinutes: asNumber(row['duration_minutes']),
            isActive: asNumber(row['is_active']) === 1,
            usageCount: asNumber(
              (
                this.db
                  .prepare(`SELECT COUNT(*) AS total FROM treatment_records WHERE treatment_id = ? AND deleted_at IS NULL`)
                  .get(asNumber(row['id'])) as { total: number }
              ).total,
            ),
          })),
          total,
          page,
          pageSize,
        );
      }
      default:
        throw AppError.notFound('Resource');
    }
  }

  private slice<T>(items: T[], total: number, page: number, pageSize: number): Paged<T> {
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(resource: ResourceName, id: number): unknown {
    this.requireView(resource);
    const list = this.list(resource, { page: 1, pageSize: 1000, includeInactive: true });
    const found = (list.items as Array<{ id: number }>).find((item) => item.id === id);
    if (!found) throw AppError.notFound(this.definition(resource).singular);
    return found;
  }

  options(resource: ResourceName): Array<{ value: number; label: string; meta?: string }> {
    this.requireView(resource);
    const list = this.list(resource, { page: 1, pageSize: 500 });
    return (list.items as Array<Record<string, unknown>>).map((item) => {
      const id = asNumber(item['id']);
      switch (resource) {
        case 'payment-methods':
          return { value: id, label: asString(item['name']), meta: asString(item['category']) };
        case 'accounting-categories':
          return { value: id, label: asString(item['name']), meta: asString(item['direction']) };
        case 'treatments':
          return { value: id, label: asString(item['name']), meta: asString(item['code']) };
        case 'clinical-options':
          return { value: id, label: asString(item['label']), meta: asString(item['category']) };
        case 'referral-doctors':
          return { value: id, label: asString(item['name']), meta: asString(item['specialty']) };
        case 'patient-tags':
          return { value: id, label: asString(item['name']), meta: asString(item['colour']) };
        default:
          return { value: id, label: asString(item['name']) };
      }
    });
  }

  // --- Writes -------------------------------------------------------------

  save(resource: ResourceName, id: number | null, input: ResourceInput<ResourceName>): { id: number } {
    requirePermission(this.context(), this.definition(resource).managePermission);
    const ctx = this.context();
    const now = ctx.instant();

    switch (resource) {
      case 'patient-tags': {
        const payload = input as { name: string; colour: string };
        if (payload.name.trim().length < 1) throw AppError.validation('Enter a tag name.', { name: 'Name is required.' });
        if (!/^#[0-9a-fA-F]{6}$/.test(payload.colour.trim())) {
          throw AppError.validation('Choose a tag colour.', { colour: 'Use a hex colour such as #2563EB.' });
        }
        return this.patients.saveTag({ id, name: payload.name, colour: payload.colour });
      }
      case 'medications': {
        return this.prescriptions.saveMedication(id, input as never);
      }
      case 'clinical-options': {
        return this.prescriptions.saveClinicalOption(id, input as never);
      }
      case 'treatments': {
        const payload = input as { code: string; name: string; category: string; description: string; pricePaisa: number; durationMinutes: number; isActive: boolean };
        const fieldErrors: Record<string, string> = {};
        if (payload.name.trim().length < 2) fieldErrors['name'] = 'Enter the treatment name.';
        if (payload.code.trim() !== '' && !/^[A-Za-z0-9._-]{2,16}$/.test(payload.code.trim())) {
          fieldErrors['code'] = 'Use 2–16 letters, numbers, dots, hyphens or underscores.';
        }
        if (!Number.isFinite(payload.pricePaisa) || payload.pricePaisa < 0) fieldErrors['pricePaisa'] = 'Enter a valid price.';
        if (!Number.isFinite(payload.durationMinutes) || payload.durationMinutes < 0) fieldErrors['durationMinutes'] = 'Enter a valid duration.';
        if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
        const code = payload.code.trim() === '' ? this.suggestTreatmentCode(payload.name) : payload.code.trim().toUpperCase();
        const duplicate = this.db
          .prepare(`SELECT id FROM treatment_catalog WHERE lower(code) = lower(?) AND deleted_at IS NULL${id ? ' AND id <> ?' : ''}`)
          .get(...(id ? [code, id] : [code])) as { id: number } | undefined;
        if (duplicate) throw AppError.validation('That treatment code is already in use.', { code: 'Code already used.' });
        return this.db.transaction(() => {
          let targetId = id;
          if (targetId) {
            this.db
              .prepare(
                `UPDATE treatment_catalog SET code = ?, name = ?, category = ?, description = ?, price_paisa = ?,
                   duration_minutes = ?, is_active = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
              )
              .run(code, payload.name.trim(), payload.category.trim(), payload.description.trim(), Math.round(payload.pricePaisa), Math.round(payload.durationMinutes), payload.isActive ? 1 : 0, now, targetId);
          } else {
            const result = this.db
              .prepare(
                `INSERT INTO treatment_catalog (code, name, category, description, price_paisa, duration_minutes, is_active, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(code, payload.name.trim(), payload.category.trim(), payload.description.trim(), Math.round(payload.pricePaisa), Math.round(payload.durationMinutes), payload.isActive ? 1 : 0, now, now);
            targetId = Number(result.lastInsertRowid);
          }
          this.syncTreatmentFts(targetId);
          ctx.audit.record({
            action: id ? 'update' : 'create',
            entityType: 'treatment',
            entityId: targetId,
            entityLabel: `${code} — ${payload.name.trim()}`,
            detail: id ? 'Treatment catalog entry updated' : 'Treatment catalog entry created',
          });
          return { id: targetId };
        })();
      }
      case 'payment-methods': {
        const payload = input as { code: string; name: string; category: string; requiresReference: boolean; isActive: boolean };
        if (payload.name.trim().length < 2) throw AppError.validation('Enter the method name.', { name: 'Name is required.' });
        const code = payload.code.trim() === '' ? payload.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) : payload.code.trim().toLowerCase();
        const duplicate = this.db
          .prepare(`SELECT id FROM payment_methods WHERE lower(code) = lower(?)${id ? ' AND id <> ?' : ''}`)
          .get(...(id ? [code, id] : [code])) as { id: number } | undefined;
        if (duplicate) throw AppError.validation('That method code is already in use.', { code: 'Code already used.' });
        const sortOrder = id
          ? asNumber((this.db.prepare(`SELECT sort_order FROM payment_methods WHERE id = ?`).get(id) as { sort_order: number } | undefined)?.sort_order ?? 0, 0)
          : asNumber((this.db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM payment_methods`).get() as { next: number }).next, 1);
        if (id) {
          this.db
            .prepare(`UPDATE payment_methods SET code = ?, name = ?, category = ?, requires_reference = ?, is_active = ?, updated_at = ? WHERE id = ?`)
            .run(code, payload.name.trim(), payload.category, payload.requiresReference ? 1 : 0, payload.isActive ? 1 : 0, now, id);
          ctx.audit.record({ action: 'update', entityType: 'payment_method', entityId: id, entityLabel: payload.name.trim(), detail: 'Payment method updated' });
          return { id };
        }
        const result = this.db
          .prepare(
            `INSERT INTO payment_methods (code, name, category, requires_reference, is_active, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(code, payload.name.trim(), payload.category, payload.requiresReference ? 1 : 0, payload.isActive ? 1 : 0, sortOrder, now, now);
        const newId = Number(result.lastInsertRowid);
        ctx.audit.record({ action: 'create', entityType: 'payment_method', entityId: newId, entityLabel: payload.name.trim(), detail: 'Payment method created' });
        return { id: newId };
      }
      case 'inventory-categories':
      case 'suppliers':
      case 'accounting-categories':
      case 'referral-doctors':
      case 'printer-profiles':
      case 'print-templates': {
        return this.saveSimple(resource, id, input as unknown as Record<string, unknown>, now);
      }
      default:
        throw AppError.notFound('Resource');
    }
  }

  private saveSimple(resource: ResourceName, id: number | null, payload: Record<string, unknown>, now: string): { id: number } {
    const ctx = this.context();
    const name = asString(payload['name']).trim();
    if (name.length < 2) throw AppError.validation('Enter a name.', { name: 'A name is required.' });

    const table =
      resource === 'inventory-categories'
        ? 'inventory_categories'
        : resource === 'suppliers'
          ? 'suppliers'
          : resource === 'accounting-categories'
            ? 'accounting_categories'
            : resource === 'referral-doctors'
              ? 'referral_doctors'
              : resource === 'printer-profiles'
                ? 'printer_profiles'
                : 'print_templates';

    const duplicate = this.db
      .prepare(`SELECT id FROM ${table} WHERE lower(name) = lower(?) AND deleted_at IS NULL${id ? ' AND id <> ?' : ''}`)
      .get(...(id ? [name, id] : [name])) as { id: number } | undefined;
    if (duplicate) throw AppError.validation('A record with this name already exists.', { name: 'Name already used.' });

    switch (resource) {
      case 'inventory-categories': {
        const description = asString(payload['description']).trim();
        if (id) {
          this.db
            .prepare(`UPDATE inventory_categories SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
            .run(name, description, now, id);
          ctx.audit.record({ action: 'update', entityType: 'inventory_category', entityId: id, entityLabel: name, detail: 'Inventory category updated' });
          return { id };
        }
        const result = this.db
          .prepare(`INSERT INTO inventory_categories (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)`)
          .run(name, description, now, now);
        const newId = Number(result.lastInsertRowid);
        ctx.audit.record({ action: 'create', entityType: 'inventory_category', entityId: newId, entityLabel: name, detail: 'Inventory category created' });
        return { id: newId };
      }
      case 'suppliers': {
        const active = payload['isActive'] === false ? 0 : 1;
        if (id) {
          this.db
            .prepare(
              `UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, notes = ?, is_active = ?, updated_at = ? WHERE id = ?`,
            )
            .run(name, asString(payload['contactPerson']).trim(), asString(payload['phone']).trim(), asString(payload['email']).trim(), asString(payload['address']).trim(), asString(payload['notes']).trim(), active, now, id);
          ctx.audit.record({ action: 'update', entityType: 'supplier', entityId: id, entityLabel: name, detail: 'Supplier updated' });
          return { id };
        }
        const result = this.db
          .prepare(
            `INSERT INTO suppliers (name, contact_person, phone, email, address, notes, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, asString(payload['contactPerson']).trim(), asString(payload['phone']).trim(), asString(payload['email']).trim(), asString(payload['address']).trim(), asString(payload['notes']).trim(), active, now, now);
        const newId = Number(result.lastInsertRowid);
        ctx.audit.record({ action: 'create', entityType: 'supplier', entityId: newId, entityLabel: name, detail: 'Supplier created' });
        return { id: newId };
      }
      case 'accounting-categories': {
        const direction = asString(payload['direction'], 'expense') === 'income' ? 'income' : 'expense';
        const active = payload['isActive'] === false ? 0 : 1;
        const clash = this.db
          .prepare(`SELECT id FROM accounting_categories WHERE direction = ? AND lower(name) = lower(?) AND deleted_at IS NULL${id ? ' AND id <> ?' : ''}`)
          .get(...(id ? [direction, name, id] : [direction, name])) as { id: number } | undefined;
        if (clash) throw AppError.validation('That category already exists for this direction.', { name: 'Duplicate category.' });
        if (id) {
          const row = this.db.prepare(`SELECT is_system FROM accounting_categories WHERE id = ?`).get(id) as { is_system: number } | undefined;
          if (!row) throw AppError.notFound('Accounting category');
          if (row.is_system === 1 && active === 0) {
            throw AppError.precondition('System categories cannot be deactivated because reports rely on them.');
          }
          this.db
            .prepare(`UPDATE accounting_categories SET name = ?, direction = ?, is_active = ?, updated_at = ? WHERE id = ?`)
            .run(name, direction, active, now, id);
          ctx.audit.record({ action: 'update', entityType: 'accounting_category', entityId: id, entityLabel: name, detail: 'Accounting category updated' });
          return { id };
        }
        const result = this.db
          .prepare(`INSERT INTO accounting_categories (name, direction, is_active, is_system, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`)
          .run(name, direction, active, now, now);
        const newId = Number(result.lastInsertRowid);
        ctx.audit.record({ action: 'create', entityType: 'accounting_category', entityId: newId, entityLabel: name, detail: 'Accounting category created' });
        return { id: newId };
      }
      case 'referral-doctors': {
        const active = payload['isActive'] === false ? 0 : 1;
        if (id) {
          this.db
            .prepare(
              `UPDATE referral_doctors SET name = ?, specialty = ?, organisation = ?, phone = ?, email = ?, address = ?, notes = ?, is_active = ?, updated_at = ? WHERE id = ?`,
            )
            .run(name, asString(payload['specialty']).trim(), asString(payload['organisation']).trim(), asString(payload['phone']).trim(), asString(payload['email']).trim(), asString(payload['address']).trim(), asString(payload['notes']).trim(), active, now, id);
          ctx.audit.record({ action: 'update', entityType: 'referral_doctor', entityId: id, entityLabel: name, detail: 'Referral doctor updated' });
          return { id };
        }
        const result = this.db
          .prepare(
            `INSERT INTO referral_doctors (name, specialty, organisation, phone, email, address, notes, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, asString(payload['specialty']).trim(), asString(payload['organisation']).trim(), asString(payload['phone']).trim(), asString(payload['email']).trim(), asString(payload['address']).trim(), asString(payload['notes']).trim(), active, now, now);
        const newId = Number(result.lastInsertRowid);
        ctx.audit.record({ action: 'create', entityType: 'referral_doctor', entityId: newId, entityLabel: name, detail: 'Referral doctor created' });
        return { id: newId };
      }
      case 'printer-profiles': {
        const isDefault = payload['isDefault'] === true;
        const kind = asString(payload['kind'], 'prescription');
        const values = {
          name,
          kind,
          printerName: asString(payload['printerName']).trim(),
          paperKey: asString(payload['paperKey'], 'a4'),
          widthMm: Number(payload['widthMm'] ?? 210),
          heightMm: Number(payload['heightMm'] ?? 297),
          orientation: asString(payload['orientation'], 'portrait') === 'landscape' ? 'landscape' : 'portrait',
          marginTopMm: Number(payload['marginTopMm'] ?? 12),
          marginRightMm: Number(payload['marginRightMm'] ?? 12),
          marginBottomMm: Number(payload['marginBottomMm'] ?? 12),
          marginLeftMm: Number(payload['marginLeftMm'] ?? 12),
          scalePercent: Math.min(Math.max(Math.round(Number(payload['scalePercent'] ?? 100)), 50), 200),
          copies: Math.min(Math.max(Math.round(Number(payload['copies'] ?? 1)), 1), 10),
          isThermal: payload['isThermal'] === true ? 1 : 0,
          isDefault: isDefault ? 1 : 0,
          isActive: payload['isActive'] === false ? 0 : 1,
          headerNote: asString(payload['headerNote']).trim(),
          footerNote: asString(payload['footerNote']).trim(),
        };
        return this.db.transaction(() => {
          let targetId = id;
          if (targetId) {
            this.db
              .prepare(
                `UPDATE printer_profiles SET name = @name, kind = @kind, printer_name = @printerName, paper_key = @paperKey,
                   width_mm = @widthMm, height_mm = @heightMm, orientation = @orientation, margin_top_mm = @marginTopMm,
                   margin_right_mm = @marginRightMm, margin_bottom_mm = @marginBottomMm, margin_left_mm = @marginLeftMm,
                   scale_percent = @scalePercent, copies = @copies, is_thermal = @isThermal, is_default = @isDefault,
                   is_active = @isActive, header_note = @headerNote, footer_note = @footerNote, updated_at = @now
                 WHERE id = @id`,
              )
              .run({ ...values, now, id: targetId });
          } else {
            const result = this.db
              .prepare(
                `INSERT INTO printer_profiles (name, kind, printer_name, paper_key, width_mm, height_mm, orientation,
                   margin_top_mm, margin_right_mm, margin_bottom_mm, margin_left_mm, scale_percent, copies, is_thermal,
                   is_default, is_active, header_note, footer_note, created_at, updated_at)
                 VALUES (@name, @kind, @printerName, @paperKey, @widthMm, @heightMm, @orientation, @marginTopMm,
                   @marginRightMm, @marginBottomMm, @marginLeftMm, @scalePercent, @copies, @isThermal, @isDefault,
                   @isActive, @headerNote, @footerNote, @now, @now)`,
              )
              .run({ ...values, now });
            targetId = Number(result.lastInsertRowid);
          }
          if (isDefault) {
            this.db.prepare(`UPDATE printer_profiles SET is_default = 0 WHERE kind = ? AND id <> ?`).run(kind, targetId);
          }
          ctx.audit.record({
            action: id ? 'update' : 'create',
            entityType: 'printer_profile',
            entityId: targetId,
            entityLabel: name,
            detail: id ? 'Printer profile updated' : 'Printer profile created',
          });
          return { id: targetId };
        })();
      }
      case 'print-templates': {
        const kind = asString(payload['kind'], 'prescription');
        const accent = asString(payload['accentColour'], '#0B2545');
        if (!/^#[0-9a-fA-F]{6}$/.test(accent)) {
          throw AppError.validation('Choose a valid accent colour.', { accentColour: 'Use a hex colour such as #0B2545.' });
        }
        const isDefault = payload['isDefault'] === true;
        const values = {
          kind,
          name,
          headerText: asString(payload['headerText']),
          footerText: asString(payload['footerText']),
          showLogo: payload['showLogo'] === false ? 0 : 1,
          showDentistSignature: payload['showDentistSignature'] === false ? 0 : 1,
          showDentistQualifications: payload['showDentistQualifications'] === false ? 0 : 1,
          signatureLabel: asString(payload['signatureLabel']).trim(),
          accent,
          isDefault: isDefault ? 1 : 0,
        };
        return this.db.transaction(() => {
          let targetId = id;
          if (targetId) {
            this.db
              .prepare(
                `UPDATE print_templates SET kind = @kind, name = @name, header_text = @headerText, footer_text = @footerText,
                   show_logo = @showLogo, show_dentist_signature = @showDentistSignature,
                   show_dentist_qualifications = @showDentistQualifications, signature_label = @signatureLabel,
                   accent_colour = @accent, is_default = @isDefault, updated_at = @now WHERE id = @id`,
              )
              .run({ ...values, now, id: targetId });
          } else {
            const result = this.db
              .prepare(
                `INSERT INTO print_templates (kind, name, header_text, footer_text, show_logo, show_dentist_signature,
                   show_dentist_qualifications, signature_label, accent_colour, is_default, created_at, updated_at)
                 VALUES (@kind, @name, @headerText, @footerText, @showLogo, @showDentistSignature,
                   @showDentistQualifications, @signatureLabel, @accent, @isDefault, @now, @now)`,
              )
              .run({ ...values, now });
            targetId = Number(result.lastInsertRowid);
          }
          if (isDefault) this.db.prepare(`UPDATE print_templates SET is_default = 0 WHERE kind = ? AND id <> ?`).run(kind, targetId);
          ctx.audit.record({
            action: id ? 'update' : 'create',
            entityType: 'print_template',
            entityId: targetId,
            entityLabel: name,
            detail: id ? 'Print template updated' : 'Print template created',
          });
          return { id: targetId };
        })();
      }
      default:
        throw AppError.notFound('Resource');
    }
  }

  delete(resource: ResourceName, id: number, options: { reason?: string; confirmText?: string } = {}): void {
    requirePermission(this.context(), this.definition(resource).managePermission);
    const ctx = this.context();
    const now = ctx.instant();

    if (resource === 'medications') {
      this.prescriptions.deleteMedication(id);
      return;
    }

    const table =
      resource === 'patient-tags'
        ? 'patient_tags'
        : resource === 'clinical-options'
          ? 'clinical_options'
          : resource === 'payment-methods'
            ? 'payment_methods'
            : resource === 'inventory-categories'
              ? 'inventory_categories'
              : resource === 'suppliers'
                ? 'suppliers'
                : resource === 'accounting-categories'
                  ? 'accounting_categories'
                  : resource === 'referral-doctors'
                    ? 'referral_doctors'
                    : resource === 'printer-profiles'
                      ? 'printer_profiles'
                      : resource === 'print-templates'
                        ? 'print_templates'
                        : 'treatment_catalog';

    const row = this.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined;
    if (!row) throw AppError.notFound(this.definition(resource).singular);

    if (this.definition(resource).requiresTypedConfirmation) {
      if (options.confirmText?.trim() !== row.name) {
        throw AppError.validation(`Type “${row.name}” to confirm removing this ${this.definition(resource).singular}.`, {
          confirmText: 'The typed name does not match.',
        });
      }
    }

    // Usage guards: catalog entries that history depends on are deactivated
    // rather than removed.
    const usage = this.usageCount(resource, id, table);
    if (usage > 0) {
      if (resource === 'accounting-categories') {
        throw AppError.precondition(
          `This category is used by ${usage} transaction(s). Deactivate it instead so the history stays readable.`,
        );
      }
      const activeColumn = table === 'clinical_options' ? 'is_active' : 'is_active';
      this.db.prepare(`UPDATE ${table} SET ${activeColumn} = 0, updated_at = ? WHERE id = ?`).run(now, id);
      ctx.audit.record({
        action: 'update',
        entityType: this.definition(resource).singular,
        entityId: id,
        entityLabel: row.name,
        detail: `Deactivated instead of removed — still referenced by ${usage} record(s)`,
        severity: 'warning',
      });
      return;
    }

    this.db.transaction(() => {
      if (resource === 'patient-tags') {
        this.db.prepare(`DELETE FROM patient_tag_links WHERE tag_id = ?`).run(id);
        this.db.prepare(`DELETE FROM patient_tags WHERE id = ?`).run(id);
      } else if (table === 'treatment_catalog') {
        this.db.prepare(`DELETE FROM treatment_catalog WHERE id = ?`).run(id);
        this.db.prepare(`DELETE FROM treatments_fts WHERE rowid = ?`).run(id);
      } else {
        this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      }
      ctx.audit.record({
        action: 'delete',
        entityType: this.definition(resource).singular,
        entityId: id,
        entityLabel: row.name,
        detail: `${this.definition(resource).singular} removed${options.reason?.trim() ? `. Reason: ${options.reason.trim()}` : ''}`,
        severity: 'warning',
      });
    })();
  }

  private usageCount(resource: ResourceName, id: number, table: string): number {
    const count = (sql: string): number => asNumber((this.db.prepare(sql).get(id) as { total: number }).total);
    switch (resource) {
      case 'patient-tags':
        return count(`SELECT COUNT(*) AS total FROM patient_tag_links WHERE tag_id = ?`);
      case 'clinical-options':
        return 0;
      case 'payment-methods':
        return count(`SELECT COUNT(*) AS total FROM payments WHERE method_id = ?`);
      case 'inventory-categories':
        return count(`SELECT COUNT(*) AS total FROM inventory_items WHERE category_id = ?`);
      case 'suppliers':
        return count(`SELECT COUNT(*) AS total FROM inventory_purchases WHERE supplier_id = ?`);
      case 'accounting-categories':
        return count(`SELECT COUNT(*) AS total FROM accounting_transactions WHERE category_id = ?`);
      case 'referral-doctors':
        return count(`SELECT COUNT(*) AS total FROM referrals WHERE referral_doctor_id = ?`);
      case 'printer-profiles':
      case 'print-templates':
        return 0;
      case 'treatments':
        return count(`SELECT COUNT(*) AS total FROM treatment_records WHERE treatment_id = ?`) + count(`SELECT COUNT(*) AS total FROM invoice_items WHERE treatment_id = ?`);
      default:
        void table;
        return 0;
    }
  }

  /** Restore a soft-deleted catalog row (used by the "show deleted" toggle). */
  restore(resource: ResourceName, id: number): void {
    requirePermission(this.context(), this.definition(resource).managePermission);
    const table =
      resource === 'medications'
        ? 'medications'
        : resource === 'clinical-options'
          ? 'clinical_options'
          : resource === 'payment-methods'
            ? 'payment_methods'
            : resource === 'inventory-categories'
              ? 'inventory_categories'
              : resource === 'suppliers'
                ? 'suppliers'
                : resource === 'accounting-categories'
                  ? 'accounting_categories'
                  : resource === 'referral-doctors'
                    ? 'referral_doctors'
                    : resource === 'printer-profiles'
                      ? 'printer_profiles'
                      : resource === 'print-templates'
                        ? 'print_templates'
                        : 'treatment_catalog';
    const result = this.db.prepare(`UPDATE ${table} SET deleted_at = NULL, is_active = 1, updated_at = ? WHERE id = ?`).run(this.context().instant(), id);
    if (result.changes === 0) throw AppError.notFound(this.definition(resource).singular);
    if (resource === 'treatments') this.syncTreatmentFts(id);
    this.context().audit.record({ action: 'restore', entityType: this.definition(resource).singular, entityId: id, detail: 'Catalog entry restored' });
  }

  private syncTreatmentFts(treatmentId: number): void {
    this.db.prepare(`DELETE FROM treatments_fts WHERE rowid = ?`).run(treatmentId);
    const row = this.db
      .prepare(`SELECT id, code, name, category, description, deleted_at FROM treatment_catalog WHERE id = ?`)
      .get(treatmentId) as { id: number; code: string; name: string; category: string; description: string; deleted_at: string | null } | undefined;
    if (!row || row.deleted_at) return;
    this.db
      .prepare(`INSERT INTO treatments_fts (rowid, code, name, category, description) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, row.code, row.name, row.category, row.description);
  }

  private suggestTreatmentCode(name: string): string {
    const base = name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 12);
    const candidate = base === '' ? 'TRT' : base;
    let suffix = 0;
    for (;;) {
      const code = suffix === 0 ? candidate : `${candidate}-${suffix}`;
      const clash = this.db.prepare(`SELECT 1 AS present FROM treatment_catalog WHERE lower(code) = lower(?) AND deleted_at IS NULL`).get(code);
      if (!clash) return code;
      suffix += 1;
    }
  }
}

type ResourceListItemExtension = string;

function mapPrinterProfile(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asNumber(row['id']),
    name: asString(row['name']),
    kind: asString(row['kind']),
    printerName: asString(row['printer_name']),
    paperKey: asString(row['paper_key']),
    widthMm: Number(row['width_mm']),
    heightMm: Number(row['height_mm']),
    orientation: asString(row['orientation']),
    marginTopMm: Number(row['margin_top_mm']),
    marginRightMm: Number(row['margin_right_mm']),
    marginBottomMm: Number(row['margin_bottom_mm']),
    marginLeftMm: Number(row['margin_left_mm']),
    scalePercent: asNumber(row['scale_percent']),
    copies: asNumber(row['copies']),
    isThermal: asNumber(row['is_thermal']) === 1,
    isDefault: asNumber(row['is_default']) === 1,
    isActive: asNumber(row['is_active']) === 1,
    headerNote: asString(row['header_note']),
    footerNote: asString(row['footer_note']),
  };
}

function mapPrintTemplate(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asNumber(row['id']),
    kind: asString(row['kind']),
    name: asString(row['name']),
    headerText: asString(row['header_text']),
    footerText: asString(row['footer_text']),
    showLogo: asNumber(row['show_logo']) === 1,
    showDentistSignature: asNumber(row['show_dentist_signature']) === 1,
    showDentistQualifications: asNumber(row['show_dentist_qualifications']) === 1,
    signatureLabel: asString(row['signature_label']),
    accentColour: asString(row['accent_colour'], '#0B2545'),
    isDefault: asNumber(row['is_default']) === 1,
  };
}

export { nowInstant };
