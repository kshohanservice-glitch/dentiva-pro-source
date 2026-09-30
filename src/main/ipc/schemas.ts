/**
 * Zod payload schemas for every IPC method.
 *
 * The renderer is treated as untrusted input: nothing reaches a service before
 * it has passed through the matching schema. Unknown keys are stripped rather
 * than rejected, so a newer renderer talking to an older main process degrades
 * gracefully, while wrong types, out-of-range numbers and unknown enum values
 * are refused with a field-level message the UI can show next to the input.
 */
import { z } from 'zod';
import type { ApiMethodName } from '@shared/api';
import {
  ACCOUNTING_DIRECTIONS,
  APPOINTMENT_STATUSES,
  ATTACHMENT_CATEGORIES,
  AUTO_LOCK_OPTIONS,
  BACKUP_INTERVAL_OPTIONS,
  BLOOD_GROUPS,
  CLINICAL_OPTION_CATEGORIES,
  DENSITY_MODES,
  FOOD_TIMINGS,
  GENDERS,
  INVENTORY_UNITS,
  INVOICE_STATUSES,
  MEDICATION_FORMS,
  PAPER_SIZES,
  PATIENT_STATUSES,
  PAYMENT_METHOD_CATEGORIES,
  PRINT_TEMPLATE_KINDS,
  QUEUE_PRIORITIES,
  QUEUE_STATUSES,
  REFERRAL_STATUSES,
  STOCK_MOVEMENT_TYPES,
  THEME_MODES,
  TOOTH_FINDING_TYPES,
  TOOTH_NUMBERING_SYSTEMS,
  TOOTH_SURFACES,
} from '@shared/constants';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function enumOf<T extends string>(values: readonly T[]): z.ZodType<T> {
  return z.enum(values as unknown as [T, ...T[]]);
}

/** Numeric enumerations (auto-lock minutes, backup interval days). */
function numberEnumOf<T extends number>(values: readonly T[]): z.ZodType<T> {
  return z.union(values.map((value) => z.literal(value)) as [z.ZodLiteral<T>, ...Array<z.ZodLiteral<T>>]);
}

const valuesOf = <T extends string>(list: ReadonlyArray<{ value: T }>): T[] => list.map((entry) => entry.value);

const id = z.number().int().positive().max(2_147_483_646);
const nullableId = id.nullable();
const optionalId = id.optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const isoTime = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.');
const isoInstant = z.string().min(10).max(40);
const text = z.string().max(2000);
const shortText = z.string().max(200);
const nonNegativeMoney = z.number().int().min(0).max(9_000_000_000);
const quantity = z.number().min(-1_000_000).max(1_000_000);
const smallCount = z.number().int().min(0).max(1_000_000);
const percent = z.number().min(0).max(100);
const sortDirection = enumOf(['asc', 'desc'] as const);
const enabled = z.boolean();
const empty = z.unknown().optional();

const listQueryShape = {
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  search: shortText.optional(),
  sort: z.string().max(60).optional(),
  direction: sortDirection.optional(),
  preset: z.string().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
};

const listQuery = z.object(listQueryShape);
const rangeQuery = z.object({
  preset: z.string().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
const deleteOptions = z.object({
  reason: text.optional(),
  confirmText: shortText.optional(),
});

// ---------------------------------------------------------------------------
// Domain inputs
// ---------------------------------------------------------------------------

const patientInput = z.object({
  firstName: z.string().min(1).max(120),
  lastName: z.string().max(120),
  gender: enumOf(valuesOf(GENDERS)),
  dob: isoDate.nullable(),
  ageYears: z.number().int().min(0).max(130).nullable(),
  bloodGroup: enumOf(BLOOD_GROUPS.map((entry) => entry.value)),
  phone: z.string().max(40),
  alternatePhone: z.string().max(40),
  email: z.string().max(160),
  address: text,
  city: shortText,
  emergencyContactName: z.string().max(120),
  emergencyPhone: z.string().max(40),
  chiefComplaint: text,
  previousProblems: text,
  medicalNotes: text,
  allergies: text,
  notes: text,
  preferredContact: enumOf(['mobile', 'phone', 'sms', 'email', 'none'] as const),
  status: enumOf(valuesOf(PATIENT_STATUSES)),
  referredBy: z.string().max(160),
  tagIds: z.array(id).max(50),
});

const toothFinding = z.object({
  toothFdi: z.string().min(1).max(4),
  finding: enumOf(valuesOf(TOOTH_FINDING_TYPES)),
  surfaces: z.array(enumOf(valuesOf(TOOTH_SURFACES))).max(6),
  mobilityGrade: numberEnumOf([0, 1, 2, 3] as const),
  note: text,
});

const treatmentRecordInput = z.object({
  id: nullableId.optional(),
  treatmentId: nullableId,
  code: z.string().max(40).optional(),
  description: text,
  toothCodes: z.array(z.string().max(4)).max(32),
  quantity: z.number().min(0).max(1000),
  unitPricePaisa: nonNegativeMoney,
  discountPaisa: nonNegativeMoney,
  notes: text,
});

const visitInput = z.object({
  patientId: id,
  dentistId: nullableId,
  visitDate: isoDate,
  visitTime: isoTime,
  chiefComplaint: text,
  history: text,
  examination: text,
  diagnosis: text,
  ccOptions: z.array(z.string().max(200)).max(80),
  oeOptions: z.array(z.string().max(200)).max(80),
  reOptions: z.array(z.string().max(200)).max(80),
  adviceOptions: z.array(z.string().max(200)).max(80),
  advice: text,
  notes: text,
  followUpDate: isoDate.nullable(),
  treatments: z.array(treatmentRecordInput).max(60),
  dentalFindings: z.array(toothFinding).max(200),
  prescriptionId: nullableId,
});

const prescriptionItem = z.object({
  id: nullableId.optional(),
  medicationId: nullableId,
  name: z.string().min(1).max(160),
  form: enumOf(valuesOf(MEDICATION_FORMS)),
  strength: z.string().max(80),
  doseMorning: z.number().min(0).max(20),
  doseNoon: z.number().min(0).max(20),
  doseNight: z.number().min(0).max(20),
  foodTiming: enumOf(valuesOf(FOOD_TIMINGS)),
  durationDays: z.number().int().min(0).max(365).nullable(),
  quantity: z.number().min(0).max(1000).nullable(),
  instructions: text,
  sortOrder: z.number().int().min(0).max(200),
});

const prescriptionInput = z.object({
  patientId: id,
  dentistId: nullableId,
  visitId: nullableId,
  date: isoDate,
  cc: z.array(z.string().max(200)).max(40),
  oe: z.array(z.string().max(200)).max(40),
  re: z.array(z.string().max(200)).max(40),
  advice: z.array(z.string().max(200)).max(40),
  notes: text,
  items: z.array(prescriptionItem).max(40),
});

const appointmentInput = z.object({
  patientId: id,
  dentistId: nullableId,
  date: isoDate,
  startTime: isoTime,
  endTime: isoTime,
  reason: text,
  notes: text,
  status: enumOf(valuesOf(APPOINTMENT_STATUSES)),
  reminderNote: text,
});

const queueInput = z.object({
  patientId: id,
  dentistId: nullableId,
  appointmentId: nullableId,
  priority: enumOf(valuesOf(QUEUE_PRIORITIES)),
  notes: text,
});

const invoiceItem = z.object({
  id: nullableId.optional(),
  treatmentId: nullableId,
  treatmentRecordId: nullableId.optional(),
  code: z.string().max(40),
  description: z.string().min(1).max(300),
  toothCodes: z.array(z.string().max(4)).max(32),
  quantity: z.number().min(0).max(1000),
  unitPricePaisa: nonNegativeMoney,
  discountType: enumOf(['none', 'percent', 'amount'] as const),
  discountValue: percent,
  sortOrder: z.number().int().min(0).max(200),
});

const invoiceInput = z.object({
  patientId: id,
  visitId: nullableId,
  dentistId: nullableId,
  date: isoDate,
  notes: text,
  items: z.array(invoiceItem).max(80),
  discountType: enumOf(['none', 'percent', 'amount'] as const).optional(),
  discountValue: percent.optional(),
});

const paymentInput = z.object({
  invoiceId: id,
  amountPaisa: nonNegativeMoney,
  methodId: nullableId,
  reference: shortText,
  note: text,
  paidAtInstant: isoInstant.optional(),
  paidDate: isoDate.optional(),
});

const inventoryItemInput = z.object({
  code: z.string().max(40),
  name: z.string().min(1).max(160),
  categoryId: nullableId,
  supplierId: nullableId,
  unit: enumOf(INVENTORY_UNITS),
  purchasePricePaisa: nonNegativeMoney,
  sellingPricePaisa: nonNegativeMoney.nullable(),
  minimumStockMilli: smallCount,
  reorderLevelMilli: smallCount,
  batchNumber: z.string().max(60),
  expiryDate: isoDate.nullable(),
  purchaseDate: isoDate.nullable(),
  storageLocation: z.string().max(120),
  notes: text,
  isActive: enabled,
});

const stockMovementInput = z.object({
  itemId: id,
  type: enumOf(valuesOf(STOCK_MOVEMENT_TYPES)),
  quantityMilli: quantity,
  unitCostPaisa: nonNegativeMoney.nullable(),
  reason: text,
  reference: shortText,
  batchNumber: z.string().max(60).optional(),
  expiryDate: isoDate.nullable().optional(),
});

const purchaseItem = z.object({
  id: nullableId.optional(),
  itemId: nullableId,
  itemName: z.string().max(160),
  unit: enumOf(INVENTORY_UNITS),
  quantityMilli: quantity,
  unitPricePaisa: nonNegativeMoney,
  batchNumber: z.string().max(60),
  expiryDate: isoDate.nullable(),
  createItemIfMissing: enabled.optional(),
  categoryId: nullableId.optional(),
});

const purchaseInput = z.object({
  supplierId: nullableId,
  date: isoDate,
  invoiceNumber: z.string().max(60),
  paymentMethodId: nullableId,
  paidPaisa: nonNegativeMoney,
  discountPaisa: nonNegativeMoney,
  notes: text,
  recordAsExpense: enabled,
  items: z.array(purchaseItem).min(1).max(80),
});

const accountingInput = z.object({
  direction: enumOf(valuesOf(ACCOUNTING_DIRECTIONS)),
  date: isoDate,
  categoryId: id,
  amountPaisa: nonNegativeMoney,
  paymentMethodId: nullableId,
  reference: shortText,
  note: text,
});

const staffInput = z.object({
  name: z.string().min(1).max(160),
  designation: z.string().max(120),
  department: z.string().max(120),
  phone: z.string().max(40),
  email: z.string().max(160),
  address: text,
  dob: isoDate.nullable(),
  bloodGroup: enumOf(BLOOD_GROUPS.map((entry) => entry.value)),
  nationalId: z.string().max(40),
  salaryPaisa: nonNegativeMoney.nullable(),
  joiningDate: isoDate.nullable(),
  status: enumOf(['active', 'on_leave', 'resigned'] as const),
  notes: text,
  userId: nullableId,
});

const dentistCredential = z.object({
  id: nullableId.optional(),
  type: enumOf(['designation', 'qualification', 'certification'] as const),
  title: z.string().max(200),
  institution: z.string().max(200),
  year: z.number().int().min(1900).max(2100).nullable(),
  sortOrder: z.number().int().min(0).max(100),
  showOnPrescription: enabled,
});

const dentistInput = z.object({
  name: z.string().min(1).max(160),
  phone: z.string().max(40),
  email: z.string().max(160),
  registrationNumber: z.string().max(60),
  visitingHours: z.string().max(120),
  isActive: enabled,
  isDefault: enabled,
  credentials: z.array(dentistCredential).max(30),
});

const userInput = z.object({
  username: z.string().min(3).max(60),
  fullName: z.string().min(1).max(160),
  email: z.string().max(160),
  phone: z.string().max(40),
  isActive: enabled,
  mustChangePassword: enabled,
  roleIds: z.array(id).max(30),
});

const roleInput = z.object({
  key: z.string().max(40).optional(),
  name: z.string().min(1).max(120),
  description: text,
  permissions: z.array(z.string().max(60)).max(200),
});

const treatmentInput = z.object({
  code: z.string().max(40),
  name: z.string().min(1).max(200),
  category: z.string().max(120),
  description: text,
  pricePaisa: nonNegativeMoney,
  durationMinutes: z.number().int().min(0).max(1440),
  isActive: enabled,
});

const planInput = z.object({
  patientId: id,
  title: z.string().min(1).max(200),
  status: enumOf(['draft', 'active', 'completed', 'cancelled'] as const),
  notes: text,
});

const planItemInput = z.object({
  id: nullableId.optional(),
  treatmentId: nullableId,
  description: z.string().min(1).max(300),
  toothCodes: z.array(z.string().max(4)).max(32),
  sessionNumber: z.number().int().min(1).max(200),
  estimatedPaisa: nonNegativeMoney,
  status: enumOf(['pending', 'in_progress', 'completed', 'cancelled'] as const),
  notes: text,
  completedVisitId: nullableId.optional(),
});

const referralInput = z.object({
  patientId: id,
  visitId: nullableId,
  referralDoctorId: nullableId,
  doctorName: z.string().max(160),
  specialty: z.string().max(120),
  organisation: z.string().max(160),
  contact: z.string().max(120),
  reason: text,
  date: isoDate,
  followUpDate: isoDate.nullable(),
  status: enumOf(valuesOf(REFERRAL_STATUSES)),
  notes: text,
});

// --- Generic master data ----------------------------------------------------

const patientTagInput = z.object({ name: z.string().min(1).max(80), colour: z.string().max(20) });
const medicationInput = z.object({
  name: z.string().min(1).max(160),
  form: enumOf(valuesOf(MEDICATION_FORMS)),
  strength: z.string().max(80),
  defaultDoseMorning: z.number().min(0).max(20),
  defaultDoseNoon: z.number().min(0).max(20),
  defaultDoseNight: z.number().min(0).max(20),
  defaultFoodTiming: enumOf(valuesOf(FOOD_TIMINGS)),
  defaultDurationDays: z.number().int().min(0).max(365).nullable(),
  isActive: enabled,
});
const clinicalOptionInput = z.object({
  category: enumOf(valuesOf(CLINICAL_OPTION_CATEGORIES)),
  label: z.string().min(1).max(200),
  sortOrder: z.number().int().min(0).max(9999),
  isActive: enabled,
});
const paymentMethodInput = z.object({
  code: z.string().max(40),
  name: z.string().min(1).max(120),
  category: enumOf(valuesOf(PAYMENT_METHOD_CATEGORIES)),
  requiresReference: enabled,
  isActive: enabled,
  sortOrder: z.number().int().min(0).max(9999),
});
const inventoryCategoryInput = z.object({ name: z.string().min(1).max(120), description: text });
const supplierInput = z.object({
  name: z.string().min(1).max(160),
  contactPerson: z.string().max(120),
  phone: z.string().max(40),
  email: z.string().max(160),
  address: text,
  notes: text,
  isActive: enabled,
});
const accountingCategoryInput = z.object({
  name: z.string().min(1).max(120),
  direction: enumOf(valuesOf(ACCOUNTING_DIRECTIONS)),
  isActive: enabled,
});
const referralDoctorInput = z.object({
  name: z.string().min(1).max(160),
  specialty: z.string().max(120),
  organisation: z.string().max(160),
  phone: z.string().max(40),
  email: z.string().max(160),
  address: text,
  notes: text,
  isActive: enabled,
});
const printerProfileInput = z.object({
  name: z.string().min(1).max(120),
  kind: enumOf(valuesOf(PRINT_TEMPLATE_KINDS)),
  printerName: z.string().max(200),
  paperKey: enumOf(PAPER_SIZES.map((entry) => entry.key)),
  widthMm: z.number().min(20).max(2000),
  heightMm: z.number().min(20).max(2000),
  orientation: enumOf(['portrait', 'landscape'] as const),
  marginTopMm: z.number().min(0).max(50),
  marginRightMm: z.number().min(0).max(50),
  marginBottomMm: z.number().min(0).max(50),
  marginLeftMm: z.number().min(0).max(50),
  scalePercent: z.number().min(50).max(200),
  copies: z.number().int().min(1).max(20),
  isThermal: enabled,
  isDefault: enabled,
  isActive: enabled,
  headerNote: text,
  footerNote: text,
});
const printTemplateInput = z.object({
  kind: enumOf(valuesOf(PRINT_TEMPLATE_KINDS)),
  name: z.string().min(1).max(120),
  headerText: text,
  footerText: text,
  showLogo: enabled,
  showDentistSignature: enabled,
  showDentistQualifications: enabled,
  signatureLabel: z.string().max(120),
  accentColour: z.string().max(20),
  isDefault: enabled,
});

const RESOURCE_INPUT_SCHEMAS = {
  'patient-tags': patientTagInput,
  medications: medicationInput,
  'clinical-options': clinicalOptionInput,
  'payment-methods': paymentMethodInput,
  'inventory-categories': inventoryCategoryInput,
  suppliers: supplierInput,
  'accounting-categories': accountingCategoryInput,
  'referral-doctors': referralDoctorInput,
  'printer-profiles': printerProfileInput,
  'print-templates': printTemplateInput,
  treatments: treatmentInput,
} as const;

const resourceName = enumOf(Object.keys(RESOURCE_INPUT_SCHEMAS) as Array<keyof typeof RESOURCE_INPUT_SCHEMAS>);

const resourceQuery = z.object({
  ...listQueryShape,
  category: z.string().max(120).nullable().optional(),
  isActive: enabled.optional(),
  form: z
    .array(enumOf(valuesOf(MEDICATION_FORMS)))
    .max(20)
    .optional(),
  includeInactive: enabled.optional(),
});

// --- Reports, printing, backup ---------------------------------------------

const REPORT_KEYS = [
  'patients_registered',
  'patient_register_detail',
  'appointments',
  'no_shows',
  'visits',
  'treatments',
  'prescriptions',
  'revenue',
  'payments',
  'outstanding',
  'expenses',
  'income',
  'profit',
  'inventory_stock',
  'inventory_low_stock',
  'inventory_expiry',
  'inventory_movements',
  'dentist_activity',
  'staff_activity',
  'referrals',
  'audit_summary',
  'daybook',
] as const;

const reportRequest = z.object({
  reportKey: enumOf(REPORT_KEYS),
  from: isoDate,
  to: isoDate,
  filters: z
    .object({
      dentistId: nullableId.optional(),
      patientId: nullableId.optional(),
      categoryId: nullableId.optional(),
      supplierId: nullableId.optional(),
      itemId: nullableId.optional(),
      status: z.string().max(40).nullable().optional(),
      paymentMethodId: nullableId.optional(),
      direction: enumOf(valuesOf(ACCOUNTING_DIRECTIONS)).nullable().optional(),
    })
    .optional(),
  groupBy: enumOf(['day', 'week', 'month', 'category', 'dentist', 'patient', 'method'] as const)
    .nullable()
    .optional(),
});

const printRequest = z.object({
  kind: enumOf(valuesOf(PRINT_TEMPLATE_KINDS)),
  id: nullableId.optional(),
  report: reportRequest.nullable().optional(),
  profileId: nullableId.optional(),
  templateId: nullableId.optional(),
  output: enumOf(['pdf', 'print', 'preview'] as const),
  copies: z.number().int().min(1).max(20).nullable().optional(),
});

const settingsPatch = z.object({
  theme: enumOf(valuesOf(THEME_MODES)).optional(),
  density: enumOf(valuesOf(DENSITY_MODES)).optional(),
  dateFormat: z.string().max(40).optional(),
  timeFormat: z.string().max(40).optional(),
  timeZone: z.string().max(60).optional(),
  numberGrouping: enumOf(['international', 'south_asian'] as const).optional(),
  autoLockMinutes: numberEnumOf(AUTO_LOCK_OPTIONS.map((entry) => entry.value)).optional(),
  passwordMinLength: z.number().int().min(6).max(40).optional(),
  maxFailedAttempts: z.number().int().min(3).max(20).optional(),
  lockoutMinutes: z.number().int().min(1).max(240).optional(),
  backupFolder: z.string().max(500).optional(),
  backupIntervalDays: numberEnumOf(BACKUP_INTERVAL_OPTIONS.map((entry) => entry.value)).optional(),
  defaultPrescriptionProfileId: nullableId.optional(),
  defaultInvoiceProfileId: nullableId.optional(),
  defaultReportProfileId: nullableId.optional(),
  defaultToothNumbering: enumOf(valuesOf(TOOTH_NUMBERING_SYSTEMS)).optional(),
  defaultDentition: enumOf(['permanent', 'primary'] as const).optional(),
  appointmentSlotMinutes: z.number().int().min(5).max(240).optional(),
  queuePrefix: z.string().max(10).optional(),
  lowStockWarningFactor: z.number().min(1).max(5).optional(),
  expiryWarningDays: z.number().int().min(1).max(365).optional(),
  invoiceFooterNote: text.optional(),
  prescriptionFooterNote: text.optional(),
  showFinancialWidgetsForStaff: enabled.optional(),
  lastAutomaticBackupAt: isoInstant.nullable().optional(),
});

// ---------------------------------------------------------------------------
// The schema table
// ---------------------------------------------------------------------------

/**
 * The schema table. `satisfies` keeps the literal type of every entry, so the
 * handler map can derive each method's payload type from its own schema — a
 * handler that reads a field its schema does not allow is a compile error.
 */
export const SCHEMAS = {
  // Application shell & session
  'app.bootstrap': empty,
  'app.health': empty,
  'app.systemInfo': empty,
  'app.relaunch': empty,
  'app.openPath': z.object({ path: z.string().min(1).max(1000), reveal: enabled.optional() }),
  'app.openExternal': z.object({ url: z.string().url().max(1000) }),

  'auth.login': z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }),
  'auth.logout': empty,
  'auth.lock': empty,
  'auth.unlock': z.object({ password: z.string().min(1).max(200) }),
  'auth.changePassword': z.object({ currentPassword: z.string().max(200), newPassword: z.string().min(6).max(200) }),
  'auth.session': empty,

  'activation.status': empty,
  'activation.activate': z.object({ code: z.string().min(8).max(64) }),

  'setup.status': empty,
  'setup.saveClinic': z.object({
    name: z.string().min(1).max(200),
    address: text,
    phone: z.string().max(40),
    email: z.string().max(160),
    website: z.string().max(200),
    logoSourcePath: z.string().max(1000).nullable().optional(),
  }),
  'setup.saveDentists': z.object({ dentists: z.array(dentistInput).max(30) }),
  'setup.savePreferences': z.object({
    dateFormat: z.string().max(40),
    timeFormat: z.string().max(40),
    timeZone: z.string().max(60),
    numberGrouping: enumOf(['international', 'south_asian'] as const),
    autoLockMinutes: numberEnumOf(AUTO_LOCK_OPTIONS.map((entry) => entry.value)),
    backupFolder: z.string().max(500),
    backupIntervalDays: numberEnumOf(BACKUP_INTERVAL_OPTIONS.map((entry) => entry.value)),
    defaultPrinterName: z.string().max(200),
  }),
  'setup.createAdministrator': z.object({
    username: z.string().min(3).max(60),
    fullName: z.string().min(1).max(160),
    password: z.string().min(6).max(200),
  }),
  'setup.review': empty,
  'setup.complete': empty,

  'clinic.get': empty,
  'clinic.update': z.object({
    name: z.string().min(1).max(200),
    address: text,
    phone: z.string().max(40),
    email: z.string().max(160),
    website: z.string().max(200),
    clinicMessage: text,
    visitingHours: z.string().max(200),
    registrationNumber: z.string().max(80),
    logoSourcePath: z.string().max(1000).nullable().optional(),
    removeLogo: enabled.optional(),
  }),
  'settings.get': empty,
  'settings.update': z.object({ patch: settingsPatch }),

  // Generic master data
  'resource.list': z.object({ resource: resourceName, query: resourceQuery.optional(), includeInactive: enabled.optional() }),
  'resource.get': z.object({ resource: resourceName, id }),
  'resource.save': z.object({
    resource: resourceName,
    id: nullableId.optional(),
    input: z.unknown(),
  }),
  'resource.delete': z.object({ resource: resourceName, id, options: deleteOptions.optional() }),
  'resource.restore': z.object({ resource: resourceName, id }),
  'resource.options': z.object({ resource: resourceName }),

  // Patients
  'patients.list': z.object({
    ...listQueryShape,
    status: z
      .array(enumOf(valuesOf(PATIENT_STATUSES)))
      .max(4)
      .optional(),
    tagIds: z.array(id).max(30).optional(),
    gender: z
      .array(enumOf(valuesOf(GENDERS)))
      .max(4)
      .optional(),
    bloodGroup: z
      .array(enumOf(BLOOD_GROUPS.map((entry) => entry.value)))
      .max(12)
      .optional(),
    hasMedicalAlert: enabled.optional(),
    hasOutstanding: enabled.optional(),
    includeDeleted: enabled.optional(),
  }),
  'patients.get': z.object({ id }),
  'patients.create': z.object({ input: patientInput }),
  'patients.update': z.object({ id, input: patientInput }),
  'patients.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'patients.restore': z.object({ id }),
  'patients.timeline': z.object({
    id,
    types: z.array(z.string().max(40)).max(30).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  'patients.financialSummary': z.object({ id }),
  'patients.checkDuplicate': z.object({
    name: shortText.optional(),
    phone: z.string().max(40).optional(),
    excludeId: optionalId,
  }),
  'patients.statistics': rangeQuery,
  'patients.tags.save': z.object({ id: nullableId.optional(), name: z.string().min(1).max(80), colour: z.string().max(20) }),
  'patients.setTags': z.object({ id, tagIds: z.array(id).max(50) }),
  'patients.quickSearch': z.object({ query: z.string().max(120), limit: z.number().int().min(1).max(50).optional() }),

  // Attachments
  'attachments.list': z.union([z.object({ entityType: z.string().max(40), entityId: id }), z.object({ patientId: id })]),
  'attachments.pickAndAdd': z.object({
    entityType: z.string().max(40),
    entityId: id,
    patientId: nullableId,
    category: enumOf(valuesOf(ATTACHMENT_CATEGORIES)),
    description: text,
    copyFromPath: z.string().max(1000).nullable().optional(),
  }),
  'attachments.update': z.object({
    id,
    fileName: z.string().max(260).optional(),
    category: enumOf(valuesOf(ATTACHMENT_CATEGORIES)).optional(),
    description: text.optional(),
  }),
  'attachments.delete': z.object({ id, reason: text.optional() }),
  'attachments.open': z.object({ id }),
  'attachments.revealInFolder': z.object({ id }),
  'attachments.thumbnail': z.object({ id, maxPixels: z.number().int().min(16).max(4096).optional() }),

  // Visits
  'visits.list': listQuery.extend({ patientId: optionalId, dentistId: nullableId.optional() }),
  'visits.get': z.object({ id }),
  'visits.create': z.object({ input: visitInput }),
  'visits.update': z.object({ id, input: visitInput }),
  'visits.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'visits.byPatient': z.object({ patientId: id, limit: z.number().int().min(1).max(500).optional() }),
  'visits.statistics': rangeQuery.extend({ dentistId: nullableId.optional() }),

  // Dental chart
  'dental.getChart': z.object({
    patientId: id,
    dentition: enumOf(['permanent', 'primary'] as const).optional(),
    numberingSystem: enumOf(valuesOf(TOOTH_NUMBERING_SYSTEMS)).optional(),
  }),
  'dental.saveFindings': z.object({
    patientId: id,
    dentition: enumOf(['permanent', 'primary'] as const),
    findings: z.array(toothFinding).max(200),
    visitId: nullableId.optional(),
    clearTeeth: z.array(z.string().max(4)).max(32).optional(),
  }),
  'dental.history': z.object({ patientId: id, toothFdi: z.string().min(1).max(4) }),
  'dental.savePerio': z.object({
    patientId: id,
    records: z
      .array(z.object({ toothFdi: z.string().min(1).max(4), site: z.string().max(8), depthMm: z.number().min(0).max(30) }))
      .max(500),
  }),
  'dental.clear': z.object({
    patientId: id,
    dentition: enumOf(['permanent', 'primary'] as const),
    confirmText: shortText.optional(),
  }),

  // Prescriptions
  'prescriptions.list': listQuery.extend({ patientId: optionalId, dentistId: nullableId.optional(), includeVoid: enabled.optional() }),
  'prescriptions.get': z.object({ id }),
  'prescriptions.create': z.object({ input: prescriptionInput }),
  'prescriptions.update': z.object({ id, input: prescriptionInput }),
  'prescriptions.void': z.object({ id, reason: z.string().min(1).max(1000) }),
  'prescriptions.delete': z.object({ id, reason: z.string().min(1).max(1000) }),
  'prescriptions.byPatient': z.object({ patientId: id, limit: z.number().int().min(1).max(500).optional() }),
  'prescriptions.supersede': z.object({ id, input: prescriptionInput, reason: z.string().min(1).max(1000) }),

  // Treatment plans & records
  'treatmentPlans.list': z.object({
    patientId: optionalId,
    status: z.string().max(30).optional(),
    page: listQueryShape.page,
    pageSize: listQueryShape.pageSize,
  }),
  'treatmentPlans.get': z.object({ id }),
  'treatmentPlans.create': z.object({ input: planInput }),
  'treatmentPlans.update': z.object({ id, input: planInput }),
  'treatmentPlans.delete': z.object({ id, reason: text.optional() }),
  'treatmentPlans.saveItem': z.object({ planId: id, input: planItemInput }),
  'treatmentPlans.deleteItem': z.object({ id, reason: text.optional() }),
  'treatmentPlans.completeItem': z.object({ id, visitId: nullableId }),
  // --- Referrals ----------------------------------------------------------
  'referrals.list': z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
    patientId: optionalId,
    status: enumOf(valuesOf(REFERRAL_STATUSES)).optional(),
    search: z.string().max(200).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  }),
  'referrals.get': z.object({ id }),
  'referrals.save': z.object({ id: id.nullable().optional(), input: referralInput }),
  'referrals.delete': z.object({ id, reason: z.string().min(3).max(1000) }),
  'referrals.byPatient': z.object({ patientId: id }),
  'referrals.statistics': z.object({ from: isoDate, to: isoDate }),

  'treatmentRecords.byPatient': z.object({ patientId: id, limit: z.number().int().min(1).max(500).optional() }),
  'treatmentRecords.byVisit': z.object({ visitId: id }),
  'treatmentRecords.delete': z.object({ id, reason: z.string().min(1).max(1000) }),

  // Appointments
  'appointments.list': z.object({
    ...listQueryShape,
    status: z
      .array(enumOf(valuesOf(APPOINTMENT_STATUSES)))
      .max(10)
      .optional(),
    dentistId: nullableId.optional(),
    patientId: optionalId,
    view: enumOf(['day', 'week', 'month', 'list'] as const).optional(),
    date: isoDate.optional(),
  }),
  'appointments.get': z.object({ id }),
  'appointments.create': z.object({ input: appointmentInput }),
  'appointments.update': z.object({ id, input: appointmentInput }),
  'appointments.delete': z.object({ id, reason: text.optional() }),
  'appointments.setStatus': z.object({
    id,
    status: enumOf(valuesOf(APPOINTMENT_STATUSES)),
    note: text.optional(),
  }),
  'appointments.byRange': z.object({
    from: isoDate,
    to: isoDate,
    dentistId: nullableId.optional(),
    statuses: z.array(z.string().max(30)).max(10).optional(),
  }),
  'appointments.byPatient': z.object({ patientId: id, limit: z.number().int().min(1).max(500).optional() }),
  'appointments.availability': z.object({ dentistId: nullableId, date: isoDate, excludeId: nullableId.optional() }),
  'appointments.statistics': rangeQuery.extend({ dentistId: nullableId.optional() }),

  // Queue
  'queue.list': z.object({ date: isoDate.optional(), includeClosed: enabled.optional() }),
  'queue.add': z.object({ input: queueInput }),
  'queue.setStatus': z.object({ id, status: enumOf(valuesOf(QUEUE_STATUSES)), note: text.optional() }),
  'queue.move': z.object({ id, direction: enumOf(['up', 'down'] as const) }),
  'queue.remove': z.object({ id, reason: text.optional() }),
  'queue.statistics': z.object({ date: isoDate.optional() }),

  // Invoices
  'invoices.list': z.object({
    ...listQueryShape,
    status: z
      .array(enumOf(valuesOf(INVOICE_STATUSES)))
      .max(5)
      .optional(),
    patientId: optionalId,
    hasOutstanding: enabled.optional(),
  }),
  'invoices.get': z.object({ id }),
  'invoices.create': z.object({ input: invoiceInput }),
  'invoices.update': z.object({ id, input: invoiceInput }),
  'invoices.void': z.object({ id, reason: z.string().min(1).max(1000) }),
  'invoices.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'invoices.byPatient': z.object({ patientId: id, limit: z.number().int().min(1).max(500).optional() }),
  'invoices.outstanding': z.object({
    page: listQueryShape.page,
    pageSize: listQueryShape.pageSize,
    search: shortText.optional(),
  }),
  'invoices.statistics': rangeQuery,

  // Payments
  'payments.list': listQuery.extend({
    patientId: optionalId,
    invoiceId: optionalId,
    methodId: nullableId.optional(),
    includeVoid: enabled.optional(),
  }),
  'payments.get': z.object({ id }),
  'payments.create': z.object({ input: paymentInput }),
  'payments.update': z.object({ id, input: paymentInput }),
  'payments.void': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'payments.byInvoice': z.object({ invoiceId: id }),
  'payments.byPatient': z.object({ patientId: id, limit: z.number().int().min(1).max(500).optional() }),
  'payments.statistics': rangeQuery,

  // Inventory
  'inventory.items.list': listQuery.extend({
    categoryId: nullableId.optional(),
    supplierId: nullableId.optional(),
    lowStockOnly: enabled.optional(),
    expiringOnly: enabled.optional(),
    includeInactive: enabled.optional(),
  }),
  'inventory.items.get': z.object({ id }),
  'inventory.items.save': z.object({
    id: nullableId.optional(),
    input: inventoryItemInput,
    openingStockMilli: smallCount.optional(),
  }),
  'inventory.items.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'inventory.items.options': empty,
  'inventory.movements.list': listQuery.extend({
    itemId: optionalId,
    type: z
      .array(enumOf(valuesOf(STOCK_MOVEMENT_TYPES)))
      .max(12)
      .optional(),
  }),
  'inventory.movements.create': z.object({ input: stockMovementInput }),
  'inventory.movements.delete': z.object({ id, reason: z.string().min(1).max(1000) }),
  'inventory.purchases.list': listQuery.extend({ supplierId: nullableId.optional() }),
  'inventory.purchases.get': z.object({ id }),
  'inventory.purchases.create': z.object({ input: purchaseInput }),
  'inventory.purchases.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'inventory.alerts': empty,
  'inventory.statistics': rangeQuery,
  'inventory.consumeForVisit': z.object({
    visitId: id,
    items: z.array(z.object({ itemId: id, quantityMilli: quantity, note: text })).max(80),
  }),

  // Accounting
  'accounting.transactions.list': listQuery.extend({
    direction: enumOf(valuesOf(ACCOUNTING_DIRECTIONS)).optional(),
    categoryId: nullableId.optional(),
    methodId: nullableId.optional(),
    includeVoid: enabled.optional(),
  }),
  'accounting.transactions.create': z.object({ input: accountingInput }),
  'accounting.transactions.update': z.object({ id, input: accountingInput }),
  'accounting.transactions.void': z.object({ id, reason: z.string().min(1).max(1000) }),
  'accounting.transactions.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'accounting.summary': rangeQuery.extend({ direction: enumOf(valuesOf(ACCOUNTING_DIRECTIONS)).optional() }),
  'accounting.daybook': z.object({ from: isoDate, to: isoDate }),
  'accounting.periods.list': empty,
  'accounting.periods.close': z.object({ periodStart: isoDate, periodEnd: isoDate, notes: text }),
  'accounting.periods.reopen': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),

  // Staff & dentists
  'staff.list': listQuery.extend({
    status: z.array(z.string().max(30)).max(6).optional(),
    department: z.string().max(120).nullable().optional(),
  }),
  'staff.get': z.object({ id }),
  'staff.save': z.object({
    id: nullableId.optional(),
    input: staffInput,
    photoSourcePath: z.string().max(1000).nullable().optional(),
  }),
  'staff.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'staff.departments': empty,
  'staff.statistics': empty,

  'dentists.list': z.object({ includeInactive: enabled.optional() }).optional(),
  'dentists.get': z.object({ id }),
  'dentists.save': z.object({
    id: nullableId.optional(),
    input: dentistInput,
    photoSourcePath: z.string().max(1000).nullable().optional(),
    signatureSourcePath: z.string().max(1000).nullable().optional(),
  }),
  'dentists.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'dentists.statistics': rangeQuery,

  // Users & roles
  'users.list': listQuery.extend({ isActive: enabled.optional() }),
  'users.get': z.object({ id }),
  'users.create': z.object({ input: userInput.extend({ password: z.string().min(6).max(200) }) }),
  'users.update': z.object({ id, input: userInput }),
  'users.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'users.resetPassword': z.object({ id, newPassword: z.string().min(6).max(200), mustChange: enabled }),
  'users.setActive': z.object({ id, isActive: enabled }),
  'roles.list': empty,
  'roles.save': z.object({ id: nullableId.optional(), input: roleInput }),
  'roles.delete': z.object({ id, reason: z.string().min(1).max(1000), confirmText: shortText.optional() }),
  'roles.permissionCatalogue': empty,

  // Audit
  'audit.list': z.object({
    ...listQueryShape,
    action: z.array(z.string().max(60)).max(40).optional(),
    userId: nullableId.optional(),
    entityType: z.string().max(40).optional(),
    severity: z
      .array(enumOf(['info', 'warning', 'critical'] as const))
      .max(3)
      .optional(),
  }),
  'audit.get': z.object({ id }),
  'audit.export': z.object({ from: isoDate.optional(), to: isoDate.optional(), format: enumOf(['csv', 'pdf'] as const) }),
  'audit.actions': empty,

  // Notifications
  'notifications.list': z
    .object({
      onlyUnread: enabled.optional(),
      category: z.string().max(40).nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .optional(),
  'notifications.unreadCount': empty,
  'notifications.markRead': z.object({ ids: z.array(id).max(500) }),
  'notifications.markAllRead': empty,
  'notifications.dismiss': z.object({ id }),
  'notifications.clearAll': z.object({ includeUnread: enabled }),
  'notifications.refresh': empty,

  // Search & dashboard
  'search.global': z.object({ query: z.string().max(120), limit: z.number().int().min(1).max(100).optional() }),
  'dashboard.get': empty,

  // Reports
  'reports.run': reportRequest,
  'reports.export': z.object({ request: reportRequest, format: enumOf(['csv', 'pdf', 'print'] as const) }),
  'reports.catalogue': empty,

  // Printing
  'print.systemPrinters': empty,
  'print.render': printRequest,
  'print.defaultProfile': z.object({ kind: enumOf(valuesOf(PRINT_TEMPLATE_KINDS)) }),

  // Backup & restore
  'backup.status': empty,
  'backup.create': z.object({
    note: text.optional(),
    kind: enumOf(['manual', 'automatic', 'pre_restore'] as const).optional(),
  }),
  'backup.verify': z.object({ id }),
  'backup.delete': z.object({ id, deleteFile: enabled, confirmText: shortText.optional() }),
  'backup.pickFolder': empty,
  'backup.setFolder': z.object({ folder: z.string().min(1).max(1000) }),
  'backup.scanFolder': z.object({ folder: z.string().max(1000).optional() }),
  'backup.previewRestore': z.object({ filePath: z.string().min(1).max(1000) }),
  'backup.restore': z.object({
    filePath: z.string().min(1).max(1000),
    confirmText: z.string().min(1).max(40),
    restoreAttachments: enabled,
  }),

  // Data & destructive operations
  'system.dataSummary': empty,
  'system.integrityCheck': empty,
  'system.vacuum': empty,
  'system.exportCsv': z.object({
    what: enumOf(['patients', 'invoices', 'payments', 'inventory', 'accounting', 'appointments', 'visits', 'prescriptions'] as const),
    from: isoDate.optional(),
    to: isoDate.optional(),
  }),
  'system.importPatients': z.object({ filePath: z.string().max(1000).nullable().optional(), commit: enabled }),
  'system.resetData': z.object({
    scope: enumOf(['clinical', 'financial', 'all'] as const),
    confirmText: z.string().min(1).max(40),
    backupFirst: enabled,
  }),
  'system.deleteBusiness': z.object({
    password: z.string().min(1).max(200),
    confirmText: z.string().min(1).max(80),
    backupFirst: enabled,
  }),
  'system.logFiles': empty,
  'system.openLogFolder': empty,
} satisfies Record<ApiMethodName, z.ZodTypeAny>;

/** Inputs that arrive through `resource.save`, resolved by resource name. */
export const RESOURCE_INPUT_SCHEMAS_EXPORT = RESOURCE_INPUT_SCHEMAS;

export function schemaFor(method: ApiMethodName): z.ZodTypeAny {
  return SCHEMAS[method];
}
