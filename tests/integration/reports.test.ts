/**
 * Every report in the catalogue, executed against real data.
 *
 * The catalogue drives the report screen, the export menu and the print
 * pipeline, so a report that throws only when it is opened by a real user is
 * both a product defect and a support call. This suite walks the whole
 * catalogue — including the keys a stress test never touches — and checks the
 * shape of every result, its CSV export and its printable HTML.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPORT_CATALOGUE } from '@core/services/report-service';
import { todayIso } from '@shared/dates';
import type { ReportKey } from '@shared/types';
import { createPatient, createTestApp, type TestApp } from './harness';

let test: TestApp;
let patientId = 0;
let dentistId = 0;

const TODAY = todayIso();
const FROM = todayIso(new Date(Date.now() - 90 * 86_400_000));

beforeEach(async () => {
  test = createTestApp();
  const ownerId = await test.bootstrapOwner({ username: 'owner', password: 'OwnerPass123' });
  test.signIn(ownerId);

  const { dentists, visits, invoices, payments, prescriptions, appointments, inventory, accounting, referrals, queue } = test.services;

  const dentist = await dentists.save(null, {
    name: 'Dr. Report Reader',
    phone: '01711000000',
    email: '',
    registrationNumber: 'BMDC-77777',
    visitingHours: '10:00 - 20:00',
    isActive: true,
    isDefault: true,
    credentials: [
      { type: 'qualification', title: 'BDS', institution: 'Dhaka Dental College', year: 2014, sortOrder: 1, showOnPrescription: true },
    ],
  });
  dentistId = dentist.id;

  const patient = createPatient(test, { firstName: 'Report', lastName: 'Patient', phone: '01812345678' });
  patientId = patient.id;

  const visit = visits.create({
    patientId,
    dentistId,
    visitDate: TODAY,
    visitTime: '11:00',
    chiefComplaint: 'Pain',
    history: 'Two days',
    examination: 'Caries 46',
    diagnosis: 'Irreversible pulpitis',
    ccOptions: [],
    oeOptions: [],
    reOptions: [],
    adviceOptions: [],
    advice: 'RCT advised',
    notes: '',
    followUpDate: null,
    treatments: [
      {
        treatmentId: null,
        code: 'CONS',
        description: 'Consultation',
        toothCodes: ['46'],
        quantity: 1,
        unitPricePaisa: 60_000,
        discountPaisa: 0,
        notes: '',
      },
    ],
    dentalFindings: [{ toothFdi: '46', finding: 'caries', surfaces: ['occlusal'], mobilityGrade: 0, note: '' }],
    prescriptionId: null,
  });

  const prescription = prescriptions.create({
    patientId,
    dentistId,
    visitId: visit.id,
    date: TODAY,
    cc: ['Pain'],
    oe: ['Caries'],
    re: [],
    advice: ['Soft diet'],
    notes: '',
    items: [
      {
        medicationId: prescriptions.medications({ page: 1, pageSize: 1 }).items[0]?.id ?? null,
        name: 'Amoxicillin 500 mg',
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
  expect(prescription.id).toBeGreaterThan(0);

  const invoice = invoices.create({
    patientId,
    visitId: visit.id,
    dentistId,
    date: TODAY,
    notes: '',
    items: [
      {
        treatmentId: null,
        code: 'CONS',
        description: 'Consultation',
        toothCodes: ['46'],
        quantity: 1,
        unitPricePaisa: 60_000,
        discountType: 'none',
        discountValue: 0,
        sortOrder: 1,
      },
    ],
  });
  const methodId = payments.methods()[0]?.id ?? null;
  payments.create({ invoiceId: invoice.id, amountPaisa: 60_000, methodId, reference: '', note: '', paidDate: TODAY });

  // An unpaid invoice and a voided one: the outstanding and void paths must
  // still produce a table rather than an empty result.
  const openInvoice = invoices.create({
    patientId,
    visitId: null,
    dentistId,
    date: TODAY,
    notes: 'Awaiting payment',
    items: [
      {
        treatmentId: null,
        code: 'RCT',
        description: 'Root canal treatment',
        toothCodes: ['46'],
        quantity: 1,
        unitPricePaisa: 850_000,
        discountType: 'percent',
        discountValue: 10,
        sortOrder: 1,
      },
    ],
  });
  payments.create({ invoiceId: openInvoice.id, amountPaisa: 300_000, methodId, reference: '', note: '', paidDate: TODAY });

  const voided = invoices.create({
    patientId,
    visitId: null,
    dentistId,
    date: TODAY,
    notes: 'Raised in error',
    items: [
      {
        treatmentId: null,
        code: 'X',
        description: 'Wrong line',
        toothCodes: [],
        quantity: 1,
        unitPricePaisa: 10_000,
        discountType: 'none',
        discountValue: 0,
        sortOrder: 1,
      },
    ],
  });
  invoices.void(voided.id, 'Raised in error');

  appointments.create({
    patientId,
    dentistId,
    date: TODAY,
    startTime: '12:00',
    endTime: '12:30',
    reason: 'Follow-up',
    notes: '',
    status: 'completed',
    reminderNote: '',
  });
  appointments.create({
    patientId,
    dentistId,
    date: todayIso(new Date(Date.now() - 2 * 86_400_000)),
    startTime: '16:00',
    endTime: '16:30',
    reason: 'Extraction review',
    notes: '',
    status: 'no_show',
    reminderNote: 'Called the patient twice.',
  });
  queue.add({ patientId, dentistId, appointmentId: null, priority: 'normal', notes: '' }, TODAY);

  referrals.save(null, {
    patientId,
    visitId: null,
    referralDoctorId: null,
    doctorName: 'Dr. Referrer',
    specialty: 'Orthodontics',
    organisation: 'City Dental Hospital',
    contact: '01712000000',
    reason: 'Orthodontic opinion',
    date: TODAY,
    followUpDate: null,
    status: 'pending',
    notes: '',
  });

  const item = inventory.save(
    null,
    {
      code: 'REP-001',
      name: 'Report gloves',
      categoryId: null,
      supplierId: null,
      unit: 'box',
      purchasePricePaisa: 30_000,
      sellingPricePaisa: null,
      minimumStockMilli: 5_000,
      reorderLevelMilli: 10_000,
      batchNumber: 'B-1',
      expiryDate: TODAY,
      purchaseDate: null,
      storageLocation: 'Store',
      notes: '',
      isActive: true,
    },
    20_000,
  );
  inventory.createMovement({
    itemId: item.id,
    type: 'consumption',
    quantityMilli: 18_000,
    unitCostPaisa: null,
    reason: 'Used in treatment',
    reference: '',
  });
  inventory.save(
    null,
    {
      code: 'REP-002',
      name: 'Expiring anaesthetic',
      categoryId: null,
      supplierId: null,
      unit: 'bottle',
      purchasePricePaisa: 60_000,
      sellingPricePaisa: null,
      minimumStockMilli: 1_000,
      reorderLevelMilli: 2_000,
      batchNumber: 'B-2',
      expiryDate: todayIso(new Date(Date.now() + 30 * 86_400_000)),
      purchaseDate: null,
      storageLocation: 'Fridge',
      notes: '',
      isActive: true,
    },
    5_000,
  );

  accounting.create({
    direction: 'expense',
    date: TODAY,
    categoryId: accounting.categories('expense')[0]?.id ?? 0,
    amountPaisa: 100_000,
    paymentMethodId: methodId,
    reference: 'BILL-1',
    note: 'Clinic electricity',
  });

  // One staff member so the staff-activity report has a row to describe.
  const staff = await test.services.staff.save(null, {
    name: 'Report Assistant',
    designation: 'Dental assistant',
    department: 'Clinical',
    phone: '01911000000',
    email: '',
    address: 'Tangail',
    dob: null,
    bloodGroup: 'unknown',
    nationalId: '',
    salaryPaisa: 2_000_000,
    joiningDate: FROM,
    status: 'active',
    notes: '',
    userId: null,
  });
  expect(staff.id).toBeGreaterThan(0);
});

afterEach(() => {
  test?.cleanup();
});

describe('report catalogue coverage', () => {
  it('exposes every report key the shared constants declare', () => {
    const catalogue = test.services.reports.catalogue();
    const keys = catalogue.map((entry) => entry.key);
    expect(keys).toEqual(REPORT_CATALOGUE.map((entry) => entry.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(20);
    expect(catalogue.every((entry) => entry.title.length > 0 && entry.description.length > 0)).toBe(true);
  });

  it('runs every report with data and returns a well-formed table', () => {
    const { reports } = test.services;
    const items = test.services.inventory.list({ page: 1, pageSize: 50 }).items;
    const filtersFor = (reportKey: ReportKey): Parameters<typeof reports.run>[0] => {
      const base = { reportKey, from: FROM, to: TODAY } as Parameters<typeof reports.run>[0];
      switch (reportKey) {
        case 'patient_register_detail':
          return { ...base, filters: { patientId } };
        case 'inventory_movements':
          return { ...base, filters: { itemId: items[0]?.id ?? null } };
        case 'inventory_stock':
        case 'inventory_low_stock':
        case 'inventory_expiry':
          return { ...base, filters: { supplierId: null } };
        case 'treatments':
        case 'revenue':
          return { ...base, filters: { dentistId } };
        default:
          return base;
      }
    };

    // Reports over data this fixture creates; the rest must still return a
    // well-formed (possibly empty) table.
    const EXPECTED_ROWS = new Set<ReportKey>([
      'patients_registered',
      'patient_register_detail',
      'appointments',
      'no_shows',
      'visits',
      'treatments',
      'prescriptions',
      'referrals',
      'revenue',
      'payments',
      'outstanding',
      'expenses',
      'income',
      'profit',
      'daybook',
      'inventory_stock',
      'inventory_low_stock',
      'inventory_expiry',
      'inventory_movements',
      'dentist_activity',
      'staff_activity',
      'audit_summary',
    ]);

    let populated = 0;
    for (const entry of REPORT_CATALOGUE) {
      const result = reports.run(filtersFor(entry.key));
      expect(result.columns.length, `${entry.key} has no columns`).toBeGreaterThan(0);
      if (EXPECTED_ROWS.has(entry.key)) {
        expect(result.rows.length, `${entry.key} returned no rows`).toBeGreaterThan(0);
        populated += 1;
      }
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.range.from <= result.range.to).toBe(true);
      for (const column of result.columns) {
        expect(column.key.length, `${entry.key} has a column without a key`).toBeGreaterThan(0);
        expect(column.label.length, `${entry.key} has a column without a label`).toBeGreaterThan(0);
      }
      // Nothing in a report may be `undefined`: the table and the CSV writer
      // only understand null for an empty cell.
      for (const row of result.rows) {
        for (const value of Object.values(row)) {
          expect(value === undefined, `${entry.key} produced an undefined cell`).toBe(false);
        }
      }
    }
    expect(populated).toBe(EXPECTED_ROWS.size);
  });

  it('exports every report to CSV on disk', async () => {
    const { reports } = test.services;
    for (const entry of REPORT_CATALOGUE) {
      const exported = await reports.exportCsv({ reportKey: entry.key, from: FROM, to: TODAY }, test.paths.exportsDir);
      expect(exported.rowCount).toBeGreaterThanOrEqual(0);
      expect(existsSync(exported.path)).toBe(true);
      const csv = readFileSync(exported.path, 'utf8');
      expect(csv.split('\n').length).toBeGreaterThan(1);
      expect(csv).not.toContain('[object Object]');
      expect(csv).not.toContain('undefined');
    }
  });

  it('renders every report to printable HTML', async () => {
    const { reports } = test.services;
    for (const entry of REPORT_CATALOGUE) {
      const rendered = await reports.export({ reportKey: entry.key, from: FROM, to: TODAY }, 'print');
      expect(rendered.printed).toBe(true);
      const html = test.printHost.lastHtml;
      expect(html).toContain('<table');
      expect(html).toContain(entry.title.split(' ')[0] ?? '');
      expect(html).not.toContain('[object Object]');
    }
  });

  it('refuses a backwards date range instead of returning nonsense', () => {
    expect(() => test.services.reports.run({ reportKey: 'revenue', from: TODAY, to: FROM })).toThrowError(/start date/i);
  });
});
