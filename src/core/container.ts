/**
 * Service composition root.
 *
 * Everything the application can do lives behind this container: one database
 * handle, one logger, one session, one context, and one instance of every
 * service. The main process builds it once at start-up; the tests build it
 * against a temporary file, which is why the database and the clock can both
 * be injected.
 */
import type { SqliteDatabase } from './db/connection';
import { openDatabase, runMigrations } from './db/connection';
import type { CoreContext, CorePaths } from './context';
import { toInstant, todayIso } from '@shared/dates';
import { APP_BUILD_NUMBER, APP_VERSION } from '@shared/app-info';
import type { Logger } from './util/logger';
import { createLogger, createNullLogger } from './util/logger';
import { SessionManager } from './security/session';
import { seedReferenceData, type SeedResult } from './seed';
import { AppService, type RuntimeInfo } from './services/app-service';
import { DashboardService } from './services/dashboard-service';
import { ResourceService } from './services/resource-service';
import { SearchService } from './services/search-service';
import { SetupService } from './services/setup-service';
import { SystemService } from './services/system-service';
import { AccountingService } from './services/accounting-service';
import { AppointmentService } from './services/appointment-service';
import { AttachmentService } from './services/attachment-service';
import { AuditService } from './services/audit-service';
import { AuthService } from './services/auth-service';
import { BackupService, type BackupProgress } from './services/backup-service';
import { DentalService } from './services/dental-service';
import { DentistService } from './services/dentist-service';
import { InventoryService } from './services/inventory-service';
import { InvoiceService } from './services/invoice-service';
import { NotificationService } from './services/notification-service';
import { PatientService } from './services/patient-service';
import { PaymentService } from './services/payment-service';
import { PrescriptionService } from './services/prescription-service';
import { PrintService, type PrintHostPort } from './services/print-service';
import { ReportService } from './services/report-service';
import { QueueService } from './services/queue-service';
import { ReferralService } from './services/referral-service';
import { SettingsService } from './services/settings-service';
import { StaffService } from './services/staff-service';
import { TreatmentService } from './services/treatment-service';
import { UserService } from './services/user-service';
import { VisitService } from './services/visit-service';

export interface CoreServices {
  readonly accounting: AccountingService;
  readonly app: AppService;
  readonly appointments: AppointmentService;
  readonly attachments: AttachmentService;
  readonly audit: AuditService;
  readonly auth: AuthService;
  readonly backups: BackupService;
  readonly dashboard: DashboardService;
  readonly dental: DentalService;
  readonly dentists: DentistService;
  readonly inventory: InventoryService;
  readonly invoices: InvoiceService;
  readonly notifications: NotificationService;
  readonly patients: PatientService;
  readonly payments: PaymentService;
  readonly prescriptions: PrescriptionService;
  readonly print: PrintService;
  readonly reports: ReportService;
  readonly queue: QueueService;
  readonly referrals: ReferralService;
  readonly resources: ResourceService;
  readonly search: SearchService;
  readonly settings: SettingsService;
  readonly setup: SetupService;
  readonly staff: StaffService;
  readonly system: SystemService;
  readonly treatments: TreatmentService;
  readonly users: UserService;
  readonly visits: VisitService;
}

export interface CoreContainerOptions {
  readonly paths: CorePaths;
  readonly machineGuid: string;
  readonly appVersion?: string;
  readonly appBuild?: string;
  readonly logger?: Logger;
  /** Injectable clock so tests can travel in time. */
  readonly now?: () => Date;
  /** Called whenever a service records something the main process should broadcast. */
  readonly notify?: (event: string, payload?: Record<string, unknown>) => void;
  readonly onBackupProgress?: (progress: BackupProgress) => void;
  /** Electron/Chromium/Node versions and locale, supplied by the main process. */
  readonly runtimeInfo?: () => RuntimeInfo;
  /** Printer/PDF adapter. Omitted by tests and by the dev bridge. */
  readonly printHost?: PrintHostPort;
  /** Font-face CSS with the embedded Bengali + Latin faces, supplied by main. */
  readonly fontCss?: string;
  /** Pre-opened database (tests); when omitted the container opens one itself. */
  readonly database?: SqliteDatabase;
  /** Run migrations on the database the container opened (default true). */
  readonly migrate?: boolean;
  /** Skip reference-data seeding (used by migration tests). */
  readonly seed?: boolean;
}

export interface CoreContainer {
  readonly db: SqliteDatabase;
  readonly logger: Logger;
  readonly paths: CorePaths;
  readonly session: SessionManager;
  readonly services: CoreServices;
  readonly seed: SeedResult;
  readonly ownsDatabase: boolean;
  context(): CoreContext;
  /** Rebuild the cached context after the session, clock or settings change. */
  refreshContext(): CoreContext;
  close(): void;
}

export function createCoreContainer(options: CoreContainerOptions): CoreContainer {
  const ownsDatabase = options.database === undefined;
  const db =
    options.database ??
    openDatabase({
      path: options.paths.databasePath,
      onLog: (message) => options.logger?.debug(message),
    });
  if (!ownsDatabase && options.migrate === true) runMigrations(db);

  const logger = options.logger ?? createNullLogger();
  const clock = options.now ?? (() => new Date());
  const session = new SessionManager();

  const audit = new AuditService(db, () => context ?? null);
  const settings = new SettingsService(db, () => context ?? null);
  const notifications = new NotificationService(db, () => context ?? missingContext());
  const attachments = new AttachmentService(db, () => context ?? missingContext());
  const patients = new PatientService(db, () => context ?? missingContext());
  const dental = new DentalService(db, () => context ?? missingContext());
  const visits = new VisitService(db, () => context ?? missingContext(), dental);
  const prescriptions = new PrescriptionService(db, () => context ?? missingContext());
  const treatments = new TreatmentService(db, () => context ?? missingContext());
  const referrals = new ReferralService(db, () => context ?? missingContext());
  const appointments = new AppointmentService(db, () => context ?? missingContext());
  const invoices = new InvoiceService(db, () => context ?? missingContext());
  const accounting = new AccountingService(db, () => context ?? missingContext());
  const payments = new PaymentService(db, () => context ?? missingContext(), invoices, accounting);
  const queue = new QueueService(db, () => context ?? missingContext());
  const users = new UserService(db, () => context ?? missingContext());
  const staff = new StaffService(db, () => context ?? missingContext(), attachments);
  const dentists = new DentistService(db, () => context ?? missingContext(), attachments);
  const inventory = new InventoryService(db, () => context ?? missingContext(), accounting, settings);
  const auth = new AuthService(db, () => context ?? missingContext(), users, settings);
  const backups = new BackupService(
    db,
    () => context ?? missingContext(),
    settings,
    options.onBackupProgress,
  );
  const search = new SearchService(db, () => context ?? missingContext());
  const resources = new ResourceService(db, () => context ?? missingContext(), prescriptions, patients);
  const setup = new SetupService(db, () => context ?? missingContext(), settings, dentists, attachments, users);
  const system = new SystemService(db, () => context ?? missingContext(), backups, attachments);
  const dashboard = new DashboardService(
    db,
    () => context ?? missingContext(),
    settings,
    appointments,
    queue,
    invoices,
    prescriptions,
    inventory,
    backups,
  );
  const app = new AppService(
    db,
    () => context ?? missingContext(),
    settings,
    setup,
    () =>
      options.runtimeInfo?.() ?? {
        electronVersion: 'unknown',
        chromeVersion: 'unknown',
        nodeVersion: process.versions.node ?? 'unknown',
        osVersion: `${process.platform} ${process.arch}`,
        architecture: process.arch ?? 'unknown',
        locale: 'en-GB',
      },
  );

  let reports: ReportService | null = null;
  const print = new PrintService(
    db,
    () => context ?? missingContext(),
    options.printHost ?? null,
    prescriptions,
    invoices,
    patients,
    visits,
    treatments,
    attachments,
    () => reports,
    options.fontCss ?? '',
  );
  reports = new ReportService(db, () => context ?? missingContext(), print);

  let context: CoreContext | null = null;

  function buildContext(): CoreContext {
    return {
      db,
      logger,
      paths: options.paths,
      session,
      audit,
      appVersion: options.appVersion ?? APP_VERSION,
      appBuild: options.appBuild ?? APP_BUILD_NUMBER,
      machineGuid: options.machineGuid,
      now: () => clock(),
      today: () => todayIso(clock(), settings.getSettings().timeZone),
      instant: () => toInstant(clock()),
      timeZone: () => settings.getSettings().timeZone,
      notify: options.notify,
    };
  }

  function missingContext(): CoreContext {
    throw new Error('Core context is not available yet.');
  }

  context = buildContext();

  const services: CoreServices = {
    accounting,
    app,
    appointments,
    attachments,
    audit,
    auth,
    backups,
    dashboard,
    dental,
    dentists,
    inventory,
    invoices,
    notifications,
    patients,
    payments,
    prescriptions,
    print,
    queue,
    referrals,
    reports,
    resources,
    search,
    settings,
    setup,
    staff,
    system,
    treatments,
    users,
    visits,
  };

  const seed: SeedResult =
    options.seed === false
      ? {
          roles: 0,
          paymentMethods: 0,
          clinicalOptions: 0,
          medications: 0,
          treatments: 0,
          accountingCategories: 0,
          inventoryCategories: 0,
          printerProfiles: 0,
          printTemplates: 0,
          createdClinic: false,
        }
      : seedReferenceData(db, { users, accounting }, () => context);

  session.setAutoLockMinutes(settings.getSettings().autoLockMinutes);

  return {
    db,
    logger,
    paths: options.paths,
    session,
    services,
    seed,
    ownsDatabase,
    context: () => context ?? missingContext(),
    refreshContext: () => {
      context = buildContext();
      session.setAutoLockMinutes(settings.getSettings().autoLockMinutes);
      return context;
    },
    close: () => {
      if (ownsDatabase && db.open) db.close();
    },
  };
}
