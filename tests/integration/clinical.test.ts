/**
 * The clinical half of the application: patients, dentists, visits, the dental
 * chart, prescriptions, treatment plans, referrals, appointments and the queue.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayIso } from '@shared/dates';
import { createPatient, createTestApp, type TestApp } from './harness';

let test: TestApp;
let dentistId: number;

beforeEach(async () => {
  test = createTestApp();
  const ownerId = await test.bootstrapOwner({ username: 'owner', password: 'OwnerPass123' });
  test.signIn(ownerId);
  const saved = await test.services.dentists.save(null, {
    name: 'Dr. Shohan Khan',
    phone: '01711000000',
    email: '',
    registrationNumber: 'BMDC-12345',
    visitingHours: '10:00 - 20:00',
    isActive: true,
    isDefault: true,
    credentials: [
      {
        type: 'qualification',
        title: 'BDS',
        institution: 'Dhaka Dental College',
        year: 2015,
        sortOrder: 1,
        showOnPrescription: true,
      },
      {
        type: 'certification',
        title: 'Certified implantologist',
        institution: 'Bangladesh Dental Society',
        year: 2019,
        sortOrder: 2,
        showOnPrescription: true,
      },
    ],
  });
  dentistId = saved.id;
});

afterEach(() => {
  test?.cleanup();
});

describe('patients', () => {
  it('registers patients with sequential codes and finds them again', () => {
    const first = createPatient(test);
    const second = createPatient(test, { firstName: 'Rahim', lastName: 'Uddin', phone: '01812345678' });

    expect(first.code).toBe('P-000001');
    expect(second.code).toBe('P-000002');

    const page = test.services.patients.list({page: 1, pageSize: 25});
    expect(page.total).toBe(2);
    expect(page.items[0]?.code).toBe('P-000002');

    const found = test.services.patients.list({ page: 1, pageSize: 25, search: 'Rahim' });
    expect(found.total).toBe(1);
    expect(found.items[0]?.name).toContain('Rahim');

    // FTS-backed quick search must also match on the patient code.
    const quick = test.services.patients.quickSearch('P-000001');
    expect(quick.some((row) => row.id === first.id)).toBe(true);
  });

  it('honours the date-range filter and newer-first default order', () => {
    const older = createPatient(test, { firstName: 'Old' });
    test.setNow(new Date(Date.now() + 86_400_000));
    const newer = createPatient(test, { firstName: 'New' });

    const page = test.services.patients.list({ page: 1, pageSize: 25 });
    expect(page.items[0]?.id).toBe(newer.id);

    // `older` was registered "today"; `newer` was registered a day later, so a
    // range limited to today must only return the first patient.
    const today = todayIso();
    const ranged = test.services.patients.list({ page: 1, pageSize: 25, from: today, to: today });
    expect(ranged.items.map((row) => row.id)).toEqual([older.id]);
  });

  it('keeps medical notes behind the medical permission', async () => {
    const patient = createPatient(test, { allergies: 'Penicillin' });
    expect(test.services.patients.get(patient.id).allergies).toBe('Penicillin');

    const { users } = test.services;
    const receptionistRole = users.roleIdByKey('receptionist') as number;
    const receptionist = await users.create({
      username: 'frontdesk',
      fullName: 'Front Desk',
      email: '',
      phone: '',
      isActive: true,
      mustChangePassword: false,
      roleIds: [receptionistRole],
      password: 'FrontDesk123',
    });

    test.container.session.end();
    test.signIn(receptionist.id);
    const detail = test.services.patients.get(patient.id);
    expect(detail.allergies).toBe('');
    expect(detail.hasMedicalAlerts).toBe(false);
    expect(() => test.services.patients.assertMedicalAccess()).toThrowError(/permission/i);

    // Saving the record must not blank the medical fields the user cannot see.
    test.services.patients.update(patient.id, {
      firstName: 'Test',
      lastName: 'Patient',
      gender: 'male',
      dob: null,
      ageYears: 30,
      bloodGroup: 'unknown',
      phone: '01900000000',
      alternatePhone: '',
      email: '',
      address: 'Tangail',
      city: 'Tangail',
      emergencyContactName: '',
      emergencyPhone: '',
      chiefComplaint: '',
      previousProblems: '',
      medicalNotes: '',
      allergies: '',
      notes: '',
      preferredContact: 'mobile',
      status: 'active',
      referredBy: '',
      tagIds: [],
    });
    test.container.session.end();
    test.signIn(1);
    expect(test.services.patients.get(patient.id).allergies).toBe('Penicillin');
  });
});

describe('visits and the dental chart', () => {
  it('records a visit with treatment lines and chart findings', () => {
    const patient = createPatient(test);
    const today = todayIso();
    const { visits, dental } = test.services;

    const visit = visits.create({
      patientId: patient.id,
      dentistId,
      visitDate: today,
      visitTime: '10:30',
      chiefComplaint: 'Pain in upper right molar',
      history: 'Pain for three days',
      examination: 'Deep caries in 16',
      diagnosis: 'Irreversible pulpitis 16',
      ccOptions: ['Pain'],
      oeOptions: ['Caries'],
      reOptions: [],
      adviceOptions: ['Soft diet advised'],
      advice: 'Root canal treatment advised',
      notes: '',
      followUpDate: null,
      treatments: [
        {
          treatmentId: null,
          code: 'CONS',
          description: 'Consultation',
          toothCodes: [],
          quantity: 1,
          unitPricePaisa: 50_000,
          discountPaisa: 0,
          notes: '',
        },
      ],
      dentalFindings: [
        { toothFdi: '16', finding: 'caries', surfaces: ['occlusal', 'distal'], mobilityGrade: 0, note: 'Deep cavity' },
      ],
      prescriptionId: null,
    });

    const detail = visits.get(visit.id);
    expect(detail.patientId).toBe(patient.id);
    expect(detail.treatments).toHaveLength(1);
    expect(detail.treatments[0]?.description).toBe('Consultation');

    const chart = dental.getChart({ patientId: patient.id });
    expect(chart.findings.some((finding) => finding.toothFdi === '16' && finding.finding === 'caries')).toBe(true);

    const history = dental.history(patient.id, '16');
    expect(history).toHaveLength(1);
    expect(history[0]?.surfaces.slice().sort()).toEqual(['distal', 'occlusal']);
  });

  it('replaces findings for the same tooth instead of duplicating them', () => {
    const patient = createPatient(test);
    const today = todayIso();
    const { visits, dental } = test.services;

    const makeVisit = (finding: 'caries' | 'filled'): number =>
      visits.create({
        patientId: patient.id,
        dentistId,
        visitDate: today,
        visitTime: '11:00',
        chiefComplaint: '',
        history: '',
        examination: '',
        diagnosis: '',
        ccOptions: [],
        oeOptions: [],
        reOptions: [],
        adviceOptions: [],
        advice: '',
        notes: '',
        followUpDate: null,
        treatments: [],
        dentalFindings: [{ toothFdi: '26', finding, surfaces: ['occlusal'], mobilityGrade: 0, note: '' }],
        prescriptionId: null,
      }).id;

    makeVisit('caries');
    makeVisit('filled');

    const active = dental.getChart({ patientId: patient.id }).findings.filter((row) => row.toothFdi === '26');
    expect(active).toHaveLength(1);
    expect(active[0]?.finding).toBe('filled');
    // Both versions remain in the history — clinical records are never erased.
    expect(dental.history(patient.id, '26')).toHaveLength(2);
  });

  it('stores periodontal depths and refuses impossible values', () => {
    const patient = createPatient(test);
    const { dental } = test.services;
    const chart = dental.savePerio({
      patientId: patient.id,
      records: [
        { toothFdi: '11', site: 'mb', depthMm: 3 },
        { toothFdi: '11', site: 'b', depthMm: 15 },
      ],
    });
    expect(chart.perio.filter((row) => row.toothFdi === '11')).toHaveLength(2);
    expect(() => dental.savePerio({ patientId: patient.id, records: [{ toothFdi: '11', site: 'mb', depthMm: 22 }] })).toThrowError(
      /depth|0|15/i,
    );
  });

  it('rejects an unknown tooth number', () => {
    const patient = createPatient(test);
    expect(() =>
      test.services.dental.saveFindings({
        patientId: patient.id,
        dentition: 'permanent',
        findings: [{ toothFdi: '99', finding: 'caries', surfaces: ['occlusal'], mobilityGrade: 0, note: '' }],
      }),
    ).toThrowError();
  });

  it('keeps a visit timeline for the patient', () => {
    const patient = createPatient(test);
    const today = todayIso();
    test.services.visits.create({
      patientId: patient.id,
      dentistId,
      visitDate: today,
      visitTime: '12:00',
      chiefComplaint: 'Check-up',
      history: '',
      examination: '',
      diagnosis: '',
      ccOptions: [],
      oeOptions: [],
      reOptions: [],
      adviceOptions: [],
      advice: '',
      notes: '',
      followUpDate: null,
      treatments: [],
      dentalFindings: [],
      prescriptionId: null,
    });
    const timeline = test.services.patients.timeline(patient.id);
    expect(timeline.some((event) => event.type === 'visit')).toBe(true);
  });
});

describe('prescriptions', () => {
  it('creates a numbered prescription with medications and printable credentials', () => {
    const patient = createPatient(test);
    const today = todayIso();
    const { prescriptions } = test.services;

    const medications = prescriptions.medications({ page: 1, pageSize: 50 });
    const amoxicillin = medications.items.find((row) => row.name === 'Amoxicillin');
    expect(amoxicillin).toBeDefined();

    const created = prescriptions.create({
      patientId: patient.id,
      dentistId,
      visitId: null,
      date: today,
      cc: ['Pain'],
      oe: ['Caries'],
      re: [],
      advice: ['Complete the full antibiotic course'],
      notes: '',
      items: [
        {
          medicationId: amoxicillin?.id ?? null,
          name: 'Amoxicillin',
          form: 'capsule',
          strength: '500 mg',
          doseMorning: 1,
          doseNoon: 0,
          doseNight: 1,
          foodTiming: 'after_food',
          durationDays: 5,
          quantity: 10,
          instructions: '',
          sortOrder: 1,
        },
      ],
    });
    expect(created.number).toMatch(/^RX-\d{4}-000001$/);

    const detail = prescriptions.get(created.id);
    expect(detail.items).toHaveLength(1);
    expect(detail.patientName).toContain('Test');

    const printable = prescriptions.forPrint(created.id);
    expect(printable.dentist?.qualifications).toContain('BDS');
    expect(printable.dentist?.certifications).toContain('Certified implantologist');
    expect(printable.prescription.items[0]?.name).toBe('Amoxicillin');
    expect(printable.clinic.name).toBe('');
  });

  it('voids a prescription with a reason instead of deleting it', () => {
    const patient = createPatient(test);
    const { prescriptions } = test.services;
    const created = prescriptions.create({
      patientId: patient.id,
      dentistId,
      visitId: null,
      date: todayIso(),
      cc: [],
      oe: [],
      re: [],
      advice: [],
      notes: '',
      items: [
        {
          medicationId: null,
          name: 'Paracetamol',
          form: 'tablet',
          strength: '500 mg',
          doseMorning: 1,
          doseNoon: 1,
          doseNight: 1,
          foodTiming: 'after_food',
          durationDays: 3,
          quantity: 9,
          instructions: '',
          sortOrder: 1,
        },
      ],
    });
    expect(() => prescriptions.void(created.id, '')).toThrowError();
    prescriptions.void(created.id, 'Written in error');
    const detail = prescriptions.get(created.id);
    expect(detail.isVoid).toBe(true);
    expect(detail.voidReason).toBe('Written in error');
  });
});

describe('treatment plans and referrals', () => {
  it('creates a plan with items and completes an item', () => {
    const patient = createPatient(test);
    const { treatments } = test.services;
    const plan = treatments.createPlan({ patientId: patient.id, title: 'Full mouth rehabilitation', notes: '', status: 'active' });
    const item = treatments.savePlanItem(plan.id, {
      treatmentId: null,
      description: 'Root canal — 16',
      toothCodes: ['16'],
      sessionNumber: 1,
      estimatedPaisa: 500_000,
      status: 'pending',
      notes: '',
    });
    const loaded = treatments.getPlan(plan.id);
    expect(loaded.items).toHaveLength(1);
    treatments.completePlanItem(item.id, null);
    expect(treatments.getPlan(plan.id).completedItems).toBe(1);
  });

  it('records a referral and lists it by patient', () => {
    const patient = createPatient(test);
    const { referrals } = test.services;
    const created = referrals.save(null, {
      patientId: patient.id,
      visitId: null,
      referralDoctorId: null,
      doctorName: 'Dr. Ortho Consultant',
      specialty: 'Orthodontics',
      organisation: 'Dhaka Dental',
      contact: '01911000000',
      reason: 'Crowding',
      date: todayIso(),
      followUpDate: null,
      status: 'pending',
      notes: '',
    });
    const list = referrals.byPatient(patient.id);
    expect(list.map((row) => row.id)).toContain(created.id);
    expect(list[0]?.doctorName).toBe('Dr. Ortho Consultant');
  });
});

describe('appointments and the queue', () => {
  it('books an appointment, protects the slot and pushes arrival into the queue', () => {
    const patient = createPatient(test);
    const today = todayIso();
    const { appointments, queue } = test.services;

    const created = appointments.create({
      patientId: patient.id,
      dentistId,
      date: today,
      startTime: '15:00',
      endTime: '15:30',
      reason: 'Scaling',
      notes: '',
      status: 'scheduled',
      reminderNote: '',
    });

    // Same dentist, same day, overlapping time → refused.
    expect(() =>
      appointments.create({
        patientId: patient.id,
        dentistId,
        date: today,
        startTime: '15:15',
        endTime: '15:45',
        reason: 'Duplicate',
        notes: '',
        status: 'scheduled',
        reminderNote: '',
      }),
    ).toThrowError();

    appointments.setStatus(created.id, 'arrived');
    const entries = queue.list(today);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patientId).toBe(patient.id);
    expect(entries[0]?.queueLabel).toMatch(/^Q-?0*1$/);

    queue.setStatus(entries[0]!.id, 'in_consultation');
    queue.setStatus(entries[0]!.id, 'completed');
    const stats = queue.statistics(today);
    expect(stats.completed).toBe(1);
  });

  it('cancelling an appointment requires a reason and clears the queue', () => {
    const patient = createPatient(test);
    const today = todayIso();
    const { appointments, queue } = test.services;
    const created = appointments.create({
      patientId: patient.id,
      dentistId,
      date: today,
      startTime: '16:00',
      endTime: '16:30',
      reason: 'Check-up',
      notes: '',
      status: 'scheduled',
      reminderNote: '',
    });
    appointments.setStatus(created.id, 'arrived');
    expect(queue.list(today)).toHaveLength(1);

    expect(() => appointments.setStatus(created.id, 'cancelled')).toThrowError();
    appointments.setStatus(created.id, 'cancelled', 'Patient called to cancel');
    expect(queue.list(today)).toHaveLength(0);
  });
});

describe('statistics', () => {
  it('summarises the day without losing money precision', () => {
    const patient = createPatient(test);
    const today = todayIso();
    test.services.visits.create({
      patientId: patient.id,
      dentistId,
      visitDate: today,
      visitTime: '09:00',
      chiefComplaint: '',
      history: '',
      examination: '',
      diagnosis: '',
      ccOptions: [],
      oeOptions: [],
      reOptions: [],
      adviceOptions: [],
      advice: '',
      notes: '',
      followUpDate: null,
      treatments: [
        {
          treatmentId: null,
          code: 'SCAL',
          description: 'Scaling and polishing',
          toothCodes: [],
          quantity: 1,
          unitPricePaisa: 150_000,
          discountPaisa: 10_000,
          notes: '',
        },
      ],
      dentalFindings: [],
      prescriptionId: null,
    });
    const stats = test.services.visits.statistics({ preset: 'today' });
    expect(stats.total).toBe(1);
    expect(stats.byDentist).toHaveLength(1);
    expect(stats.byDentist[0]?.count).toBe(1);

    // Treatment lines keep exact paisa values (1500.00 − 100.00 = 1400.00 BDT).
    const visit = test.services.visits.list({ page: 1, pageSize: 10 }).items[0];
    const detail = test.services.visits.get(visit!.id);
    expect(detail.treatments[0]?.unitPricePaisa).toBe(150_000);
    expect(detail.treatments[0]?.discountPaisa).toBe(10_000);
  });
});
