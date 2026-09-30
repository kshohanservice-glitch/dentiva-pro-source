/**
 * Canonical enumerations, labels and defaults.
 *
 * Anything a clinic may reasonably want to change at runtime lives in the
 * database (payment methods, treatment catalog, clinical options, expense
 * categories …). The values here are *defaults* seeded on setup plus the
 * closed sets the application itself relies on for logic.
 */

export interface EnumOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

function options<T extends string>(entries: ReadonlyArray<readonly [T, string]>): ReadonlyArray<EnumOption<T>> {
  return entries.map(([value, label]) => ({ value, label }));
}

function labelMap<T extends string>(list: ReadonlyArray<EnumOption<T>>): Readonly<Record<T, string>> {
  return list.reduce<Record<string, string>>((accumulator, option) => {
    accumulator[option.value] = option.label;
    return accumulator;
  }, {}) as Record<T, string>;
}

// --- Gender ---------------------------------------------------------------
export type Gender = 'male' | 'female' | 'other';
export const GENDERS = options<Gender>([
  ['male', 'Male'],
  ['female', 'Female'],
  ['other', 'Other'],
]);
export const GENDER_LABELS = labelMap(GENDERS);

// --- Blood groups ---------------------------------------------------------
export type BloodGroup = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-' | 'unknown';
export const BLOOD_GROUPS: ReadonlyArray<EnumOption<BloodGroup>> = [
  { value: 'A+', label: 'A+' },
  { value: 'A-', label: 'A-' },
  { value: 'B+', label: 'B+' },
  { value: 'B-', label: 'B-' },
  { value: 'AB+', label: 'AB+' },
  { value: 'AB-', label: 'AB-' },
  { value: 'O+', label: 'O+' },
  { value: 'O-', label: 'O-' },
  { value: 'unknown', label: 'Unknown' },
];

// --- Patient status -------------------------------------------------------
export type PatientStatus = 'active' | 'inactive' | 'archived';
export const PATIENT_STATUSES = options<PatientStatus>([
  ['active', 'Active'],
  ['inactive', 'Inactive'],
  ['archived', 'Archived'],
]);
export const PATIENT_STATUS_LABELS = labelMap(PATIENT_STATUSES);

export type PreferredContact = 'phone' | 'mobile' | 'sms' | 'email' | 'none';
export const PREFERRED_CONTACTS = options<PreferredContact>([
  ['mobile', 'Mobile call'],
  ['phone', 'Phone call'],
  ['sms', 'SMS'],
  ['email', 'Email'],
  ['none', 'Do not contact'],
]);

// --- Appointments ---------------------------------------------------------
export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'arrived'
  | 'in_queue'
  | 'in_treatment'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'rescheduled';

export const APPOINTMENT_STATUSES = options<AppointmentStatus>([
  ['scheduled', 'Scheduled'],
  ['confirmed', 'Confirmed'],
  ['arrived', 'Arrived'],
  ['in_queue', 'In Queue'],
  ['in_treatment', 'In Treatment'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
  ['no_show', 'No-show'],
  ['rescheduled', 'Rescheduled'],
]);
export const APPOINTMENT_STATUS_LABELS = labelMap(APPOINTMENT_STATUSES);

/** Statuses that still occupy a time slot on the calendar. */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'scheduled', 'confirmed', 'arrived', 'in_queue', 'in_treatment', 'rescheduled',
];
/** Statuses that mean the appointment will not happen. */
export const CLOSED_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ['completed', 'cancelled', 'no_show'];

export type AppointmentStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const APPOINTMENT_STATUS_TONES: Readonly<Record<AppointmentStatus, AppointmentStatusTone>> = {
  scheduled: 'info',
  confirmed: 'info',
  arrived: 'warning',
  in_queue: 'warning',
  in_treatment: 'warning',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'danger',
  rescheduled: 'neutral',
};

/** Default appointment slot length in minutes. */
export const DEFAULT_APPOINTMENT_MINUTES = 30;

// --- Queue ----------------------------------------------------------------
export type QueueStatus = 'waiting' | 'called' | 'in_consultation' | 'completed' | 'cancelled';
export const QUEUE_STATUSES = options<QueueStatus>([
  ['waiting', 'Waiting'],
  ['called', 'Called'],
  ['in_consultation', 'In consultation'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
]);
export const QUEUE_STATUS_LABELS = labelMap(QUEUE_STATUSES);
export const OPEN_QUEUE_STATUSES: readonly QueueStatus[] = ['waiting', 'called', 'in_consultation'];

export type QueuePriority = 'normal' | 'urgent';
export const QUEUE_PRIORITIES = options<QueuePriority>([
  ['normal', 'Normal'],
  ['urgent', 'Urgent'],
]);

// --- Invoices & payments --------------------------------------------------
export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'void';
export const INVOICE_STATUSES = options<InvoiceStatus>([
  ['unpaid', 'Unpaid'],
  ['partially_paid', 'Partially paid'],
  ['paid', 'Paid'],
  ['void', 'Void'],
]);
export const INVOICE_STATUS_LABELS = labelMap(INVOICE_STATUSES);
export const INVOICE_STATUS_TONES: Readonly<Record<InvoiceStatus, AppointmentStatusTone>> = {
  unpaid: 'danger',
  partially_paid: 'warning',
  paid: 'success',
  void: 'neutral',
};

/** Payment methods seeded on setup; fully editable afterwards. */
export const DEFAULT_PAYMENT_METHODS: ReadonlyArray<{ code: string; name: string; category: PaymentMethodCategory; requiresReference: boolean }> = [
  { code: 'cash', name: 'Cash', category: 'cash', requiresReference: false },
  { code: 'bank', name: 'Bank transfer', category: 'bank', requiresReference: true },
  { code: 'card', name: 'Card', category: 'card', requiresReference: true },
  { code: 'bkash', name: 'bKash', category: 'mobile_wallet', requiresReference: true },
  { code: 'nagad', name: 'Nagad', category: 'mobile_wallet', requiresReference: true },
  { code: 'rocket', name: 'Rocket', category: 'mobile_wallet', requiresReference: true },
  { code: 'upay', name: 'Upay', category: 'mobile_wallet', requiresReference: true },
  { code: 'other', name: 'Other', category: 'other', requiresReference: false },
];

export type PaymentMethodCategory = 'cash' | 'bank' | 'card' | 'mobile_wallet' | 'other';
export const PAYMENT_METHOD_CATEGORIES = options<PaymentMethodCategory>([
  ['cash', 'Cash'],
  ['bank', 'Bank'],
  ['card', 'Card'],
  ['mobile_wallet', 'Mobile wallet'],
  ['other', 'Other'],
]);
export const PAYMENT_METHOD_CATEGORY_LABELS = labelMap(PAYMENT_METHOD_CATEGORIES);

// --- Inventory ------------------------------------------------------------
export type StockMovementType =
  | 'opening'
  | 'purchase'
  | 'consumption'
  | 'adjustment_in'
  | 'adjustment_out'
  | 'return_in'
  | 'return_out'
  | 'expired'
  | 'damaged'
  | 'transfer_in'
  | 'transfer_out';

export const STOCK_MOVEMENT_TYPES = options<StockMovementType>([
  ['opening', 'Opening stock'],
  ['purchase', 'Purchase'],
  ['consumption', 'Consumption'],
  ['adjustment_in', 'Adjustment (increase)'],
  ['adjustment_out', 'Adjustment (decrease)'],
  ['return_in', 'Return (in)'],
  ['return_out', 'Return (out)'],
  ['expired', 'Expired'],
  ['damaged', 'Damaged'],
  ['transfer_in', 'Transfer in'],
  ['transfer_out', 'Transfer out'],
]);
export const STOCK_MOVEMENT_LABELS = labelMap(STOCK_MOVEMENT_TYPES);

/** Movements that increase stock (used by the integrity checks and reports). */
export const STOCK_INCREASE_TYPES: readonly StockMovementType[] = ['opening', 'purchase', 'adjustment_in', 'return_in', 'transfer_in'];
export const STOCK_DECREASE_TYPES: readonly StockMovementType[] = ['consumption', 'adjustment_out', 'return_out', 'expired', 'damaged', 'transfer_out'];

export const INVENTORY_UNITS = [
  'piece', 'pack', 'box', 'bottle', 'tube', 'syringe', 'set', 'ml', 'gram', 'kg', 'roll', 'sachet',
] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export const DEFAULT_INVENTORY_CATEGORIES = [
  'Restorative materials',
  'Endodontic materials',
  'Impression materials',
  'Instruments',
  'Disposables',
  'Anaesthetics',
  'Sterilisation',
  'Orthodontic',
  'Prosthodontic',
  'Radiology',
  'Stationery',
  'Other',
] as const;

/** Items at or below this multiple of the reorder level are flagged as low stock. */
export const LOW_STOCK_WARNING_FACTOR = 1;
/** Days ahead used for "expiring soon" alerts. */
export const EXPIRY_WARNING_DAYS = 60;

// --- Accounting -----------------------------------------------------------
export type AccountingDirection = 'income' | 'expense';
export const ACCOUNTING_DIRECTIONS = options<AccountingDirection>([
  ['income', 'Income'],
  ['expense', 'Expense'],
]);

export const DEFAULT_EXPENSE_CATEGORIES: ReadonlyArray<string> = [
  'Clinic rent',
  'Electricity',
  'Internet',
  'Staff salary',
  'Dental supplies',
  'Equipment',
  'Maintenance',
  'Cleaning',
  'Transportation',
  'Marketing',
  'Utilities',
  'Laboratory',
  'Other',
];

export const DEFAULT_INCOME_CATEGORIES: ReadonlyArray<string> = [
  'Treatment revenue',
  'Product sales',
  'Consultation fee',
  'Laboratory service',
  'Other income',
];

// --- Clinical -------------------------------------------------------------
export type DentitionType = 'permanent' | 'primary';
export type ToothNumberingSystem = 'fdi' | 'universal' | 'palmer';
export const TOOTH_NUMBERING_SYSTEMS = options<ToothNumberingSystem>([
  ['fdi', 'FDI (ISO 3950)'],
  ['universal', 'Universal (1–32)'],
  ['palmer', 'Palmer'],
]);

export type ToothFindingType =
  | 'healthy'
  | 'caries'
  | 'filled'
  | 'crown'
  | 'missing'
  | 'extracted'
  | 'root_canal'
  | 'impacted'
  | 'fracture'
  | 'mobility'
  | 'implant'
  | 'sealant'
  | 'bridge_abutment'
  | 'pontic'
  | 'other';

export const TOOTH_FINDING_TYPES = options<ToothFindingType>([
  ['healthy', 'Healthy'],
  ['caries', 'Caries'],
  ['filled', 'Filled'],
  ['crown', 'Crown'],
  ['missing', 'Missing'],
  ['extracted', 'Extracted'],
  ['root_canal', 'Root canal treated'],
  ['impacted', 'Impacted'],
  ['fracture', 'Fracture'],
  ['mobility', 'Mobility'],
  ['implant', 'Implant'],
  ['sealant', 'Sealant'],
  ['bridge_abutment', 'Bridge abutment'],
  ['pontic', 'Pontic'],
  ['other', 'Other finding'],
]);
export const TOOTH_FINDING_LABELS = labelMap(TOOTH_FINDING_TYPES);

/** Colour tokens for chart rendering — mapped to the design system's status palette. */
export const TOOTH_FINDING_COLOURS: Readonly<Record<ToothFindingType, string>> = {
  healthy: 'var(--chart-healthy)',
  caries: 'var(--chart-caries)',
  filled: 'var(--chart-filled)',
  crown: 'var(--chart-crown)',
  missing: 'var(--chart-missing)',
  extracted: 'var(--chart-missing)',
  root_canal: 'var(--chart-root-canal)',
  impacted: 'var(--chart-impacted)',
  fracture: 'var(--chart-fracture)',
  mobility: 'var(--chart-mobility)',
  implant: 'var(--chart-implant)',
  sealant: 'var(--chart-sealant)',
  bridge_abutment: 'var(--chart-crown)',
  pontic: 'var(--chart-crown)',
  other: 'var(--chart-other)',
};

export type ToothSurface = 'mesial' | 'distal' | 'buccal' | 'lingual' | 'occlusal' | 'incisal';
export const TOOTH_SURFACES = options<ToothSurface>([
  ['mesial', 'Mesial'],
  ['distal', 'Distal'],
  ['buccal', 'Buccal'],
  ['lingual', 'Lingual'],
  ['occlusal', 'Occlusal'],
  ['incisal', 'Incisal'],
]);

export type MobilityGrade = 0 | 1 | 2 | 3;

/** Finding types for which tooth surfaces are meaningful. */
export const SURFACE_SCOPED_FINDINGS: readonly ToothFindingType[] = ['caries', 'filled', 'sealant', 'fracture'];

export type ClinicalOptionCategory = 'cc' | 'oe' | 're' | 'advice';
export const CLINICAL_OPTION_CATEGORIES = options<ClinicalOptionCategory>([
  ['cc', 'C/C — Chief complaint'],
  ['oe', 'O/E — On examination'],
  ['re', 'R/E — Radiographic evidence'],
  ['advice', 'Advice'],
]);

/** Seeded clinical option sets (fully editable in Settings → Clinical options). */
export const DEFAULT_CLINICAL_OPTIONS: Readonly<Record<ClinicalOptionCategory, readonly string[]>> = {
  cc: ['Pain', 'Swelling', 'Gum bleeding', 'Bad breath', 'Sensitivity', 'Broken tooth', 'Ulcer', 'Check-up', 'Other'],
  oe: [
    'Caries', 'Generalised caries', 'BDR', 'BDC', 'Gingivitis', 'Periodontal pocket', 'Periodontitis', 'Pulpitis',
    'Impacted teeth', 'Dry socket', 'Attrition', 'Erosion', 'Abscess', 'Fractured tooth', 'Missing teeth', 'Other',
  ],
  re: ['No periapical change', 'Periapical radiolucency', 'Widened PDL space', 'Impacted tooth', 'Bone loss', 'Retained root', 'Other'],
  advice: [
    'Maintain oral hygiene', 'Brush twice daily', 'Warm saline rinse', 'Avoid hard food', 'Complete the full antibiotic course',
    'Follow-up after 7 days', 'Follow-up after 1 month', 'Avoid smoking', 'Soft diet advised',
  ],
};

export type MedicationForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'suspension'
  | 'cream'
  | 'gel'
  | 'ointment'
  | 'mouthwash'
  | 'drops'
  | 'injection'
  | 'powder'
  | 'other';

export const MEDICATION_FORMS = options<MedicationForm>([
  ['tablet', 'Tablet'],
  ['capsule', 'Capsule'],
  ['syrup', 'Syrup'],
  ['suspension', 'Suspension'],
  ['cream', 'Cream'],
  ['gel', 'Gel'],
  ['ointment', 'Ointment'],
  ['mouthwash', 'Mouthwash'],
  ['drops', 'Drops'],
  ['injection', 'Injection'],
  ['powder', 'Powder'],
  ['other', 'Other'],
]);
export const MEDICATION_FORM_LABELS = labelMap(MEDICATION_FORMS);

export type FoodTiming = 'before_food' | 'after_food' | 'with_food' | 'empty_stomach' | 'any_time';
export const FOOD_TIMINGS = options<FoodTiming>([
  ['after_food', 'After food'],
  ['before_food', 'Before food'],
  ['with_food', 'With food'],
  ['empty_stomach', 'Empty stomach'],
  ['any_time', 'Any time'],
]);
export const FOOD_TIMING_LABELS = labelMap(FOOD_TIMINGS);

/** Doses must not exceed this per slot — a guard against impossible input. */
export const MAX_DOSES_PER_SLOT = 10;
export const MAX_MEDICATIONS_PER_PRESCRIPTION = 60;
export const MAX_DURATION_DAYS = 365;

/** Seeded medication catalog: common dental prescriptions in Bangladesh. */
export const DEFAULT_MEDICATIONS: ReadonlyArray<{ name: string; form: MedicationForm; strength?: string; defaultDose?: string; defaultDurationDays?: number }> = [
  { name: 'Amoxicillin', form: 'capsule', strength: '500 mg', defaultDose: '1+0+1', defaultDurationDays: 5 },
  { name: 'Amoxicillin + Clavulanic acid', form: 'tablet', strength: '625 mg', defaultDose: '1+0+1', defaultDurationDays: 5 },
  { name: 'Metronidazole', form: 'tablet', strength: '400 mg', defaultDose: '1+1+1', defaultDurationDays: 5 },
  { name: 'Azithromycin', form: 'tablet', strength: '500 mg', defaultDose: '1+0+0', defaultDurationDays: 3 },
  { name: 'Cefuroxime', form: 'tablet', strength: '500 mg', defaultDose: '1+0+1', defaultDurationDays: 5 },
  { name: 'Paracetamol', form: 'tablet', strength: '500 mg', defaultDose: '1+1+1', defaultDurationDays: 3 },
  { name: 'Ibuprofen', form: 'tablet', strength: '400 mg', defaultDose: '1+0+1', defaultDurationDays: 3 },
  { name: 'Diclofenac sodium', form: 'tablet', strength: '50 mg', defaultDose: '1+0+1', defaultDurationDays: 3 },
  { name: 'Ketorolac', form: 'tablet', strength: '10 mg', defaultDose: '1+0+1', defaultDurationDays: 3 },
  { name: 'Pantoprazole', form: 'tablet', strength: '20 mg', defaultDose: '1+0+0', defaultDurationDays: 5 },
  { name: 'Omeprazole', form: 'capsule', strength: '20 mg', defaultDose: '1+0+0', defaultDurationDays: 5 },
  { name: 'Chlorhexidine mouthwash', form: 'mouthwash', strength: '0.12%', defaultDose: 'Rinse 10 ml twice daily', defaultDurationDays: 7 },
  { name: 'Metronidazole gel', form: 'gel', strength: '0.8%', defaultDose: 'Apply locally twice daily', defaultDurationDays: 7 },
  { name: 'Lignocaine gel', form: 'gel', strength: '2%', defaultDose: 'Apply locally as needed', defaultDurationDays: 3 },
  { name: 'Potassium nitrate toothpaste', form: 'other', strength: '5%', defaultDose: 'Brush twice daily', defaultDurationDays: 30 },
  { name: 'Prednisolone', form: 'tablet', strength: '10 mg', defaultDose: '1+0+0', defaultDurationDays: 3 },
  { name: 'Vitamin B complex', form: 'tablet', strength: '', defaultDose: '1+0+1', defaultDurationDays: 14 },
  { name: 'Calcium + Vitamin D3', form: 'tablet', strength: '', defaultDose: '0+0+1', defaultDurationDays: 30 },
];

/** Default treatment catalog seeded on setup (names, categories and indicative BDT prices). */
export const DEFAULT_TREATMENTS: ReadonlyArray<{ code: string; name: string; category: string; pricePaisa: number; durationMinutes: number }> = [
  { code: 'CONS', name: 'Consultation', category: 'Diagnostics', pricePaisa: 50000, durationMinutes: 15 },
  { code: 'XRAY-IOPA', name: 'X-ray — Intraoral periapical', category: 'Diagnostics', pricePaisa: 40000, durationMinutes: 15 },
  { code: 'XRAY-OPG', name: 'X-ray — OPG (panoramic)', category: 'Diagnostics', pricePaisa: 120000, durationMinutes: 20 },
  { code: 'SCAL', name: 'Scaling and polishing', category: 'Preventive', pricePaisa: 150000, durationMinutes: 45 },
  { code: 'FLUO', name: 'Fluoride application', category: 'Preventive', pricePaisa: 80000, durationMinutes: 20 },
  { code: 'SEAL', name: 'Pit and fissure sealant (per tooth)', category: 'Preventive', pricePaisa: 90000, durationMinutes: 20 },
  { code: 'FIL-C', name: 'Filling — Composite (per tooth)', category: 'Restorative', pricePaisa: 250000, durationMinutes: 45 },
  { code: 'FIL-A', name: 'Filling — Amalgam (per tooth)', category: 'Restorative', pricePaisa: 180000, durationMinutes: 40 },
  { code: 'FIL-GIC', name: 'Filling — GIC (per tooth)', category: 'Restorative', pricePaisa: 150000, durationMinutes: 30 },
  { code: 'RCT-ANT', name: 'Root canal treatment — Anterior', category: 'Endodontics', pricePaisa: 500000, durationMinutes: 60 },
  { code: 'RCT-POST', name: 'Root canal treatment — Posterior', category: 'Endodontics', pricePaisa: 700000, durationMinutes: 90 },
  { code: 'PULP', name: 'Pulpotomy / pulpectomy', category: 'Endodontics', pricePaisa: 250000, durationMinutes: 45 },
  { code: 'EXT-S', name: 'Extraction — Simple', category: 'Oral surgery', pricePaisa: 200000, durationMinutes: 30 },
  { code: 'EXT-SURG', name: 'Extraction — Surgical / impacted', category: 'Oral surgery', pricePaisa: 600000, durationMinutes: 60 },
  { code: 'CROWN-PFM', name: 'Crown — Porcelain fused to metal', category: 'Prosthodontics', pricePaisa: 600000, durationMinutes: 60 },
  { code: 'CROWN-ZIR', name: 'Crown — Zirconia', category: 'Prosthodontics', pricePaisa: 1200000, durationMinutes: 60 },
  { code: 'BRIDGE-3', name: 'Bridge — 3 unit', category: 'Prosthodontics', pricePaisa: 1500000, durationMinutes: 90 },
  { code: 'DENT-PART', name: 'Denture — Partial (acrylic)', category: 'Prosthodontics', pricePaisa: 800000, durationMinutes: 60 },
  { code: 'DENT-FULL', name: 'Denture — Complete (acrylic)', category: 'Prosthodontics', pricePaisa: 1500000, durationMinutes: 90 },
  { code: 'ORTHO-1', name: 'Orthodontic treatment — Starting (per phase)', category: 'Orthodontics', pricePaisa: 3000000, durationMinutes: 90 },
  { code: 'ORTHO-REV', name: 'Orthodontic review', category: 'Orthodontics', pricePaisa: 100000, durationMinutes: 30 },
  { code: 'IMP-1', name: 'Dental implant — Single unit', category: 'Implantology', pricePaisa: 5000000, durationMinutes: 120 },
  { code: 'WHITE', name: 'Teeth whitening (per arch)', category: 'Cosmetic', pricePaisa: 1200000, durationMinutes: 60 },
];

// --- Referrals ------------------------------------------------------------
export type ReferralStatus = 'pending' | 'scheduled' | 'completed' | 'cancelled';
export const REFERRAL_STATUSES = options<ReferralStatus>([
  ['pending', 'Pending'],
  ['scheduled', 'Scheduled'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
]);
export const REFERRAL_STATUS_LABELS = labelMap(REFERRAL_STATUSES);

export const REFERRAL_SPECIALTIES: readonly string[] = [
  'Oral and maxillofacial surgery',
  'Orthodontics',
  'Periodontology',
  'Endodontics',
  'Prosthodontics',
  'Paediatric dentistry',
  'Oral medicine',
  'Oral pathology',
  'Radiology',
  'General medicine',
  'Other',
];

// --- Attachments ----------------------------------------------------------
export type AttachmentCategory = 'xray' | 'clinical_photo' | 'lab_report' | 'consent' | 'document' | 'other';
export const ATTACHMENT_CATEGORIES = options<AttachmentCategory>([
  ['xray', 'Radiograph'],
  ['clinical_photo', 'Clinical photograph'],
  ['lab_report', 'Laboratory report'],
  ['consent', 'Consent form'],
  ['document', 'Document'],
  ['other', 'Other'],
]);
export const ATTACHMENT_CATEGORY_LABELS = labelMap(ATTACHMENT_CATEGORIES);

export const ATTACHMENT_ALLOWED_EXTENSIONS: readonly string[] = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.doc', '.docx', '.txt'];
export const ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB
export const ATTACHMENT_IMAGE_EXTENSIONS: readonly string[] = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'];

// --- Notifications --------------------------------------------------------
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';
export const NOTIFICATION_SEVERITIES = options<NotificationSeverity>([
  ['info', 'Information'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['critical', 'Critical'],
]);

export type NotificationCategory =
  | 'appointment'
  | 'payment'
  | 'inventory'
  | 'backup'
  | 'security'
  | 'system';

export const NOTIFICATION_CATEGORIES = options<NotificationCategory>([
  ['appointment', 'Appointments'],
  ['payment', 'Payments'],
  ['inventory', 'Inventory'],
  ['backup', 'Backup'],
  ['security', 'Security'],
  ['system', 'System'],
]);

// --- Audit ----------------------------------------------------------------
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'lock'
  | 'unlock'
  | 'password_change'
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'soft_delete'
  | 'print'
  | 'export'
  | 'import'
  | 'backup'
  | 'backup_failed'
  | 'restore_started'
  | 'restore_completed'
  | 'restore_failed'
  | 'activation'
  | 'setup'
  | 'settings_change'
  | 'permission_change'
  | 'role_change'
  | 'user_manage'
  | 'db_integrity'
  | 'destructive'
  | 'app_start'
  | 'app_stop'
  | 'abnormal_exit'
  | 'system';

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'login', 'login_failed', 'logout', 'lock', 'unlock', 'password_change', 'create', 'update', 'delete', 'restore',
  'soft_delete', 'print', 'export', 'import', 'backup', 'backup_failed', 'restore_started', 'restore_completed',
  'restore_failed', 'activation', 'setup', 'settings_change', 'permission_change', 'role_change', 'user_manage',
  'db_integrity', 'destructive', 'app_start', 'app_stop', 'abnormal_exit', 'system',
];

export const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  logout: 'Signed out',
  lock: 'Locked',
  unlock: 'Unlocked',
  password_change: 'Password changed',
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  restore: 'Restored',
  soft_delete: 'Removed',
  print: 'Printed',
  export: 'Exported',
  import: 'Imported',
  backup: 'Backup created',
  backup_failed: 'Backup failed',
  restore_started: 'Restore started',
  restore_completed: 'Restore completed',
  restore_failed: 'Restore failed',
  activation: 'Activation',
  setup: 'Setup',
  settings_change: 'Settings changed',
  permission_change: 'Permission changed',
  role_change: 'Role changed',
  user_manage: 'User management',
  db_integrity: 'Database integrity check',
  destructive: 'Destructive action',
  app_start: 'Application started',
  app_stop: 'Application closed',
  abnormal_exit: 'Unexpected shutdown',
  system: 'System',
};

// --- Printing -------------------------------------------------------------
export type PaperSizeKey = 'a4' | 'a5' | 'letter' | 'thermal_58' | 'thermal_80' | 'custom';

export interface PaperDefinition {
  readonly key: PaperSizeKey;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly continuous: boolean;
}

export const PAPER_SIZES: ReadonlyArray<PaperDefinition> = [
  { key: 'a4', label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297, continuous: false },
  { key: 'a5', label: 'A5 (148 × 210 mm)', widthMm: 148, heightMm: 210, continuous: false },
  { key: 'letter', label: 'Letter (216 × 279 mm)', widthMm: 215.9, heightMm: 279.4, continuous: false },
  { key: 'thermal_80', label: 'Thermal — 80 mm roll', widthMm: 80, heightMm: 297, continuous: true },
  { key: 'thermal_58', label: 'Thermal — 58 mm roll', widthMm: 58, heightMm: 297, continuous: true },
  { key: 'custom', label: 'Custom size', widthMm: 210, heightMm: 297, continuous: false },
];

export type PrintTemplateKind = 'prescription' | 'invoice' | 'report' | 'patient_summary';

export const PRINT_TEMPLATE_KINDS = options<PrintTemplateKind>([
  ['prescription', 'Prescription'],
  ['invoice', 'Invoice'],
  ['report', 'Report'],
  ['patient_summary', 'Patient summary'],
]);

export const DPI_OPTIONS = [96, 150, 203, 300, 600] as const;

// --- Settings -------------------------------------------------------------
export type ThemeMode = 'light' | 'dark' | 'system';
export const THEME_MODES = options<ThemeMode>([
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'Follow Windows'],
]);

export type DensityMode = 'comfortable' | 'compact';
export const DENSITY_MODES = options<DensityMode>([
  ['comfortable', 'Comfortable'],
  ['compact', 'Compact'],
]);

export type AutoLockMinutes = 0 | 5 | 10 | 15 | 30;
export const AUTO_LOCK_OPTIONS: ReadonlyArray<{ value: AutoLockMinutes; label: string }> = [
  { value: 5, label: '5 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 0, label: 'Disabled' },
];

export type BackupIntervalDays = 0 | 7 | 15 | 30;
export const BACKUP_INTERVAL_OPTIONS: ReadonlyArray<{ value: BackupIntervalDays; label: string }> = [
  { value: 7, label: 'Every 7 days' },
  { value: 15, label: 'Every 15 days' },
  { value: 30, label: 'Every 30 days' },
  { value: 0, label: 'Disabled' },
];

export type NumberGrouping = 'international' | 'south_asian';
export const NUMBER_GROUPINGS = options<NumberGrouping>([
  ['international', '1,500,000 (international)'],
  ['south_asian', '15,00,000 (lakh / crore)'],
]);

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Session/security defaults applied on setup. */
export const DEFAULT_SECURITY_SETTINGS = {
  autoLockMinutes: 10 as AutoLockMinutes,
  passwordMinLength: PASSWORD_MIN_LENGTH,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  requireAdminPasswordForDestructive: true,
} as const;

/** List page sizes supported by the data tables. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export const CLINIC_DEFAULT_MESSAGE = 'Thank you for choosing our dental care. Please follow the advice given.';
