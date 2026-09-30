/**
 * Patient register and patient profile.
 *
 * Financial and medical fields are filtered per permission: a receptionist who
 * may not see balances receives `outstandingPaisa: null` and no medical notes,
 * and that filtering happens here — not in the UI.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, hasPermission, requirePermission } from '../context';
import type {
  Paged,
  PatientDetail,
  PatientFinancialSummary,
  PatientInput,
  PatientListQuery,
  PatientSummary,
  PatientTag,
  TimelineEvent,
  TimelineEventType,
} from '@shared/types';
import type { BloodGroup, Gender, PatientStatus, PreferredContact } from '@shared/constants';
import { AppError } from '@shared/errors';
import { ageText, resolveDateRange, todayIso } from '@shared/dates';
import { asNumber, buildWhere, ftsQuery, likeTerm, pageCount, paginate, parseJsonArray } from '../db/sql';
import { nextPatientCode } from '../util/ids';

interface PatientRow {
  id: number;
  code: string;
  first_name: string;
  last_name: string;
  gender: string;
  dob: string | null;
  age_years: number | null;
  blood_group: string;
  phone: string;
  alternate_phone: string;
  email: string;
  address: string;
  city: string;
  emergency_contact_name: string;
  emergency_phone: string;
  chief_complaint: string;
  previous_problems: string;
  medical_notes: string;
  allergies: string;
  notes: string;
  preferred_contact: string;
  status: string;
  referred_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  visit_count?: number;
  last_visit_date?: string | null;
  outstanding_paisa?: number;
  open_plans?: number;
  last_appointment_date?: string | null;
}

const LIST_SELECT =
  `
  SELECT p.id, p.code, p.first_name, p.last_name, p.gender, p.dob, p.age_years, p.blood_group, p.phone,
         p.alternate_phone, p.status, p.referred_by, p.created_at, p.updated_at, p.deleted_at,
         (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS visit_count,
         (SELECT MAX(v.visit_date) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS last_visit_date,
         (SELECT MAX(a.date) FROM appointments a WHERE a.patient_id = p.id AND a.deleted_at IS NULL) AS last_appointment_date,
         (SELECT COUNT(*) FROM treatment_plans tp WHERE tp.patient_id =` +
  ` p.id AND tp.deleted_at IS NULL AND tp.status = 'active') AS open_plans,
         COALESCE((
           SELECT SUM(i.total_paisa - i.paid_paisa) FROM invoices i
            WHERE i.patient_id = p.id AND i.deleted_at IS NULL AND i.is_void = 0 AND i.total_paisa > i.paid_paisa
         ), 0) AS outstanding_paisa
    FROM patients p
`;

/** Text for a value read out of an untyped database row (never “object Object”). */
function textValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return fallback;
}

function fullName(first: string, last: string): string {
  return `${first} ${last}`.trim();
}

export class PatientService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private canSeeFinancials(): boolean {
    return hasPermission(this.context(), 'invoice.view') || hasPermission(this.context(), 'report.financial.view');
  }

  /**
   * Medical notes, allergies and previous problems are sensitive: they are
   * only readable with `patient.medical.view`, and the update path refuses to
   * overwrite them without it (so a user who never saw the values cannot wipe
   * them by saving the rest of the form).
   */
  private canSeeMedical(): boolean {
    return hasPermission(this.context(), 'patient.medical.view');
  }

  // --- Queries ------------------------------------------------------------

  list(query: PatientListQuery): Paged<PatientSummary> {
    requirePermission(this.context(), 'patient.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const params: unknown[] = [];
    const clauses: Array<string | null> = [];

    if (!query.includeDeleted) clauses.push('p.deleted_at IS NULL');

    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    let from = query.from;
    let to = query.to;
    if (preset) {
      const range = resolveDateRange(preset, { custom: { from: query.from, to: query.to } });
      from = range.from;
      to = range.to;
    }
    if (from) {
      clauses.push('substr(p.created_at, 1, 10) >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('substr(p.created_at, 1, 10) <= ?');
      params.push(to);
    }
    if (query.status && query.status.length > 0) {
      clauses.push(`p.status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    if (query.gender && query.gender.length > 0) {
      clauses.push(`p.gender IN (${query.gender.map(() => '?').join(', ')})`);
      params.push(...query.gender);
    }
    if (query.bloodGroup && query.bloodGroup.length > 0) {
      clauses.push(`p.blood_group IN (${query.bloodGroup.map(() => '?').join(', ')})`);
      params.push(...query.bloodGroup);
    }
    if (query.tagIds && query.tagIds.length > 0) {
      clauses.push(`p.id IN (SELECT patient_id FROM patient_tag_links WHERE tag_id IN (${query.tagIds.map(() => '?').join(', ')}))`);
      params.push(...query.tagIds);
    }
    if (query.hasMedicalAlert) {
      clauses.push(`(trim(p.allergies) <> '' OR trim(p.medical_notes) <> '' OR trim(p.previous_problems) <> '')`);
    }
    if (query.hasOutstanding) {
      clauses.push(
        `EXISTS (SELECT 1 FROM invoices i WHERE i.patient_id = p.id AND` +
          ` i.deleted_at IS NULL AND i.is_void = 0 AND i.total_paisa > i.paid_paisa)`,
      );
    }

    const search = query.search?.trim() ?? '';
    if (search !== '') {
      const term = likeTerm(search);
      clauses.push(`(
        p.code LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.phone LIKE ? ESCAPE '\\'
        OR p.alternate_phone LIKE ? ESCAPE '\\'
        OR p.address LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.city LIKE ? ESCAPE '\\' COLLATE NOCASE
      )`);
      params.push(term, term, term, term, term, term, term);
    }

    const where = buildWhere(clauses);
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM patients p${where}`).get(...params) as { total: number }).total);

    const sortMap: Record<string, string> = {
      name: 'lower(p.first_name)',
      code: 'p.code',
      registered: 'p.created_at',
      lastVisit: 'last_visit_date',
      outstanding: 'outstanding_paisa',
      status: 'p.status',
    };
    const sortColumn = sortMap[query.sort ?? 'registered'] ?? 'p.created_at';
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';

    const rows = this.db
      .prepare(`${LIST_SELECT}${where} ORDER BY ${sortColumn} ${direction}, p.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as PatientRow[];

    const tagMap = this.tagsByPatient(rows.map((row) => row.id));

    return {
      items: rows.map((row) => this.toSummary(row, tagMap.get(row.id) ?? [])),
      total,
      page,
      pageSize,
      pageCount: pageCount(total, pageSize),
    };
  }

  private toSummary(row: PatientRow, tags: string[]): PatientSummary {
    const showFinancials = this.canSeeFinancials();
    return {
      id: row.id,
      code: row.code,
      name: fullName(row.first_name, row.last_name),
      gender: row.gender as Gender,
      ageYears: row.age_years,
      ageText: ageText({ dob: row.dob, age: row.age_years }),
      dob: row.dob,
      phone: row.phone,
      bloodGroup: row.blood_group as BloodGroup,
      status: row.status as PatientStatus,
      tags,
      registeredAt: row.created_at.slice(0, 10),
      lastVisitDate: row.last_visit_date ?? null,
      visitCount: asNumber(row.visit_count),
      referredBy: row.referred_by,
      outstandingPaisa: showFinancials ? asNumber(row.outstanding_paisa) : null,
    };
  }

  private tagsByPatient(patientIds: readonly number[]): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (patientIds.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT l.patient_id, t.name
           FROM patient_tag_links l JOIN patient_tags t ON t.id = l.tag_id
          WHERE l.patient_id IN (${patientIds.map(() => '?').join(', ')}) AND t.deleted_at IS NULL
          ORDER BY t.name`,
      )
      .all(...patientIds) as Array<{ patient_id: number; name: string }>;
    for (const row of rows) {
      const list = map.get(row.patient_id) ?? [];
      list.push(row.name);
      map.set(row.patient_id, list);
    }
    return map;
  }

  get(id: number): PatientDetail {
    requirePermission(this.context(), 'patient.view');
    const row = this.db.prepare(`${LIST_SELECT} WHERE p.id = ?`).get(id) as PatientRow | undefined;
    if (!row) throw AppError.notFound('Patient');
    const detail = this.db.prepare(`SELECT * FROM patients WHERE id = ?`).get(id) as
      | (PatientRow & {
          emergency_contact_name: string;
          emergency_phone: string;
          chief_complaint: string;
          previous_problems: string;
          medical_notes: string;
          allergies: string;
          notes: string;
          email?: string;
          address?: string;
          city?: string;
          preferred_contact?: string;
        })
      | undefined;
    if (!detail) throw AppError.notFound('Patient');
    const tags = this.tagsByPatient([id]).get(id) ?? [];
    const contacts = this.db
      .prepare(
        `SELECT id, patient_id, type, name, relation, value, is_primary FROM` +
          ` patient_contacts WHERE patient_id = ? ORDER BY is_primary DESC, id`,
      )
      .all(id) as Array<{
      id: number;
      patient_id: number;
      type: string;
      name: string;
      relation: string;
      value: string;
      is_primary: number;
    }>;
    const medicalVisible = this.canSeeMedical();
    const summary = this.toSummary(row, tags);
    return {
      ...summary,
      firstName: detail.first_name,
      lastName: detail.last_name,
      alternatePhone: detail.alternate_phone,
      email: detail.email ?? '',
      address: detail.address ?? '',
      city: detail.city ?? '',
      emergencyContactName: detail.emergency_contact_name,
      emergencyPhone: detail.emergency_phone,
      chiefComplaint: medicalVisible ? detail.chief_complaint : '',
      previousProblems: medicalVisible ? detail.previous_problems : '',
      medicalNotes: medicalVisible ? detail.medical_notes : '',
      allergies: medicalVisible ? detail.allergies : '',
      notes: detail.notes,
      preferredContact: (detail.preferred_contact ?? 'mobile') as PreferredContact,
      contacts: contacts.map((contact) => ({
        id: contact.id,
        patientId: contact.patient_id,
        type: contact.type as 'alternate_phone' | 'phone' | 'email' | 'emergency' | 'guardian',
        name: contact.name,
        relation: contact.relation,
        value: contact.value,
        isPrimary: contact.is_primary === 1,
      })),
      createdAt: detail.created_at,
      updatedAt: detail.updated_at,
      hasMedicalAlerts: medicalVisible && (detail.allergies.trim() !== '' || detail.previous_problems.trim() !== ''),
      openTreatmentPlanCount: asNumber(row.open_plans),
      lastAppointmentDate: row.last_appointment_date ?? null,
      deletedAt: detail.deleted_at ?? null,
    };
  }

  // --- Mutations ----------------------------------------------------------

  create(input: PatientInput): { id: number; code: string } {
    requirePermission(this.context(), 'patient.create');
    this.validate(input);
    const ctx = this.context();
    const now = this.context().instant();
    const code = nextPatientCode(this.db);
    const run = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO patients (
             code, first_name, last_name, gender, dob, age_years, blood_group, phone, alternate_phone, email,
             address, city, emergency_contact_name, emergency_phone, chief_complaint, previous_problems,
             medical_notes, allergies, notes, preferred_contact, status, referred_by, created_by, created_at, updated_at
           ) VALUES (
             @code, @firstName, @lastName, @gender, @dob, @ageYears, @bloodGroup, @phone, @alternatePhone, @email,
             @address, @city, @emergencyContactName, @emergencyPhone, @chiefComplaint, @previousProblems,
             @medicalNotes, @allergies, @notes, @preferredContact, @status, @referredBy, @createdBy, @createdAt, @updatedAt
           )`,
        )
        .run({
          code,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          gender: input.gender,
          dob: input.dob,
          ageYears: input.ageYears,
          bloodGroup: input.bloodGroup,
          phone: input.phone.trim(),
          alternatePhone: input.alternatePhone.trim(),
          email: input.email.trim(),
          address: input.address.trim(),
          city: input.city.trim(),
          emergencyContactName: input.emergencyContactName.trim(),
          emergencyPhone: input.emergencyPhone.trim(),
          chiefComplaint: input.chiefComplaint.trim(),
          previousProblems: input.previousProblems.trim(),
          medicalNotes: input.medicalNotes.trim(),
          allergies: input.allergies.trim(),
          notes: input.notes.trim(),
          preferredContact: input.preferredContact,
          status: input.status,
          referredBy: input.referredBy.trim(),
          createdBy: currentUserId(ctx),
          createdAt: now,
          updatedAt: now,
        });
      const id = Number(result.lastInsertRowid);
      this.replaceContacts(id, input);
      this.setTags(id, input.tagIds);
      this.syncFts(id);
      ctx.audit.record({
        action: 'create',
        entityType: 'patient',
        entityId: id,
        entityLabel: `${code} — ${fullName(input.firstName, input.lastName)}`,
        detail: 'Patient registered',
        after: { code, name: fullName(input.firstName, input.lastName), phone: input.phone, gender: input.gender },
      });
      return id;
    });
    const id = run();
    ctx.notify?.('patients.changed', { id });
    return { id, code };
  }

  update(id: number, input: PatientInput): void {
    requirePermission(this.context(), 'patient.edit');
    this.validate(input);
    const ctx = this.context();
    const before = this.db.prepare(`SELECT * FROM patients WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!before) throw AppError.notFound('Patient');
    const now = this.context().instant();
    const medicalVisible = this.canSeeMedical();
    const keep = (key: string, value: string): string => (medicalVisible ? value : textValue(before[key]));
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE patients SET
             first_name = @firstName, last_name = @lastName, gender = @gender, dob = @dob, age_years = @ageYears,
             blood_group = @bloodGroup, phone = @phone, alternate_phone = @alternatePhone, email = @email,
             address = @address, city = @city, emergency_contact_name = @emergencyContactName,
             emergency_phone = @emergencyPhone, chief_complaint = @chiefComplaint, previous_problems = @previousProblems,
             medical_notes = @medicalNotes, allergies = @allergies, notes = @notes, preferred_contact = @preferredContact,
             status = @status, referred_by = @referredBy, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          gender: input.gender,
          dob: input.dob,
          ageYears: input.ageYears,
          bloodGroup: input.bloodGroup,
          phone: input.phone.trim(),
          alternatePhone: input.alternatePhone.trim(),
          email: input.email.trim(),
          address: input.address.trim(),
          city: input.city.trim(),
          emergencyContactName: input.emergencyContactName.trim(),
          emergencyPhone: input.emergencyPhone.trim(),
          chiefComplaint: keep('chief_complaint', input.chiefComplaint.trim()),
          previousProblems: keep('previous_problems', input.previousProblems.trim()),
          medicalNotes: keep('medical_notes', input.medicalNotes.trim()),
          allergies: keep('allergies', input.allergies.trim()),
          notes: input.notes.trim(),
          preferredContact: input.preferredContact,
          status: input.status,
          referredBy: input.referredBy.trim(),
          updatedAt: now,
        });
      this.replaceContacts(id, input);
      this.setTags(id, input.tagIds);
      this.syncFts(id);
      ctx.audit.record({
        action: 'update',
        entityType: 'patient',
        entityId: id,
        entityLabel: textValue(before['code']),
        detail: 'Patient details updated',
        before: {
          name: fullName(textValue(before['first_name']), textValue(before['last_name'])),
          phone: before['phone'],
          status: before['status'],
          bloodGroup: before['blood_group'],
        },
        after: {
          name: fullName(input.firstName, input.lastName),
          phone: input.phone,
          status: input.status,
          bloodGroup: input.bloodGroup,
        },
      });
    });
    run();
    ctx.notify?.('patients.changed', { id });
  }

  /** Soft delete: history (visits, invoices, prescriptions) is always preserved. */
  delete(id: number, reason: string, confirmText?: string): void {
    const ctx = this.context();
    const patient = this.db.prepare(`SELECT id, code, first_name, last_name FROM patients WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { id: number; code: string; first_name: string; last_name: string }
      | undefined;
    if (!patient) throw AppError.notFound('Patient');
    const hasHistory = asNumber(
      (
        this.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM visits WHERE patient_id = ?) +
               (SELECT COUNT(*) FROM invoices WHERE patient_id = ?) +
               (SELECT COUNT(*) FROM prescriptions WHERE patient_id = ?) AS total`,
          )
          .get(id, id, id) as { total: number }
      ).total,
    );
    if (hasHistory > 0) {
      // Patients with clinical/financial history can only be removed by someone
      // who is allowed to archive records, and must confirm the patient code.
      requirePermission(ctx, 'patient.edit');
      if (confirmText?.trim() !== patient.code) {
        throw AppError.validation(
          `This patient has ${hasHistory} linked record(s) which will be preserved. Type the patient code (${patient.code}) to confirm.`,
          { confirmText: 'Type the patient code exactly as shown.' },
        );
      }
    } else {
      requirePermission(ctx, 'patient.delete');
    }
    if (reason.trim().length < 3) {
      throw AppError.validation('Please give a short reason for removing this patient.', { reason: 'Reason is required.' });
    }
    const now = this.context().instant();
    const run = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE patients SET deleted_at = ?, deleted_reason = ?, updated_at = ? WHERE id = ?`)
        .run(now, reason.trim(), now, id);
      this.db.prepare(`DELETE FROM patients_fts WHERE rowid = ?`).run(id);
      this.db
        .prepare(`UPDATE appointments SET deleted_at = ? WHERE patient_id = ? AND deleted_at IS NULL AND date >= ?`)
        .run(now, id, todayIso());
      this.db
        .prepare(`UPDATE queue_entries SET status = 'cancelled' WHERE patient_id = ? AND status IN ('waiting','called','in_consultation')`)
        .run(id);
      ctx.audit.record({
        action: 'soft_delete',
        entityType: 'patient',
        entityId: id,
        entityLabel: patient.code,
        detail: `Patient removed. Reason: ${reason.trim()}`,
        severity: 'warning',
        before: { status: 'active' },
        after: { status: 'removed', reason: reason.trim() },
      });
    });
    run();
    ctx.notify?.('patients.changed', { id });
  }

  restore(id: number): void {
    requirePermission(this.context(), 'patient.delete');
    const patient = this.db.prepare(`SELECT id, code FROM patients WHERE id = ? AND deleted_at IS NOT NULL`).get(id) as
      | { id: number; code: string }
      | undefined;
    if (!patient) throw AppError.notFound('Removed patient');
    const ctx = this.context();
    const run = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE patients SET deleted_at = NULL,` + ` deleted_reason = NULL, updated_at = ? WHERE id = ?`)
        .run(this.context().instant(), id);
      this.syncFts(id);
      ctx.audit.record({
        action: 'restore',
        entityType: 'patient',
        entityId: id,
        entityLabel: patient.code,
        detail: 'Patient restored to the active register',
        severity: 'warning',
      });
    });
    run();
    ctx.notify?.('patients.changed', { id });
  }

  // --- Clinical timeline --------------------------------------------------

  timeline(patientId: number, options: { types?: string[]; from?: string; to?: string; limit?: number } = {}): TimelineEvent[] {
    requirePermission(this.context(), 'patient.view');
    const patient = this.db.prepare(`SELECT id, code, first_name, last_name, created_at FROM patients WHERE id = ?`).get(patientId) as
      | { id: number; code: string; first_name: string; last_name: string; created_at: string }
      | undefined;
    if (!patient) throw AppError.notFound('Patient');
    const events: TimelineEvent[] = [];
    const wants = (type: TimelineEventType): boolean => !options.types || options.types.length === 0 || options.types.includes(type);
    const inRange = (date: string): boolean => (!options.from || date >= options.from) && (!options.to || date <= options.to);

    events.push({
      id: `registration-${patient.id}`,
      type: 'registration',
      date: patient.created_at.slice(0, 10),
      instant: patient.created_at,
      title: 'Patient registered',
      subtitle: `${patient.first_name} ${patient.last_name} joined the clinic`,
      detail: `Patient code ${patient.code}`,
      dentistName: null,
      amountPaisa: null,
      status: 'completed',
      target: { screen: 'patient', id: patient.id },
      meta: { code: patient.code },
    });

    if (wants('visit')) {
      const visits = this.db
        .prepare(
          `SELECT v.id, v.visit_date, v.chief_complaint, v.diagnosis, v.follow_up_date, d.name AS dentist_name,
                  (SELECT COUNT(*) FROM treatment_records tr WHERE tr.visit_id = v.id AND tr.deleted_at IS NULL) AS treatment_count
             FROM visits v LEFT JOIN dentists d ON d.id = v.dentist_id
            WHERE v.patient_id = ? AND v.deleted_at IS NULL ORDER BY v.visit_date DESC LIMIT 500`,
        )
        .all(patientId) as Array<{
        id: number;
        visit_date: string;
        chief_complaint: string;
        diagnosis: string;
        follow_up_date: string | null;
        dentist_name: string | null;
        treatment_count: number;
      }>;
      for (const visit of visits) {
        if (!inRange(visit.visit_date)) continue;
        events.push({
          id: `visit-${visit.id}`,
          type: 'visit',
          date: visit.visit_date,
          instant: null,
          title: 'Visit recorded',
          subtitle: visit.chief_complaint || visit.diagnosis || 'Clinical visit',
          detail:
            visit.diagnosis ||
            (asNumber(visit.treatment_count) > 0 ? `${visit.treatment_count} treatment(s) recorded` : 'No treatment recorded'),
          dentistName: visit.dentist_name ?? null,
          amountPaisa: null,
          status: visit.follow_up_date ? `Follow-up ${visit.follow_up_date}` : 'completed',
          target: { screen: 'visits', id: visit.id },
          meta: visit.follow_up_date ? { followUp: visit.follow_up_date } : {},
        });
      }
    }

    if (wants('treatment')) {
      const treatments = this.db
        .prepare(
          `SELECT tr.id, tr.description, tr.performed_at, tr.total_paisa, tr.tooth_codes, d.name AS dentist_name
             FROM treatment_records tr LEFT JOIN dentists d ON d.id = tr.dentist_id
            WHERE tr.patient_id = ? AND tr.deleted_at IS NULL ORDER BY tr.performed_at DESC LIMIT 500`,
        )
        .all(patientId) as Array<{
        id: number;
        description: string;
        performed_at: string;
        total_paisa: number;
        tooth_codes: string;
        dentist_name: string | null;
      }>;
      for (const treatment of treatments) {
        if (!inRange(treatment.performed_at)) continue;
        const teeth = parseJsonArray(treatment.tooth_codes);
        events.push({
          id: `treatment-${treatment.id}`,
          type: 'treatment',
          date: treatment.performed_at,
          instant: null,
          title: treatment.description || 'Treatment',
          subtitle: teeth.length > 0 ? `Tooth ${teeth.join(', ')}` : 'Treatment performed',
          detail: this.canSeeFinancials() ? `Charged ${(treatment.total_paisa / 100).toFixed(2)} BDT` : 'Charged',
          dentistName: treatment.dentist_name ?? null,
          amountPaisa: this.canSeeFinancials() ? asNumber(treatment.total_paisa) : null,
          status: 'performed',
          target: { screen: 'visits', id: treatment.id },
          meta: { teeth: teeth.join(', ') },
        });
      }
    }

    if (wants('prescription')) {
      const prescriptions = this.db
        .prepare(
          `SELECT pr.id, pr.number, pr.date, pr.created_at, d.name AS dentist_name,
                  (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = pr.id) AS item_count
             FROM prescriptions pr LEFT JOIN dentists d ON d.id = pr.dentist_id
            WHERE pr.patient_id = ? AND pr.deleted_at IS NULL ORDER BY pr.date DESC LIMIT 500`,
        )
        .all(patientId) as Array<{
        id: number;
        number: string;
        date: string;
        created_at: string;
        dentist_name: string | null;
        item_count: number;
      }>;
      for (const prescription of prescriptions) {
        if (!inRange(prescription.date)) continue;
        events.push({
          id: `prescription-${prescription.id}`,
          type: 'prescription',
          date: prescription.date,
          instant: prescription.created_at,
          title: `Prescription ${prescription.number}`,
          subtitle: `${prescription.item_count} medication(s)`,
          detail: prescription.dentist_name ? `Prescribed by ${prescription.dentist_name}` : 'Prescribed',
          dentistName: prescription.dentist_name ?? null,
          amountPaisa: null,
          status: 'issued',
          target: { screen: 'prescriptions', id: prescription.id },
          meta: { number: prescription.number },
        });
      }
    }

    if (wants('appointment')) {
      const appointments = this.db
        .prepare(
          `SELECT a.id, a.date, a.start_time, a.status, a.reason, d.name AS dentist_name
             FROM appointments a LEFT JOIN dentists d ON d.id = a.dentist_id
            WHERE a.patient_id = ? AND a.deleted_at IS NULL ORDER BY a.date DESC LIMIT 500`,
        )
        .all(patientId) as Array<{
        id: number;
        date: string;
        start_time: string;
        status: string;
        reason: string;
        dentist_name: string | null;
      }>;
      for (const appointment of appointments) {
        if (!inRange(appointment.date)) continue;
        events.push({
          id: `appointment-${appointment.id}`,
          type: 'appointment',
          date: appointment.date,
          instant: null,
          title: `Appointment ${appointment.start_time}`,
          subtitle: appointment.reason || 'Appointment',
          detail: `Status: ${appointment.status.replace(/_/g, ' ')}`,
          dentistName: appointment.dentist_name ?? null,
          amountPaisa: null,
          status: appointment.status,
          target: { screen: 'appointments', id: appointment.id },
          meta: { time: appointment.start_time },
        });
      }
    }

    if (wants('invoice') && this.canSeeFinancials()) {
      const invoices = this.db
        .prepare(
          `SELECT id, number, date, total_paisa, paid_paisa, status, created_at
             FROM invoices WHERE patient_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT 500`,
        )
        .all(patientId) as Array<{
        id: number;
        number: string;
        date: string;
        total_paisa: number;
        paid_paisa: number;
        status: string;
        created_at: string;
      }>;
      for (const invoice of invoices) {
        if (!inRange(invoice.date)) continue;
        events.push({
          id: `invoice-${invoice.id}`,
          type: 'invoice',
          date: invoice.date,
          instant: invoice.created_at,
          title: `Invoice ${invoice.number}`,
          subtitle: `${invoice.status.replace(/_/g, ' ')}`,
          detail: `Total ${(invoice.total_paisa / 100).toFixed(2)} BDT · Paid ${(invoice.paid_paisa / 100).toFixed(2)} BDT`,
          dentistName: null,
          amountPaisa: asNumber(invoice.total_paisa),
          status: invoice.status,
          target: { screen: 'invoices', id: invoice.id },
          meta: { number: invoice.number },
        });
      }
    }

    if (wants('payment') && this.canSeeFinancials()) {
      const payments = this.db
        .prepare(
          `SELECT pay.id, pay.amount_paisa, pay.paid_at, pay.paid_date,` +
            ` pay.receipt_number, m.name AS method_name, i.number AS invoice_number
             FROM payments pay
             LEFT JOIN payment_methods m ON m.id = pay.method_id
             LEFT JOIN invoices i ON i.id = pay.invoice_id
            WHERE pay.patient_id = ? AND pay.is_void = 0 ORDER BY pay.paid_at DESC LIMIT 500`,
        )
        .all(patientId) as Array<{
        id: number;
        amount_paisa: number;
        paid_at: string;
        paid_date: string;
        receipt_number: string;
        method_name: string | null;
        invoice_number: string | null;
      }>;
      for (const payment of payments) {
        if (!inRange(payment.paid_date)) continue;
        events.push({
          id: `payment-${payment.id}`,
          type: 'payment',
          date: payment.paid_date,
          instant: payment.paid_at,
          title: `Payment received`,
          subtitle: `${payment.receipt_number}${payment.invoice_number ? ` · Invoice ${payment.invoice_number}` : ''}`,
          detail: `${(payment.amount_paisa / 100).toFixed(2)} BDT via ${payment.method_name ?? 'unspecified method'}`,
          dentistName: null,
          amountPaisa: asNumber(payment.amount_paisa),
          status: 'received',
          target: { screen: 'payments', id: payment.id },
          meta: { receipt: payment.receipt_number },
        });
      }
    }

    if (wants('chart')) {
      const findings = this.db
        .prepare(
          `SELECT tf.id, tf.tooth_fdi, tf.finding, tf.recorded_at, u.full_name AS recorded_by
             FROM tooth_findings tf LEFT JOIN users u ON u.id = tf.recorded_by
            WHERE tf.patient_id = ? AND tf.is_active = 1 ORDER BY tf.recorded_at DESC LIMIT 200`,
        )
        .all(patientId) as Array<{ id: number; tooth_fdi: string; finding: string; recorded_at: string; recorded_by: string | null }>;
      for (const finding of findings) {
        const date = finding.recorded_at.slice(0, 10);
        if (!inRange(date)) continue;
        events.push({
          id: `chart-${finding.id}`,
          type: 'chart',
          date,
          instant: finding.recorded_at,
          title: `Dental chart · tooth ${finding.tooth_fdi}`,
          subtitle: finding.finding.replace(/_/g, ' '),
          detail: finding.recorded_by ? `Recorded by ${finding.recorded_by}` : 'Chart updated',
          dentistName: finding.recorded_by ?? null,
          amountPaisa: null,
          status: 'recorded',
          target: { screen: 'patient', id: patientId },
          meta: { tooth: finding.tooth_fdi },
        });
      }
    }

    if (wants('referral')) {
      const referrals = this.db
        .prepare(
          `SELECT id, date, doctor_name, specialty, status, reason FROM referrals
            WHERE patient_id = ? ORDER BY date DESC LIMIT 200`,
        )
        .all(patientId) as Array<{ id: number; date: string; doctor_name: string; specialty: string; status: string; reason: string }>;
      for (const referral of referrals) {
        if (!inRange(referral.date)) continue;
        events.push({
          id: `referral-${referral.id}`,
          type: 'referral',
          date: referral.date,
          instant: null,
          title: `Referred to ${referral.doctor_name}`,
          subtitle: referral.specialty || 'Specialist referral',
          detail: referral.reason || 'Referral recorded',
          dentistName: null,
          amountPaisa: null,
          status: referral.status,
          target: { screen: 'patient', id: patientId },
          meta: {},
        });
      }
    }

    if (wants('attachment')) {
      const attachments = this.db
        .prepare(
          `SELECT id, file_name, category, created_at FROM attachments
            WHERE patient_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
        )
        .all(patientId) as Array<{ id: number; file_name: string; category: string; created_at: string }>;
      for (const attachment of attachments) {
        const date = attachment.created_at.slice(0, 10);
        if (!inRange(date)) continue;
        events.push({
          id: `attachment-${attachment.id}`,
          type: 'attachment',
          date,
          instant: attachment.created_at,
          title: 'File attached',
          subtitle: attachment.file_name,
          detail: attachment.category.replace(/_/g, ' '),
          dentistName: null,
          amountPaisa: null,
          status: 'stored',
          target: { screen: 'patient', id: patientId },
          meta: {},
        });
      }
    }

    const limit = options.limit ?? 300;
    return events
      .filter((event) => event.date !== '')
      .sort((a, b) => (a.date === b.date ? (b.instant ?? '').localeCompare(a.instant ?? '') : b.date.localeCompare(a.date)))
      .slice(0, limit);
  }

  // --- Financial summary --------------------------------------------------

  financialSummary(patientId: number): PatientFinancialSummary {
    requirePermission(this.context(), 'invoice.view');
    const patient = this.db.prepare(`SELECT id FROM patients WHERE id = ?`).get(patientId);
    if (!patient) throw AppError.notFound('Patient');
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS invoice_count,
                COALESCE(SUM(total_paisa), 0) AS total_invoiced,
                COALESCE(SUM(paid_paisa), 0) AS total_paid
           FROM invoices WHERE patient_id = ? AND deleted_at IS NULL AND is_void = 0`,
      )
      .get(patientId) as { invoice_count: number; total_invoiced: number; total_paid: number };
    const openInvoices = this.db
      .prepare(
        `SELECT id, number, date, total_paisa, paid_paisa, (total_paisa - paid_paisa) AS due
           FROM invoices
          WHERE patient_id = ? AND deleted_at IS NULL AND is_void = 0 AND total_paisa > paid_paisa
          ORDER BY date ASC, id ASC`,
      )
      .all(patientId) as Array<{ id: number; number: string; date: string; total_paisa: number; paid_paisa: number; due: number }>;
    const recentPayments = this.db
      .prepare(
        `SELECT pay.id, pay.amount_paisa, pay.paid_at, m.name AS method_name, i.number AS invoice_number
           FROM payments pay
           LEFT JOIN payment_methods m ON m.id = pay.method_id
           LEFT JOIN invoices i ON i.id = pay.invoice_id
          WHERE pay.patient_id = ? AND pay.is_void = 0
          ORDER BY pay.paid_at DESC LIMIT 20`,
      )
      .all(patientId) as Array<{
      id: number;
      amount_paisa: number;
      paid_at: string;
      method_name: string | null;
      invoice_number: string | null;
    }>;
    const lastPayment = this.db
      .prepare(`SELECT MAX(paid_at) AS last_paid FROM payments WHERE patient_id = ? AND is_void = 0`)
      .get(patientId) as { last_paid: string | null };

    return {
      totalInvoicedPaisa: asNumber(totals.total_invoiced),
      totalPaidPaisa: asNumber(totals.total_paid),
      outstandingPaisa: openInvoices.reduce((sum, invoice) => sum + asNumber(invoice.due), 0),
      invoiceCount: asNumber(totals.invoice_count),
      lastPaymentAt: lastPayment.last_paid ?? null,
      openInvoices: openInvoices.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        date: invoice.date,
        totalPaisa: asNumber(invoice.total_paisa),
        paidPaisa: asNumber(invoice.paid_paisa),
        duePaisa: asNumber(invoice.due),
      })),
      recentPayments: recentPayments.map((payment) => ({
        id: payment.id,
        amountPaisa: asNumber(payment.amount_paisa),
        methodName: payment.method_name ?? 'Unspecified',
        paidAt: payment.paid_at,
        invoiceNumber: payment.invoice_number ?? '—',
      })),
    };
  }

  // --- Duplicates, search, statistics -------------------------------------

  checkDuplicate(input: { name?: string; phone?: string; excludeId?: number }): {
    matches: Array<{ id: number; code: string; name: string; phone: string; registeredAt: string }>;
  } {
    requirePermission(this.context(), 'patient.view');
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (input.excludeId) {
      clauses.push('id <> ?');
      params.push(input.excludeId);
    }
    const conditions: string[] = [];
    if (input.phone && input.phone.trim().length >= 5) {
      conditions.push(`phone = ? OR alternate_phone = ? OR emergency_phone = ?`);
      params.push(input.phone.trim(), input.phone.trim(), input.phone.trim());
    }
    if (input.name && input.name.trim().length >= 2) {
      const term = likeTerm(input.name);
      conditions.push(`(first_name || ' ' || last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE`);
      params.push(term);
    }
    if (conditions.length === 0) return { matches: [] };
    clauses.push(`(${conditions.join(' OR ')})`);
    const rows = this.db
      .prepare(
        `SELECT id, code, first_name, last_name, phone, substr(created_at, 1, 10) AS registered_at
           FROM patients WHERE ${clauses.join(' AND ')} LIMIT 10`,
      )
      .all(...params) as Array<{ id: number; code: string; first_name: string; last_name: string; phone: string; registered_at: string }>;
    return {
      matches: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: fullName(row.first_name, row.last_name),
        phone: row.phone,
        registeredAt: row.registered_at,
      })),
    };
  }

  quickSearch(query: string, limit = 20): PatientSummary[] {
    requirePermission(this.context(), 'patient.view');
    const term = query.trim();
    if (term.length === 0) return [];
    const fts = ftsQuery(term);
    let ids: number[] = [];
    if (fts) {
      try {
        const rows = this.db
          .prepare(`SELECT rowid FROM patients_fts WHERE patients_fts MATCH ? ORDER BY rank LIMIT ?`)
          .all(fts, limit) as Array<{ rowid: number }>;
        ids = rows.map((row) => row.rowid);
      } catch {
        ids = [];
      }
    }
    if (ids.length === 0) {
      const like = likeTerm(term);
      const rows = this.db
        .prepare(
          `SELECT id FROM patients
            WHERE deleted_at IS NULL AND (
              code LIKE ? ESCAPE '\\' COLLATE NOCASE OR
              first_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
              last_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
              phone LIKE ? ESCAPE '\\')
            ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(like, like, like, like, limit) as Array<{ id: number }>;
      ids = rows.map((row) => row.id);
    }
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`${LIST_SELECT} WHERE p.id IN (${ids.map(() => '?').join(', ')}) AND p.deleted_at IS NULL`)
      .all(...ids) as PatientRow[];
    const order = new Map(ids.map((id, index) => [id, index]));
    const tagMap = this.tagsByPatient(ids);
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map((row) => this.toSummary(row, tagMap.get(row.id) ?? []));
  }

  statistics(options: { preset?: string; from?: string; to?: string } = {}): {
    total: number;
    active: number;
    newInRange: number;
    byGender: Array<{ label: string; value: number }>;
    byStatus: Array<{ label: string; value: number }>;
    registrations: Array<{ date: string; count: number }>;
  } {
    requirePermission(this.context(), 'patient.view');
    const range = resolveDateRange((options.preset ?? 'last_30_days') as Parameters<typeof resolveDateRange>[0], {
      custom: { from: options.from, to: options.to },
    });
    const total = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM patients WHERE deleted_at IS NULL`).get() as { total: number }).total,
    );
    const active = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM patients WHERE deleted_at IS NULL AND status = 'active'`).get() as { total: number })
        .total,
    );
    const newInRange = asNumber(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS total FROM patients WHERE deleted_at IS NULL AND substr(created_at,1,10) BETWEEN ? AND ?`)
          .get(range.from, range.to) as { total: number }
      ).total,
    );
    const byGender = (
      this.db.prepare(`SELECT gender AS label, COUNT(*) AS value FROM patients WHERE deleted_at IS NULL GROUP BY gender`).all() as Array<{
        label: string;
        value: number;
      }>
    ).map((row) => ({ label: row.label, value: asNumber(row.value) }));
    const byStatus = (
      this.db.prepare(`SELECT status AS label, COUNT(*) AS value FROM patients WHERE deleted_at IS NULL GROUP BY status`).all() as Array<{
        label: string;
        value: number;
      }>
    ).map((row) => ({ label: row.label, value: asNumber(row.value) }));
    const registrations = (
      this.db
        .prepare(
          `SELECT substr(created_at,1,10) AS date, COUNT(*) AS count FROM patients
            WHERE deleted_at IS NULL AND substr(created_at,1,10) BETWEEN ? AND ?
            GROUP BY date ORDER BY date`,
        )
        .all(range.from, range.to) as Array<{ date: string; count: number }>
    ).map((row) => ({ date: row.date, count: asNumber(row.count) }));
    return { total, active, newInRange, byGender, byStatus, registrations };
  }

  // --- Tags ---------------------------------------------------------------

  listTags(): PatientTag[] {
    requirePermission(this.context(), 'patient.view');
    return (
      this.db
        .prepare(
          `SELECT t.id, t.name, t.colour,
                  (SELECT COUNT(*) FROM patient_tag_links l JOIN patients p ON p.id = l.patient_id
                    WHERE l.tag_id = t.id AND p.deleted_at IS NULL) AS patient_count
             FROM patient_tags t WHERE t.deleted_at IS NULL ORDER BY t.name`,
        )
        .all() as Array<{ id: number; name: string; colour: string; patient_count: number }>
    ).map((row) => ({ id: row.id, name: row.name, colour: row.colour, patientCount: asNumber(row.patient_count) }));
  }

  saveTag(input: { id?: number | null; name: string; colour: string }): { id: number } {
    requirePermission(this.context(), 'patient.edit');
    const name = input.name.trim();
    if (name.length < 2) throw AppError.validation('Tag name is too short.', { name: 'Enter at least two characters.' });
    const now = this.context().instant();
    if (input.id) {
      const result = this.db
        .prepare(`UPDATE patient_tags SET name = ?, colour = ?, updated_at = ? WHERE id = ?`)
        .run(name, input.colour, now, input.id);
      if (result.changes === 0) throw AppError.notFound('Tag');
      this.context().audit.record({ action: 'update', entityType: 'patient_tag', entityId: input.id, detail: `Tag renamed to ${name}` });
      return { id: input.id };
    }
    const existing = this.db.prepare(`SELECT id FROM patient_tags WHERE lower(name) = lower(?) AND deleted_at IS NULL`).get(name) as
      | { id: number }
      | undefined;
    if (existing) throw AppError.conflict(`A tag named “${name}” already exists.`);
    const result = this.db
      .prepare(`INSERT INTO patient_tags (name, colour, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(name, input.colour, now, now);
    const id = Number(result.lastInsertRowid);
    this.context().audit.record({ action: 'create', entityType: 'patient_tag', entityId: id, detail: `Tag ${name} created` });
    return { id };
  }

  setTags(patientId: number, tagIds: readonly number[]): void {
    requirePermission(this.context(), 'patient.edit');
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM patient_tag_links WHERE patient_id = ?`).run(patientId);
      const insert = this.db.prepare(`INSERT OR IGNORE INTO patient_tag_links (patient_id, tag_id) VALUES (?, ?)`);
      for (const tagId of tagIds) insert.run(patientId, tagId);
    });
    run();
  }

  // --- Internals ----------------------------------------------------------

  private validate(input: PatientInput): void {
    const fieldErrors: Record<string, string> = {};
    if (input.firstName.trim().length < 2) fieldErrors.firstName = 'Enter the patient’s first name.';
    if (input.gender !== 'male' && input.gender !== 'female' && input.gender !== 'other') fieldErrors.gender = 'Select a gender.';
    const phone = input.phone.trim();
    if (phone === '' && input.alternatePhone.trim() === '' && input.emergencyPhone.trim() === '') {
      fieldErrors.phone = 'At least one phone number is required.';
    } else if (phone !== '' && !/^[0-9+\-\s()]{6,20}$/.test(phone)) {
      fieldErrors.phone = 'Enter a valid phone number.';
    }
    if (input.alternatePhone.trim() !== '' && !/^[0-9+\-\s()]{6,20}$/.test(input.alternatePhone.trim())) {
      fieldErrors.alternatePhone = 'Enter a valid phone number.';
    }
    if (input.emergencyPhone.trim() !== '' && !/^[0-9+\-\s()]{6,20}$/.test(input.emergencyPhone.trim())) {
      fieldErrors.emergencyPhone = 'Enter a valid phone number.';
    }
    if (input.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
      fieldErrors.email = 'Enter a valid email address.';
    }
    if (input.dob) {
      const today = todayIso();
      if (input.dob > today) fieldErrors.dob = 'Date of birth cannot be in the future.';
      if (input.dob < '1900-01-01') fieldErrors.dob = 'Date of birth looks invalid.';
    }
    if (input.ageYears !== null && input.ageYears !== undefined) {
      if (input.ageYears < 0 || input.ageYears > 150) fieldErrors.ageYears = 'Enter an age between 0 and 150.';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
    }
  }

  private replaceContacts(patientId: number, input: PatientInput): void {
    this.db.prepare(`DELETE FROM patient_contacts WHERE patient_id = ?`).run(patientId);
    const insert = this.db.prepare(
      `INSERT INTO patient_contacts (patient_id, type, name, relation, value, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    if (input.alternatePhone.trim() !== '') {
      insert.run(patientId, 'alternate_phone', '', '', input.alternatePhone.trim(), 0);
    }
    if (input.email.trim() !== '') {
      insert.run(patientId, 'email', '', '', input.email.trim(), 0);
    }
    if (input.emergencyPhone.trim() !== '' || input.emergencyContactName.trim() !== '') {
      insert.run(patientId, 'emergency', input.emergencyContactName.trim(), '', input.emergencyPhone.trim(), 1);
    }
  }

  /** Keep the FTS index in step with the patient row. */
  syncFts(patientId: number): void {
    const row = this.db
      .prepare(`SELECT id, code, first_name, last_name, phone, alternate_phone, address, deleted_at FROM patients WHERE id = ?`)
      .get(patientId) as
      | {
          id: number;
          code: string;
          first_name: string;
          last_name: string;
          phone: string;
          alternate_phone: string;
          address: string;
          deleted_at: string | null;
        }
      | undefined;
    this.db.prepare(`DELETE FROM patients_fts WHERE rowid = ?`).run(patientId);
    if (!row || row.deleted_at) return;
    this.db
      .prepare(`INSERT INTO patients_fts (rowid, code, name, phone, address) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, row.code, fullName(row.first_name, row.last_name), `${row.phone} ${row.alternate_phone}`.trim(), row.address);
  }

  /** Patient options for pickers, filtered by search text. */
  options(search: string, limit = 25): Array<{ value: number; label: string; meta: string }> {
    requirePermission(this.context(), 'patient.view');
    return this.quickSearch(search, limit).map((patient) => ({
      value: patient.id,
      label: patient.name,
      meta: `${patient.code} · ${patient.phone}`,
    }));
  }

  /** Used by other services to enrich rows without a circular dependency. */
  patientLabel(patientId: number): { code: string; name: string; phone: string } {
    const row = this.db.prepare(`SELECT code, first_name, last_name, phone FROM patients WHERE id = ?`).get(patientId) as
      | { code: string; first_name: string; last_name: string; phone: string }
      | undefined;
    if (!row) throw AppError.notFound('Patient');
    return { code: row.code, name: fullName(row.first_name, row.last_name), phone: row.phone };
  }

  assertMedicalAccess(): void {
    if (!this.canSeeMedical()) throw AppError.forbidden('You do not have permission to view medical information.');
  }

  patientCountSummary(): { total: number; active: number; removed: number } {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL) AS total,
           (SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL AND status = 'active') AS active,
           (SELECT COUNT(*) FROM patients WHERE deleted_at IS NOT NULL) AS removed`,
      )
      .get() as { total: number; active: number; removed: number };
    return { total: asNumber(row.total), active: asNumber(row.active), removed: asNumber(row.removed) };
  }
}
