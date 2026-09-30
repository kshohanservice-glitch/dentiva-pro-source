#!/usr/bin/env node
/**
 * Stress-data seeder.
 *
 * Fills a throw-away data folder with a realistic multi-year clinic: patients,
 * appointments, queue tokens, visits with charting, prescriptions, invoices,
 * payments, stock movements and accounting entries.
 *
 * Everything is written through the same `invoke` contract the desktop window
 * uses — the same services, the same zod validation and the same permission
 * checks — so the generated database is exactly as consistent as one a clinic
 * would build by hand, and the seeder doubles as a contract check.
 *
 *   npm run seed:stress            # 250 patients in a temporary folder
 *   npm run seed:stress -- 60      # a smaller batch
 *   npm run seed:stress -- 500 --keep   # keep the data in .dentiva-stress
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const targetPatients = Number(args.find((arg) => /^\d+$/.test(arg)) ?? '250');
const port = Number(process.env['DENTIVA_STRESS_PORT'] ?? '4421');
const base = `http://127.0.0.1:${port}`;
const dataDir =
  process.env['DENTIVA_DEV_DATA'] ?? (keep ? path.join(root, '.dentiva-stress') : await mkdtemp(path.join(tmpdir(), 'dentiva-stress-')));
const OWNER = { username: 'owner', password: 'Clinic-Stress-2026' };
const ACTIVATION_CODE = '1516591935015165';

// ---------------------------------------------------------------------------
// Deterministic pseudo-random generator, so two runs look the same.
// ---------------------------------------------------------------------------
let rngState = 20260930;
function random() {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
}
function pick(list) {
  return list[Math.floor(random() * list.length)];
}
function chance(probability) {
  return random() < probability;
}
function isoDate(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
function phone() {
  return `+880 17${String(Math.floor(10000000 + random() * 89999999))}`;
}

const FIRST_NAMES = [
  'Abdul',
  'Ayesha',
  'Bilkis',
  'Chandni',
  'Delwar',
  'Farhana',
  'Golam',
  'Hasina',
  'Ibrahim',
  'Jannatul',
  'Kamrul',
  'Laila',
  'Mahmud',
  'Nasrin',
  'Omar',
  'Parvin',
  'Rafiq',
  'Sabina',
  'Tanvir',
  'Umme',
  'Vashkar',
  'Wahida',
  'Yasmin',
  'Zahid',
  'Anika',
  'Bashir',
  'Dilruba',
  'Emon',
  'Firoza',
  'Nazmul',
];
const LAST_NAMES = ['Islam', 'Hossain', 'Akter', 'Rahman', 'Chowdhury', 'Sarker', 'Mia', 'Begum', 'Uddin', 'Khatun'];
const CITIES = ['Tangail', 'Dhaka', 'Mymensingh', 'Gazipur', 'Jamalpur', 'Bogura', 'Narayanganj'];
const COMPLAINTS = [
  'Toothache on the lower left',
  'Bleeding gums',
  'Sensitivity to cold water',
  'Broken front tooth',
  'Swelling on the right cheek',
  'Routine check-up',
  'Orthodontic consultation',
  'Food stuck between back teeth',
];
const DIAGNOSES = ['Dental caries', 'Chronic gingivitis', 'Pulpitis', 'Pericoronitis', 'Peri-apical abscess'];
const FINDINGS = ['caries', 'filled', 'missing', 'crown', 'root_canal'];
const ANTERIOR_POSITIONS = [1, 2, 3];
function isAnterior(tooth) {
  return ANTERIOR_POSITIONS.includes(Number(String(tooth).slice(1)));
}
function surfacesFor(tooth) {
  return isAnterior(tooth)
    ? [pick(['mesial', 'distal', 'buccal', 'lingual', 'incisal'])]
    : [pick(['mesial', 'distal', 'buccal', 'lingual', 'occlusal'])];
}
const ADULT_TEETH = [
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
];

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------
const bridge = spawn(
  process.execPath,
  [path.join(root, 'node_modules', '.bin', 'vite-node'), '--config', 'vitest.config.ts', 'tools/dev-bridge.mts'],
  {
    cwd: root,
    env: {
      ...process.env,
      DENTIVA_DEV_BRIDGE_PORT: String(port),
      DENTIVA_DEV_DATA: dataDir,
      DENTIVA_TESTING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let bridgeLog = '';
bridge.stdout.on('data', (chunk) => {
  bridgeLog += String(chunk);
});
bridge.stderr.on('data', (chunk) => {
  bridgeLog += String(chunk);
});

function stopBridge() {
  if (!bridge.killed) bridge.kill('SIGTERM');
}
process.on('SIGINT', () => {
  stopBridge();
  process.exit(130);
});

async function waitForBridge(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`The core bridge did not start in ${timeoutMs} ms.\n${bridgeLog}`);
}

async function call(method, payload) {
  const response = await fetch(`${base}/api/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.error.code} — ${result.error.message}`);
  return result.data;
}

const started = Date.now();
const counters = { patients: 0, visits: 0, prescriptions: 0, invoices: 0, payments: 0, appointments: 0, movements: 0, expenses: 0 };

try {
  await waitForBridge();
  console.log(`seed:stress — writing ${targetPatients} patients to ${dataDir}`);

  // --- Activation & the one-time wizard ------------------------------------
  let bootstrap = await call('app.bootstrap');
  if (bootstrap.state === 'activation_required') {
    await call('activation.activate', { code: ACTIVATION_CODE });
    bootstrap = await call('app.bootstrap');
    console.log('  activated this installation');
  }
  if (bootstrap.state === 'setup_required' || bootstrap.state === 'activation_required') {
    await call('setup.saveClinic', {
      name: 'Stress Test Dental College Hospital',
      address: '88 Load Road, Tangail',
      phone: '+880 1700 123456',
      email: 'stress@example.com',
      website: '',
      registrationNumber: '',
      clinicMessage: '',
      visitingHours: 'Sat–Thu, 9 am – 9 pm',
    });
    await call('setup.saveDentists', {
      dentists: [
        {
          name: 'Dr Stress One',
          phone: phone(),
          email: '',
          registrationNumber: 'BDS-STRESS-1',
          visitingHours: 'Sat–Thu, 9 am – 9 pm',
          isActive: true,
          isDefault: true,
          credentials: [
            {
              id: null,
              type: 'qualification',
              title: 'BDS, DDS',
              institution: 'Dhaka Dental College',
              year: 2008,
              sortOrder: 10,
              showOnPrescription: true,
            },
            {
              id: null,
              type: 'designation',
              title: 'Chief Consultant',
              institution: 'Stress Test Dental',
              year: null,
              sortOrder: 20,
              showOnPrescription: true,
            },
          ],
        },
        {
          name: 'Dr Stress Two',
          phone: phone(),
          email: '',
          registrationNumber: 'BDS-STRESS-2',
          visitingHours: 'Sun–Fri, 4 pm – 9 pm',
          isActive: true,
          isDefault: false,
          credentials: [
            {
              id: null,
              type: 'qualification',
              title: 'BDS, FCPS (Orthodontics)',
              institution: 'BSMMU',
              year: 2014,
              sortOrder: 10,
              showOnPrescription: true,
            },
          ],
        },
      ],
    });
    await call('setup.savePreferences', {
      dateFormat: 'DD MMM YYYY',
      timeFormat: 'hh:mm A',
      timeZone: 'Asia/Dhaka',
      numberGrouping: 'international',
      autoLockMinutes: 10,
      backupFolder: '',
      backupIntervalDays: 7,
      defaultPrinterName: '',
    });
    await call('setup.createAdministrator', { username: OWNER.username, fullName: 'Stress Owner', password: OWNER.password });
    await call('setup.complete');
    console.log('  ran the setup wizard');
  }

  await call('auth.login', { username: OWNER.username, password: OWNER.password });

  // --- Master data ---------------------------------------------------------
  const dentists = await call('dentists.list', { includeInactive: false });
  if (dentists.length === 0) throw new Error('No dentist is available; finish the setup wizard or add a dentist first.');
  const treatments = (await call('resource.list', { resource: 'treatments', query: { page: 1, pageSize: 200 } })).items;
  const medications = (await call('resource.list', { resource: 'medications', query: { page: 1, pageSize: 50 } })).items;
  const methods = (await call('resource.list', { resource: 'payment-methods', query: { page: 1, pageSize: 20 } })).items;
  const categories = (await call('resource.list', { resource: 'accounting-categories', query: { page: 1, pageSize: 40 } })).items;
  const inventory = (await call('inventory.items.list', { page: 1, pageSize: 50 })).items;
  const expenseCategory = categories.find((category) => category.direction === 'expense') ?? categories[0];
  if (treatments.length === 0) throw new Error('The treatment catalogue is empty.');

  // --- Patients, visits, prescriptions, invoices ---------------------------
  const batchLog = Math.max(25, Math.floor(targetPatients / 10));
  for (let index = 0; index < targetPatients; index += 1) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const gender = chance(0.55) ? 'female' : 'male';
    const patient = await call('patients.create', {
      input: {
        firstName: first,
        lastName: last,
        gender,
        dob: isoDate(Math.floor(365 * (5 + random() * 65))),
        ageYears: null,
        bloodGroup: pick(['A+', 'B+', 'O+', 'AB+', 'A-', 'unknown']),
        phone: phone(),
        alternatePhone: '',
        email: '',
        address: `${Math.floor(1 + random() * 200)} ${pick(['Road', 'Lane', 'Bazar', 'Para'])}, ${pick(CITIES)}`,
        city: pick(CITIES),
        emergencyContactName: '',
        emergencyPhone: '',
        chiefComplaint: pick(COMPLAINTS),
        previousProblems: '',
        medicalNotes: chance(0.1) ? 'Hypertension, on medication' : '',
        allergies: chance(0.08) ? 'Penicillin' : '',
        notes: '',
        preferredContact: 'mobile',
        status: 'active',
        referredBy: chance(0.12) ? 'Referred by a former patient' : '',
        tagIds: [],
      },
    });
    counters.patients += 1;

    const visitCount = chance(0.15) ? 0 : 1 + Math.floor(random() * 3);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const daysAgo = Math.floor(random() * 720);
      const date = isoDate(daysAgo);
      const dentist = pick(dentists);
      const treatment = pick(treatments);
      const tooth = pick(ADULT_TEETH);
      const hour = 9 + Math.floor(random() * 10);

      const visit = await call('visits.create', {
        input: {
          patientId: patient.id,
          dentistId: dentist.id,
          visitDate: date,
          visitTime: `${String(hour).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`,
          chiefComplaint: pick(COMPLAINTS),
          history: '',
          examination: 'Caries noted, gingiva mildly inflamed',
          diagnosis: pick(DIAGNOSES),
          ccOptions: [],
          oeOptions: [],
          reOptions: [],
          adviceOptions: [],
          advice: 'Maintain oral hygiene, review in two weeks',
          notes: '',
          followUpDate: null,
          dentalFindings: [
            {
              toothFdi: String(tooth),
              finding: pick(FINDINGS),
              surfaces: surfacesFor(tooth),
              mobilityGrade: 0,
              note: '',
            },
          ],
          treatments: [
            {
              treatmentId: treatment.id,
              treatmentRecordId: null,
              description: treatment.name,
              toothCodes: [String(tooth)],
              quantity: 1,
              unitPricePaisa: treatment.pricePaisa,
              discountPaisa: 0,
              notes: '',
            },
          ],
          prescriptionId: null,
        },
      });
      counters.visits += 1;

      if (chance(0.7) && medications.length > 0) {
        const medication = pick(medications);
        await call('prescriptions.create', {
          input: {
            patientId: patient.id,
            dentistId: dentist.id,
            visitId: visit.id,
            date,
            cc: [pick(COMPLAINTS)],
            oe: ['Deep caries, tender on percussion'],
            re: [pick(DIAGNOSES)],
            advice: ['Avoid hot and cold food', 'Return if pain increases'],
            notes: '',
            items: [
              {
                medicationId: medication.id,
                name: medication.name,
                form: medication.form,
                strength: medication.strength,
                doseMorning: 1,
                doseNoon: 1,
                doseNight: 1,
                foodTiming: 'after_food',
                durationDays: 5,
                quantity: null,
                instructions: 'Complete the full course',
                sortOrder: 1,
              },
            ],
          },
        });
        counters.prescriptions += 1;
      }

      if (chance(0.85)) {
        const quantity = 1 + Math.floor(random() * 2);
        const discountPercent = chance(0.2) ? 5 : 0;
        const invoice = await call('invoices.create', {
          input: {
            patientId: patient.id,
            visitId: visit.id,
            dentistId: dentist.id,
            date,
            notes: '',
            discountType: discountPercent > 0 ? 'percent' : 'none',
            discountValue: discountPercent,
            items: [
              {
                treatmentId: treatment.id,
                treatmentRecordId: null,
                code: treatment.code,
                description: treatment.name,
                toothCodes: [String(tooth)],
                quantity,
                unitPricePaisa: treatment.pricePaisa,
                discountType: 'none',
                discountValue: 0,
                sortOrder: 1,
              },
            ],
          },
        });
        counters.invoices += 1;

        const detail = await call('invoices.get', { id: invoice.id });
        const roll = random();
        const paid = roll < 0.7 ? detail.totalPaisa : roll < 0.85 ? Math.round(detail.totalPaisa / 2) : 0;
        if (paid > 0 && methods.length > 0) {
          const method = pick(methods);
          await call('payments.create', {
            input: {
              invoiceId: invoice.id,
              amountPaisa: paid,
              methodId: method.id,
              reference: method.requiresReference ? `REF-${Math.floor(random() * 900000 + 100000)}` : '',
              note: '',
            },
          });
          counters.payments += 1;
        }
      }
    }

    if (index > 0 && index % batchLog === 0) {
      console.log(`  ${index}/${targetPatients} patients · ${counters.visits} visits · ${counters.invoices} invoices`);
    }
  }

  // --- Today's appointments and the live queue -----------------------------
  const recent = await call('patients.list', { page: 1, pageSize: 12, preset: 'all' });
  for (let index = 0; index < 12 && recent.items.length > 0; index += 1) {
    const patient = recent.items[index % recent.items.length];
    const dentist = pick(dentists);
    const hour = 9 + index;
    const status = pick(['scheduled', 'confirmed', 'scheduled']);
    const appointment = await call('appointments.create', {
      input: {
        patientId: patient.id,
        dentistId: dentist.id,
        date: isoDate(0),
        startTime: `${String(hour).padStart(2, '0')}:00`,
        endTime: `${String(hour).padStart(2, '0')}:30`,
        reason: pick(COMPLAINTS),
        notes: '',
        status,
        reminderNote: '',
      },
    });
    counters.appointments += 1;
    if (index < 5 && status === 'confirmed') {
      // Marking a patient as arrived may already place them in the queue, so a
      // duplicate token is expected rather than an error.
      await call('appointments.setStatus', { id: appointment.id, status: 'arrived' });
      try {
        await call('queue.add', {
          input: { patientId: patient.id, dentistId: dentist.id, appointmentId: appointment.id, priority: 'normal', notes: '' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/CONFLICT/.test(message)) throw error;
      }
    }
  }
  console.log(`  ${counters.appointments} appointments booked for today`);

  // --- Stock: a small consumable cupboard, then usage ----------------------
  if (inventory.length === 0) {
    const inventoryCategories = (await call('resource.list', { resource: 'inventory-categories', query: { page: 1, pageSize: 20 } })).items;
    const itemsToCreate = [
      ['Articaine 4% ampoule', 'syringe', 3_500_000, 6_000, 2_000],
      ['Composite resin A2', 'syringe', 1_850_000, 4_000, 1_000],
      ['Sodium hypochlorite 3%', 'bottle', 320_000, 8_000, 2_000],
      ['Latex gloves (M)', 'box', 480_000, 12_000, 4_000],
      ['Endodontic file set', 'set', 2_650_000, 3_000, 1_000],
      ['Sterilisation pouch', 'pack', 240_000, 20_000, 5_000],
    ];
    for (const [name, unit, pricePaisa, openingMilli, minimumMilli] of itemsToCreate) {
      await call('inventory.items.save', {
        input: {
          code: `STR-${name.slice(0, 3).toUpperCase()}-${Math.floor(random() * 900 + 100)}`,
          name,
          categoryId: inventoryCategories.length > 0 ? pick(inventoryCategories).id : null,
          supplierId: null,
          unit,
          purchasePricePaisa: pricePaisa,
          sellingPricePaisa: null,
          minimumStockMilli: minimumMilli,
          reorderLevelMilli: minimumMilli * 2,
          batchNumber: '',
          expiryDate: null,
          purchaseDate: isoDate(Math.floor(random() * 120)),
          storageLocation: 'Store room',
          notes: '',
          isActive: true,
        },
        openingStockMilli: openingMilli,
      });
    }
    inventory.push(...(await call('inventory.items.list', { page: 1, pageSize: 50 })).items);
  }

  for (const item of inventory.slice(0, 20)) {
    const takeMilli = Math.min(item.currentStockMilli, 1000 * (1 + Math.floor(random() * 4)));
    if (takeMilli <= 0) continue;
    await call('inventory.movements.create', {
      input: {
        itemId: item.id,
        type: 'consumption',
        quantityMilli: takeMilli,
        unitCostPaisa: item.purchasePricePaisa,
        reason: 'Consumed during treatment',
        reference: '',
      },
    });
    counters.movements += 1;
  }

  // --- A few clinic expenses so the daybook is not empty -------------------
  if (expenseCategory) {
    const expenses = [
      ['Electricity bill', 420_000],
      ['Staff salary advance', 1_500_000],
      ['Instrument sterilisation supplies', 265_000],
      ['Internet bill', 120_000],
    ];
    for (const [note, amountPaisa] of expenses) {
      await call('accounting.transactions.create', {
        input: {
          direction: 'expense',
          date: isoDate(Math.floor(random() * 20)),
          categoryId: expenseCategory.id,
          amountPaisa,
          paymentMethodId: methods.length > 0 ? pick(methods).id : null,
          reference: '',
          note,
        },
      });
      counters.expenses += 1;
    }
  }

  const summary = await call('system.dataSummary');
  console.log('');
  console.log('seed:stress — finished');
  console.log(`  patients      ${summary.patients}`);
  console.log(`  visits        ${summary.visits}`);
  console.log(`  prescriptions ${summary.prescriptions}`);
  console.log(`  invoices      ${summary.invoices}`);
  console.log(`  payments      ${summary.payments}`);
  console.log(`  appointments  ${summary.appointments}`);
  console.log(`  stock moves   ${summary.stockMovements}`);
  console.log(`  expenses      ${summary.accountingTransactions}`);
  console.log(`  database      ${(summary.databaseSizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  elapsed       ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (keep) console.log(`  data kept in  ${dataDir}`);
} catch (error) {
  console.error(`\nseed:stress failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('--- core bridge output ---');
  console.error(bridgeLog.trim());
  process.exitCode = 1;
} finally {
  stopBridge();
  if (!keep && !process.env['DENTIVA_DEV_DATA']) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
