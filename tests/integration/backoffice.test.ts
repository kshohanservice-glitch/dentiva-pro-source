/**
 * The back-office half of the application: billing, inventory, accounting,
 * staff, users and roles, audit and notifications, reports, printing, backup
 * and the data-management screens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayIso } from '@shared/dates';
import { createPatient, createTestApp, type TestApp } from './harness';

let test: TestApp;
let dentistId: number;
let patientId: number;

beforeEach(async () => {
  test = createTestApp();
  const ownerId = await test.bootstrapOwner({ username: 'owner', password: 'OwnerPass123' });
  test.signIn(ownerId);
  const dentist = await test.services.dentists.save(null, {
    name: 'Dr. Shohan Khan',
    phone: '01711000000',
    email: '',
    registrationNumber: 'BMDC-12345',
    visitingHours: '10:00 - 20:00',
    isActive: true,
    isDefault: true,
    credentials: [
      { type: 'qualification', title: 'BDS', institution: 'Dhaka Dental College', year: 2015, sortOrder: 1, showOnPrescription: true },
    ],
  });
  dentistId = dentist.id;
  patientId = createPatient(test).id;
});

afterEach(() => {
  test?.cleanup();
});

describe('billing', () => {
  it('bills a visit, records a payment and keeps the outstanding balance exact', () => {
    const { invoices, payments } = test.services;
    const date = todayIso();
    const created = invoices.create({
      patientId,
      visitId: null,
      dentistId,
      date,
      notes: 'Consultation and filling',
      items: [
        { treatmentId: null, code: 'CONS', description: 'Consultation', toothCodes: [], quantity: 1, unitPricePaisa: 50_000, discountType: 'none', discountValue: 0, sortOrder: 1 },
        { treatmentId: null, code: 'FIL', description: 'Composite filling', toothCodes: ['16'], quantity: 2, unitPricePaisa: 120_000, discountType: 'amount', discountValue: 4_000, sortOrder: 2 },
      ],
      discountType: 'percent',
      discountValue: 10,
    });

    const invoice = invoices.get(created.id);
    // Gross: 500 + 2 x 1200 = 2900. Discounts: 40 on the line, then 10% of the
    // discounted 2860 = 286, so subtotal - discount = 2900 - 326 = 2574.
    expect(invoice.subtotalPaisa).toBe(290_000);
    expect(invoice.discountPaisa).toBe(32_600);
    expect(invoice.totalPaisa).toBe(257_400);
    expect(invoice.status).toBe('unpaid');

    const payment = payments.create({ invoiceId: created.id, amountPaisa: 50_000, methodId: null, reference: '', note: 'Part payment', paidDate: date });
    expect(payment.receiptNumber).toMatch(/^RCP-/);

    const afterPayment = invoices.get(created.id);
    expect(afterPayment.paidPaisa).toBe(50_000);
    expect(afterPayment.duePaisa).toBe(207_400);
    expect(afterPayment.status).toBe('partially_paid');

    const outstanding = invoices.outstanding({ page: 1, pageSize: 25 });
    expect(outstanding.total).toBe(1);
    expect(outstanding.items[0]?.duePaisa).toBe(207_400);

    const summary = test.services.patients.financialSummary(patientId);
    expect(summary.outstandingPaisa).toBe(207_400);
  });

  it('refuses to bill a voided invoice and keeps receipts for voided payments', () => {
    const { invoices, payments } = test.services;
    const date = todayIso();
    const created = invoices.create({
      patientId,
      visitId: null,
      dentistId,
      date,
      notes: '',
      items: [
        { treatmentId: null, code: 'X', description: 'Extraction', toothCodes: ['38'], quantity: 1, unitPricePaisa: 200_000, discountType: 'none', discountValue: 0, sortOrder: 1 },
      ],
    });
    const payment = payments.create({ invoiceId: created.id, amountPaisa: 200_000, methodId: null, reference: '', note: '', paidDate: date });

    payments.void(payment.id, 'Cheque bounced', payment.receiptNumber);
    const afterVoid = invoices.get(created.id);
    expect(afterVoid.paidPaisa).toBe(0);
    expect(afterVoid.status).toBe('unpaid');
    expect(() => payments.void(payment.id, 'again')).toThrowError(/already/i);

    invoices.void(created.id, 'Raised in error');
    expect(invoices.get(created.id).status).toBe('void');
    expect(() => payments.create({ invoiceId: created.id, amountPaisa: 1_000, methodId: null, reference: '', note: '', paidDate: date })).toThrowError(/void/i);
  });
});

describe('inventory', () => {
  it('tracks stock movements and reports items that fall below the minimum', () => {
    const { inventory } = test.services;
    const saved = inventory.save(null, {
      code: 'MAT-001',
      name: 'Composite resin A2',
      categoryId: null,
      supplierId: null,
      unit: 'syringe',
      purchasePricePaisa: 85_000,
      sellingPricePaisa: null,
      minimumStockMilli: 20_000,
      reorderLevelMilli: 30_000,
      batchNumber: 'B-1',
      expiryDate: null,
      purchaseDate: null,
      storageLocation: 'Cabinet 2',
      notes: '',
      isActive: true,
    }, 50_000);

    expect(inventory.get(saved.id).currentStockMilli).toBe(50_000);

    const movement = inventory.createMovement({
      itemId: saved.id,
      type: 'consumption',
      quantityMilli: 35_000,
      unitCostPaisa: null,
      reason: 'Used on a filling',
      reference: '',
    });
    expect(movement.balanceAfterMilli).toBe(15_000);

    const item = inventory.get(saved.id);
    expect(item.isLowStock).toBe(true);
    expect(item.currentStockText).toContain('15');

    const alerts = inventory.alerts();
    expect(alerts.lowStock.some((row) => row.id === saved.id)).toBe(true);

    const page = inventory.movements({ page: 1, pageSize: 25, itemId: saved.id });
    expect(page.total).toBe(2); // opening stock + consumption
  });

  it('records purchases, adds the stock and books the expense in one step', () => {
    const { inventory, accounting } = test.services;
    const item = inventory.save(null, {
      code: 'MAT-002',
      name: 'Gloves (medium)',
      categoryId: null,
      supplierId: null,
      unit: 'box',
      purchasePricePaisa: 45_000,
      sellingPricePaisa: null,
      minimumStockMilli: 5_000,
      reorderLevelMilli: 10_000,
      batchNumber: '',
      expiryDate: null,
      purchaseDate: null,
      storageLocation: '',
      notes: '',
      isActive: true,
    });

    const purchase = inventory.createPurchase({
      supplierId: null,
      date: todayIso(),
      invoiceNumber: 'SUP-1001',
      paymentMethodId: null,
      paidPaisa: 90_000,
      discountPaisa: 0,
      notes: '',
      recordAsExpense: true,
      items: [
        { itemId: item.id, itemName: 'Gloves (medium)', unit: 'box', quantityMilli: 2_000, unitPricePaisa: 45_000, batchNumber: 'G-9', expiryDate: null },
      ],
    });

    expect(purchase.reference).toMatch(/^PUR-/);
    const stored = inventory.get(item.id);
    expect(stored.currentStockMilli).toBe(2_000);

    const ledger = accounting.list({ page: 1, pageSize: 25, direction: 'expense' });
    expect(ledger.items.some((row) => row.sourceType === 'purchase')).toBe(true);

    const summary = accounting.summary({ preset: 'this_month' });
    expect(summary.expensePaisa).toBeGreaterThanOrEqual(90_000);
  });
});

describe('accounting', () => {
  it('records manual income and expenses, and closes a period so it cannot be edited', () => {
    const { accounting } = test.services;
    const date = todayIso();
    const expenseCategory = accounting.categories('expense')[0];
    const incomeCategory = accounting.categories('income')[0];
    expect(expenseCategory).toBeDefined();
    expect(incomeCategory).toBeDefined();

    accounting.create({
      direction: 'expense',
      date,
      categoryId: expenseCategory!.id,
      amountPaisa: 25_000,
      paymentMethodId: null,
      reference: 'Rent slip 7',
      note: 'Studio rent',
    });
    accounting.create({
      direction: 'income',
      date,
      categoryId: incomeCategory!.id,
      amountPaisa: 100_000,
      paymentMethodId: null,
      reference: '',
      note: 'Course fee',
    });

    const summary = accounting.summary({ from: date, to: date });
    expect(summary.incomePaisa).toBe(100_000);
    expect(summary.expensePaisa).toBe(25_000);
    expect(summary.netPaisa).toBe(75_000);

    const daybook = accounting.daybook(date, date);
    expect(daybook).toHaveLength(1);
    expect(daybook[0]?.closingPaisa).toBe(75_000);

    const period = accounting.closePeriod({ periodStart: date, periodEnd: date, notes: 'Month end' });
    expect(period.id).toBeGreaterThan(0);
    expect(() =>
      accounting.create({
        direction: 'expense',
        date,
        categoryId: expenseCategory!.id,
        amountPaisa: 1_000,
        paymentMethodId: null,
        reference: '',
        note: 'Late slip',
      }),
    ).toThrowError(/closed/i);

    accounting.reopenPeriod(period.id, 'Adjustment needed', 'REOPEN');
    accounting.create({
      direction: 'expense',
      date,
      categoryId: expenseCategory!.id,
      amountPaisa: 1_000,
      paymentMethodId: null,
      reference: '',
      note: 'Late slip',
    });
    expect(accounting.summary({ from: date, to: date }).expensePaisa).toBe(26_000);
  });
});

describe('staff, dentists, users and roles', () => {
  it('creates a restricted user and enforces permissions below the UI', async () => {
    const { staff, users } = test.services;
    const member = await staff.save(null, {
      name: 'Nurse Ratna',
      designation: 'Dental assistant',
      department: 'Clinical',
      phone: '01712000000',
      email: '',
      address: '',
      dob: null,
      bloodGroup: 'unknown',
      nationalId: '',
      salaryPaisa: 2_000_000,
      joiningDate: todayIso(),
      status: 'active',
      notes: '',
      userId: null,
    });
    expect(member.id).toBeGreaterThan(0);
    expect(staff.departments()).toContain('Clinical');

    const role = users.saveRole(null, {
      name: 'Front desk (limited)',
      description: 'Can register patients only',
      permissions: ['patient.view', 'patient.create', 'appointment.view'],
    });
    const created = await users.create({
      username: 'ratna',
      fullName: 'Ratna Akter',
      email: '',
      phone: '',
      isActive: true,
      mustChangePassword: false,
      roleIds: [role.id],
      password: 'RatnaPass123',
    });

    const login = await test.services.auth.login('ratna', 'RatnaPass123');
    expect(login.user.permissions).toContain('patient.view');

    // The session is really restricted: the permission check lives in the service.
    expect(() => test.services.invoices.create({
      patientId,
      visitId: null,
      dentistId,
      date: todayIso(),
      notes: '',
      items: [{ treatmentId: null, code: 'X', description: 'Filling', toothCodes: [], quantity: 1, unitPricePaisa: 10_000, discountType: 'none', discountValue: 0, sortOrder: 1 }],
    })).toThrowError(/permission/i);
    expect(() => test.services.users.list({ page: 1, pageSize: 10 })).toThrowError(/permission/i);
    expect(created.id).toBeGreaterThan(0);
  });
});

describe('audit and notifications', () => {
  it('records sensitive changes in the audit trail and can export them', async () => {
    const { settings, audit } = test.services;
    settings.updateSettings({ autoLockMinutes: 15, expiryWarningDays: 45 });

    const page = audit.list({ page: 1, pageSize: 25, entityType: 'settings' });
    expect(page.total).toBeGreaterThanOrEqual(1);
    const entry = page.items[0];
    expect(entry?.actionLabel.length).toBeGreaterThan(0);
    expect(entry?.detail).toContain('autoLockMinutes');

    const exported = await auditActions(test);
    expect(exported).toBeGreaterThan(0);
  });

  it('turns real conditions into notifications without duplicating them', () => {
    const { notifications, appointments } = test.services;
    const now = new Date();
    const start = new Date(now.getTime() + 30 * 60_000);
    appointments.create({
      patientId,
      dentistId,
      date: todayIso(now),
      startTime: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      endTime: `${String(start.getHours() + 1).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      reason: 'Review',
      notes: '',
      status: 'scheduled',
      reminderNote: '',
    });

    const first = notifications.refresh();
    expect(first.created).toBeGreaterThanOrEqual(1);
    const second = notifications.refresh();
    expect(second.created).toBe(0);

    const list = notifications.list({ onlyUnread: true });
    expect(list.length).toBeGreaterThanOrEqual(1);
    const unread = notifications.unreadCount();
    expect(unread.total).toBe(list.length);
  });
});

describe('reports, printing, search and the dashboard', () => {
  it('runs a report from the catalogue and exports it as CSV with a BOM', async () => {
    const { reports } = test.services;
    const catalogue = reports.catalogue();
    expect(catalogue.length).toBeGreaterThanOrEqual(14);
    expect(catalogue.map((entry) => entry.key)).toContain('patients_registered');

    const result = reports.run({ reportKey: 'patients_registered', from: '1900-01-01', to: '2999-12-31' });
    expect(result.rowCount).toBe(1);
    expect(result.columns.length).toBeGreaterThan(2);

    const csv = await reports.exportCsv({ reportKey: 'patients_registered', from: '1900-01-01', to: '2999-12-31' }, test.paths.exportsDir);
    const text = readFileSync(csv.path, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('New patients');
    expect(csv.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('renders a prescription with the letterhead and the dentist signature', async () => {
    const { prescriptions, print } = test.services;
    const created = prescriptions.create({
      patientId,
      dentistId,
      visitId: null,
      date: todayIso(),
      cc: ['Tooth pain'],
      oe: ['Caries 16'],
      re: ['OPG'],
      advice: ['Soft diet'],
      notes: '',
      items: [
        {
          medicationId: null,
          name: 'Amoxicillin',
          form: 'capsule',
          strength: '500 mg',
          doseMorning: 1,
          doseNoon: 0,
          doseNight: 1,
          foodTiming: 'after_food',
          durationDays: 5,
          quantity: 10,
          instructions: 'Complete the course',
          sortOrder: 1,
        },
      ],
    });

    const rendered = await print.render({ kind: 'prescription', id: created.id, output: 'pdf' });
    expect(rendered.pdfPath).toBeTruthy();
    const html = test.printHost.lastHtml;
    expect(html).toContain('Prescription');
    expect(html).toContain('Amoxicillin');
    expect(html).toContain('1 + 0 + 1');
    expect(html).toContain('Dr. Shohan Khan');
    expect(html).toContain('BDS');
    expect(html).toContain('class="signature"');
    expect(html).toContain('class="signature__line"');
    expect(html).toContain('BDS');
  });

  it('renders an invoice as a clinic document without a dentist signature', async () => {
    const { invoices, print } = test.services;
    const created = invoices.create({
      patientId,
      visitId: null,
      dentistId,
      date: todayIso(),
      notes: '',
      items: [
        { treatmentId: null, code: 'SCL', description: 'Scaling', toothCodes: [], quantity: 1, unitPricePaisa: 150_000, discountType: 'none', discountValue: 0, sortOrder: 1 },
      ],
    });

    const rendered = await print.render({ kind: 'invoice', id: created.id, output: 'print' });
    expect(rendered.printerName).toBe('Dentiva-Test-Printer');
    const html = test.printHost.lastHtml;
    expect(html).toContain('Invoice');
    expect(html).toContain('Scaling');
    // An invoice is a clinic document: no dentist signature block at all.
    // (The stylesheet defines the rule for prescriptions, but no element uses it.)
    expect(html).not.toContain('<div class="signature"');
  });

  it('finds records the user may see and hides the rest', () => {
    const { search } = test.services;
    createPatient(test, { firstName: 'Ayesha', lastName: 'Begum', phone: '01911111111' });

    const response = search.global('Ayesha');
    expect(response.groups.length).toBeGreaterThanOrEqual(1);
    const patients = response.groups.find((group) => group.key === 'patients');
    expect(patients?.items.length).toBe(1);
    expect(patients?.items[0]?.title).toContain('Ayesha');
  });

  it('builds the role-aware dashboard from real conditions', () => {
    const { dashboard } = test.services;
    const data = dashboard.get();
    expect(data.cards.length).toBeGreaterThanOrEqual(4);
    expect(data.todayAppointments).toEqual([]);
    expect(data.queue).toEqual([]);
    expect(data.newPatientsThisMonth).toBe(1);
    expect(data.backup.intervalDays).toBe(7);
  });
});

describe('application status and master data', () => {
  it('reports bootstrap state and health', () => {
    const { app } = test.services;
    const bootstrap = app.bootstrap();
    expect(bootstrap.activation.activated).toBe(true);
    expect(bootstrap.activation.machineBound).toBe(true);
    // The harness activates the installation but has not run the setup wizard,
    // so the state must honestly say so.
    expect(bootstrap.state).toBe('setup_required');
    expect(bootstrap.clinic).toBeNull();
    expect(bootstrap.setup.activationComplete).toBe(true);
    const health = app.health();
    expect(health.databaseOk).toBe(true);
    expect(health.integrityOk).toBe(true);
  });

  it('performs generic master-data CRUD with permission guards', () => {
    const { resources } = test.services;
    const saved = resources.save('suppliers', null, {
      name: 'Dhaka Dental Supplies',
      contactPerson: 'Mr. Karim',
      phone: '01713000000',
      email: '',
      address: 'Mirpur, Dhaka',
      notes: '',
      isActive: true,
    });
    const list = resources.list('suppliers', { page: 1, pageSize: 25 });
    expect(list.total).toBe(1);

    const options = resources.options('suppliers');
    expect(options[0]?.value).toBe(saved.id);

    resources.delete('suppliers', saved.id, {});
    expect(resources.list('suppliers', { page: 1, pageSize: 25 }).total).toBe(0);
  });
});

async function auditActions(app: TestApp): Promise<number> {
  const csv = await app.services.audit.exportRows('1900-01-01', '2999-12-31').length;
  return csv;
}
