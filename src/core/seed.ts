/**
 * Reference data seeding.
 *
 * Runs at every start-up, directly after migrations, and only ever inserts what
 * is missing: an installation that a clinic has customised (renamed a treatment,
 * added payment methods, deleted a seeding mistake) is never overwritten.
 * Roles are the one exception — they are kept in step with the code because
 * their permission grants belong to the application, not to the clinic.
 */
import type { SqliteDatabase } from './db/connection';
import type { CoreContext } from './context';
import type { PaperDefinition, PrintTemplateKind } from '@shared/constants';
import {
  DEFAULT_CLINICAL_OPTIONS,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  DEFAULT_INVENTORY_CATEGORIES,
  DEFAULT_MEDICATIONS,
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_TREATMENTS,
  PAPER_SIZES,
  MEDICATION_FORMS,
} from '@shared/constants';
import { APP_VERSION } from '@shared/app-info';
import { nowInstant } from '@shared/dates';
import { asNumber } from './db/sql';
import type { AccountingService } from './services/accounting-service';
import type { UserService } from './services/user-service';

export interface SeedResult {
  readonly roles: number;
  readonly paymentMethods: number;
  readonly clinicalOptions: number;
  readonly medications: number;
  readonly treatments: number;
  readonly accountingCategories: number;
  readonly inventoryCategories: number;
  readonly printerProfiles: number;
  readonly printTemplates: number;
  readonly createdClinic: boolean;
}

export interface SeedDependencies {
  readonly users: UserService;
  readonly accounting: AccountingService;
}

function exists(db: SqliteDatabase, table: string, column: string, value: string): boolean {
  const row = db.prepare(`SELECT 1 AS present FROM ${table} WHERE lower(${column}) = lower(?)`).get(value) as
    | { present: number }
    | undefined;
  return Boolean(row);
}

function count(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return asNumber(row.total);
}

/**
 * Split a legacy dose string such as `1+0+1` into morning/noon/night integers.
 * `Rinse 10 ml twice daily` and similar free-text doses fall back to a single
 * night dose so the printed prescription keeps the original wording intact.
 */
function parseDose(dose: string | undefined): { morning: number; noon: number; night: number } {
  if (!dose) return { morning: 1, noon: 1, night: 1 };
  const match = /^\s*(\d+)\s*\+\s*(\d+)\s*\+\s*(\d+)\s*$/.exec(dose);
  if (match) {
    return { morning: Number(match[1]), noon: Number(match[2]), night: Number(match[3]) };
  }
  return { morning: 0, noon: 0, night: 1 };
}

function paper(key: string): PaperDefinition {
  const fallback: PaperDefinition = { key: 'a4', label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297, continuous: false };
  return PAPER_SIZES.find((candidate) => candidate.key === key) ?? PAPER_SIZES[0] ?? fallback;
}

interface PrinterProfileSeed {
  readonly name: string;
  readonly kind: 'prescription' | 'invoice' | 'report' | 'patient_summary';
  readonly paperKey: string;
  readonly isThermal: boolean;
  readonly isDefault: boolean;
  readonly headerNote?: string;
  readonly footerNote?: string;
}

interface PrintTemplateSeed {
  readonly kind: PrintTemplateKind;
  readonly name: string;
  readonly headerText: string;
  readonly footerText: string;
  readonly showLogo: boolean;
  readonly showDentistSignature: boolean;
  readonly showDentistQualifications: boolean;
  readonly signatureLabel: string;
  readonly isDefault: boolean;
}

/**
 * Seed everything. Safe to call on every start-up and safe to call twice.
 */
export function seedReferenceData(db: SqliteDatabase, deps: SeedDependencies, ctx: () => CoreContext | null): SeedResult {
  const now = nowInstant();

  // --- Roles (kept in step with the code) ---------------------------------
  deps.users.ensureSystemRoles();

  // --- Clinic (single row, created blank and filled by the setup wizard) --
  let createdClinic = false;
  const clinicRow = db.prepare(`SELECT id FROM clinic WHERE id = 1`).get();
  if (!clinicRow) {
    db.prepare(
      `INSERT INTO clinic (id, name, address, phone, email, website, clinic_message,` +
        ` visiting_hours, registration_number, created_at, updated_at)
       VALUES (1, '', '', '', '', '', '', '', '', ?, ?)`,
    ).run(now, now);
    createdClinic = true;
  }

  // --- Payment methods ----------------------------------------------------
  let paymentMethods = 0;
  const insertPayment = db.prepare(
    `INSERT INTO payment_methods (code, name, category, requires_reference, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  DEFAULT_PAYMENT_METHODS.forEach((method, index) => {
    if (exists(db, 'payment_methods', 'code', method.code)) return;
    insertPayment.run(method.code, method.name, method.category, method.requiresReference ? 1 : 0, index, now, now);
    paymentMethods += 1;
  });

  // --- Clinical options ---------------------------------------------------
  let clinicalOptions = 0;
  const insertOption = db.prepare(
    `INSERT INTO clinical_options (category, label, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
  );
  for (const category of ['cc', 'oe', 're', 'advice'] as const) {
    DEFAULT_CLINICAL_OPTIONS[category].forEach((label, index) => {
      const duplicate = db
        .prepare(`SELECT 1 AS present FROM clinical_options WHERE category = ? AND lower(label) = lower(?)`)
        .get(category, label) as { present: number } | undefined;
      if (duplicate) return;
      insertOption.run(category, label, index, now, now);
      clinicalOptions += 1;
    });
  }

  // --- Medications --------------------------------------------------------
  let medications = 0;
  const insertMedication = db.prepare(
    `INSERT INTO medications
       (name, form, strength, default_dose_morning, default_dose_noon, default_dose_night,
        default_food_timing, default_duration_days, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const medication of DEFAULT_MEDICATIONS) {
    if (exists(db, 'medications', 'name', medication.name)) continue;
    const dose = parseDose(medication.defaultDose);
    const form = (MEDICATION_FORMS as ReadonlyArray<{ value: string }>).some((option) => option.value === medication.form)
      ? medication.form
      : 'tablet';
    // Seeded medications are all taken after food unless the dose text says otherwise.
    const timing = 'after_food';
    insertMedication.run(
      medication.name,
      form,
      medication.strength ?? '',
      dose.morning,
      dose.noon,
      dose.night,
      timing,
      medication.defaultDurationDays ?? null,
      now,
      now,
    );
    medications += 1;
  }

  // --- Treatment catalog --------------------------------------------------
  let treatments = 0;
  const insertTreatment = db.prepare(
    `INSERT INTO treatment_catalog (code, name, category, description, price_paisa, duration_minutes, is_active, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, 1, ?, ?)`,
  );
  for (const treatment of DEFAULT_TREATMENTS) {
    if (exists(db, 'treatment_catalog', 'code', treatment.code)) continue;
    insertTreatment.run(treatment.code, treatment.name, treatment.category, treatment.pricePaisa, treatment.durationMinutes, now, now);
    treatments += 1;
  }

  // --- Accounting categories ---------------------------------------------
  const beforeCategories = count(db, 'accounting_categories');
  deps.accounting.seedCategories(DEFAULT_INCOME_CATEGORIES, DEFAULT_EXPENSE_CATEGORIES);
  const accountingCategories = count(db, 'accounting_categories') - beforeCategories;

  // --- Inventory categories ----------------------------------------------
  let inventoryCategories = 0;
  const insertInventoryCategory = db.prepare(
    `INSERT INTO inventory_categories (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  );
  for (const name of DEFAULT_INVENTORY_CATEGORIES) {
    if (exists(db, 'inventory_categories', 'name', name)) continue;
    insertInventoryCategory.run(name, '', now, now);
    inventoryCategories += 1;
  }

  // --- Printer profiles ---------------------------------------------------
  const profileSeeds: PrinterProfileSeed[] = [
    { name: 'Prescription — A4', kind: 'prescription', paperKey: 'a4', isThermal: false, isDefault: true },
    { name: 'Prescription — Thermal 80 mm', kind: 'prescription', paperKey: 'thermal_80', isThermal: true, isDefault: false },
    { name: 'Invoice — A4', kind: 'invoice', paperKey: 'a4', isThermal: false, isDefault: true },
    { name: 'Report — A4', kind: 'report', paperKey: 'a4', isThermal: false, isDefault: true },
    { name: 'Patient summary — A4', kind: 'patient_summary', paperKey: 'a4', isThermal: false, isDefault: true },
  ];
  let printerProfiles = 0;
  const insertProfile = db.prepare(
    `INSERT INTO printer_profiles
       (name, kind, printer_name, paper_key, width_mm, height_mm, orientation, margin_top_mm, margin_right_mm,
        margin_bottom_mm, margin_left_mm, scale_percent, copies, is_thermal, is_default, is_active,
        header_note, footer_note, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, 'portrait', 12, 12, 12, 12, 100, 1, ?, ?, 1, '', '', ?, ?)`,
  );
  for (const seed of profileSeeds) {
    const duplicate = db.prepare(`SELECT 1 AS present FROM printer_profiles WHERE name = ?`).get(seed.name) as
      | { present: number }
      | undefined;
    if (duplicate) continue;
    const definition = paper(seed.paperKey);
    insertProfile.run(
      seed.name,
      seed.kind,
      definition.key,
      definition.key === 'custom' ? 210 : definition.widthMm,
      definition.continuous ? 297 : definition.heightMm,
      seed.isThermal ? 1 : 0,
      seed.isDefault ? 1 : 0,
      now,
      now,
    );
    printerProfiles += 1;
  }

  // --- Print templates ----------------------------------------------------
  const templateSeeds: PrintTemplateSeed[] = [
    {
      kind: 'prescription',
      name: 'Prescription — standard',
      headerText: '',
      footerText: '',
      showLogo: true,
      showDentistSignature: true,
      showDentistQualifications: true,
      signatureLabel: 'Signature',
      isDefault: true,
    },
    {
      kind: 'invoice',
      name: 'Invoice — standard',
      headerText: '',
      footerText: '',
      showLogo: true,
      showDentistSignature: false,
      showDentistQualifications: false,
      signatureLabel: 'Received by',
      isDefault: true,
    },
    {
      kind: 'report',
      name: 'Report — standard',
      headerText: '',
      footerText: '',
      showLogo: true,
      showDentistSignature: false,
      showDentistQualifications: false,
      signatureLabel: '',
      isDefault: true,
    },
    {
      kind: 'patient_summary',
      name: 'Patient summary — standard',
      headerText: '',
      footerText: '',
      showLogo: true,
      showDentistSignature: false,
      showDentistQualifications: false,
      signatureLabel: '',
      isDefault: true,
    },
  ];
  let printTemplates = 0;
  const insertTemplate = db.prepare(
    `INSERT INTO print_templates
       (kind, name, header_text, footer_text, show_logo, show_dentist_signature, show_dentist_qualifications,
        signature_label, accent_colour, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '#0B2545', ?, ?, ?)`,
  );
  for (const seed of templateSeeds) {
    const duplicate = db.prepare(`SELECT 1 AS present FROM print_templates WHERE kind = ? AND name = ?`).get(seed.kind, seed.name);
    if (duplicate) continue;
    insertTemplate.run(
      seed.kind,
      seed.name,
      seed.headerText,
      seed.footerText,
      seed.showLogo ? 1 : 0,
      seed.showDentistSignature ? 1 : 0,
      seed.showDentistQualifications ? 1 : 0,
      seed.signatureLabel,
      seed.isDefault ? 1 : 0,
      now,
      now,
    );
    printTemplates += 1;
  }

  // --- Meta ---------------------------------------------------------------
  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO NOTHING`).run(now);
  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seeded_by_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    APP_VERSION,
  );

  ctx()?.logger.debug('reference data seeded', {
    paymentMethods,
    clinicalOptions,
    medications,
    treatments,
    inventoryCategories,
    printerProfiles,
    printTemplates,
  });

  return {
    roles: count(db, 'roles'),
    paymentMethods,
    clinicalOptions,
    medications,
    treatments,
    accountingCategories,
    inventoryCategories,
    printerProfiles,
    printTemplates,
    createdClinic,
  };
}
