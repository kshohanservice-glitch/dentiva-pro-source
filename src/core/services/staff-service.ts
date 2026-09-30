/**
 * Staff directory.
 *
 * Salary and national ID are sensitive: they are only returned to users with
 * `staff.sensitive.view`, and changes to them are audited separately.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { hasPermission, requirePermission } from '../context';
import type { Paged, StaffInput, StaffMember } from '@shared/types';
import type { BloodGroup } from '@shared/constants';
import { AppError } from '@shared/errors';
import { ageYears } from '@shared/dates';
import { asNumber, asString, buildWhere, pageCount, paginate } from '../db/sql';
import type { AttachmentService } from './attachment-service';

interface StaffRow {
  id: number;
  name: string;
  designation: string;
  department: string;
  phone: string;
  email: string;
  address: string;
  dob: string | null;
  blood_group: string;
  national_id: string;
  photo_path: string | null;
  salary_paisa: number | null;
  joining_date: string | null;
  status: string;
  notes: string;
  user_id: number | null;
  created_at: string;
}

export class StaffService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly attachments: AttachmentService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private map(row: StaffRow): StaffMember {
    const ctx = this.context();
    const canSeeSensitive = hasPermission(ctx, 'staff.sensitive.view');
    return {
      id: row.id,
      name: row.name,
      designation: row.designation,
      department: row.department,
      phone: row.phone,
      email: row.email,
      address: row.address,
      dob: row.dob,
      ageYears: row.dob ? ageYears(row.dob, ctx.today()) : null,
      bloodGroup: asString(row.blood_group, 'unknown') as BloodGroup,
      nationalId: canSeeSensitive ? row.national_id : '',
      photoPath: row.photo_path,
      salaryPaisa: canSeeSensitive && row.salary_paisa !== null ? asNumber(row.salary_paisa) : null,
      joiningDate: row.joining_date,
      status: asString(row.status, 'active') as StaffMember['status'],
      notes: row.notes,
      userId: row.user_id,
      createdAt: row.created_at,
    };
  }

  private readonly select = `SELECT * FROM staff s`;

  list(
    query: { page?: number; pageSize?: number; search?: string; status?: string[]; department?: string | null } = {},
  ): Paged<StaffMember> {
    requirePermission(this.context(), 'staff.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize ?? 50);
    const clauses: string[] = ['s.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.status && query.status.length > 0) {
      clauses.push(`s.status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    if (query.department) {
      clauses.push('s.department = ?');
      params.push(query.department);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(
        `(s.name LIKE ? ESCAPE '\\' OR s.designation LIKE ? ESCAPE '\\' OR` +
          ` s.department LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\')`,
      );
      params.push(term, term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM staff s${where}`).get(...params) as { total: number }).total);
    const rows = this.db
      .prepare(
        `${this.select}${where} ORDER BY CASE s.status WHEN 'active' THEN` +
          ` 0 WHEN 'on_leave' THEN 1 ELSE 2 END, s.name LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as StaffRow[];
    return { items: rows.map((row) => this.map(row)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): StaffMember {
    requirePermission(this.context(), 'staff.view');
    const row = this.db.prepare(`SELECT * FROM staff WHERE id = ? AND deleted_at IS NULL`).get(id) as StaffRow | undefined;
    if (!row) throw AppError.notFound('Staff member');
    return this.map(row);
  }

  async save(id: number | null, input: StaffInput, photoSourcePath?: string | null): Promise<{ id: number }> {
    requirePermission(this.context(), 'staff.manage');
    this.validate(input, id);
    const ctx = this.context();
    const now = ctx.instant();
    const canSeeSensitive = hasPermission(ctx, 'staff.sensitive.view');

    let photoPath: string | null | undefined;
    if (photoSourcePath !== undefined) {
      if (photoSourcePath === null) photoPath = null;
      else photoPath = await this.attachments.storeProfileImage({ sourcePath: photoSourcePath, kind: 'staff' });
    }

    if (id) {
      const before = this.db.prepare(`SELECT * FROM staff WHERE id = ? AND deleted_at IS NULL`).get(id) as StaffRow | undefined;
      if (!before) throw AppError.notFound('Staff member');
      if (!canSeeSensitive) {
        // A user without the sensitive permission cannot blank the salary by accident.
        input.salaryPaisa = before.salary_paisa === null ? null : asNumber(before.salary_paisa);
        input.nationalId = before.national_id;
      }
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE staff SET name = @name, designation = @designation, department = @department, phone = @phone, email = @email,
               address = @address, dob = @dob, blood_group = @bloodGroup, national_id = @nationalId, salary_paisa = @salary,
               joining_date = @joiningDate, status = @status, notes = @notes, user_id = @userId,
               photo_path = COALESCE(@photoPath, photo_path), updated_at = @now
             WHERE id = @id`,
          )
          .run({
            id,
            name: input.name.trim(),
            designation: input.designation.trim(),
            department: input.department.trim(),
            phone: input.phone.trim(),
            email: input.email.trim(),
            address: input.address.trim(),
            dob: input.dob,
            bloodGroup: input.bloodGroup,
            nationalId: input.nationalId.trim(),
            salary: input.salaryPaisa === null ? null : Math.round(input.salaryPaisa),
            joiningDate: input.joiningDate,
            status: input.status,
            notes: input.notes.trim(),
            userId: input.userId,
            photoPath: photoPath ?? null,
            now,
          });
        if (photoPath === null && before.photo_path) {
          this.db.prepare(`UPDATE staff SET photo_path = NULL WHERE id = ?`).run(id);
        }
        ctx.audit.record({
          action: 'update',
          entityType: 'staff',
          entityId: id,
          entityLabel: input.name.trim(),
          detail: 'Staff record updated',
          before: { name: before.name, status: before.status, department: before.department, salaryPaisa: before.salary_paisa },
          after: { name: input.name.trim(), status: input.status, department: input.department.trim(), salaryPaisa: input.salaryPaisa },
          severity:
            before.salary_paisa !== null && input.salaryPaisa !== null && asNumber(before.salary_paisa) !== Math.round(input.salaryPaisa)
              ? 'warning'
              : 'info',
        });
      })();
      if (photoPath === null && before.photo_path) await this.attachments.removeProfileImage(before.photo_path);
      return { id };
    }

    const newId = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO staff (name, designation, department, phone, email, address, dob, blood_group, national_id, photo_path,
             salary_paisa, joining_date, status, notes, user_id, created_at, updated_at)
           VALUES (@name, @designation, @department, @phone, @email, @address, @dob, @bloodGroup, @nationalId, @photoPath,
             @salary, @joiningDate, @status, @notes, @userId, @now, @now)`,
        )
        .run({
          name: input.name.trim(),
          designation: input.designation.trim(),
          department: input.department.trim(),
          phone: input.phone.trim(),
          email: input.email.trim(),
          address: input.address.trim(),
          dob: input.dob,
          bloodGroup: input.bloodGroup,
          nationalId: input.nationalId.trim(),
          photoPath: photoPath ?? null,
          salary: input.salaryPaisa === null ? null : Math.round(input.salaryPaisa),
          joiningDate: input.joiningDate,
          status: input.status,
          notes: input.notes.trim(),
          userId: input.userId,
          now,
        });
      const createdId = Number(inserted.lastInsertRowid);
      ctx.audit.record({
        action: 'create',
        entityType: 'staff',
        entityId: createdId,
        entityLabel: input.name.trim(),
        detail: `Staff member added${input.designation.trim() ? ` (${input.designation.trim()})` : ''}`,
      });
      return createdId;
    })();
    return { id: newId };
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'staff.manage');
    const row = this.db.prepare(`SELECT name FROM staff WHERE id = ? AND deleted_at IS NULL`).get(id) as { name: string } | undefined;
    if (!row) throw AppError.notFound('Staff member');
    if (confirmText?.trim() !== row.name) {
      throw AppError.validation(`Type the name (${row.name}) to confirm deletion.`, { confirmText: `Type ${row.name} to confirm.` });
    }
    if (reason.trim().length < 3)
      throw AppError.validation('Please give a reason for' + ' removing this staff record.', { reason: 'Reason is required.' });
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE staff SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ctx.instant(), ctx.instant(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'staff',
        entityId: id,
        entityLabel: row.name,
        detail: `Staff record removed. Reason: ${reason.trim()}`,
        severity: 'critical',
      });
    })();
  }

  departments(): string[] {
    requirePermission(this.context(), 'staff.view');
    const rows = this.db
      .prepare(`SELECT DISTINCT department FROM staff WHERE deleted_at IS NULL AND trim(department) <> '' ORDER BY department`)
      .all() as Array<{ department: string }>;
    return rows.map((row) => row.department);
  }

  statistics(): {
    total: number;
    active: number;
    byDepartment: Array<{ label: string; value: number }>;
    byStatus: Array<{ label: string; value: number }>;
  } {
    requirePermission(this.context(), 'staff.view');
    const rows = this.db
      .prepare(`SELECT status, COALESCE(NULLIF(trim(department), ''), 'Unassigned') AS department FROM staff WHERE deleted_at IS NULL`)
      .all() as Array<{ status: string; department: string }>;
    const byStatusMap = new Map<string, number>();
    const byDepartmentMap = new Map<string, number>();
    for (const row of rows) {
      byStatusMap.set(row.status, (byStatusMap.get(row.status) ?? 0) + 1);
      byDepartmentMap.set(row.department, (byDepartmentMap.get(row.department) ?? 0) + 1);
    }
    return {
      total: rows.length,
      active: rows.filter((row) => row.status === 'active').length,
      byStatus: [...byStatusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      byDepartment: [...byDepartmentMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    };
  }

  /** Staff linked to an application user (used by the user screen). */
  byUserId(userId: number): StaffMember | null {
    const row = this.db.prepare(`SELECT * FROM staff WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as StaffRow | undefined;
    return row ? this.map(row) : null;
  }

  /** Total monthly salary commitment (payroll widget on the dashboard). */
  monthlySalaryTotalPaisa(): number {
    requirePermission(this.context(), 'staff.sensitive.view');
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(salary_paisa), 0) AS total FROM staff WHERE deleted_at IS NULL AND status = 'active'`)
      .get() as { total: number };
    return asNumber(row.total);
  }

  private validate(input: StaffInput, existingId: number | null): void {
    const fieldErrors: Record<string, string> = {};
    if (input.name.trim().length < 2) fieldErrors['name'] = 'Enter the staff member’s name.';
    if (input.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))
      fieldErrors['email'] = 'Enter a valid' + ' email address.';
    if (input.phone.trim() !== '' && !/^[0-9+\-\s()]{6,20}$/.test(input.phone.trim())) fieldErrors['phone'] = 'Enter a valid phone number.';
    if (input.dob && input.dob > this.context().today()) fieldErrors['dob'] = 'Date of birth cannot be in the future.';
    if (input.joiningDate && input.dob && input.joiningDate < input.dob)
      fieldErrors['joiningDate'] = 'Joining date cannot be' + ' before the date of birth.';
    if (input.salaryPaisa !== null && (!Number.isFinite(input.salaryPaisa) || input.salaryPaisa < 0)) {
      fieldErrors['salaryPaisa'] = 'Enter a valid salary.';
    }
    if (input.userId !== null) {
      const linked = this.db.prepare(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`).get(input.userId);
      if (!linked) fieldErrors['userId'] = 'Select a valid user account.';
      const taken = this.db.prepare(`SELECT id FROM staff WHERE user_id` + ` = ? AND deleted_at IS NULL`).get(input.userId) as
        | { id: number }
        | undefined;
      if (taken && taken.id !== existingId) fieldErrors['userId'] = 'That user account is already linked to another staff member.';
    }
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  /** Guard used when a user account is deleted while linked to staff. */
  unlinkUser(userId: number): void {
    this.db.prepare(`UPDATE staff SET user_id = NULL, updated_at = ? WHERE user_id = ?`).run(this.context().instant(), userId);
  }

  /** Number of records shown on the data summary screen. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM staff WHERE deleted_at IS NULL`).get() as { total: number };
    return asNumber(row.total);
  }

  /** Active staff, for pickers that assign work. */
  options(): Array<{ value: number; label: string; meta: string }> {
    requirePermission(this.context(), 'staff.view');
    const rows = this.db
      .prepare(`SELECT id, name, designation FROM staff WHERE deleted_at IS NULL AND status = 'active' ORDER BY name`)
      .all() as Array<{ id: number; name: string; designation: string }>;
    return rows.map((row) => ({ value: row.id, label: row.name, meta: row.designation }));
  }

  /** Recent hires/changes for the dashboard "team" card. */
  recent(limit = 5): StaffMember[] {
    requirePermission(this.context(), 'staff.view');
    const rows = this.db
      .prepare(`SELECT * FROM staff WHERE deleted_at IS NULL ORDER BY COALESCE(joining_date, created_at) DESC LIMIT ?`)
      .all(limit) as StaffRow[];
    return rows.map((row) => this.map(row));
  }

  /** Birthdays this month (staff appreciation card, uses non-sensitive data). */
  birthdaysThisMonth(): StaffMember[] {
    requirePermission(this.context(), 'staff.view');
    const today = this.context().today();
    const month = today.slice(5, 7);
    const rows = this.db
      .prepare(`SELECT * FROM staff WHERE deleted_at IS NULL AND dob IS NOT NULL AND substr(dob, 6, 2) = ? ORDER BY substr(dob, 9, 2)`)
      .all(month) as StaffRow[];
    return rows.map((row) => this.map(row));
  }
}
