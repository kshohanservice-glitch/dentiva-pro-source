/**
 * Domain contracts shared by the core services, the IPC boundary and the UI.
 * These are plain data shapes: no behaviour, no framework, no Node APIs.
 */
import type { AccountingDirection, AppointmentStatus, AttachmentCategory, AutoLockMinutes, BackupIntervalDays, BloodGroup, ClinicalOptionCategory, DensityMode, DentistCredentialType, DentitionType, FoodTiming, Gender, InventoryUnit, InvoiceStatus, MedicationForm, MobilityGrade, NotificationCategory, NotificationSeverity, NumberGrouping, PaperSizeKey, PatientStatus, PaymentMethodCategory, PreferredContact, PrintTemplateKind, QueuePriority, QueueStatus, ReferralStatus, StockMovementType, ThemeMode, ToothFindingType, ToothNumberingSystem, ToothSurface } from './constants';
import type { IsoDate, IsoInstant, IsoTime } from './dates';
import type { Paisa } from './money';
import type { SerializedError } from './errors';

// ---------------------------------------------------------------------------
// Generic list plumbing
// ---------------------------------------------------------------------------

export type SortDirection = 'asc' | 'desc';

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: string;
  direction?: SortDirection;
  /** Named date range preset applied to the entity's primary date column. */
  preset?: string;
  from?: IsoDate;
  to?: IsoDate;
}

export interface Paged<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

export interface SelectOption {
  readonly value: number;
  readonly label: string;
  readonly meta?: string;
}

export type ApiResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SerializedError };

// ---------------------------------------------------------------------------
// Clinic, settings, session
// ---------------------------------------------------------------------------

export interface ClinicProfile {
  readonly id: number;
  readonly name: string;
  readonly logoPath: string | null;
  readonly address: string;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
  readonly clinicMessage: string;
  readonly visitingHours: string;
  readonly registrationNumber: string;
  readonly updatedAt: IsoInstant;
}

export interface AppSettings {
  readonly theme: ThemeMode;
  readonly density: DensityMode;
  readonly dateFormat: string;
  readonly timeFormat: string;
  readonly timeZone: string;
  readonly numberGrouping: NumberGrouping;
  readonly autoLockMinutes: AutoLockMinutes;
  readonly passwordMinLength: number;
  readonly maxFailedAttempts: number;
  readonly lockoutMinutes: number;
  readonly backupFolder: string;
  readonly backupIntervalDays: BackupIntervalDays;
  readonly lastAutomaticBackupAt: IsoInstant | null;
  readonly defaultPrescriptionProfileId: number | null;
  readonly defaultInvoiceProfileId: number | null;
  readonly defaultReportProfileId: number | null;
  readonly defaultToothNumbering: ToothNumberingSystem;
  readonly defaultDentition: DentitionType;
  readonly appointmentSlotMinutes: number;
  readonly queuePrefix: string;
  readonly lowStockWarningFactor: number;
  readonly expiryWarningDays: number;
  readonly invoiceFooterNote: string;
  readonly prescriptionFooterNote: string;
  readonly showFinancialWidgetsForStaff: boolean;
}

export interface SessionUser {
  readonly id: number;
  readonly username: string;
  readonly fullName: string;
  readonly roleIds: readonly number[];
  readonly roleNames: readonly string[];
  readonly isOwner: boolean;
  readonly permissions: readonly string[];
  readonly mustChangePassword: boolean;
  readonly loginAt: IsoInstant;
}

export type AppState = 'activation_required' | 'setup_required' | 'locked' | 'ready';

export interface AppBootstrap {
  readonly state: AppState;
  readonly appVersion: string;
  readonly appBuild: string;
  readonly session: SessionUser | null;
  readonly clinic: ClinicProfile | null;
  readonly settings: AppSettings | null;
  readonly activation: ActivationStatus;
  readonly setup: SetupStatus;
  readonly dataDir: string;
  readonly lastBackupAt: IsoInstant | null;
  readonly previousShutdownWasAbnormal: boolean;
}

export interface ActivationStatus {
  readonly activated: boolean;
  readonly activatedAt: IsoInstant | null;
  readonly machineBound: boolean;
  readonly lastError: string | null;
}

export interface SetupStatus {
  readonly activationComplete: boolean;
  readonly clinicComplete: boolean;
  readonly dentistsComplete: boolean;
  readonly preferencesComplete: boolean;
  readonly administratorComplete: boolean;
  readonly reviewComplete: boolean;
  readonly completedAt: IsoInstant | null;
  readonly completedStep: number;
}

export interface HealthReport {
  readonly databaseOk: boolean;
  readonly integrityOk: boolean;
  readonly schemaVersion: number;
  readonly dataDir: string;
  readonly logDir: string;
  readonly attachmentsDir: string;
  readonly backupsDir: string;
  readonly databaseSizeBytes: number;
  readonly attachmentCount: number;
  readonly uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export interface PatientContact {
  readonly id: number;
  readonly patientId: number;
  readonly type: 'alternate_phone' | 'phone' | 'email' | 'emergency' | 'guardian';
  readonly name: string;
  readonly relation: string;
  readonly value: string;
  readonly isPrimary: boolean;
}

export interface PatientSummary {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly gender: Gender;
  readonly ageYears: number | null;
  readonly ageText: string;
  readonly dob: IsoDate | null;
  readonly phone: string;
  readonly bloodGroup: BloodGroup;
  readonly status: PatientStatus;
  readonly tags: readonly string[];
  readonly registeredAt: IsoDate;
  readonly lastVisitDate: IsoDate | null;
  readonly visitCount: number;
  readonly referredBy: string;
  /** Outstanding balance in paisa, or null when the user may not see financial data. */
  readonly outstandingPaisa: number | null;
}

export interface PatientDetail extends PatientSummary {
  readonly firstName: string;
  readonly lastName: string;
  readonly alternatePhone: string;
  readonly email: string;
  readonly address: string;
  readonly city: string;
  readonly emergencyContactName: string;
  readonly emergencyPhone: string;
  readonly chiefComplaint: string;
  readonly previousProblems: string;
  readonly medicalNotes: string;
  readonly allergies: string;
  readonly notes: string;
  readonly preferredContact: PreferredContact;
  readonly contacts: readonly PatientContact[];
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  readonly hasMedicalAlerts: boolean;
  readonly openTreatmentPlanCount: number;
  readonly lastAppointmentDate: IsoDate | null;
  readonly deletedAt: IsoInstant | null;
}

export interface PatientInput {
  firstName: string;
  lastName: string;
  gender: Gender;
  dob: IsoDate | null;
  ageYears: number | null;
  bloodGroup: BloodGroup;
  phone: string;
  alternatePhone: string;
  email: string;
  address: string;
  city: string;
  emergencyContactName: string;
  emergencyPhone: string;
  chiefComplaint: string;
  previousProblems: string;
  medicalNotes: string;
  allergies: string;
  notes: string;
  preferredContact: PreferredContact;
  status: PatientStatus;
  referredBy: string;
  tagIds: number[];
}

export interface PatientListQuery extends ListQuery {
  status?: PatientStatus[];
  tagIds?: number[];
  gender?: Gender[];
  bloodGroup?: BloodGroup[];
  hasMedicalAlert?: boolean;
  hasOutstanding?: boolean;
  includeDeleted?: boolean;
}

export interface PatientTag {
  readonly id: number;
  readonly name: string;
  readonly colour: string;
  readonly patientCount: number;
}

export interface PatientFinancialSummary {
  readonly totalInvoicedPaisa: Paisa;
  readonly totalPaidPaisa: Paisa;
  readonly outstandingPaisa: Paisa;
  readonly invoiceCount: number;
  readonly lastPaymentAt: IsoInstant | null;
  readonly openInvoices: ReadonlyArray<{
    id: number;
    number: string;
    date: IsoDate;
    totalPaisa: Paisa;
    paidPaisa: Paisa;
    duePaisa: Paisa;
  }>;
  readonly recentPayments: ReadonlyArray<{
    id: number;
    amountPaisa: Paisa;
    methodName: string;
    paidAt: IsoInstant;
    invoiceNumber: string;
  }>;
}

export type TimelineEventType =
  | 'registration'
  | 'visit'
  | 'appointment'
  | 'prescription'
  | 'invoice'
  | 'payment'
  | 'treatment'
  | 'chart'
  | 'referral'
  | 'attachment'
  | 'note';

export interface TimelineEvent {
  readonly id: string;
  readonly type: TimelineEventType;
  readonly date: IsoDate;
  readonly instant: IsoInstant | null;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly dentistName: string | null;
  readonly amountPaisa: Paisa | null;
  readonly status: string | null;
  /** Route the UI navigates to when the event is opened. */
  readonly target: { readonly screen: string; readonly id: number } | null;
  readonly meta: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Visits, treatments, dental chart
// ---------------------------------------------------------------------------

export interface VisitSummary {
  readonly id: number;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly dentistId: number | null;
  readonly dentistName: string;
  readonly visitDate: IsoDate;
  readonly visitTime: IsoTime;
  readonly chiefComplaint: string;
  readonly diagnosis: string;
  readonly treatmentCount: number;
  readonly hasPrescription: boolean;
  readonly invoiceId: number | null;
  readonly invoiceNumber: string | null;
  readonly invoiceTotalPaisa: Paisa | null;
  readonly followUpDate: IsoDate | null;
  readonly createdAt: IsoInstant;
}

export interface VisitDetail extends VisitSummary {
  readonly history: string;
  readonly examination: string;
  readonly advice: string;
  readonly notes: string;
  readonly ccOptions: readonly string[];
  readonly oeOptions: readonly string[];
  readonly reOptions: readonly string[];
  readonly adviceOptions: readonly string[];
  readonly findings: readonly ToothFinding[];
  readonly treatments: readonly TreatmentRecord[];
  readonly prescriptionIds: readonly number[];
  readonly referralIds: readonly number[];
  readonly attachmentIds: readonly number[];
}

export interface VisitInput {
  patientId: number;
  dentistId: number | null;
  visitDate: IsoDate;
  visitTime: IsoTime;
  chiefComplaint: string;
  history: string;
  examination: string;
  diagnosis: string;
  ccOptions: string[];
  oeOptions: string[];
  reOptions: string[];
  adviceOptions: string[];
  advice: string;
  notes: string;
  followUpDate: IsoDate | null;
  treatments: TreatmentRecordInput[];
  dentalFindings: ToothFindingInput[];
  prescriptionId: number | null;
}

export interface Treatment {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly pricePaisa: Paisa;
  readonly durationMinutes: number;
  readonly isActive: boolean;
  readonly usageCount: number;
}

export interface TreatmentInput {
  code: string;
  name: string;
  category: string;
  description: string;
  pricePaisa: Paisa;
  durationMinutes: number;
  isActive: boolean;
}

export interface TreatmentRecord {
  readonly id: number;
  readonly visitId: number | null;
  readonly patientId: number;
  readonly treatmentId: number | null;
  readonly code: string;
  readonly description: string;
  readonly toothCodes: readonly string[];
  readonly quantity: number;
  readonly unitPricePaisa: Paisa;
  readonly discountPaisa: Paisa;
  readonly totalPaisa: Paisa;
  readonly dentistId: number | null;
  readonly dentistName: string;
  readonly performedAt: IsoDate;
  readonly invoiceItemId: number | null;
  readonly notes: string;
}

export interface TreatmentRecordInput {
  id?: number | null;
  treatmentId: number | null;
  code?: string;
  description: string;
  toothCodes: string[];
  quantity: number;
  unitPricePaisa: Paisa;
  discountPaisa: Paisa;
  notes: string;
}

export interface TreatmentPlan {
  readonly id: number;
  readonly patientId: number;
  readonly patientName: string;
  readonly title: string;
  readonly status: 'draft' | 'active' | 'completed' | 'cancelled';
  readonly notes: string;
  readonly createdAt: IsoInstant;
  readonly createdByName: string;
  readonly estimatedTotalPaisa: Paisa;
  readonly completedItems: number;
  readonly items: readonly TreatmentPlanItem[];
}

export interface TreatmentPlanItem {
  readonly id: number;
  readonly planId: number;
  readonly treatmentId: number | null;
  readonly description: string;
  readonly toothCodes: readonly string[];
  readonly sessionNumber: number;
  readonly estimatedPaisa: Paisa;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  readonly notes: string;
  readonly completedVisitId: number | null;
}

export interface DentalChart {
  readonly patientId: number;
  readonly dentition: DentitionType;
  readonly numberingSystem: ToothNumberingSystem;
  readonly findings: readonly ToothFinding[];
  readonly perio: readonly PerioRecord[];
  readonly updatedAt: IsoInstant | null;
  readonly updatedByName: string | null;
}

export interface ToothFinding {
  readonly id: number;
  readonly patientId: number;
  readonly toothFdi: string;
  readonly finding: ToothFindingType;
  readonly surfaces: readonly ToothSurface[];
  readonly mobilityGrade: MobilityGrade;
  readonly note: string;
  readonly visitId: number | null;
  readonly visitDate: IsoDate | null;
  readonly recordedAt: IsoInstant;
  readonly recordedByName: string;
  readonly isActive: boolean;
}

export interface ToothFindingInput {
  toothFdi: string;
  finding: ToothFindingType;
  surfaces: ToothSurface[];
  mobilityGrade: MobilityGrade;
  note: string;
}

export interface PerioRecord {
  readonly id: number;
  readonly patientId: number;
  readonly toothFdi: string;
  readonly site: string;
  readonly depthMm: number;
  readonly recordedAt: IsoInstant;
}

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

export interface PrescriptionItemInput {
  id?: number | null;
  medicationId: number | null;
  name: string;
  form: MedicationForm;
  strength: string;
  doseMorning: number;
  doseNoon: number;
  doseNight: number;
  foodTiming: FoodTiming;
  durationDays: number | null;
  quantity: number | null;
  instructions: string;
  sortOrder: number;
}

export interface PrescriptionItem extends PrescriptionItemInput {
  readonly id: number;
  readonly resolveName: string;
}

export interface PrescriptionSummary {
  readonly id: number;
  readonly number: string;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly dentistId: number | null;
  readonly dentistName: string;
  readonly date: IsoDate;
  readonly itemCount: number;
  readonly diagnosis: string;
  readonly isVoid: boolean;
  readonly printedAt: IsoInstant | null;
  readonly visitId: number | null;
}

export interface PrescriptionDetail extends PrescriptionSummary {
  readonly patientGender: Gender;
  readonly patientAgeText: string;
  readonly patientPhone: string;
  readonly patientAddress: string;
  readonly cc: readonly string[];
  readonly oe: readonly string[];
  readonly re: readonly string[];
  readonly advice: readonly string[];
  readonly notes: string;
  readonly items: readonly PrescriptionItem[];
  readonly createdByName: string;
  readonly createdAt: IsoInstant;
  readonly voidReason: string;
  readonly supersededById: number | null;
}

export interface PrescriptionInput {
  patientId: number;
  dentistId: number | null;
  visitId: number | null;
  date: IsoDate;
  cc: string[];
  oe: string[];
  re: string[];
  advice: string[];
  notes: string;
  items: PrescriptionItemInput[];
}

export interface Medication {
  readonly id: number;
  readonly name: string;
  readonly form: MedicationForm;
  readonly strength: string;
  readonly defaultDoseMorning: number;
  readonly defaultDoseNoon: number;
  readonly defaultDoseNight: number;
  readonly defaultFoodTiming: FoodTiming;
  readonly defaultDurationDays: number | null;
  readonly isActive: boolean;
  readonly usageCount: number;
}

export interface MedicationInput {
  name: string;
  form: MedicationForm;
  strength: string;
  defaultDoseMorning: number;
  defaultDoseNoon: number;
  defaultDoseNight: number;
  defaultFoodTiming: FoodTiming;
  defaultDurationDays: number | null;
  isActive: boolean;
}

export interface ClinicalOption {
  readonly id: number;
  readonly category: ClinicalOptionCategory;
  readonly label: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly usageCount: number;
}

// ---------------------------------------------------------------------------
// Appointments & queue
// ---------------------------------------------------------------------------

export interface Appointment {
  readonly id: number;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly patientPhone: string;
  readonly dentistId: number | null;
  readonly dentistName: string;
  readonly date: IsoDate;
  readonly startTime: IsoTime;
  readonly endTime: IsoTime;
  readonly reason: string;
  readonly notes: string;
  readonly status: AppointmentStatus;
  readonly queueEntryId: number | null;
  readonly visitId: number | null;
  readonly reminderNote: string;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
}

export interface AppointmentInput {
  patientId: number;
  dentistId: number | null;
  date: IsoDate;
  startTime: IsoTime;
  endTime: IsoTime;
  reason: string;
  notes: string;
  status: AppointmentStatus;
  reminderNote: string;
}

export interface AppointmentListQuery extends ListQuery {
  status?: AppointmentStatus[];
  dentistId?: number | null;
  patientId?: number;
  view?: 'day' | 'week' | 'month' | 'list';
  date?: IsoDate;
}

export interface QueueEntry {
  readonly id: number;
  readonly queueNumber: number;
  readonly queueLabel: string;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly patientPhone: string;
  readonly dentistId: number | null;
  readonly dentistName: string;
  readonly appointmentId: number | null;
  readonly date: IsoDate;
  readonly arrivalTime: IsoTime;
  readonly status: QueueStatus;
  readonly priority: QueuePriority;
  readonly notes: string;
  readonly calledAt: IsoInstant | null;
  readonly startedAt: IsoInstant | null;
  readonly completedAt: IsoInstant | null;
  readonly visitId: number | null;
  readonly waitingMinutes: number | null;
}

export interface QueueInput {
  patientId: number;
  dentistId: number | null;
  appointmentId: number | null;
  priority: QueuePriority;
  notes: string;
}

// ---------------------------------------------------------------------------
// Invoices & payments
// ---------------------------------------------------------------------------

export interface InvoiceItem {
  readonly id: number;
  readonly invoiceId: number;
  readonly treatmentId: number | null;
  readonly treatmentRecordId: number | null;
  readonly code: string;
  readonly description: string;
  readonly toothCodes: readonly string[];
  readonly quantity: number;
  readonly unitPricePaisa: Paisa;
  readonly discountType: 'none' | 'percent' | 'amount';
  readonly discountValue: number;
  readonly discountPaisa: Paisa;
  readonly lineTotalPaisa: Paisa;
  readonly sortOrder: number;
}

export interface InvoiceItemInput {
  id?: number | null;
  treatmentId: number | null;
  treatmentRecordId?: number | null;
  code: string;
  description: string;
  toothCodes: string[];
  quantity: number;
  unitPricePaisa: Paisa;
  discountType: 'none' | 'percent' | 'amount';
  discountValue: number;
  sortOrder: number;
}

export interface InvoiceSummary {
  readonly id: number;
  readonly number: string;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly date: IsoDate;
  readonly subtotalPaisa: Paisa;
  readonly discountPaisa: Paisa;
  readonly totalPaisa: Paisa;
  readonly paidPaisa: Paisa;
  readonly duePaisa: Paisa;
  readonly status: InvoiceStatus;
  readonly itemCount: number;
  readonly visitId: number | null;
  readonly createdByName: string;
  readonly createdAt: IsoInstant;
  readonly voidedAt: IsoInstant | null;
  readonly voidReason: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  readonly patientPhone: string;
  readonly patientAddress: string;
  readonly notes: string;
  readonly items: readonly InvoiceItem[];
  readonly payments: readonly PaymentSummary[];
  readonly dentistId: number | null;
  readonly dentistName: string;
}

export interface InvoiceInput {
  patientId: number;
  visitId: number | null;
  dentistId: number | null;
  date: IsoDate;
  notes: string;
  items: InvoiceItemInput[];
  discountType?: 'none' | 'percent' | 'amount';
  discountValue?: number;
}

export interface InvoiceListQuery extends ListQuery {
  status?: InvoiceStatus[];
  patientId?: number;
  hasOutstanding?: boolean;
}

export interface PaymentSummary {
  readonly id: number;
  readonly receiptNumber: string;
  readonly invoiceId: number;
  readonly invoiceNumber: string;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly amountPaisa: Paisa;
  readonly methodId: number | null;
  readonly methodName: string;
  readonly methodCategory: PaymentMethodCategory;
  readonly reference: string;
  readonly note: string;
  readonly paidAt: IsoInstant;
  readonly paidDate: IsoDate;
  readonly receivedByName: string;
  readonly isVoid: boolean;
  readonly voidReason: string;
  readonly createdAt: IsoInstant;
}

export interface PaymentInput {
  invoiceId: number;
  amountPaisa: Paisa;
  methodId: number | null;
  reference: string;
  note: string;
  paidAtInstant?: IsoInstant;
  paidDate?: IsoDate;
}

export interface PaymentMethod {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly category: PaymentMethodCategory;
  readonly requiresReference: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly usageCount: number;
}

export interface PaymentMethodInput {
  code: string;
  name: string;
  category: PaymentMethodCategory;
  requiresReference: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface PaymentStats {
  readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly totalPaisa: Paisa;
  readonly cashPaisa: Paisa;
  readonly bankPaisa: Paisa;
  readonly cardPaisa: Paisa;
  readonly mobileWalletPaisa: Paisa;
  readonly otherPaisa: Paisa;
  readonly byMethod: ReadonlyArray<{ methodId: number; methodName: string; category: PaymentMethodCategory; amountPaisa: Paisa; count: number }>;
  readonly daily: ReadonlyArray<{ date: IsoDate; amountPaisa: Paisa; count: number }>;
  readonly outstandingPaisa: Paisa;
  readonly invoiceCount: number;
  readonly paymentCount: number;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryCategory {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly itemCount: number;
}

export interface Supplier {
  readonly id: number;
  readonly name: string;
  readonly contactPerson: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly notes: string;
  readonly isActive: boolean;
  readonly purchaseCount: number;
  readonly lastPurchaseDate: IsoDate | null;
  readonly totalPurchasedPaisa: Paisa;
}

export interface InventoryItem {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly categoryId: number | null;
  readonly categoryName: string;
  readonly supplierId: number | null;
  readonly supplierName: string;
  readonly unit: InventoryUnit;
  readonly purchasePricePaisa: Paisa;
  readonly sellingPricePaisa: Paisa | null;
  readonly currentStockMilli: number;
  readonly currentStockText: string;
  readonly minimumStockMilli: number;
  readonly reorderLevelMilli: number;
  readonly batchNumber: string;
  readonly expiryDate: IsoDate | null;
  readonly purchaseDate: IsoDate | null;
  readonly storageLocation: string;
  readonly notes: string;
  readonly isActive: boolean;
  readonly isLowStock: boolean;
  readonly isExpiringSoon: boolean;
  readonly isExpired: boolean;
  readonly stockValuePaisa: Paisa;
  readonly createdAt: IsoInstant;
}

export interface InventoryItemInput {
  code: string;
  name: string;
  categoryId: number | null;
  supplierId: number | null;
  unit: InventoryUnit;
  purchasePricePaisa: Paisa;
  sellingPricePaisa: Paisa | null;
  minimumStockMilli: number;
  reorderLevelMilli: number;
  batchNumber: string;
  expiryDate: IsoDate | null;
  purchaseDate: IsoDate | null;
  storageLocation: string;
  notes: string;
  isActive: boolean;
}

export interface StockMovement {
  readonly id: number;
  readonly itemId: number;
  readonly itemName: string;
  readonly itemCode: string;
  readonly type: StockMovementType;
  readonly quantityMilli: number;
  readonly quantityText: string;
  readonly signedQuantityMilli: number;
  readonly balanceAfterMilli: number;
  readonly unitCostPaisa: Paisa | null;
  readonly reason: string;
  readonly reference: string;
  readonly relatedPurchaseId: number | null;
  readonly relatedVisitId: number | null;
  readonly movedAt: IsoInstant;
  readonly movedDate: IsoDate;
  readonly movedByName: string;
}

export interface StockMovementInput {
  itemId: number;
  type: StockMovementType;
  quantityMilli: number;
  unitCostPaisa: Paisa | null;
  reason: string;
  reference: string;
  batchNumber?: string;
  expiryDate?: IsoDate | null;
}

export interface InventoryPurchaseItem {
  readonly id: number;
  readonly purchaseId: number;
  readonly itemId: number | null;
  readonly itemName: string;
  readonly quantityMilli: number;
  readonly quantityText: string;
  readonly unitPricePaisa: Paisa;
  readonly totalPaisa: Paisa;
  readonly batchNumber: string;
  readonly expiryDate: IsoDate | null;
}

export interface InventoryPurchase {
  readonly id: number;
  readonly reference: string;
  readonly supplierId: number | null;
  readonly supplierName: string;
  readonly date: IsoDate;
  readonly invoiceNumber: string;
  readonly subtotalPaisa: Paisa;
  readonly discountPaisa: Paisa;
  readonly totalPaisa: Paisa;
  readonly paidPaisa: Paisa;
  readonly paymentMethodId: number | null;
  readonly paymentMethodName: string;
  readonly notes: string;
  readonly createdByName: string;
  readonly createdAt: IsoInstant;
  readonly itemCount: number;
  readonly items: readonly InventoryPurchaseItem[];
}

export interface InventoryPurchaseInput {
  supplierId: number | null;
  date: IsoDate;
  invoiceNumber: string;
  paymentMethodId: number | null;
  paidPaisa: Paisa;
  discountPaisa: Paisa;
  notes: string;
  recordAsExpense: boolean;
  items: Array<{
    id?: number | null;
    itemId: number | null;
    itemName: string;
    unit: InventoryUnit;
    quantityMilli: number;
    unitPricePaisa: Paisa;
    batchNumber: string;
    expiryDate: IsoDate | null;
    createItemIfMissing?: boolean;
    categoryId?: number | null;
  }>;
}

export interface InventoryAlerts {
  readonly lowStock: readonly InventoryItem[];
  readonly expiringSoon: readonly InventoryItem[];
  readonly expired: readonly InventoryItem[];
}

export interface InventoryStats {
  readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly stockValuePaisa: Paisa;
  readonly itemCount: number;
  readonly lowStockCount: number;
  readonly expiredCount: number;
  readonly expiringSoonCount: number;
  readonly purchaseTotalPaisa: Paisa;
  readonly consumptionValuePaisa: Paisa;
  readonly topConsumed: ReadonlyArray<{ itemId: number; itemName: string; quantityMilli: number; quantityText: string; valuePaisa: Paisa }>;
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

export interface AccountingCategory {
  readonly id: number;
  readonly name: string;
  readonly direction: AccountingDirection;
  readonly isActive: boolean;
  readonly isSystem: boolean;
  readonly usageCount: number;
}

export interface AccountingTransaction {
  readonly id: number;
  readonly direction: AccountingDirection;
  readonly date: IsoDate;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly amountPaisa: Paisa;
  readonly paymentMethodId: number | null;
  readonly paymentMethodName: string;
  readonly reference: string;
  readonly note: string;
  readonly sourceType: 'manual' | 'payment' | 'invoice_void' | 'purchase' | 'payroll' | 'opening';
  readonly sourceId: number | null;
  readonly attachmentCount: number;
  readonly createdByName: string;
  readonly createdAt: IsoInstant;
  readonly isVoid: boolean;
  readonly voidReason: string;
}

export interface AccountingTransactionInput {
  direction: AccountingDirection;
  date: IsoDate;
  categoryId: number;
  amountPaisa: Paisa;
  paymentMethodId: number | null;
  reference: string;
  note: string;
}

export interface FinancialPeriod {
  readonly id: number;
  readonly label: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly isClosed: boolean;
  readonly closedAt: IsoInstant | null;
  readonly closedByName: string | null;
  readonly notes: string;
  readonly incomePaisa: Paisa;
  readonly expensePaisa: Paisa;
}

export interface AccountingSummary {
  readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly incomePaisa: Paisa;
  readonly expensePaisa: Paisa;
  readonly netPaisa: Paisa;
  readonly collectedFromInvoicesPaisa: Paisa;
  readonly outstandingPaisa: Paisa;
  readonly byCategory: ReadonlyArray<{ categoryId: number; categoryName: string; direction: AccountingDirection; amountPaisa: Paisa; count: number }>;
  readonly byMonth: ReadonlyArray<{ month: string; incomePaisa: Paisa; expensePaisa: Paisa; netPaisa: Paisa }>;
  readonly byMethod: ReadonlyArray<{ methodId: number | null; methodName: string; amountPaisa: Paisa }>;
}

export interface DaybookRow {
  readonly date: IsoDate;
  readonly openingPaisa: Paisa;
  readonly incomePaisa: Paisa;
  readonly expensePaisa: Paisa;
  readonly closingPaisa: Paisa;
  readonly entries: number;
}

// ---------------------------------------------------------------------------
// Staff & dentists
// ---------------------------------------------------------------------------

export interface StaffMember {
  readonly id: number;
  readonly name: string;
  readonly designation: string;
  readonly department: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly dob: IsoDate | null;
  readonly ageYears: number | null;
  readonly bloodGroup: BloodGroup;
  readonly nationalId: string;
  readonly photoPath: string | null;
  readonly salaryPaisa: Paisa | null;
  readonly joiningDate: IsoDate | null;
  readonly status: 'active' | 'on_leave' | 'resigned';
  readonly notes: string;
  readonly userId: number | null;
  readonly createdAt: IsoInstant;
}

export interface StaffInput {
  name: string;
  designation: string;
  department: string;
  phone: string;
  email: string;
  address: string;
  dob: IsoDate | null;
  bloodGroup: BloodGroup;
  nationalId: string;
  salaryPaisa: Paisa | null;
  joiningDate: IsoDate | null;
  status: 'active' | 'on_leave' | 'resigned';
  notes: string;
  userId: number | null;
}

export interface DentistCredential {
  readonly id: number;
  readonly dentistId: number;
  readonly type: 'designation' | 'qualification' | 'certification';
  readonly title: string;
  readonly institution: string;
  readonly year: number | null;
  readonly sortOrder: number;
  readonly showOnPrescription: boolean;
}

export interface Dentist {
  readonly id: number;
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly photoPath: string | null;
  readonly signaturePath: string | null;
  readonly registrationNumber: string;
  readonly visitingHours: string;
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly credentials: readonly DentistCredential[];
  readonly todayAppointmentCount: number;
  readonly monthVisitCount: number;
}

export interface DentistInput {
  name: string;
  phone: string;
  email: string;
  registrationNumber: string;
  visitingHours: string;
  isActive: boolean;
  isDefault: boolean;
  credentials: Array<{
    id?: number | null;
    type: DentistCredential['type'];
    title: string;
    institution: string;
    year: number | null;
    sortOrder: number;
    showOnPrescription: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Users, roles, audit
// ---------------------------------------------------------------------------

export interface UserAccount {
  readonly id: number;
  readonly username: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly isActive: boolean;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: IsoInstant | null;
  readonly failedAttempts: number;
  readonly lockedUntil: IsoInstant | null;
  readonly roleIds: readonly number[];
  readonly roleNames: readonly string[];
  readonly createdAt: IsoInstant;
}

export interface UserInput {
  username: string;
  fullName: string;
  email: string;
  phone: string;
  isActive: boolean;
  mustChangePassword: boolean;
  roleIds: number[];
  password?: string;
}

export interface Role {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
  readonly userCount: number;
}

export interface RoleInput {
  key?: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface AuditEntry {
  readonly id: number;
  readonly action: string;
  readonly actionLabel: string;
  readonly entityType: string;
  readonly entityId: number | null;
  readonly entityLabel: string;
  readonly userId: number | null;
  readonly userName: string;
  readonly detail: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly createdAt: IsoInstant;
  readonly hasBeforeAfter: boolean;
}

export interface AuditEntryDetail extends AuditEntry {
  readonly before: unknown;
  readonly after: unknown;
  readonly context: Readonly<Record<string, string>>;
}

export interface AuditListQuery extends ListQuery {
  action?: string[];
  userId?: number | null;
  entityType?: string;
  severity?: Array<'info' | 'warning' | 'critical'>;
}

// ---------------------------------------------------------------------------
// Notifications, search, dashboard, reports
// ---------------------------------------------------------------------------

export interface Notification {
  readonly id: number;
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly message: string;
  readonly entityType: string;
  readonly entityId: number | null;
  readonly isRead: boolean;
  readonly isDismissed: boolean;
  readonly createdAt: IsoInstant;
  readonly target: { readonly screen: string; readonly id?: number } | null;
}

export interface SearchResultItem {
  readonly id: number;
  readonly title: string;
  readonly subtitle: string;
  readonly meta: string;
  readonly screen: string;
  readonly badge?: string;
}

export interface SearchGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly SearchResultItem[];
}

export interface GlobalSearchResponse {
  readonly query: string;
  readonly groups: readonly SearchGroup[];
  readonly totalCount: number;
  readonly tookMs: number;
  readonly truncated: boolean;
}

export interface DashboardCard {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly tone: 'default' | 'success' | 'warning' | 'danger' | 'info';
  readonly screen: string;
  readonly requiresFinancialPermission: boolean;
}

export interface DashboardData {
  readonly cards: readonly DashboardCard[];
  readonly todayAppointments: readonly Appointment[];
  readonly queue: readonly QueueEntry[];
  readonly upcomingAppointments: readonly Appointment[];
  readonly noShowsToday: number;
  readonly recentPrescriptions: readonly PrescriptionSummary[];
  readonly recentInvoices: readonly InvoiceSummary[];
  readonly newPatientsThisMonth: number;
  readonly followUpsDue: readonly { patientId: number; patientCode: string; patientName: string; followUpDate: IsoDate; phone: string }[];
  readonly inventoryAlerts: { lowStock: number; expiringSoon: number; expired: number; items: readonly InventoryItem[] };
  readonly backup: { lastBackupAt: IsoInstant | null; isDue: boolean; intervalDays: number; folder: string };
  readonly paymentTrend: readonly { date: IsoDate; amountPaisa: Paisa }[];
  readonly dentitionSummary: { permanentFindings: number; primaryFindings: number };
  readonly generatedAt: IsoInstant;
}

export type ReportKey =
  | 'patients_registered'
  | 'patient_register_detail'
  | 'appointments'
  | 'no_shows'
  | 'visits'
  | 'treatments'
  | 'prescriptions'
  | 'revenue'
  | 'payments'
  | 'outstanding'
  | 'expenses'
  | 'income'
  | 'profit'
  | 'inventory_stock'
  | 'inventory_low_stock'
  | 'inventory_expiry'
  | 'inventory_movements'
  | 'dentist_activity'
  | 'staff_activity'
  | 'referrals'
  | 'audit_summary'
  | 'daybook';

export interface ReportRequest {
  reportKey: ReportKey;
  from: IsoDate;
  to: IsoDate;
  filters?: {
    dentistId?: number | null;
    patientId?: number | null;
    categoryId?: number | null;
    supplierId?: number | null;
    itemId?: number | null;
    status?: string | null;
    paymentMethodId?: number | null;
    direction?: AccountingDirection | null;
  };
  groupBy?: 'day' | 'week' | 'month' | 'category' | 'dentist' | 'patient' | 'method' | null;
}

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
  readonly align: 'left' | 'right' | 'center';
  readonly widthMm?: number;
  readonly type: 'text' | 'number' | 'money' | 'date' | 'datetime' | 'status';
}

export interface ReportResult {
  readonly reportKey: ReportKey;
  readonly title: string;
  readonly subtitle: string;
  readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly columns: readonly ReportColumn[];
  readonly rows: ReadonlyArray<Readonly<Record<string, string | number | null>>>;
  readonly totals: Readonly<Record<string, number>>;
  readonly summary: ReadonlyArray<{ label: string; value: string; tone?: 'default' | 'success' | 'warning' | 'danger' }>;
  readonly chart: ReadonlyArray<{ label: string; value: number }> | null;
  readonly generatedAt: IsoInstant;
  readonly rowCount: number;
  readonly requiresFinancialPermission: boolean;
}

export interface DataSummary {
  readonly patients: number;
  readonly deletedPatients: number;
  readonly visits: number;
  readonly appointments: number;
  readonly prescriptions: number;
  readonly invoices: number;
  readonly payments: number;
  readonly treatments: number;
  readonly inventoryItems: number;
  readonly stockMovements: number;
  readonly accountingTransactions: number;
  readonly attachments: number;
  readonly auditEntries: number;
  readonly notifications: number;
  readonly databaseSizeBytes: number;
  readonly attachmentSizeBytes: number;
  readonly oldestRecordDate: IsoDate | null;
  readonly newestRecordDate: IsoDate | null;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export interface PrinterProfile {
  readonly id: number;
  readonly name: string;
  readonly kind: PrintTemplateKind;
  readonly printerName: string;
  readonly paperKey: PaperSizeKey;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly orientation: 'portrait' | 'landscape';
  readonly marginTopMm: number;
  readonly marginRightMm: number;
  readonly marginBottomMm: number;
  readonly marginLeftMm: number;
  readonly scalePercent: number;
  readonly copies: number;
  readonly isThermal: boolean;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly headerNote: string;
  readonly footerNote: string;
}

export interface PrinterProfileInput {
  name: string;
  kind: PrintTemplateKind;
  printerName: string;
  paperKey: PaperSizeKey;
  widthMm: number;
  heightMm: number;
  orientation: 'portrait' | 'landscape';
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  scalePercent: number;
  copies: number;
  isThermal: boolean;
  isDefault: boolean;
  isActive: boolean;
  headerNote: string;
  footerNote: string;
}

export interface PrintTemplate {
  readonly id: number;
  readonly kind: PrintTemplateKind;
  readonly name: string;
  readonly headerText: string;
  readonly footerText: string;
  readonly showLogo: boolean;
  readonly showDentistSignature: boolean;
  readonly showDentistQualifications: boolean;
  readonly signatureLabel: string;
  readonly accentColour: string;
  readonly isDefault: boolean;
}

export interface PrintTemplateInput {
  kind: PrintTemplateKind;
  name: string;
  headerText: string;
  footerText: string;
  showLogo: boolean;
  showDentistSignature: boolean;
  showDentistQualifications: boolean;
  signatureLabel: string;
  accentColour: string;
  isDefault: boolean;
}

export interface SystemPrinter {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly status: number;
  readonly isDefault: boolean;
  readonly options: Readonly<Record<string, string>>;
}

export interface PrintRenderRequest {
  kind: PrintTemplateKind;
  /** Entity id for prescription/invoice/patient_summary; report requests supply `report`. */
  id?: number | null;
  report?: ReportRequest | null;
  profileId?: number | null;
  templateId?: number | null;
  /** pdf = write a PDF and return its path; print = send to the printer; preview = open the PDF viewer. */
  output: 'pdf' | 'print' | 'preview';
  copies?: number | null;
}

export interface PrintRenderResult {
  readonly kind: PrintTemplateKind;
  readonly output: 'pdf' | 'print' | 'preview';
  readonly pdfPath: string | null;
  readonly pageCount: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly printerName: string | null;
  readonly copies: number;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Attachments & backups
// ---------------------------------------------------------------------------

export interface Attachment {
  readonly id: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly patientId: number | null;
  readonly patientName: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly category: AttachmentCategory;
  readonly description: string;
  readonly uploadedByName: string;
  readonly createdAt: IsoInstant;
  readonly isImage: boolean;
  readonly missingFile: boolean;
}

export interface AttachmentInput {
  entityType: string;
  entityId: number;
  patientId: number | null;
  category: AttachmentCategory;
  description: string;
  fileName: string;
}

export interface BackupRecord {
  readonly id: number;
  readonly fileName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly kind: 'manual' | 'automatic' | 'pre_restore';
  readonly status: 'completed' | 'failed' | 'in_progress';
  readonly note: string;
  readonly createdAt: IsoInstant;
  readonly createdByName: string;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly patientCount: number;
  readonly invoiceCount: number;
  readonly attachmentCount: number;
  readonly checksum: string;
  readonly verifiedAt: IsoInstant | null;
}

export interface BackupStatus {
  readonly folder: string;
  readonly folderWritable: boolean;
  readonly intervalDays: number;
  readonly lastBackupAt: IsoInstant | null;
  readonly nextDueAt: IsoInstant | null;
  readonly isDue: boolean;
  readonly lastFailure: { message: string; at: IsoInstant } | null;
  readonly backups: readonly BackupRecord[];
  readonly preRestoreBackups: readonly BackupRecord[];
  readonly externalFiles: readonly BackupCandidate[];
}

export interface BackupCandidate {
  readonly filePath: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly modifiedAt: IsoInstant;
  readonly valid: boolean;
  readonly metadata: BackupMetadata | null;
  readonly problem: string | null;
}

export interface BackupMetadata {
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: IsoInstant;
  readonly clinicName: string;
  readonly patientCount: number;
  readonly invoiceCount: number;
  readonly attachmentCount: number;
  readonly checksum: string;
  readonly containsAttachments: boolean;
}

export interface RestorePreview {
  readonly candidate: BackupCandidate;
  readonly currentData: { readonly patients: number; readonly invoices: number; readonly visits: number };
  readonly warnings: readonly string[];
  readonly requiresTypedConfirmation: string;
}

export interface RestoreResult {
  readonly restored: boolean;
  readonly databaseRestored: boolean;
  readonly attachmentsRestored: number;
  readonly preRestoreBackupPath: string | null;
  readonly integrityOk: boolean;
  readonly relaunchRequired: boolean;
  readonly message: string;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly checkedAt: IsoInstant;
  readonly foreignKeyViolations: number;
  readonly checks: ReadonlyArray<{ name: string; ok: boolean; detail: string }>;
  readonly databaseSizeBytes: number;
  readonly orphanAttachments: number;
  readonly missingAttachments: number;
}

// ---------------------------------------------------------------------------
// Access control helpers used by the UI
// ---------------------------------------------------------------------------

export interface PermissionDescriptor {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly sensitive: boolean;
}

export interface SystemInfo {
  readonly appVersion: string;
  readonly appBuild: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly osVersion: string;
  readonly architecture: string;
  readonly userDataPath: string;
  readonly databasePath: string;
  readonly logPath: string;
  readonly installedAt: IsoInstant | null;
  readonly locale: string;
}

// ---------------------------------------------------------------------------
// Master-data inputs referenced by the resource API
// ---------------------------------------------------------------------------

export interface PatientTagInput {
  name: string;
  colour: string;
}

export interface MedicationListQuery extends ListQuery {
  form?: MedicationForm[];
  includeInactive?: boolean;
}

export interface MedicationListRow extends Medication {}

export interface ClinicalOptionInput {
  category: ClinicalOptionCategory;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

export interface InventoryCategoryInput {
  name: string;
  description: string;
}

export interface SupplierInput {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
}

export interface AccountingCategoryInput {
  name: string;
  direction: AccountingDirection;
  isActive: boolean;
}

export interface ReferralDoctor {
  readonly id: number;
  readonly name: string;
  readonly specialty: string;
  readonly organisation: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly notes: string;
  readonly isActive: boolean;
  readonly referralCount: number;
}

export interface ReferralDoctorInput {
  name: string;
  specialty: string;
  organisation: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
}

export interface Referral {
  readonly id: number;
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly visitId: number | null;
  readonly referralDoctorId: number | null;
  readonly doctorName: string;
  readonly specialty: string;
  readonly organisation: string;
  readonly contact: string;
  readonly reason: string;
  readonly date: IsoDate;
  readonly followUpDate: IsoDate | null;
  readonly status: ReferralStatus;
  readonly notes: string;
  readonly createdByName: string;
  readonly createdAt: IsoInstant;
}

export interface ReferralInput {
  patientId: number;
  visitId: number | null;
  referralDoctorId: number | null;
  doctorName: string;
  specialty: string;
  organisation: string;
  contact: string;
  reason: string;
  date: IsoDate;
  followUpDate: IsoDate | null;
  status: ReferralStatus;
  notes: string;
}

export interface TreatmentListQuery extends ListQuery {
  category?: string | null;
  isActive?: boolean;
}

export interface TreatmentPlanInput {
  patientId: number;
  title: string;
  status: TreatmentPlan['status'];
  notes: string;
}

export interface TreatmentPlanItemInput {
  id?: number | null;
  treatmentId: number | null;
  description: string;
  toothCodes: string[];
  sessionNumber: number;
  estimatedPaisa: Paisa;
  status: TreatmentPlanItem['status'];
  notes: string;
  completedVisitId?: number | null;
}

export interface TreatmentPlanSummaryRow {
  readonly id: number;
  readonly patientId: number;
  readonly patientName: string;
  readonly title: string;
  readonly status: TreatmentPlan['status'];
  readonly estimatedTotalPaisa: Paisa;
  readonly itemCount: number;
  readonly completedItems: number;
  readonly createdAt: IsoInstant;
}

export interface ReportCatalogueEntry {
  readonly key: ReportKey;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  readonly requiresFinancialPermission: boolean;
}

export interface PermissionCatalogueEntry {
  readonly key: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly label: string;
  readonly description: string;
  readonly sensitive: boolean;
}

export interface InvoiceOutstandingRow {
  readonly patientId: number;
  readonly patientCode: string;
  readonly patientName: string;
  readonly phone: string;
  readonly invoiceCount: number;
  readonly totalPaisa: Paisa;
  readonly paidPaisa: Paisa;
  readonly duePaisa: Paisa;
  readonly oldestDueDate: IsoDate;
  readonly lastPaymentAt: IsoInstant | null;
}

export interface TreatmentUsageRow {
  readonly label: string;
  readonly value: number;
  readonly amountPaisa: Paisa;
}
