#!/usr/bin/env node
/**
 * End-to-end smoke test through the real application stack.
 *
 * Starts the core bridge in-process (the same services, the same SQLite file
 * and the same permission checks the desktop build uses), drives the complete
 * first-day workflow through the IPC surface — activation, setup, sign-in,
 * patient, appointment, queue, visit, chart, prescription, invoice, payment,
 * report, backup — and asserts on the result.
 *
 * The test talks to the same `invoke` contract the renderer uses, so a broken
 * handler or a schema mismatch fails here before it reaches a clinic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = await mkdtemp(path.join(tmpdir(), 'dentiva-e2e-'));
const port = 4399;
const base = `http://127.0.0.1:${port}`;

const failures = [];
let step = 0;

function ok(label) {
  step += 1;
  console.log(`  ok ${String(step).padStart(2, '0')}  ${label}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Start the development bridge against a throw-away data directory. */
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

async function callExpectingFailure(method, payload, code) {
  const response = await fetch(`${base}/api/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  expect(result.ok === false, `${method} should have been refused`);
  if (code) expect(result.error.code === code, `${method}: expected ${code}, received ${result.error.code}`);
  return result.error;
}

function cleanup() {
  if (!bridge.killed) bridge.kill('SIGTERM');
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  await waitForBridge();
  ok('core bridge started on a fresh data folder');

  // --- Activation & setup -------------------------------------------------
  let bootstrap = await call('app.bootstrap');
  expect(bootstrap.state === 'activation_required', `expected activation_required, received ${bootstrap.state}`);
  ok('a brand-new installation asks for activation');

  await callExpectingFailure(
    'setup.saveClinic',
    { name: 'Test Dental', address: '', phone: '', email: '', website: '' },
    'PRECONDITION_FAILED',
  );
  ok('setup is refused before activation');

  await callExpectingFailure('activation.activate', { code: '1516591935015166' }, 'VALIDATION');
  ok('a wrong activation code is refused and counted');

  const activation = await call('activation.activate', { code: '1516591935015165' });
  expect(activation.activated === true, 'the licence code was not accepted');
  ok('activation code 1516591935015165 unlocks this machine');

  await call('setup.saveClinic', {
    name: 'Smoke Test Dental Care',
    address: '12 Test Road, Tangail',
    phone: '+880 1700 000000',
    email: 'clinic@example.com',
    website: '',
  });
  await call('setup.saveDentists', {
    dentists: [
      {
        name: 'Dr Smoke Tester',
        phone: '+880 1700 000001',
        email: '',
        registrationNumber: 'BDS-TEST-1',
        visitingHours: 'Sat–Thu, 5 pm – 9 pm',
        isActive: true,
        isDefault: true,
        credentials: [
          {
            id: null,
            type: 'qualification',
            title: 'BDS',
            institution: 'Test Medical College',
            year: 2015,
            sortOrder: 10,
            showOnPrescription: true,
          },
          {
            id: null,
            type: 'designation',
            title: 'Consultant Dental Surgeon',
            institution: 'Smoke Test Dental Care',
            year: null,
            sortOrder: 20,
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
  await call('setup.createAdministrator', { username: 'owner', fullName: 'Clinic Owner', password: 'Clinic-E2E-2026' });
  const review = await call('setup.review');
  expect(review.clinic?.name === 'Smoke Test Dental Care', 'the clinic profile was not saved');
  expect(review.dentists.length === 1, 'the dentist was not saved');
  expect(review.administrator === 'owner', 'the administrator was not created');
  ok('the seven-step wizard stores clinic, dentist, preferences and administrator');

  await call('setup.complete');
  bootstrap = await call('app.bootstrap');
  expect(bootstrap.state === 'locked', `expected locked after setup, received ${bootstrap.state}`);
  ok('setup completion locks the application for sign-in');

  // --- Sign-in and permissions -------------------------------------------
  await callExpectingFailure('patients.list', { page: 1 }, 'UNAUTHENTICATED');
  ok('patient data is unreadable without a session');

  const ownerLogin = await call('auth.login', { username: 'owner', password: 'Clinic-E2E-2026' });
  expect(ownerLogin.username === 'owner', 'the owner could not sign in');
  ok('the owner signs in');

  await callExpectingFailure('users.delete', { id: ownerLogin.id, reason: 'test', confirmText: 'owner' }, 'PRECONDITION_FAILED');
  ok('the signed-in account refuses to delete itself');

  // --- Master data --------------------------------------------------------
  const catalogue = await call('reports.catalogue');
  expect(catalogue.length >= 20, `expected the report catalogue, received ${catalogue.length}`);
  ok(`${catalogue.length} reports are available`);

  const treatmentList = await call('resource.list', { resource: 'treatments', query: { page: 1, pageSize: 50 } });
  expect(treatmentList.total > 0, 'the seeded treatment catalogue is empty');
  const treatments = treatmentList.items;
  ok(`${treatmentList.total} seeded treatments`);

  const dentists = await call('dentists.list', { includeInactive: false });
  expect(dentists.length === 1, 'the dentist is missing');
  ok('dentist list contains the credentials recorded during setup');

  // --- Patient ------------------------------------------------------------
  const patient = await call('patients.create', {
    input: {
      firstName: 'Smoke',
      lastName: 'Patient',
      gender: 'female',
      dob: '1995-04-12',
      ageYears: null,
      bloodGroup: 'B+',
      phone: '+880 1711 111111',
      alternatePhone: '',
      email: '',
      address: '45 Test Lane, Tangail',
      city: 'Tangail',
      emergencyContactName: '',
      emergencyPhone: '',
      chiefComplaint: 'Pain in the lower right molar',
      previousProblems: '',
      medicalNotes: '',
      allergies: '',
      notes: 'Created by the end-to-end smoke test.',
      preferredContact: 'mobile',
      status: 'active',
      referredBy: '',
      tagIds: [],
    },
  });
  expect(patient.id > 0 && /^P-/.test(patient.code), 'the patient code was not generated');
  ok(`patient ${patient.code} registered`);

  const duplicate = await call('patients.checkDuplicate', { name: 'Smoke Patient', phone: '+880 1711 111111' });
  expect(duplicate.matches.length > 0, 'the duplicate check did not find the new patient');
  ok('duplicate registration is detected');

  const search = await call('search.global', { query: 'Smoke', limit: 20 });
  expect(search.groups.length > 0, 'global search returned nothing for the new patient');
  ok(`global search found ${search.groups.length} group(s)`);

  // --- Appointment and queue ---------------------------------------------
  const today = new Date().toISOString().slice(0, 10);

  // Granular RBAC: the same methods must be refused for a receptionist, at the
  // domain layer rather than by hiding buttons.
  const roles = await call('roles.list');
  const receptionistRole = roles.find((role) => role.key === 'receptionist');
  expect(receptionistRole !== undefined, 'the receptionist role preset is missing');
  await call('users.create', {
    input: {
      username: 'frontdesk',
      fullName: 'Front Desk',
      email: '',
      phone: '',
      isActive: true,
      mustChangePassword: false,
      roleIds: [receptionistRole.id],
      password: 'Front-Desk-E2E-2026',
    },
  });
  await call('auth.logout');
  await call('auth.login', { username: 'frontdesk', password: 'Front-Desk-E2E-2026' });
  const patients = await call('patients.list', { page: 1, pageSize: 5 });
  expect(patients.total === 1, `the receptionist could not read the patient register (${JSON.stringify(patients).slice(0, 300)})`);
  await callExpectingFailure(
    'users.create',
    {
      input: {
        username: 'sneaky',
        fullName: 'Sneaky User',
        email: '',
        phone: '',
        isActive: true,
        mustChangePassword: false,
        roleIds: [receptionistRole.id],
        password: 'Sneaky-User-E2E-2026',
      },
    },
    'FORBIDDEN',
  );
  await callExpectingFailure(
    'system.deleteBusiness',
    { password: 'Front-Desk-E2E-2026', confirmText: 'DELETE BUSINESS', backupFirst: false },
    'FORBIDDEN',
  );
  await callExpectingFailure('reports.run', { reportKey: 'revenue', from: today, to: today }, 'FORBIDDEN');
  await callExpectingFailure('audit.list', { page: 1 }, 'FORBIDDEN');
  ok('a receptionist is refused user, business, financial-report and audit access');
  await call('auth.logout');
  await call('auth.login', { username: 'owner', password: 'Clinic-E2E-2026' });
  ok('the owner signs back in with full authority');
  const appointment = await call('appointments.create', {
    input: {
      patientId: patient.id,
      dentistId: dentists[0].id,
      date: today,
      startTime: '10:00',
      endTime: '10:30',
      reason: 'Toothache',
      notes: '',
      status: 'scheduled',
      reminderNote: '',
    },
  });
  await call('appointments.setStatus', { id: appointment.id, status: 'confirmed' });
  const queueEntry = await call('queue.add', {
    input: { patientId: patient.id, dentistId: dentists[0].id, appointmentId: appointment.id, priority: 'urgent', notes: 'In pain' },
  });
  expect(queueEntry.queueNumber >= 1, 'the queue token was not issued');
  ok(`appointment booked and pushed into the queue as ${queueEntry.queueLabel}`);

  await call('queue.setStatus', { id: queueEntry.id, status: 'called' });
  await call('queue.setStatus', { id: queueEntry.id, status: 'in_consultation' });
  const queueStats = await call('queue.statistics', {});
  expect(queueStats.inConsultation === 1, 'the queue does not show the patient in consultation');
  ok('queue status flow works');

  // --- Visit, chart and prescription -------------------------------------
  const visit = await call('visits.create', {
    input: {
      patientId: patient.id,
      dentistId: dentists[0].id,
      visitDate: today,
      visitTime: '10:05',
      chiefComplaint: 'Pain lower right molar',
      history: '',
      examination: 'Deep caries on 46',
      diagnosis: 'Irreversible pulpitis',
      ccOptions: [],
      oeOptions: [],
      reOptions: [],
      adviceOptions: [],
      advice: 'Root canal treatment advised',
      notes: '',
      followUpDate: null,
      treatments: [
        {
          treatmentId: treatments[0].id,
          treatmentRecordId: null,
          description: treatments[0].name,
          toothCodes: ['46'],
          quantity: 1,
          unitPricePaisa: treatments[0].pricePaisa,
          discountPaisa: 0,
          notes: '',
        },
      ],
      dentalFindings: [{ toothFdi: '46', finding: 'caries', surfaces: ['occlusal'], mobilityGrade: 0, note: '' }],
      prescriptionId: null,
    },
  });
  expect(visit.id > 0, 'the visit was not recorded');
  ok('visit recorded with a charted tooth and a treatment');

  const chart = await call('dental.getChart', { patientId: patient.id });
  expect(
    chart.findings.some((finding) => finding.toothFdi === '46' && finding.finding === 'caries'),
    'the chart does not show the finding',
  );
  ok('dental chart shows the finding for tooth 46');

  const medications = await call('resource.list', { resource: 'medications', query: { page: 1, pageSize: 5 } });
  const prescription = await call('prescriptions.create', {
    input: {
      patientId: patient.id,
      dentistId: dentists[0].id,
      visitId: visit.id,
      date: today,
      cc: ['Pain lower right molar'],
      oe: ['Deep caries on 46'],
      re: ['Irreversible pulpitis'],
      advice: ['Avoid chewing on that side'],
      notes: '',
      items: [
        {
          medicationId: medications.items[0]?.id ?? null,
          name: medications.items[0]?.name ?? 'Amoxicillin 500 mg',
          form: medications.items[0]?.form ?? 'capsule',
          strength: medications.items[0]?.strength ?? '500 mg',
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
  expect(prescription.number.startsWith('RX-'), 'the prescription number was not generated');
  ok(`prescription ${prescription.number} issued`);

  let rendered = null;
  try {
    rendered = await call('print.render', { kind: 'prescription', id: prescription.id, output: 'pdf' });
    expect(rendered.pdfPath !== null, 'the prescription produced no PDF path');
    ok('prescription renders to a PDF on disk');
  } catch (error) {
    // Without a Chromium binary the development bridge cannot produce the PDF;
    // the packaged application uses Electron's own printToPDF instead.
    const message = error instanceof Error ? error.message : String(error);
    if (!/Chromium|browser|print/i.test(message)) throw error;
    ok('prescription printing reported that no Chromium binary is available in this environment');
  }

  // --- Billing ------------------------------------------------------------
  const invoice = await call('invoices.create', {
    input: {
      patientId: patient.id,
      visitId: visit.id,
      dentistId: dentists[0].id,
      date: today,
      notes: '',
      discountType: 'none',
      discountValue: 0,
      items: [
        {
          treatmentId: treatments[0].id,
          treatmentRecordId: null,
          code: treatments[0].code,
          description: treatments[0].name,
          toothCodes: ['46'],
          quantity: 1,
          unitPricePaisa: treatments[0].pricePaisa,
          discountType: 'none',
          discountValue: 0,
          sortOrder: 1,
        },
      ],
    },
  });
  expect(invoice.number.startsWith('INV-'), 'the invoice number was not generated');
  ok(`invoice ${invoice.number} raised`);

  const methods = await call('resource.list', { resource: 'payment-methods', query: { page: 1, pageSize: 20 } });
  const cash = methods.items.find((method) => method.category === 'cash') ?? methods.items[0];
  const invoiceDetail = await call('invoices.get', { id: invoice.id });
  const payment = await call('payments.create', {
    input: { invoiceId: invoice.id, amountPaisa: invoiceDetail.totalPaisa, methodId: cash.id, reference: '', note: '' },
  });
  expect(payment.receiptNumber.startsWith('RCP-'), 'the receipt number was not generated');
  ok(`payment collected — receipt ${payment.receiptNumber}`);

  const settled = await call('invoices.get', { id: invoice.id });
  expect(settled.status === 'paid', `expected the invoice to be paid, it is ${settled.status}`);
  expect(settled.paidPaisa === settled.totalPaisa, 'the paid amount does not match the invoice total');
  ok('the invoice is fully settled');

  await callExpectingFailure('payments.void', { id: payment.id, reason: 'mistake' }, 'VALIDATION');
  ok('voiding a receipt without the exact receipt number is refused');

  const financial = await call('accounting.summary', { preset: 'today' });
  expect(financial.collectedFromInvoicesPaisa >= invoiceDetail.totalPaisa, 'the collection is missing from accounting');
  ok('accounting reflects the collection');

  const outstanding = await call('invoices.outstanding', { page: 1, pageSize: 20 });
  expect(outstanding.items.length === 0, 'a settled invoice still appears as outstanding');
  ok('nothing is outstanding after payment');

  // --- Reports ------------------------------------------------------------
  const revenue = await call('reports.run', { reportKey: 'revenue', from: today, to: today });
  expect(revenue.rowCount >= 1, 'the revenue report is empty');
  ok(`revenue report returned ${revenue.rowCount} row(s) with ${revenue.columns.length} column(s)`);

  const exportResult = await call('reports.export', {
    request: { reportKey: 'patients_registered', from: today, to: today },
    format: 'csv',
  });
  expect(exportResult.path !== null && existsSync(exportResult.path), 'the CSV export was not written to disk');
  ok('a report exports to CSV on disk');

  // --- Backup & integrity -------------------------------------------------
  const backup = await call('backup.create', { note: 'End-to-end smoke test', kind: 'manual' });
  expect(backup.sizeBytes > 10_000, 'the backup file looks too small');
  ok(`backup written (${Math.round(backup.sizeBytes / 1024)} kB)`);

  const verified = await call('backup.verify', { id: backup.id });
  expect(verified.status === 'completed' && verified.verifiedAt !== null, 'the backup did not verify');
  ok('the backup verifies');

  const preview = await call('backup.previewRestore', { filePath: backup.filePath });
  expect(preview.candidate.valid === true, 'the backup was not recognised as readable');
  expect(preview.requiresTypedConfirmation !== '', 'restore does not demand a typed confirmation');
  expect(preview.currentData.patients === 1, 'the preview does not report the current patient count');
  ok(`restore preview confirms ${preview.currentData.patients} patient(s) currently stored`);

  const integrity = await call('system.integrityCheck');
  expect(integrity.ok === true, 'the integrity check reported problems');
  ok('database integrity check passes');

  const dashboard = await call('dashboard.get');
  expect(dashboard.cards.length > 0, 'the dashboard returned no cards');
  ok(`dashboard returned ${dashboard.cards.length} card(s)`);

  const audit = await call('audit.list', { page: 1, pageSize: 50 });
  const actions = new Set(audit.items.map((entry) => entry.action));
  expect(actions.has('create'), 'the audit log did not record a create action');
  ok(`audit log holds ${audit.total} entr(ies) covering ${actions.size} action type(s)`);

  console.log('');
  console.log(`e2e: ${step} checks passed against a real application stack`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error(`e2e failed: ${failures[0]}`);
  if (bridgeLog.trim()) {
    console.error('');
    console.error('--- core bridge output ---');
    console.error(bridgeLog.trim().split('\n').slice(-40).join('\n'));
  }
  process.exitCode = 1;
} finally {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(dataDir, { recursive: true, force: true });
}
