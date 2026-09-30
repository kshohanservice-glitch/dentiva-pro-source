/**
 * The typed API surface between the renderer and the core services.
 *
 * Every entry is validated by zod on the main-process side, authorised against
 * the live session's permissions and only then executed. The renderer never
 * touches the database directly.
 */
import type {
  AccountingSummary,
  AccountingTransaction,
  AccountingTransactionInput,
  AccountingCategory,
  AccountingCategoryInput,
  Appointment,
  AppointmentInput,
  AppointmentListQuery,
  AppSettings,
  Attachment,
  AttachmentInput,
  AuditEntry,
  AuditEntryDetail,
  AuditListQuery,
  BackupCandidate,
  BackupRecord,
  BackupStatus,
  ClinicProfile,
  ClinicalOption,
  ClinicalOptionInput,
  DashboardData,
  DataSummary,
  DaybookRow,
  DentalChart,
  Dentist,
  DentistInput,
  FinancialPeriod,
  GlobalSearchResponse,
  HealthReport,
  IntegrityReport,
  InventoryAlerts,
  InventoryCategory,
  InventoryCategoryInput,
  InventoryItem,
  InventoryItemInput,
  InventoryPurchase,
  InventoryPurchaseInput,
  InventoryStats,
  InvoiceDetail,
  InvoiceInput,
  InvoiceListQuery,
  InvoiceSummary,
  ListQuery,
  Medication,
  MedicationInput,
  MedicationListQuery,
  Notification,
  Paged,
  PatientDetail,
  PatientFinancialSummary,
  PatientInput,
  PatientListQuery,
  PatientSummary,
  PatientTag,
  PatientTagInput,
  PaymentInput,
  PaymentMethod,
  PaymentMethodInput,
  PaymentStats,
  PaymentSummary,
  PerioRecord,
  PrescriptionDetail,
  PrescriptionInput,
  PrescriptionSummary,
  PrintRenderRequest,
  PrintRenderResult,
  PrintTemplate,
  PrintTemplateInput,
  PrinterProfile,
  PrinterProfileInput,
  QueueEntry,
  QueueInput,
  Referral,
  ReferralDoctor,
  ReferralDoctorInput,
  ReferralInput,
  ReportRequest,
  ReportResult,
  RestorePreview,
  RestoreResult,
  Role,
  RoleInput,
  SearchResultItem,
  SessionUser,
  SetupStatus,
  StaffInput,
  StaffMember,
  StockMovement,
  StockMovementInput,
  Supplier,
  SupplierInput,
  SystemInfo,
  SystemPrinter,
  TimelineEvent,
  ToothFinding,
  ToothFindingInput,
  Treatment,
  TreatmentInput,
  TreatmentListQuery,
  TreatmentPlan,
  TreatmentPlanInput,
  TreatmentPlanItem,
  TreatmentPlanItemInput,
  TreatmentRecord,
  UserAccount,
  UserInput,
  VisitDetail,
  VisitInput,
  VisitSummary,
} from './types';
import type { ActivationStatus, AppBootstrap } from './types';
import type { AccountingDirection, ClinicalOptionCategory, PatientStatus } from './constants';
import type { IsoDate } from './dates';
import type { Paisa } from './money';

// ---------------------------------------------------------------------------
// Generic master-data resources
// ---------------------------------------------------------------------------

export interface ResourceTypes {
  'patient-tags': { entity: PatientTag; input: PatientTagInput; query: ListQuery };
  medications: { entity: Medication; input: MedicationInput; query: MedicationListQuery };
  'clinical-options': { entity: ClinicalOption; input: ClinicalOptionInput; query: ListQuery };
  'payment-methods': { entity: PaymentMethod; input: PaymentMethodInput; query: ListQuery };
  'inventory-categories': { entity: InventoryCategory; input: InventoryCategoryInput; query: ListQuery };
  suppliers: { entity: Supplier; input: SupplierInput; query: ListQuery };
  'accounting-categories': { entity: AccountingCategory; input: AccountingCategoryInput; query: ListQuery };
  'referral-doctors': { entity: ReferralDoctor; input: ReferralDoctorInput; query: ListQuery };
  'printer-profiles': { entity: PrinterProfile; input: PrinterProfileInput; query: ListQuery };
  'print-templates': { entity: PrintTemplate; input: PrintTemplateInput; query: ListQuery };
  treatments: { entity: Treatment; input: TreatmentInput; query: TreatmentListQuery };
}

export type ResourceName = keyof ResourceTypes;
export type ResourceEntity<K extends ResourceName> = ResourceTypes[K]['entity'];
export type ResourceInput<K extends ResourceName> = ResourceTypes[K]['input'];
export type ResourceQuery<K extends ResourceName> = ResourceTypes[K]['query'];

export interface DeleteOptions {
  reason?: string;
  /** Required for hard deletion of records with history. */
  confirmText?: string;
}

// ---------------------------------------------------------------------------
// Method map
// ---------------------------------------------------------------------------

export interface ApiMethods {
  // --- Application shell & session ---------------------------------------
  'app.bootstrap': { req: undefined; res: AppBootstrap };
  'app.health': { req: undefined; res: HealthReport };
  'app.systemInfo': { req: undefined; res: SystemInfo };
  'app.relaunch': { req: undefined; res: undefined };
  'app.openPath': { req: { path: string; reveal?: boolean }; res: undefined };
  'app.openExternal': { req: { url: string }; res: undefined };

  'auth.login': { req: { username: string; password: string }; res: SessionUser };
  'auth.logout': { req: undefined; res: undefined };
  'auth.lock': { req: undefined; res: undefined };
  'auth.unlock': { req: { password: string }; res: SessionUser };
  'auth.changePassword': { req: { currentPassword: string; newPassword: string }; res: undefined };
  'auth.session': { req: undefined; res: SessionUser | null };

  'activation.status': { req: undefined; res: ActivationStatus };
  'activation.activate': { req: { code: string }; res: ActivationStatus };

  'setup.status': { req: undefined; res: SetupStatus };
  'setup.saveClinic': { req: { name: string; address: string; phone: string; email: string; website: string; logoSourcePath?: string | null }; res: undefined };
  'setup.saveDentists': { req: { dentists: DentistInput[] }; res: undefined };
  'setup.savePreferences': {
    req: {
      dateFormat: string;
      timeFormat: string;
      timeZone: string;
      numberGrouping: AppSettings['numberGrouping'];
      autoLockMinutes: number;
      backupFolder: string;
      backupIntervalDays: number;
      defaultPrinterName: string;
    };
    res: undefined;
  };
  'setup.createAdministrator': { req: { username: string; fullName: string; password: string }; res: undefined };
  'setup.review': { req: undefined; res: { clinic: ClinicProfile | null; dentists: Dentist[]; preferences: AppSettings | null; administrator: string | null } };
  'setup.complete': { req: undefined; res: undefined };

  'clinic.get': { req: undefined; res: ClinicProfile };
  'clinic.update': { req: { name: string; address: string; phone: string; email: string; website: string; clinicMessage: string; visitingHours: string; registrationNumber: string; logoSourcePath?: string | null; removeLogo?: boolean }; res: ClinicProfile };
  'settings.get': { req: undefined; res: AppSettings };
  'settings.update': { req: { patch: Partial<AppSettings> }; res: AppSettings };

  // --- Generic master data ------------------------------------------------
  'resource.list': { req: { resource: ResourceName; query?: ListQuery; includeInactive?: boolean }; res: Paged<never> };
  'resource.get': { req: { resource: ResourceName; id: number }; res: unknown };
  'resource.save': { req: { resource: ResourceName; id?: number | null; input: unknown }; res: { id: number } };
  'resource.delete': { req: { resource: ResourceName; id: number; options?: DeleteOptions }; res: undefined };
  'resource.restore': { req: { resource: ResourceName; id: number }; res: undefined };
  'resource.options': { req: { resource: ResourceName }; res: Array<{ value: number; label: string; meta?: string }> };

  // --- Patients -----------------------------------------------------------
  'patients.list': { req: PatientListQuery; res: Paged<PatientSummary> };
  'patients.get': { req: { id: number }; res: PatientDetail };
  'patients.create': { req: { input: PatientInput }; res: { id: number; code: string } };
  'patients.update': { req: { id: number; input: PatientInput }; res: undefined };
  'patients.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'patients.restore': { req: { id: number }; res: undefined };
  'patients.timeline': { req: { id: number; types?: string[]; from?: IsoDate; to?: IsoDate; limit?: number }; res: TimelineEvent[] };
  'patients.financialSummary': { req: { id: number }; res: PatientFinancialSummary };
  'patients.checkDuplicate': { req: { name?: string; phone?: string; excludeId?: number }; res: { matches: Array<{ id: number; code: string; name: string; phone: string; registeredAt: IsoDate }> } };
  'patients.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate }; res: { total: number; active: number; newInRange: number; byGender: Array<{ label: string; value: number }>; byStatus: Array<{ label: string; value: number }>; registrations: Array<{ date: IsoDate; count: number }> } };
  'patients.tags.save': { req: { id?: number | null; name: string; colour: string }; res: { id: number } };
  'patients.setTags': { req: { id: number; tagIds: number[] }; res: undefined };
  'patients.quickSearch': { req: { query: string; limit?: number }; res: PatientSummary[] };

  // --- Attachments --------------------------------------------------------
  'attachments.list': { req: { entityType: string; entityId: number } | { patientId: number }; res: Attachment[] };
  'attachments.pickAndAdd': { req: { entityType: string; entityId: number; patientId: number | null; category: Attachment['category']; description: string; copyFromPath?: string | null }; res: Attachment[] };
  'attachments.update': { req: { id: number; fileName?: string; category?: Attachment['category']; description?: string }; res: Attachment };
  'attachments.delete': { req: { id: number; reason?: string }; res: undefined };
  'attachments.open': { req: { id: number }; res: undefined };
  'attachments.revealInFolder': { req: { id: number }; res: undefined };
  'attachments.thumbnail': { req: { id: number; maxPixels?: number }; res: { dataUrl: string; width: number; height: number } | null };

  // --- Visits -------------------------------------------------------------
  'visits.list': { req: ListQuery & { patientId?: number; dentistId?: number | null }; res: Paged<VisitSummary> };
  'visits.get': { req: { id: number }; res: VisitDetail };
  'visits.create': { req: { input: VisitInput }; res: { id: number } };
  'visits.update': { req: { id: number; input: VisitInput }; res: undefined };
  'visits.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'visits.byPatient': { req: { patientId: number; limit?: number }; res: VisitSummary[] };
  'visits.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate; dentistId?: number | null }; res: { total: number; byDentist: Array<{ dentistId: number | null; dentistName: string; count: number }>; byDay: Array<{ date: IsoDate; count: number }>; topDiagnoses: Array<{ label: string; value: number }> } };

  // --- Dental chart -------------------------------------------------------
  'dental.getChart': { req: { patientId: number; dentition?: 'permanent' | 'primary'; numberingSystem?: 'fdi' | 'universal' | 'palmer' }; res: DentalChart };
  'dental.saveFindings': { req: { patientId: number; dentition: 'permanent' | 'primary'; findings: ToothFindingInput[]; visitId?: number | null; clearTeeth?: string[] }; res: DentalChart };
  'dental.history': { req: { patientId: number; toothFdi: string }; res: ToothFinding[] };
  'dental.savePerio': { req: { patientId: number; records: Array<{ toothFdi: string; site: string; depthMm: number }> }; res: DentalChart };
  'dental.clear': { req: { patientId: number; dentition: 'permanent' | 'primary'; confirmText?: string }; res: DentalChart };

  // --- Prescriptions ------------------------------------------------------
  'prescriptions.list': { req: ListQuery & { patientId?: number; dentistId?: number | null; includeVoid?: boolean }; res: Paged<PrescriptionSummary> };
  'prescriptions.get': { req: { id: number }; res: PrescriptionDetail };
  'prescriptions.create': { req: { input: PrescriptionInput }; res: { id: number; number: string } };
  'prescriptions.update': { req: { id: number; input: PrescriptionInput }; res: undefined };
  'prescriptions.void': { req: { id: number; reason: string }; res: undefined };
  'prescriptions.delete': { req: { id: number; reason: string }; res: undefined };
  'prescriptions.byPatient': { req: { patientId: number; limit?: number }; res: PrescriptionSummary[] };
  'prescriptions.supersede': { req: { id: number; input: PrescriptionInput; reason: string }; res: { id: number; number: string } };

  // --- Treatment plans ----------------------------------------------------
  'treatmentPlans.list': { req: { patientId?: number; status?: string; page?: number; pageSize?: number }; res: Paged<TreatmentPlan> };
  'treatmentPlans.get': { req: { id: number }; res: TreatmentPlan };
  'treatmentPlans.create': { req: { input: TreatmentPlanInput }; res: { id: number } };
  'treatmentPlans.update': { req: { id: number; input: TreatmentPlanInput }; res: undefined };
  'treatmentPlans.delete': { req: { id: number; reason?: string }; res: undefined };
  'treatmentPlans.saveItem': { req: { planId: number; input: TreatmentPlanItemInput }; res: { id: number } };
  'treatmentPlans.deleteItem': { req: { id: number; reason?: string }; res: undefined };
  'treatmentPlans.completeItem': { req: { id: number; visitId: number | null }; res: undefined };
  'treatmentRecords.byPatient': { req: { patientId: number; limit?: number }; res: TreatmentRecord[] };
  'treatmentRecords.byVisit': { req: { visitId: number }; res: TreatmentRecord[] };
  'treatmentRecords.delete': { req: { id: number; reason: string }; res: undefined };

  // --- Referrals ----------------------------------------------------------
  'referrals.list': { req: { page?: number; pageSize?: number; patientId?: number; status?: string; search?: string; from?: IsoDate; to?: IsoDate }; res: Paged<Referral> };
  'referrals.get': { req: { id: number }; res: Referral };
  'referrals.save': { req: { id?: number | null; input: ReferralInput }; res: { id: number } };
  'referrals.delete': { req: { id: number; reason: string }; res: undefined };
  'referrals.byPatient': { req: { patientId: number }; res: Referral[] };
  'referrals.statistics': { req: { from: IsoDate; to: IsoDate }; res: { total: number; byStatus: Array<{ label: string; value: number }>; bySpecialty: Array<{ label: string; value: number }> } };

  // --- Appointments -------------------------------------------------------
  'appointments.list': { req: AppointmentListQuery; res: Paged<Appointment> };
  'appointments.get': { req: { id: number }; res: Appointment };
  'appointments.create': { req: { input: AppointmentInput }; res: { id: number } };
  'appointments.update': { req: { id: number; input: AppointmentInput }; res: undefined };
  'appointments.delete': { req: { id: number; reason?: string }; res: undefined };
  'appointments.setStatus': { req: { id: number; status: Appointment['status']; note?: string }; res: undefined };
  'appointments.byRange': { req: { from: IsoDate; to: IsoDate; dentistId?: number | null; statuses?: string[] }; res: Appointment[] };
  'appointments.byPatient': { req: { patientId: number; limit?: number }; res: Appointment[] };
  'appointments.availability': { req: { dentistId: number | null; date: IsoDate; excludeId?: number | null }; res: Array<{ startTime: string; endTime: string; appointmentId: number; patientName: string; status: string }> };
  'appointments.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate; dentistId?: number | null }; res: { total: number; completed: number; cancelled: number; noShow: number; byStatus: Array<{ label: string; value: number }>; byDay: Array<{ date: IsoDate; count: number }>; byDentist: Array<{ dentistId: number | null; dentistName: string; count: number }> } };

  // --- Queue --------------------------------------------------------------
  'queue.list': { req: { date?: IsoDate; includeClosed?: boolean }; res: QueueEntry[] };
  'queue.add': { req: { input: QueueInput }; res: { id: number; queueNumber: number; queueLabel: string } };
  'queue.setStatus': { req: { id: number; status: QueueEntry['status']; note?: string }; res: QueueEntry };
  'queue.move': { req: { id: number; direction: 'up' | 'down' }; res: QueueEntry[] };
  'queue.remove': { req: { id: number; reason?: string }; res: undefined };
  'queue.statistics': { req: { date?: IsoDate }; res: { waiting: number; called: number; inConsultation: number; completed: number; cancelled: number; averageWaitMinutes: number | null; longestWaitMinutes: number | null } };

  // --- Invoices -----------------------------------------------------------
  'invoices.list': { req: InvoiceListQuery; res: Paged<InvoiceSummary> };
  'invoices.get': { req: { id: number }; res: InvoiceDetail };
  'invoices.create': { req: { input: InvoiceInput }; res: { id: number; number: string } };
  'invoices.update': { req: { id: number; input: InvoiceInput }; res: undefined };
  'invoices.void': { req: { id: number; reason: string }; res: undefined };
  'invoices.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'invoices.byPatient': { req: { patientId: number; limit?: number }; res: InvoiceSummary[] };
  'invoices.outstanding': { req: { page?: number; pageSize?: number; search?: string }; res: Paged<{ patientId: number; patientCode: string; patientName: string; phone: string; invoiceCount: number; totalPaisa: Paisa; paidPaisa: Paisa; duePaisa: Paisa; oldestDueDate: IsoDate; lastPaymentAt: string | null }> };
  'invoices.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate }; res: { invoiceCount: number; invoicedPaisa: Paisa; collectedPaisa: Paisa; outstandingPaisa: Paisa; discountPaisa: Paisa; byStatus: Array<{ label: string; value: number }>; byDay: Array<{ date: IsoDate; invoicedPaisa: Paisa; collectedPaisa: Paisa }>; topTreatments: Array<{ label: string; value: number; amountPaisa: Paisa }> } };

  // --- Payments -----------------------------------------------------------
  'payments.list': { req: ListQuery & { patientId?: number; invoiceId?: number; methodId?: number | null; includeVoid?: boolean }; res: Paged<PaymentSummary> };
  'payments.get': { req: { id: number }; res: PaymentSummary };
  'payments.create': { req: { input: PaymentInput }; res: { id: number; receiptNumber: string } };
  'payments.update': { req: { id: number; input: PaymentInput }; res: undefined };
  'payments.void': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'payments.byInvoice': { req: { invoiceId: number }; res: PaymentSummary[] };
  'payments.byPatient': { req: { patientId: number; limit?: number }; res: PaymentSummary[] };
  'payments.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate }; res: PaymentStats };

  // --- Inventory ----------------------------------------------------------
  'inventory.items.list': { req: ListQuery & { categoryId?: number | null; supplierId?: number | null; lowStockOnly?: boolean; expiringOnly?: boolean; includeInactive?: boolean }; res: Paged<InventoryItem> };
  'inventory.items.get': { req: { id: number }; res: InventoryItem };
  'inventory.items.save': { req: { id?: number | null; input: InventoryItemInput; openingStockMilli?: number }; res: { id: number } };
  'inventory.items.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'inventory.items.options': { req: undefined; res: Array<{ value: number; label: string; meta: string }> };
  'inventory.movements.list': { req: ListQuery & { itemId?: number; type?: string[] }; res: Paged<StockMovement> };
  'inventory.movements.create': { req: { input: StockMovementInput }; res: { id: number; balanceAfterMilli: number } };
  'inventory.movements.delete': { req: { id: number; reason: string }; res: undefined };
  'inventory.purchases.list': { req: ListQuery & { supplierId?: number | null }; res: Paged<InventoryPurchase> };
  'inventory.purchases.get': { req: { id: number }; res: InventoryPurchase };
  'inventory.purchases.create': { req: { input: InventoryPurchaseInput }; res: { id: number; reference: string } };
  'inventory.purchases.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'inventory.alerts': { req: undefined; res: InventoryAlerts };
  'inventory.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate }; res: InventoryStats };
  'inventory.consumeForVisit': { req: { visitId: number; items: Array<{ itemId: number; quantityMilli: number; note: string }> }; res: undefined };

  // --- Accounting ---------------------------------------------------------
  'accounting.transactions.list': { req: Omit<ListQuery, 'direction'> & { direction?: AccountingDirection; categoryId?: number | null; methodId?: number | null; includeVoid?: boolean }; res: Paged<AccountingTransaction> };
  'accounting.transactions.create': { req: { input: AccountingTransactionInput }; res: { id: number } };
  'accounting.transactions.update': { req: { id: number; input: AccountingTransactionInput }; res: undefined };
  'accounting.transactions.void': { req: { id: number; reason: string }; res: undefined };
  'accounting.transactions.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'accounting.summary': { req: { preset?: string; from?: IsoDate; to?: IsoDate; direction?: AccountingDirection }; res: AccountingSummary };
  'accounting.daybook': { req: { from: IsoDate; to: IsoDate }; res: DaybookRow[] };
  'accounting.periods.list': { req: undefined; res: FinancialPeriod[] };
  'accounting.periods.close': { req: { periodStart: IsoDate; periodEnd: IsoDate; notes: string }; res: { id: number } };
  'accounting.periods.reopen': { req: { id: number; reason: string; confirmText?: string }; res: undefined };

  // --- Staff & dentists ---------------------------------------------------
  'staff.list': { req: ListQuery & { status?: string[]; department?: string | null }; res: Paged<StaffMember> };
  'staff.get': { req: { id: number }; res: StaffMember };
  'staff.save': { req: { id?: number | null; input: StaffInput; photoSourcePath?: string | null }; res: { id: number } };
  'staff.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'staff.departments': { req: undefined; res: string[] };
  'staff.statistics': { req: undefined; res: { total: number; active: number; byDepartment: Array<{ label: string; value: number }>; byStatus: Array<{ label: string; value: number }> } };

  'dentists.list': { req: { includeInactive?: boolean } | undefined; res: Dentist[] };
  'dentists.get': { req: { id: number }; res: Dentist };
  'dentists.save': { req: { id?: number | null; input: DentistInput; photoSourcePath?: string | null; signatureSourcePath?: string | null }; res: { id: number } };
  'dentists.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'dentists.statistics': { req: { preset?: string; from?: IsoDate; to?: IsoDate }; res: Array<{ dentistId: number; dentistName: string; appointments: number; completed: number; noShows: number; visits: number; prescriptions: number; treatments: number; revenuePaisa: Paisa | null }> };

  // --- Users & roles ------------------------------------------------------
  'users.list': { req: ListQuery & { isActive?: boolean }; res: Paged<UserAccount> };
  'users.get': { req: { id: number }; res: UserAccount };
  'users.create': { req: { input: UserInput & { password: string } }; res: { id: number } };
  'users.update': { req: { id: number; input: UserInput }; res: undefined };
  'users.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'users.resetPassword': { req: { id: number; newPassword: string; mustChange: boolean }; res: undefined };
  'users.setActive': { req: { id: number; isActive: boolean }; res: undefined };
  'roles.list': { req: undefined; res: Role[] };
  'roles.save': { req: { id?: number | null; input: RoleInput }; res: { id: number } };
  'roles.delete': { req: { id: number; reason: string; confirmText?: string }; res: undefined };
  'roles.permissionCatalogue': { req: undefined; res: Array<{ key: string; group: string; label: string; description: string; sensitive: boolean; groupLabel: string }> };

  // --- Audit --------------------------------------------------------------
  'audit.list': { req: AuditListQuery; res: Paged<AuditEntry> };
  'audit.get': { req: { id: number }; res: AuditEntryDetail };
  'audit.export': { req: { from?: IsoDate; to?: IsoDate; format: 'csv' | 'pdf' }; res: { path: string } };
  'audit.actions': { req: undefined; res: Array<{ action: string; label: string; count: number }> };

  // --- Notifications ------------------------------------------------------
  'notifications.list': { req: { onlyUnread?: boolean; category?: string | null; limit?: number } | undefined; res: Notification[] };
  'notifications.unreadCount': { req: undefined; res: { total: number; critical: number } };
  'notifications.markRead': { req: { ids: number[] }; res: undefined };
  'notifications.markAllRead': { req: undefined; res: undefined };
  'notifications.dismiss': { req: { id: number }; res: undefined };
  'notifications.clearAll': { req: { includeUnread: boolean }; res: undefined };
  'notifications.refresh': { req: undefined; res: { created: number } };

  // --- Search -------------------------------------------------------------
  'search.global': { req: { query: string; limit?: number }; res: GlobalSearchResponse };

  // --- Dashboard ----------------------------------------------------------
  'dashboard.get': { req: undefined; res: DashboardData };

  // --- Reports ------------------------------------------------------------
  'reports.run': { req: ReportRequest; res: ReportResult };
  'reports.export': { req: { request: ReportRequest; format: 'csv' | 'pdf' | 'print' }; res: { path: string | null; printed: boolean; rowCount: number } };
  'reports.catalogue': { req: undefined; res: Array<{ key: string; title: string; description: string; group: string; requiresFinancialPermission: boolean }> };

  // --- Printing -----------------------------------------------------------
  'print.systemPrinters': { req: undefined; res: SystemPrinter[] };
  'print.render': { req: PrintRenderRequest; res: PrintRenderResult };
  'print.defaultProfile': { req: { kind: PrintRenderRequest['kind'] }; res: PrinterProfile | null };

  // --- Backup & restore ---------------------------------------------------
  'backup.status': { req: undefined; res: BackupStatus };
  'backup.create': { req: { note?: string; kind?: BackupRecord['kind'] }; res: BackupRecord };
  'backup.verify': { req: { id: number }; res: BackupRecord };
  'backup.delete': { req: { id: number; deleteFile: boolean; confirmText?: string }; res: undefined };
  'backup.pickFolder': { req: undefined; res: string | null };
  'backup.setFolder': { req: { folder: string }; res: BackupStatus };
  'backup.scanFolder': { req: { folder?: string }; res: BackupCandidate[] };
  'backup.previewRestore': { req: { filePath: string }; res: RestorePreview };
  'backup.restore': { req: { filePath: string; confirmText: string; restoreAttachments: boolean }; res: RestoreResult };

  // --- Data & destructive operations --------------------------------------
  'system.dataSummary': { req: undefined; res: DataSummary };
  'system.integrityCheck': { req: undefined; res: IntegrityReport };
  'system.vacuum': { req: undefined; res: { beforeBytes: number; afterBytes: number } };
  'system.exportCsv': { req: { what: 'patients' | 'invoices' | 'payments' | 'inventory' | 'accounting' | 'appointments' | 'visits' | 'prescriptions'; from?: IsoDate; to?: IsoDate }; res: { path: string; rowCount: number } };
  'system.importPatients': { req: { filePath?: string | null; commit: boolean }; res: { imported: number; skipped: number; errors: Array<{ row: number; message: string }>; preview: Array<Record<string, string>> } };
  'system.resetData': { req: { scope: 'clinical' | 'financial' | 'all'; confirmText: string; backupFirst: boolean }; res: { backupPath: string | null; deletedCounts: Record<string, number> } };
  'system.deleteBusiness': { req: { password: string; confirmText: string; backupFirst: boolean }; res: { deleted: boolean; backupPath: string | null } };
  'system.logFiles': { req: undefined; res: Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string }> };
  'system.openLogFolder': { req: undefined; res: undefined };
}

export type ApiMethodName = keyof ApiMethods;
export type ApiRequest<K extends ApiMethodName> = ApiMethods[K]['req'];
export type ApiResponse<K extends ApiMethodName> = ApiMethods[K]['res'];

export const API_METHOD_NAMES: readonly ApiMethodName[] = [
  'app.bootstrap', 'app.health', 'app.systemInfo', 'app.relaunch', 'app.openPath', 'app.openExternal',
  'auth.login', 'auth.logout', 'auth.lock', 'auth.unlock', 'auth.changePassword', 'auth.session',
  'activation.status', 'activation.activate',
  'setup.status', 'setup.saveClinic', 'setup.saveDentists', 'setup.savePreferences', 'setup.createAdministrator', 'setup.review', 'setup.complete',
  'clinic.get', 'clinic.update', 'settings.get', 'settings.update',
  'resource.list', 'resource.get', 'resource.save', 'resource.delete', 'resource.restore', 'resource.options',
  'patients.list', 'patients.get', 'patients.create', 'patients.update', 'patients.delete', 'patients.restore',
  'patients.timeline', 'patients.financialSummary', 'patients.checkDuplicate', 'patients.statistics', 'patients.tags.save', 'patients.setTags', 'patients.quickSearch',
  'attachments.list', 'attachments.pickAndAdd', 'attachments.update', 'attachments.delete', 'attachments.open', 'attachments.revealInFolder', 'attachments.thumbnail',
  'visits.list', 'visits.get', 'visits.create', 'visits.update', 'visits.delete', 'visits.byPatient', 'visits.statistics',
  'dental.getChart', 'dental.saveFindings', 'dental.history', 'dental.savePerio', 'dental.clear',
  'prescriptions.list', 'prescriptions.get', 'prescriptions.create', 'prescriptions.update', 'prescriptions.void', 'prescriptions.delete', 'prescriptions.byPatient', 'prescriptions.supersede',
  'treatmentPlans.list', 'treatmentPlans.get', 'treatmentPlans.create', 'treatmentPlans.update', 'treatmentPlans.delete', 'treatmentPlans.saveItem', 'treatmentPlans.deleteItem', 'treatmentPlans.completeItem',
  'treatmentRecords.byPatient', 'treatmentRecords.byVisit', 'treatmentRecords.delete',
  'referrals.list', 'referrals.get', 'referrals.save', 'referrals.delete', 'referrals.byPatient', 'referrals.statistics',
  'appointments.list', 'appointments.get', 'appointments.create', 'appointments.update', 'appointments.delete', 'appointments.setStatus', 'appointments.byRange', 'appointments.byPatient', 'appointments.availability', 'appointments.statistics',
  'queue.list', 'queue.add', 'queue.setStatus', 'queue.move', 'queue.remove', 'queue.statistics',
  'invoices.list', 'invoices.get', 'invoices.create', 'invoices.update', 'invoices.void', 'invoices.delete', 'invoices.byPatient', 'invoices.outstanding', 'invoices.statistics',
  'payments.list', 'payments.get', 'payments.create', 'payments.update', 'payments.void', 'payments.byInvoice', 'payments.byPatient', 'payments.statistics',
  'inventory.items.list', 'inventory.items.get', 'inventory.items.save', 'inventory.items.delete', 'inventory.items.options',
  'inventory.movements.list', 'inventory.movements.create', 'inventory.movements.delete',
  'inventory.purchases.list', 'inventory.purchases.get', 'inventory.purchases.create', 'inventory.purchases.delete',
  'inventory.alerts', 'inventory.statistics', 'inventory.consumeForVisit',
  'accounting.transactions.list', 'accounting.transactions.create', 'accounting.transactions.update', 'accounting.transactions.void', 'accounting.transactions.delete',
  'accounting.summary', 'accounting.daybook', 'accounting.periods.list', 'accounting.periods.close', 'accounting.periods.reopen',
  'staff.list', 'staff.get', 'staff.save', 'staff.delete', 'staff.departments', 'staff.statistics',
  'dentists.list', 'dentists.get', 'dentists.save', 'dentists.delete', 'dentists.statistics',
  'users.list', 'users.get', 'users.create', 'users.update', 'users.delete', 'users.resetPassword', 'users.setActive',
  'roles.list', 'roles.save', 'roles.delete', 'roles.permissionCatalogue',
  'audit.list', 'audit.get', 'audit.export', 'audit.actions',
  'notifications.list', 'notifications.unreadCount', 'notifications.markRead', 'notifications.markAllRead', 'notifications.dismiss', 'notifications.clearAll', 'notifications.refresh',
  'search.global', 'dashboard.get',
  'reports.run', 'reports.export', 'reports.catalogue',
  'print.systemPrinters', 'print.render', 'print.defaultProfile',
  'backup.status', 'backup.create', 'backup.verify', 'backup.delete', 'backup.pickFolder', 'backup.setFolder', 'backup.scanFolder', 'backup.previewRestore', 'backup.restore',
  'system.dataSummary', 'system.integrityCheck', 'system.vacuum', 'system.exportCsv', 'system.importPatients', 'system.resetData', 'system.deleteBusiness', 'system.logFiles', 'system.openLogFolder',
];

// ---------------------------------------------------------------------------
// Bridge events (main → renderer)
// ---------------------------------------------------------------------------

export type BridgeEventName =
  | 'session.locked'
  | 'session.unlocked'
  | 'session.changed'
  | 'app.state.changed'
  | 'notifications.changed'
  | 'backup.progress'
  | 'print.progress'
  | 'shortcut.invoke'
  | 'restore.relaunching';

export interface BridgeEventPayloads {
  'session.locked': { reason: 'manual' | 'idle' | 'security'; at: string };
  'session.unlocked': { userId: number; username: string };
  'session.changed': { session: SessionUser | null };
  'app.state.changed': { state: AppBootstrap['state'] };
  'notifications.changed': { unread: number; critical: number; latest: Notification | null };
  'backup.progress': { phase: 'starting' | 'database' | 'attachments' | 'manifest' | 'verifying' | 'done' | 'failed'; percent: number; message: string };
  'print.progress': { kind: PrintRenderRequest['kind']; phase: 'rendering' | 'generating' | 'sending' | 'done' | 'failed'; message: string };
  'shortcut.invoke': { shortcut: 'global-search' | 'new-record' | 'save' | 'print' | 'lock' | 'escape' };
  'restore.relaunching': { message: string };
}

/** Typed bridge exposed by the preload script (or the dev/test bridge). */
export interface DentivaBridge {
  readonly isElectron: boolean;
  readonly versions: Readonly<Record<string, string>>;
  invoke<K extends ApiMethodName>(method: K, payload?: ApiRequest<K>): Promise<ApiResponse<K>>;
  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEventPayloads[E]) => void): () => void;
}

/** Envelope returned by `invoke` before unwrapping. */
export type BridgeInvokeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string> } };

// ---------------------------------------------------------------------------
// Screen routing (used by search results, notifications and the timeline)
// ---------------------------------------------------------------------------

export const SCREEN_ROUTES = {
  dashboard: '/',
  patients: '/patients',
  patient: '/patients/:id',
  appointments: '/appointments',
  queue: '/queue',
  treatments: '/treatments',
  prescriptions: '/prescriptions',
  invoices: '/invoices',
  payments: '/payments',
  inventory: '/inventory',
  accounting: '/accounting',
  staff: '/staff',
  users: '/users',
  backup: '/backup',
  settings: '/settings',
  reports: '/reports',
  audit: '/audit',
  about: '/about',
  visits: '/visits',
  referral: '/referrals',
} as const;

export type ScreenKey = keyof typeof SCREEN_ROUTES;

export function resolveScreenPath(screen: string, id?: number | null): string {
  const template = (SCREEN_ROUTES as Record<string, string>)[screen];
  if (!template) return SCREEN_ROUTES.dashboard;
  if (template.includes(':id')) {
    return id === undefined || id === null ? template.replace('/:id', '') : template.replace(':id', String(id));
  }
  return template;
}

export function isPatientStatus(value: string): value is PatientStatus {
  return value === 'active' || value === 'inactive' || value === 'archived';
}

export function isClinicalOptionCategory(value: string): value is ClinicalOptionCategory {
  return value === 'cc' || value === 'oe' || value === 're' || value === 'advice';
}

export function searchResultKey(item: SearchResultItem): string {
  return `${item.screen}:${item.id}`;
}
