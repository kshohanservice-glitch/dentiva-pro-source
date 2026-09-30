/**
 * IPC method implementations.
 *
 * One entry per method in `ApiMethods` — a missing or misspelled key is a
 * compile error, so the renderer can never call something that does not exist.
 * Handlers stay thin: they translate the transport payload into a service call
 * and, where the desktop is involved, ask `MainPorts` to do the OS work.
 */
import { join } from 'node:path';
import { AppError } from '@shared/errors';
import type { ApiMethodName } from '@shared/api';
import { writeCsvFile } from '@core/util/csv';
import type { CoreContainer } from '@core/container';
import type { MainPorts } from '../ports';

export type { MainPorts };
import type { SCHEMAS } from './schemas';
import { RESOURCE_INPUT_SCHEMAS_EXPORT } from './schemas';
import type { z } from 'zod';

export interface HandlerContext {
  readonly container: CoreContainer;
  readonly ports: MainPorts;
}

type SchemaPayload<M extends ApiMethodName> = z.output<(typeof SCHEMAS)[M]>;

/** One handler per method, each typed from the schema that validates it. */
export type HandlerMap = {
  readonly [M in ApiMethodName]: (payload: SchemaPayload<M>, ctx: HandlerContext) => unknown;
};

export function createHandlers(): HandlerMap {
  return {
    // --- Application shell -------------------------------------------------
    'app.bootstrap': (_payload, ctx) => ctx.container.services.app.bootstrap(),
    'app.health': (_payload, ctx) => ctx.container.services.app.health(),
    'app.systemInfo': (_payload, ctx) => ctx.container.services.app.systemInfo(),
    'app.relaunch': (_payload, ctx) => {
      ctx.ports.relaunch();
    },
    'app.openPath': (payload, ctx) => ctx.ports.openPath(String(payload.path), Boolean(payload.reveal)),
    'app.openExternal': (payload, ctx) => ctx.ports.openExternal(String(payload.url)),

    // --- Session -----------------------------------------------------------
    'auth.login': async (payload, ctx) => {
      const result = await ctx.container.services.auth.login(String(payload.username), String(payload.password));
      return result.user;
    },
    'auth.logout': (_payload, ctx) => ctx.container.services.auth.logout(),
    'auth.lock': (_payload, ctx) => ctx.container.services.auth.lock('manual'),
    'auth.unlock': (payload, ctx) => ctx.container.services.auth.unlock(String(payload.password)),
    'auth.changePassword': (payload, ctx) =>
      ctx.container.services.auth.changePassword(String(payload.currentPassword), String(payload.newPassword)),
    'auth.session': (_payload, ctx) => ctx.container.services.auth.session(),

    // --- Activation & setup ------------------------------------------------
    'activation.status': (_payload, ctx) => ctx.container.services.setup.activationStatus(),
    'activation.activate': (payload, ctx) => ctx.container.services.setup.activate(String(payload.code)),

    'setup.status': (_payload, ctx) => ctx.container.services.setup.status(),
    'setup.saveClinic': (payload, ctx) => ctx.container.services.setup.saveClinic(payload),
    'setup.saveDentists': (payload, ctx) => ctx.container.services.setup.saveDentists(payload.dentists),
    'setup.savePreferences': (payload, ctx) => ctx.container.services.setup.savePreferences(payload),
    'setup.createAdministrator': (payload, ctx) => ctx.container.services.setup.createAdministrator(payload),
    'setup.review': (_payload, ctx) => ctx.container.services.setup.review(),
    'setup.complete': (_payload, ctx) => ctx.container.services.setup.complete(),

    'clinic.get': (_payload, ctx) => ctx.container.services.settings.getClinic(),
    'clinic.update': async (payload, ctx) => {
      const existing = ctx.container.services.settings.getClinic();
      let logoPath = existing.logoPath;
      if (payload.removeLogo) logoPath = null;
      if (payload.logoSourcePath) {
        logoPath = await ctx.container.services.attachments.storeProfileImage({
          sourcePath: String(payload.logoSourcePath),
          kind: 'clinic_logo',
        });
      }
      return ctx.container.services.settings.updateClinic({
        name: payload.name,
        address: payload.address,
        phone: payload.phone,
        email: payload.email,
        website: payload.website,
        clinicMessage: payload.clinicMessage,
        visitingHours: payload.visitingHours,
        registrationNumber: payload.registrationNumber,
        logoPath,
      });
    },
    'settings.get': (_payload, ctx) => ctx.container.services.settings.getSettings(),
    'settings.update': (payload, ctx) => ctx.container.services.settings.updateSettings(payload.patch),

    // --- Generic master data ----------------------------------------------
    'resource.list': (payload, ctx) =>
      ctx.container.services.resources.list(payload.resource, {
        ...(payload.query ?? {}),
        includeInactive: payload.includeInactive ?? payload.query?.includeInactive,
      }),
    'resource.get': (payload, ctx) => ctx.container.services.resources.get(payload.resource, payload.id),
    'resource.save': (payload, ctx) => {
      const schema = RESOURCE_INPUT_SCHEMAS_EXPORT[payload.resource];
      const parsed = schema.safeParse(payload.input);
      if (!parsed.success) {
        throw AppError.validation('Some of the details are not valid.', fieldErrorsFrom(parsed.error));
      }
      return ctx.container.services.resources.save(payload.resource, payload.id ?? null, parsed.data);
    },
    'resource.delete': (payload, ctx) => ctx.container.services.resources.delete(payload.resource, payload.id, payload.options ?? {}),
    'resource.restore': (payload, ctx) => ctx.container.services.resources.restore(payload.resource, payload.id),
    'resource.options': (payload, ctx) => ctx.container.services.resources.options(payload.resource),

    // --- Patients ----------------------------------------------------------
    'patients.list': (payload, ctx) => ctx.container.services.patients.list(payload),
    'patients.get': (payload, ctx) => ctx.container.services.patients.get(payload.id),
    'patients.create': (payload, ctx) => ctx.container.services.patients.create(payload.input),
    'patients.update': (payload, ctx) => ctx.container.services.patients.update(payload.id, payload.input),
    'patients.delete': (payload, ctx) => ctx.container.services.patients.delete(payload.id, payload.reason, payload.confirmText),
    'patients.restore': (payload, ctx) => ctx.container.services.patients.restore(payload.id),
    'patients.timeline': (payload, ctx) =>
      ctx.container.services.patients.timeline(payload.id, {
        types: payload.types,
        from: payload.from,
        to: payload.to,
        limit: payload.limit,
      }),
    'patients.financialSummary': (payload, ctx) => ctx.container.services.patients.financialSummary(payload.id),
    'patients.checkDuplicate': (payload, ctx) => ctx.container.services.patients.checkDuplicate(payload),
    'patients.statistics': (payload, ctx) => ctx.container.services.patients.statistics(payload),
    'patients.tags.save': (payload, ctx) => ctx.container.services.patients.saveTag(payload),
    'patients.setTags': (payload, ctx) => ctx.container.services.patients.setTags(payload.id, payload.tagIds),
    'patients.quickSearch': (payload, ctx) => ctx.container.services.patients.quickSearch(String(payload.query), payload.limit ?? 20),

    // --- Attachments -------------------------------------------------------
    'attachments.list': (payload, ctx) => ctx.container.services.attachments.list(payload),
    'attachments.pickAndAdd': async (payload, ctx) => {
      const paths: string[] = payload.copyFromPath
        ? [String(payload.copyFromPath)]
        : await ctx.ports.pickFiles({
            title: 'Choose files to attach',
            filters: [
              { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] },
              { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt', 'csv', 'xls', 'xlsx'] },
              { name: 'All files', extensions: ['*'] },
            ],
            multi: true,
          });
      if (paths.length === 0) return [];
      const added = [];
      for (const sourcePath of paths) {
        added.push(
          await ctx.container.services.attachments.add({
            entityType: String(payload.entityType),
            entityId: payload.entityId,
            patientId: payload.patientId ?? null,
            category: payload.category,
            description: String(payload.description ?? ''),
            sourcePath,
          }),
        );
      }
      return added;
    },
    'attachments.update': (payload, ctx) => ctx.container.services.attachments.update(payload.id, payload),
    'attachments.delete': (payload, ctx) => ctx.container.services.attachments.delete(payload.id, payload.reason),
    'attachments.open': async (payload, ctx) => {
      await ctx.ports.openPath(ctx.container.services.attachments.absolutePath(payload.id));
    },
    'attachments.revealInFolder': async (payload, ctx) => {
      await ctx.ports.openPath(ctx.container.services.attachments.absolutePath(payload.id), true);
    },
    'attachments.thumbnail': (payload, ctx) =>
      ctx.ports.thumbnail(ctx.container.services.attachments.absolutePath(payload.id), payload.maxPixels ?? 256),

    // --- Visits ------------------------------------------------------------
    'visits.list': (payload, ctx) => ctx.container.services.visits.list(payload),
    'visits.get': (payload, ctx) => ctx.container.services.visits.get(payload.id),
    'visits.create': (payload, ctx) => ctx.container.services.visits.create(payload.input),
    'visits.update': (payload, ctx) => ctx.container.services.visits.update(payload.id, payload.input),
    'visits.delete': (payload, ctx) => ctx.container.services.visits.delete(payload.id, payload.reason, payload.confirmText),
    'visits.byPatient': (payload, ctx) => ctx.container.services.visits.byPatient(payload.patientId, payload.limit ?? 50),
    'visits.statistics': (payload, ctx) => ctx.container.services.visits.statistics(payload),

    // --- Dental chart ------------------------------------------------------
    'dental.getChart': (payload, ctx) => ctx.container.services.dental.getChart(payload),
    'dental.saveFindings': (payload, ctx) => ctx.container.services.dental.saveFindings(payload),
    'dental.history': (payload, ctx) => ctx.container.services.dental.history(payload.patientId, payload.toothFdi),
    'dental.savePerio': (payload, ctx) => ctx.container.services.dental.savePerio(payload),
    'dental.clear': (payload, ctx) => ctx.container.services.dental.clear(payload),

    // --- Prescriptions -----------------------------------------------------
    'prescriptions.list': (payload, ctx) => ctx.container.services.prescriptions.list(payload),
    'prescriptions.get': (payload, ctx) => ctx.container.services.prescriptions.get(payload.id),
    'prescriptions.create': (payload, ctx) => ctx.container.services.prescriptions.create(payload.input),
    'prescriptions.update': (payload, ctx) => ctx.container.services.prescriptions.update(payload.id, payload.input),
    'prescriptions.void': (payload, ctx) => ctx.container.services.prescriptions.void(payload.id, payload.reason),
    'prescriptions.delete': (payload, ctx) => ctx.container.services.prescriptions.delete(payload.id, payload.reason),
    'prescriptions.byPatient': (payload, ctx) => ctx.container.services.prescriptions.byPatient(payload.patientId, payload.limit ?? 50),
    'prescriptions.supersede': (payload, ctx) => ctx.container.services.prescriptions.supersede(payload.id, payload.input, payload.reason),

    // --- Treatment plans & records ----------------------------------------
    'treatmentPlans.list': (payload, ctx) => ctx.container.services.treatments.listPlans(payload),
    'treatmentPlans.get': (payload, ctx) => ctx.container.services.treatments.getPlan(payload.id),
    'treatmentPlans.create': (payload, ctx) => ctx.container.services.treatments.createPlan(payload.input),
    'treatmentPlans.update': (payload, ctx) => ctx.container.services.treatments.updatePlan(payload.id, payload.input),
    'treatmentPlans.delete': (payload, ctx) => ctx.container.services.treatments.deletePlan(payload.id, payload.reason),
    'treatmentPlans.saveItem': (payload, ctx) => ctx.container.services.treatments.savePlanItem(payload.planId, payload.input),
    'treatmentPlans.deleteItem': (payload, ctx) => ctx.container.services.treatments.deletePlanItem(payload.id, payload.reason),
    'treatmentPlans.completeItem': (payload, ctx) => ctx.container.services.treatments.completePlanItem(payload.id, payload.visitId),
    'treatmentRecords.byPatient': (payload, ctx) =>
      ctx.container.services.treatments.recordsByPatient(payload.patientId, payload.limit ?? 100),
    'treatmentRecords.byVisit': (payload, ctx) => ctx.container.services.treatments.recordsByVisit(payload.visitId),
    'treatmentRecords.delete': (payload, ctx) => ctx.container.services.treatments.deleteRecord(payload.id, payload.reason),

    // --- Referrals ----------------------------------------------------------
    'referrals.list': (payload, ctx) => ctx.container.services.referrals.list(payload),
    'referrals.get': (payload, ctx) => ctx.container.services.referrals.get(payload.id),
    'referrals.save': (payload, ctx) => ctx.container.services.referrals.save(payload.id ?? null, payload.input),
    'referrals.delete': (payload, ctx) => ctx.container.services.referrals.delete(payload.id, payload.reason),
    'referrals.byPatient': (payload, ctx) => ctx.container.services.referrals.byPatient(payload.patientId),
    'referrals.statistics': (payload, ctx) => ctx.container.services.referrals.statistics(payload.from, payload.to),

    // --- Appointments ------------------------------------------------------
    'appointments.list': (payload, ctx) => ctx.container.services.appointments.list(payload),
    'appointments.get': (payload, ctx) => ctx.container.services.appointments.get(payload.id),
    'appointments.create': (payload, ctx) => ctx.container.services.appointments.create(payload.input),
    'appointments.update': (payload, ctx) => ctx.container.services.appointments.update(payload.id, payload.input),
    'appointments.delete': (payload, ctx) => ctx.container.services.appointments.delete(payload.id, payload.reason),
    'appointments.setStatus': (payload, ctx) => ctx.container.services.appointments.setStatus(payload.id, payload.status, payload.note),
    'appointments.byRange': (payload, ctx) => ctx.container.services.appointments.byRange(payload),
    'appointments.byPatient': (payload, ctx) => ctx.container.services.appointments.byPatient(payload.patientId, payload.limit ?? 50),
    'appointments.availability': (payload, ctx) => ctx.container.services.appointments.availability(payload),
    'appointments.statistics': (payload, ctx) => ctx.container.services.appointments.statistics(payload),

    // --- Queue -------------------------------------------------------------
    'queue.list': (payload, ctx) =>
      ctx.container.services.queue.list(payload.date ?? ctx.container.services.settings.today(), Boolean(payload.includeClosed)),
    'queue.add': (payload, ctx) => ctx.container.services.queue.add(payload.input, ctx.container.services.settings.today()),
    'queue.setStatus': (payload, ctx) => ctx.container.services.queue.setStatus(payload.id, payload.status, payload.note),
    'queue.move': (payload, ctx) => ctx.container.services.queue.move(payload.id, payload.direction),
    'queue.remove': (payload, ctx) => ctx.container.services.queue.remove(payload.id, payload.reason),
    'queue.statistics': (payload, ctx) => ctx.container.services.queue.statistics(payload.date ?? ctx.container.services.settings.today()),

    // --- Invoices ----------------------------------------------------------
    'invoices.list': (payload, ctx) => ctx.container.services.invoices.list(payload),
    'invoices.get': (payload, ctx) => ctx.container.services.invoices.get(payload.id),
    'invoices.create': (payload, ctx) => ctx.container.services.invoices.create(payload.input),
    'invoices.update': (payload, ctx) => ctx.container.services.invoices.update(payload.id, payload.input),
    'invoices.void': (payload, ctx) => ctx.container.services.invoices.void(payload.id, payload.reason),
    'invoices.delete': (payload, ctx) => ctx.container.services.invoices.delete(payload.id, payload.reason, payload.confirmText),
    'invoices.byPatient': (payload, ctx) => ctx.container.services.invoices.byPatient(payload.patientId, payload.limit ?? 100),
    'invoices.outstanding': (payload, ctx) => ctx.container.services.invoices.outstanding(payload),
    'invoices.statistics': (payload, ctx) => ctx.container.services.invoices.statistics(payload),

    // --- Payments ----------------------------------------------------------
    'payments.list': (payload, ctx) => ctx.container.services.payments.list(payload),
    'payments.get': (payload, ctx) => ctx.container.services.payments.get(payload.id),
    'payments.create': (payload, ctx) => ctx.container.services.payments.create(payload.input),
    'payments.update': (payload, ctx) => ctx.container.services.payments.update(payload.id, payload.input),
    'payments.void': (payload, ctx) => ctx.container.services.payments.void(payload.id, payload.reason, payload.confirmText),
    'payments.byInvoice': (payload, ctx) => ctx.container.services.payments.byInvoice(payload.invoiceId),
    'payments.byPatient': (payload, ctx) => ctx.container.services.payments.byPatient(payload.patientId, payload.limit ?? 100),
    'payments.statistics': (payload, ctx) => ctx.container.services.payments.statistics(payload),

    // --- Inventory ---------------------------------------------------------
    'inventory.items.list': (payload, ctx) => ctx.container.services.inventory.list(payload),
    'inventory.items.get': (payload, ctx) => ctx.container.services.inventory.get(payload.id),
    'inventory.items.save': (payload, ctx) =>
      ctx.container.services.inventory.save(payload.id ?? null, payload.input, payload.openingStockMilli),
    'inventory.items.delete': (payload, ctx) => ctx.container.services.inventory.delete(payload.id, payload.reason, payload.confirmText),
    'inventory.items.options': (_payload, ctx) => ctx.container.services.inventory.options(),
    'inventory.movements.list': (payload, ctx) => ctx.container.services.inventory.movements(payload),
    'inventory.movements.create': (payload, ctx) => ctx.container.services.inventory.createMovement(payload.input),
    'inventory.movements.delete': (payload, ctx) => ctx.container.services.inventory.deleteMovement(payload.id, payload.reason),
    'inventory.purchases.list': (payload, ctx) => ctx.container.services.inventory.purchases(payload),
    'inventory.purchases.get': (payload, ctx) => ctx.container.services.inventory.purchase(payload.id),
    'inventory.purchases.create': (payload, ctx) => ctx.container.services.inventory.createPurchase(payload.input),
    'inventory.purchases.delete': (payload, ctx) =>
      ctx.container.services.inventory.deletePurchase(payload.id, payload.reason, payload.confirmText),
    'inventory.alerts': (_payload, ctx) => ctx.container.services.inventory.alerts(),
    'inventory.statistics': (payload, ctx) => ctx.container.services.inventory.statistics(payload),
    'inventory.consumeForVisit': (payload, ctx) => ctx.container.services.inventory.consumeForVisit(payload.visitId, payload.items),

    // --- Accounting --------------------------------------------------------
    'accounting.transactions.list': (payload, ctx) => ctx.container.services.accounting.list(payload),
    'accounting.transactions.create': (payload, ctx) => ctx.container.services.accounting.create(payload.input),
    'accounting.transactions.update': (payload, ctx) => ctx.container.services.accounting.update(payload.id, payload.input),
    'accounting.transactions.void': (payload, ctx) => ctx.container.services.accounting.void(payload.id, payload.reason),
    'accounting.transactions.delete': (payload, ctx) =>
      ctx.container.services.accounting.delete(payload.id, payload.reason, payload.confirmText),
    'accounting.summary': (payload, ctx) => ctx.container.services.accounting.summary(payload),
    'accounting.daybook': (payload, ctx) => ctx.container.services.accounting.daybook(payload.from, payload.to),
    'accounting.periods.list': (_payload, ctx) => ctx.container.services.accounting.periods(),
    'accounting.periods.close': (payload, ctx) => ctx.container.services.accounting.closePeriod(payload),
    'accounting.periods.reopen': (payload, ctx) =>
      ctx.container.services.accounting.reopenPeriod(payload.id, payload.reason, payload.confirmText),

    // --- Staff & dentists --------------------------------------------------
    'staff.list': (payload, ctx) => ctx.container.services.staff.list(payload),
    'staff.get': (payload, ctx) => ctx.container.services.staff.get(payload.id),
    'staff.save': (payload, ctx) => ctx.container.services.staff.save(payload.id ?? null, payload.input, payload.photoSourcePath),
    'staff.delete': (payload, ctx) => ctx.container.services.staff.delete(payload.id, payload.reason, payload.confirmText),
    'staff.departments': (_payload, ctx) => ctx.container.services.staff.departments(),
    'staff.statistics': (_payload, ctx) => ctx.container.services.staff.statistics(),

    'dentists.list': (payload, ctx) => ctx.container.services.dentists.list(Boolean(payload?.includeInactive)),
    'dentists.get': (payload, ctx) => ctx.container.services.dentists.get(payload.id),
    'dentists.save': (payload, ctx) =>
      ctx.container.services.dentists.save(payload.id ?? null, payload.input, payload.photoSourcePath, payload.signatureSourcePath),
    'dentists.delete': (payload, ctx) => ctx.container.services.dentists.delete(payload.id, payload.reason, payload.confirmText),
    'dentists.statistics': (payload, ctx) => ctx.container.services.dentists.statistics(payload),

    // --- Users & roles -----------------------------------------------------
    'users.list': (payload, ctx) => ctx.container.services.users.list(payload),
    'users.get': (payload, ctx) => ctx.container.services.users.get(payload.id),
    'users.create': (payload, ctx) => ctx.container.services.users.create(payload.input),
    'users.update': (payload, ctx) => ctx.container.services.users.update(payload.id, payload.input),
    'users.delete': (payload, ctx) => ctx.container.services.users.delete(payload.id, payload.reason, payload.confirmText),
    'users.resetPassword': (payload, ctx) =>
      ctx.container.services.users.resetPassword(payload.id, payload.newPassword, payload.mustChange),
    'users.setActive': (payload, ctx) => ctx.container.services.users.setActive(payload.id, payload.isActive),
    'roles.list': (_payload, ctx) => ctx.container.services.users.listRoles(),
    'roles.save': (payload, ctx) => ctx.container.services.users.saveRole(payload.id ?? null, payload.input),
    'roles.delete': (payload, ctx) => ctx.container.services.users.deleteRole(payload.id, payload.reason, payload.confirmText),
    'roles.permissionCatalogue': (_payload, ctx) => ctx.container.services.users.permissionCatalogue(),

    // --- Audit -------------------------------------------------------------
    'audit.list': (payload, ctx) => ctx.container.services.audit.list(payload),
    'audit.get': (payload, ctx) => ctx.container.services.audit.get(payload.id),
    'audit.export': async (payload, ctx) => {
      const { audit, print } = ctx.container.services;
      const container = ctx.container;
      const { paths } = container;
      if (payload.format === 'pdf') {
        const result = await print.renderReport(
          { reportKey: 'audit_summary', from: payload.from ?? '1900-01-01', to: payload.to ?? '2999-12-31' },
          'pdf',
        );
        if (!result.path) throw AppError.precondition('The audit report could not be written to a PDF file.');
        return { path: result.path };
      }
      const rows = audit.exportRows(payload.from, payload.to).map((entry) => ({
        at: entry.createdAt,
        user: entry.userName,
        action: entry.actionLabel,
        entityType: entry.entityType,
        entityId: entry.entityId ?? '',
        entity: entry.entityLabel,
        severity: entry.severity,
        detail: entry.detail,
      }));
      const target = join(paths.exportsDir, `audit-${new Date().toISOString().slice(0, 10)}.csv`);
      const written = await writeCsvFile(target, ['at', 'user', 'action', 'entityType', 'entityId', 'entity', 'severity', 'detail'], rows);
      container.context().audit.record({
        action: 'export',
        entityType: 'audit',
        detail: `Audit log exported as CSV (${written.rowCount} row(s))`,
        severity: 'warning',
      });
      return { path: written.path };
    },
    'audit.actions': (_payload, ctx) => ctx.container.services.audit.actions(),

    // --- Notifications -----------------------------------------------------
    'notifications.list': (payload, ctx) => ctx.container.services.notifications.list(payload ?? {}),
    'notifications.unreadCount': (_payload, ctx) => ctx.container.services.notifications.unreadCount(),
    'notifications.markRead': (payload, ctx) => ctx.container.services.notifications.markRead(payload.ids),
    'notifications.markAllRead': (_payload, ctx) => ctx.container.services.notifications.markAllRead(),
    'notifications.dismiss': (payload, ctx) => ctx.container.services.notifications.dismiss(payload.id),
    'notifications.clearAll': (payload, ctx) => ctx.container.services.notifications.clearAll(payload.includeUnread),
    'notifications.refresh': (_payload, ctx) => ctx.container.services.notifications.refresh(),

    // --- Search & dashboard ------------------------------------------------
    'search.global': (payload, ctx) => ctx.container.services.search.global(String(payload.query), payload.limit ?? 25),
    'dashboard.get': (_payload, ctx) => ctx.container.services.dashboard.get(),

    // --- Reports -----------------------------------------------------------
    'reports.run': (payload, ctx) => ctx.container.services.reports.run(payload),
    'reports.export': (payload, ctx) => ctx.container.services.reports.export(payload.request, payload.format),
    'reports.catalogue': (_payload, ctx) => ctx.container.services.reports.catalogue(),

    // --- Printing ----------------------------------------------------------
    'print.systemPrinters': (_payload, ctx) => ctx.container.services.print.systemPrinters(),
    'print.render': (payload, ctx) => ctx.container.services.print.render(payload),
    'print.defaultProfile': (payload, ctx) => ctx.container.services.print.defaultProfile(payload.kind),

    // --- Backup & restore --------------------------------------------------
    'backup.status': (_payload, ctx) => ctx.container.services.backups.status(),
    'backup.create': (payload, ctx) => ctx.container.services.backups.create(payload),
    'backup.verify': (payload, ctx) => ctx.container.services.backups.verify(payload.id),
    'backup.delete': (payload, ctx) => ctx.container.services.backups.deleteBackup(payload.id, payload.deleteFile, payload.confirmText),
    'backup.pickFolder': async (_payload, ctx) => {
      const current = await ctx.container.services.backups.status();
      return ctx.ports.pickFolder('Choose the backup folder', current.folder);
    },
    'backup.setFolder': (payload, ctx) => ctx.container.services.backups.setFolder(payload.folder),
    'backup.scanFolder': (payload, ctx) => ctx.container.services.backups.scanFolder(payload.folder),
    'backup.previewRestore': (payload, ctx) => ctx.container.services.backups.previewRestore(payload.filePath),
    'backup.restore': (payload, ctx) => ctx.container.services.backups.restore(payload),

    // --- Data & destructive operations ------------------------------------
    'system.dataSummary': (_payload, ctx) => ctx.container.services.system.dataSummary(),
    'system.integrityCheck': (_payload, ctx) => ctx.container.services.system.integrityCheck(),
    'system.vacuum': (_payload, ctx) => ctx.container.services.system.vacuum(),
    'system.exportCsv': (payload, ctx) => ctx.container.services.system.exportCsv(payload.what, payload.from, payload.to),
    'system.importPatients': async (payload, ctx) => {
      let filePath: string | null = payload.filePath ?? null;
      if (!filePath && payload.commit) {
        const picked = await ctx.ports.pickFiles({
          title: 'Choose a patient CSV file',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
          multi: false,
        });
        filePath = picked[0] ?? null;
      }
      return ctx.container.services.system.importPatients(filePath, Boolean(payload.commit));
    },
    'system.resetData': (payload, ctx) => ctx.container.services.system.resetData(payload),
    'system.deleteBusiness': (payload, ctx) => ctx.container.services.system.deleteBusiness(payload),
    'system.logFiles': (_payload, ctx) => ctx.container.services.system.logFiles(),
    'system.openLogFolder': async (_payload, ctx) => {
      await ctx.ports.openPath(ctx.container.paths.logsDir);
    },
  };
}

function fieldErrorsFrom(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map((part) => String(part)).join('.') || '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}
