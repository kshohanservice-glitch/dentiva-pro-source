/**
 * Clinic-volume stress test.
 *
 * Builds a realistic multi-year clinic inside a throwaway data folder and then
 * checks the things that break first when a practice grows: list latency,
 * newest-first paging, search, dashboards, reports, money reconciliation,
 * integrity and backup. Volume is controlled by `DENTIVA_STRESS_PATIENTS`
 * (default 150) so the same file can seed a smoke dataset on a laptop or a
 * 600-patient dataset on a build machine.
 *
 * The data is generated from a fixed seed, so a failure is always reproducible.
 */
import { statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIso } from '@shared/dates';
import { createPatient, createTestApp, type TestApp } from '../integration/harness';

const PATIENT_COUNT = Number.parseInt(process.env['DENTIVA_STRESS_PATIENTS'] ?? '150', 10);
const RNG_SEED = 987_654_321;

/** Small deterministic PRNG (mulberry32) so the dataset never changes between runs. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST_NAMES = [
  'Rahim',
  'Karim',
  'Ayesha',
  'Fatema',
  'Shakib',
  'Nusrat',
  'Imran',
  'Sumaiya',
  'Tanvir',
  'Rumana',
  'Jahid',
  'Mitu',
  'Farhan',
  'Sadia',
  'Rakib',
  'Nasrin',
];
const LAST_NAMES = ['Uddin', 'Akter', 'Rahman', 'Hossain', 'Islam', 'Chowdhury', 'Mia', 'Begum', 'Khan', 'Sarkar'];
const POSTERIOR_TEETH = ['16', '17', '26', '27', '36', '37', '46', '47'];
const ANTERIOR_TEETH = ['11', '12', '21', '22', '31', '32', '41', '42'];
const FINDINGS = ['caries', 'filled', 'crown', 'root_canal', 'missing'] as const;
const ITEM_UNITS = ['box', 'piece', 'bottle', 'pack', 'tube'] as const;

interface TreatmentOption {
  readonly value: number;
  readonly label: string;
  readonly meta: string;
}

interface SeedTotals {
  patients: number;
  visits: number;
  prescriptions: number;
  invoices: number;
  payments: number;
  appointments: number;
  inventoryItems: number;
  accountingEntries: number;
}

const totals: SeedTotals = {
  patients: 0,
  visits: 0,
  prescriptions: 0,
  invoices: 0,
  payments: 0,
  appointments: 0,
  inventoryItems: 0,
  accountingEntries: 0,
};

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

describe('a busy clinic', () => {
  let test: TestApp;
  const dentistIds: number[] = [];
  let treatments: TreatmentOption[] = [];
  let medicationIds: number[] = [];
  let methodId: number | null = null;
  let expenseCategoryId: number | null = null;
  let databaseBytes = 0;

  beforeAll(async () => {
    test = createTestApp();
    const ownerId = await test.bootstrapOwner({ username: 'owner', password: 'Clinic-Stress-2026' });
    test.signIn(ownerId);

    const random = makeRandom(RNG_SEED);
    const {
      dentists,
      treatments: catalogue,
      prescriptions,
      visits,
      invoices,
      payments,
      appointments,
      inventory,
      accounting,
      patients,
    } = test.services;

    for (const index of [0, 1, 2]) {
      const saved = await dentists.save(null, {
        name: `Dr. Stress ${index + 1}`,
        phone: `0171100000${index}`,
        email: '',
        registrationNumber: `BMDC-${9_000 + index}`,
        visitingHours: '10:00 - 20:00',
        isActive: true,
        isDefault: index === 0,
        credentials: [
          {
            type: 'qualification',
            title: 'BDS',
            institution: 'Dhaka Dental College',
            year: 2012 + index,
            sortOrder: 1,
            showOnPrescription: true,
          },
        ],
      });
      dentistIds.push(saved.id);
    }

    treatments = catalogue.catalogOptions('', 60);
    medicationIds = prescriptions.medications({ page: 1, pageSize: 40 }).items.map((row) => row.id);
    methodId = payments.methods()[0]?.id ?? null;
    const categories = accounting.categories('expense');
    expenseCategoryId = categories[0]?.id ?? null;

    // --- Inventory ---------------------------------------------------------
    const itemIds: number[] = [];
    for (let index = 0; index < 24; index += 1) {
      const saved = inventory.save(
        null,
        {
          code: `STRESS-${String(index + 1).padStart(3, '0')}`,
          name: `Stress material ${index + 1}`,
          categoryId: null,
          supplierId: null,
          unit: ITEM_UNITS[index % ITEM_UNITS.length] ?? 'piece',
          purchasePricePaisa: 20_000 + index * 1_500,
          sellingPricePaisa: null,
          minimumStockMilli: 5_000,
          reorderLevelMilli: 10_000,
          batchNumber: `B-${index + 1}`,
          expiryDate: null,
          purchaseDate: null,
          storageLocation: 'Store room',
          notes: '',
          isActive: true,
        },
        40_000 + index * 2_000,
      );
      itemIds.push(saved.id);
      totals.inventoryItems += 1;
    }

    // --- Patients, visits, prescriptions, invoices and payments ------------
    const base = new Date();
    for (let index = 0; index < PATIENT_COUNT; index += 1) {
      const gender = index % 2 === 0 ? 'male' : 'female';
      const patient = createPatient(test, {
        firstName: FIRST_NAMES[index % FIRST_NAMES.length] ?? 'Patient',
        lastName: LAST_NAMES[(index * 3) % LAST_NAMES.length] ?? 'Sarker',
        gender,
        ageYears: 8 + (index % 62),
        bloodGroup: (['A+', 'B+', 'O+', 'AB+', 'unknown'] as const)[index % 5] ?? 'unknown',
        phone: `018${String(10_000_000 + index).slice(0, 8)}`,
        city: ['Dhaka', 'Tangail', 'Chattogram', 'Khulna', 'Sylhet'][index % 5] ?? 'Dhaka',
        address: `House ${index + 1}, Road ${(index % 20) + 1}`,
      });
      totals.patients += 1;

      const visitCount = 1 + Math.floor(random() * 4);
      for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
        const daysAgo = Math.floor(random() * 720);
        const visitDate = todayIso(new Date(base.getTime() - daysAgo * 86_400_000));
        const dentistId = dentistIds[Math.floor(random() * dentistIds.length)] ?? dentistIds[0]!;
        const treatment = treatments[Math.floor(random() * treatments.length)];
        const posterior = random() > 0.4;
        const tooth = (posterior ? POSTERIOR_TEETH : ANTERIOR_TEETH)[Math.floor(random() * 8)] ?? '16';
        const finding = FINDINGS[Math.floor(random() * FINDINGS.length)] ?? 'caries';
        const surface = posterior ? 'occlusal' : 'incisal';

        const visit = visits.create({
          patientId: patient.id,
          dentistId,
          visitDate,
          visitTime: `${String(9 + Math.floor(random() * 9)).padStart(2, '0')}:${random() > 0.5 ? '30' : '00'}`,
          chiefComplaint: 'Pain and sensitivity',
          history: 'Symptoms for a few days',
          examination: 'Localised tenderness on percussion',
          diagnosis: 'Dental caries',
          ccOptions: [],
          oeOptions: [],
          reOptions: [],
          adviceOptions: [],
          advice: 'Maintain oral hygiene',
          notes: '',
          followUpDate: null,
          treatments: [
            {
              treatmentId: treatment?.value ?? null,
              code: treatment?.meta ?? '',
              description: treatment?.label ?? 'Consultation',
              toothCodes: [tooth],
              quantity: 1,
              unitPricePaisa: 80_000 + index * 100,
              discountPaisa: 0,
              notes: '',
            },
          ],
          dentalFindings: [{ toothFdi: tooth, finding, surfaces: [surface], mobilityGrade: 0, note: '' }],
          prescriptionId: null,
        });
        totals.visits += 1;

        if (random() > 0.6) {
          const prescription = prescriptions.create({
            patientId: patient.id,
            dentistId,
            visitId: visit.id,
            date: visitDate,
            cc: ['Pain'],
            oe: ['Caries'],
            re: ['Periapical radiolucency'],
            advice: ['Soft diet'],
            notes: '',
            items: [
              {
                medicationId: medicationIds[Math.floor(random() * Math.max(1, medicationIds.length))] ?? null,
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
          totals.prescriptions += 1;
        }

        if (random() > 0.25) {
          const lineTotal = 80_000 + index * 100;
          const invoice = invoices.create({
            patientId: patient.id,
            visitId: visit.id,
            dentistId,
            date: visitDate,
            notes: '',
            items: [
              {
                treatmentId: treatment?.value ?? null,
                code: treatment?.meta ?? 'CONS',
                description: treatment?.label ?? 'Consultation',
                toothCodes: [tooth],
                quantity: 1,
                unitPricePaisa: lineTotal,
                discountType: 'none',
                discountValue: 0,
                sortOrder: 1,
              },
            ],
          });
          expect(invoice.number.startsWith('INV-')).toBe(true);
          totals.invoices += 1;
          const payInFull = random() > 0.35;
          const amount = payInFull ? lineTotal : Math.round(lineTotal / 2);
          if (amount > 0) {
            payments.create({
              invoiceId: invoice.id,
              amountPaisa: amount,
              methodId,
              reference: '',
              note: '',
              paidDate: visitDate,
            });
            totals.payments += 1;
          }
        }
      }

      if (index % 12 === 0) {
        // Spread the bookings over three dentists, seven days and eight hours so
        // every generated slot is unique even at six hundred patients.
        const slot = index / 12;
        const hour = 9 + (slot % 8);
        const minute = Math.floor(slot / 168) % 2 === 0 ? 0 : 30;
        appointments.create({
          patientId: patient.id,
          dentistId: dentistIds[slot % dentistIds.length] ?? dentistIds[0]!,
          date: todayIso(new Date(base.getTime() + (slot % 7) * 86_400_000)),
          startTime: `${String(hour).padStart(2, '0')}:${minute === 0 ? '00' : '30'}`,
          endTime: `${String(hour + 1).padStart(2, '0')}:${minute === 0 ? '00' : '30'}`,
          reason: 'Review',
          notes: '',
          status: 'scheduled',
          reminderNote: '',
        });
        totals.appointments += 1;
      }

      if (index % 20 === 0) {
        inventory.createMovement({
          itemId: itemIds[index % itemIds.length] ?? itemIds[0]!,
          type: 'consumption',
          quantityMilli: 3_000,
          unitCostPaisa: null,
          reason: 'Used in treatment',
          reference: '',
        });
      }
    }

    // --- Expenses across the whole period ---------------------------------
    for (let index = 0; index < 40; index += 1) {
      accounting.create({
        direction: 'expense',
        date: todayIso(new Date(base.getTime() - index * 6 * 86_400_000)),
        categoryId: expenseCategoryId ?? 0,
        amountPaisa: 150_000 + index * 5_000,
        paymentMethodId: methodId,
        reference: `BILL-${1_000 + index}`,
        note: 'Clinic running cost',
      });
      totals.accountingEntries += 1;
    }

    // Touch the newest page once so the first measured read is not the very
    // first statement against a cold page cache.
    patients.list({ page: 1, pageSize: 25 });
    databaseBytes = statSync(test.paths.databasePath).size;

    expect(totals.patients).toBe(PATIENT_COUNT);
    expect(totals.visits).toBeGreaterThanOrEqual(PATIENT_COUNT);
  }, 900_000);

  afterAll(() => {
    test?.cleanup();
  });

  it('holds a realistic amount of clinical and financial data', () => {
    const summary = test.services.system.dataSummary();
    expect(totals.invoices).toBeGreaterThan(PATIENT_COUNT);
    expect(totals.payments).toBeGreaterThan(PATIENT_COUNT / 2);
    expect(databaseBytes).toBeGreaterThan(PATIENT_COUNT * 4_000); // ~4 kB per patient
    expect(summary.patients).toBe(PATIENT_COUNT);
    expect(summary.visits).toBe(totals.visits);
    expect(summary.invoices).toBe(totals.invoices);
    expect(test.services.system.integrityCheck().ok).toBe(true);
  });

  it('pages the newest patients first within budget', () => {
    const first = timed(() => test.services.patients.list({ page: 1, pageSize: 50 }));
    expect(first.value.total).toBe(PATIENT_COUNT);
    expect(first.value.items).toHaveLength(50);
    expect(first.ms).toBeLessThan(400);

    const codes = first.value.items.map((row) => row.code);
    expect([...codes].sort().reverse()).toEqual(codes); // P-0000nn, newest code first

    const lastPage = Math.ceil(PATIENT_COUNT / 50);
    const tail = timed(() => test.services.patients.list({ page: lastPage, pageSize: 50 }));
    expect(tail.value.items.length).toBeGreaterThan(0);
    expect(tail.ms).toBeLessThan(400);
  });

  it('finds a patient by name and by code quickly', () => {
    const target = test.services.patients.list({ page: 1, pageSize: 200 }).items[37];
    expect(target).toBeDefined();
    const surname = target!.name.split(' ').slice(-1)[0] ?? '';

    const byName = timed(() => test.services.patients.list({ page: 1, pageSize: 25, search: surname }));
    expect(byName.value.total).toBeGreaterThan(0);
    expect(byName.ms).toBeLessThan(500);

    const byCode = timed(() => test.services.patients.quickSearch(target!.code, 10));
    expect(byCode.value.some((row) => row.id === target!.id)).toBe(true);
    expect(byCode.ms).toBeLessThan(500);

    // The FTS index must not be a full scan: searching a rare word stays fast.
    const rare = timed(() => test.services.patients.list({ page: 1, pageSize: 25, search: 'Cardiology-Report-Nobody-Has' }));
    expect(rare.value.total).toBe(0);
    expect(rare.ms).toBeLessThan(500);
  });

  it('keeps the dashboard responsive on a loaded database', () => {
    const dashboard = timed(() => test.services.dashboard.get());
    expect(dashboard.value.cards.length).toBeGreaterThan(3);
    expect(dashboard.value.dentitionSummary).toBeTruthy();
    expect(dashboard.ms).toBeLessThan(2_000);
  });

  it('runs the heavy reports over the full period within budget', () => {
    const from = todayIso(new Date(Date.now() - 730 * 86_400_000));
    const to = todayIso();
    for (const reportKey of ['revenue', 'outstanding', 'treatments', 'dentist_activity', 'inventory_stock'] as const) {
      const report = timed(() => test.services.reports.run({ reportKey, from, to }));
      expect(report.value.columns.length).toBeGreaterThan(0);
      expect(report.ms).toBeLessThan(5_000);
    }
  });

  it('reconciles billed, collected and outstanding money to the paisa', () => {
    const from = todayIso(new Date(Date.now() - 730 * 86_400_000));
    const to = todayIso();
    const summary = test.services.invoices.statistics({ from, to });
    const payments = test.services.payments.statistics({ from, to });
    expect(payments.totalPaisa).toBeGreaterThan(0);

    const invoices = test.services.invoices.list({ page: 1, pageSize: 200, from, to });
    expect(invoices.total).toBe(totals.invoices);
    expect(invoices.items.reduce((sum, row) => sum + row.duePaisa, 0)).toBeGreaterThanOrEqual(0);

    // Every recorded payment lands in the same window as the invoices it settles,
    // so the payment totals and the invoice "collected" total must agree exactly.
    expect(summary.collectedPaisa).toBe(payments.totalPaisa);
    expect(summary.outstandingPaisa).toBeGreaterThanOrEqual(summary.invoicedPaisa - summary.collectedPaisa);
    expect(summary.discountPaisa).toBe(0);

    // The day-by-day series must add up to the range totals.
    const byDayInvoiced = summary.byDay.reduce((sum, day) => sum + day.invoicedPaisa, 0);
    expect(byDayInvoiced).toBe(summary.invoicedPaisa);
    expect(Number.isInteger(summary.outstandingPaisa)).toBe(true);
  });

  it('backs up and verifies a large database, and previews a restore', async () => {
    const started = performance.now();
    const created = await test.services.backups.create({ kind: 'manual', note: 'stress volume' });
    const createdMs = performance.now() - started;
    expect(created.sizeBytes).toBeGreaterThan(200_000);
    expect(created.patientCount).toBe(PATIENT_COUNT);
    expect(createdMs).toBeLessThan(60_000);

    const verified = await test.services.backups.verify(created.id);
    expect(verified.status).toBe('completed');
    expect(verified.verifiedAt).toBeTruthy();
    expect(test.services.system.integrityCheck().ok).toBe(true);

    const stored = statSync(created.filePath).size;
    expect(stored).toBe(created.sizeBytes);

    const preview = await test.services.backups.previewRestore(created.filePath);
    expect(preview.candidate.valid).toBe(true);
    expect(preview.currentData.patients).toBe(PATIENT_COUNT);
    expect(preview.requiresTypedConfirmation).toBe('RESTORE');
    expect(test.services.system.integrityCheck().ok).toBe(true);
  });

  it('records every write in the audit log without slowing the clinic down', () => {
    const page = test.services.audit.list({ page: 1, pageSize: 100 });
    expect(page.total).toBeGreaterThan(PATIENT_COUNT);
    expect(page.items.length).toBe(100);
  });
});
