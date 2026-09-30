/**
 * User accounts and roles.
 *
 * Roles are stored as permission grants in the database; the seven built-in
 * roles are seeded from `SYSTEM_ROLES` and kept in step with the code. The
 * owner role always resolves to full access and cannot be edited or removed.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requireAnyPermission, requirePermission } from '../context';
import type { Paged, Role, RoleInput, SessionUser, UserAccount, UserInput } from '@shared/types';
import {
  ALL_PERMISSION_KEYS,
  OWNER_ROLE_KEY,
  PERMISSION_DEFINITIONS,
  PERMISSION_GROUP_LABELS,
  SYSTEM_ROLES,
  expandGrants,
  isPermissionKey,
  rolePreset,
  resolveRoleGrants,
  type PermissionGroup,
} from '@shared/permissions';
import { AppError } from '@shared/errors';
import {} from '@shared/dates';
import { hashPassword } from '../security/password';
import { createSessionUser } from '../security/session';
import { asNumber, buildWhere, fromBoolInt, pageCount, paginate } from '../db/sql';

export class UserService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  // --- Users --------------------------------------------------------------

  list(query: { page?: number; pageSize?: number; search?: string; isActive?: boolean } = {}): Paged<UserAccount> {
    requirePermission(this.context(), 'user.view');
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize ?? 50);
    const clauses: string[] = ['u.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.isActive !== undefined) {
      clauses.push('u.is_active = ?');
      params.push(query.isActive ? 1 : 0);
    }
    if (query.search && query.search.trim() !== '') {
      const term = `%${query.search.trim().replace(/[%_]/g, (match) => `\\${match}`)}%`;
      clauses.push(`(u.username LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
      params.push(term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM users u${where}`).get(...params) as { total: number }).total);
    const rows = this.db
      .prepare(`SELECT id FROM users u${where} ORDER BY u.is_active DESC, u.full_name, u.username LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ id: number }>;
    return { items: rows.map((row) => this.get(row.id)), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): UserAccount {
    const row = this.db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.user_id = u.id) AS role_count
           FROM users u WHERE u.id = ? AND u.deleted_at IS NULL`,
      )
      .get(id) as
      | {
          id: number;
          username: string;
          full_name: string;
          email: string;
          phone: string;
          is_active: number;
          must_change_password: number;
          last_login_at: string | null;
          failed_attempts: number;
          locked_until: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) throw AppError.notFound('User');
    const roles = this.rolesForUser(row.id);
    return {
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      isActive: fromBoolInt(row.is_active),
      mustChangePassword: fromBoolInt(row.must_change_password),
      lastLoginAt: row.last_login_at,
      failedAttempts: asNumber(row.failed_attempts),
      lockedUntil: row.locked_until,
      roleIds: roles.map((role) => role.id),
      roleNames: roles.map((role) => role.name),
      createdAt: row.created_at,
    };
  }

  private rolesForUser(userId: number): Array<{ id: number; key: string; name: string }> {
    return this.db
      .prepare(
        `SELECT r.id, r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ? AND r.deleted_at IS NULL ORDER BY r.name`,
      )
      .all(userId) as Array<{ id: number; key: string; name: string }>;
  }

  async create(input: UserInput & { password: string }): Promise<{ id: number }> {
    requirePermission(this.context(), 'user.manage');
    this.validate(input);
    if (input.password.trim().length === 0) throw AppError.validation('Set a password for the new user.', { password: 'Password is required.' });
    const passwordHash = await hashPassword(input.password);
    const ctx = this.context();
    const now = ctx.instant();
    const id = this.db.transaction(() => {
      this.assertUsernameFree(input.username, null);
      this.assertRoleIds(input.roleIds);
      const inserted = this.db
        .prepare(
          `INSERT INTO users (username, password_hash, full_name, email, phone, is_active, must_change_password,
             failed_attempts, created_at, updated_at, last_password_change_at)
           VALUES (@username, @passwordHash, @fullName, @email, @phone, @isActive, @mustChange, 0, @now, @now, @now)`,
        )
        .run({
          username: input.username.trim(),
          passwordHash,
          fullName: input.fullName.trim(),
          email: input.email.trim(),
          phone: input.phone.trim(),
          isActive: input.isActive ? 1 : 0,
          mustChange: input.mustChangePassword ? 1 : 0,
          now,
        });
      const userId = Number(inserted.lastInsertRowid);
      this.setUserRoles(userId, input.roleIds);
      ctx.audit.record({
        action: 'create',
        entityType: 'user',
        entityId: userId,
        entityLabel: input.username.trim(),
        detail: `User account created with ${input.roleIds.length} role(s)`,
        after: { username: input.username.trim(), roles: input.roleIds },
      });
      return userId;
    })();
    return { id };
  }

  update(id: number, input: UserInput): void {
    requirePermission(this.context(), 'user.manage');
    this.validate(input);
    const ctx = this.context();
    const before = this.db.prepare(`SELECT username, full_name, is_active, must_change_password FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { username: string; full_name: string; is_active: number; must_change_password: number }
      | undefined;
    if (!before) throw AppError.notFound('User');
    if (asNumber(currentUserId(ctx)) === id && !input.isActive) {
      throw AppError.precondition('You cannot deactivate your own account.');
    }
    this.db.transaction(() => {
      this.assertUsernameFree(input.username, id);
      this.assertRoleIds(input.roleIds);
      this.db
        .prepare(
          `UPDATE users SET username = @username, full_name = @fullName, email = @email, phone = @phone,
             is_active = @isActive, must_change_password = @mustChange, updated_at = @now WHERE id = @id`,
        )
        .run({
          id,
          username: input.username.trim(),
          fullName: input.fullName.trim(),
          email: input.email.trim(),
          phone: input.phone.trim(),
          isActive: input.isActive ? 1 : 0,
          mustChange: input.mustChangePassword ? 1 : 0,
          now: ctx.instant(),
        });
      this.setUserRoles(id, input.roleIds);
      ctx.audit.record({
        action: 'update',
        entityType: 'user',
        entityId: id,
        entityLabel: input.username.trim(),
        detail: 'User account updated',
        before: { username: before.username, roles: this.rolesForUser(id).map((role) => role.key), isActive: fromBoolInt(before.is_active) },
        after: { username: input.username.trim(), roles: input.roleIds, isActive: input.isActive },
      });
    })();
  }

  delete(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'user.manage');
    const row = this.db.prepare(`SELECT username FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as { username: string } | undefined;
    if (!row) throw AppError.notFound('User');
    if (asNumber(currentUserId(this.context())) === id) throw AppError.precondition('You cannot delete your own account.');
    if (confirmText?.trim() !== row.username) {
      throw AppError.validation(`Type the username (${row.username}) to confirm deletion.`, { confirmText: `Type ${row.username} to confirm.` });
    }
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for deleting this user.', { reason: 'Reason is required.' });
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE users SET deleted_at = ?, deleted_reason = ?, is_active = 0, updated_at = ? WHERE id = ?`).run(
        ctx.instant(),
        reason.trim(),
        ctx.instant(),
        id,
      );
      this.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'user',
        entityId: id,
        entityLabel: row.username,
        detail: `User account deleted. Reason: ${reason.trim()}`,
        severity: 'critical',
      });
    })();
  }

  async resetPassword(id: number, newPassword: string, mustChange: boolean): Promise<void> {
    requirePermission(this.context(), 'user.manage');
    const user = this.db.prepare(`SELECT username FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as { username: string } | undefined;
    if (!user) throw AppError.notFound('User');
    const hash = await hashPassword(newPassword);
    const ctx = this.context();
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL,
           last_password_change_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(hash, mustChange ? 1 : 0, ctx.instant(), ctx.instant(), id);
    ctx.audit.record({
      action: 'update',
      entityType: 'user',
      entityId: id,
      entityLabel: user.username,
      detail: 'Password reset by an administrator',
      severity: 'warning',
    });
  }

  setActive(id: number, isActive: boolean): void {
    requirePermission(this.context(), 'user.manage');
    if (asNumber(currentUserId(this.context())) === id && !isActive) {
      throw AppError.precondition('You cannot deactivate your own account.');
    }
    const user = this.db.prepare(`SELECT username, is_active FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { username: string; is_active: number }
      | undefined;
    if (!user) throw AppError.notFound('User');
    const ctx = this.context();
    this.db
      .prepare(`UPDATE users SET is_active = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
      .run(isActive ? 1 : 0, ctx.instant(), id);
    ctx.audit.record({
      action: 'update',
      entityType: 'user',
      entityId: id,
      entityLabel: user.username,
      detail: `Account ${isActive ? 'activated' : 'deactivated'}`,
      severity: isActive ? 'info' : 'warning',
      before: { isActive: fromBoolInt(user.is_active) },
      after: { isActive },
    });
  }

  /** Active owners — used to stop the last owner from being removed. */
  activeOwnerCount(excludeUserId?: number): number {
    const params: unknown[] = [];
    let exclude = '';
    if (excludeUserId) {
      exclude = ' AND u.id <> ?';
      params.push(excludeUserId);
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT u.id) AS total FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE u.deleted_at IS NULL AND u.is_active = 1 AND r.key = ?${exclude}`,
      )
      .get(OWNER_ROLE_KEY, ...params) as { total: number };
    return asNumber(row.total);
  }

  private validate(input: UserInput): void {
    const fieldErrors: Record<string, string> = {};
    const username = input.username.trim();
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      fieldErrors.username = 'Use 3–32 characters: letters, numbers, dot, underscore or hyphen.';
    }
    if (input.fullName.trim().length < 2) fieldErrors.fullName = 'Enter the full name.';
    if (input.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) fieldErrors.email = 'Enter a valid email address.';
    if (input.phone.trim() !== '' && !/^[0-9+\-\s()]{6,20}$/.test(input.phone.trim())) fieldErrors.phone = 'Enter a valid phone number.';
    if (input.roleIds.length === 0) fieldErrors.roleIds = 'Select at least one role.';
    if (Object.keys(fieldErrors).length > 0) throw AppError.validation('Please correct the highlighted fields.', fieldErrors);
  }

  private assertUsernameFree(username: string, excludeId: number | null): void {
    const params: unknown[] = [username.trim()];
    let exclude = '';
    if (excludeId) {
      exclude = ' AND id <> ?';
      params.push(excludeId);
    }
    const existing = this.db
      .prepare(`SELECT id FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL${exclude}`)
      .get(...params) as { id: number } | undefined;
    if (existing) throw AppError.conflict('That username is already taken.');
  }

  private assertRoleIds(roleIds: readonly number[]): void {
    for (const roleId of roleIds) {
      const role = this.db.prepare(`SELECT id FROM roles WHERE id = ? AND deleted_at IS NULL`).get(roleId);
      if (!role) throw AppError.validation('Select valid roles.', { roleIds: 'One of the selected roles no longer exists.' });
    }
  }

  private setUserRoles(userId: number, roleIds: readonly number[]): void {
    this.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(userId);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`);
    for (const roleId of roleIds) insert.run(userId, roleId);
  }

  /** Builds the session object for a signed-in user (permissions expanded from roles). */
  buildSessionUser(userId: number, loginAt?: string): SessionUser {
    const row = this.db
      .prepare(`SELECT id, username, full_name, is_active, must_change_password, deleted_at FROM users WHERE id = ?`)
      .get(userId) as
      | { id: number; username: string; full_name: string; is_active: number; must_change_password: number; deleted_at: string | null }
      | undefined;
    if (!row || row.deleted_at) throw AppError.notFound('User');
    if (!fromBoolInt(row.is_active)) throw AppError.forbidden('This account has been deactivated. Ask an administrator to reactivate it.');
    const roles = this.rolesForUser(userId);
    const isOwner = roles.some((role) => role.key === OWNER_ROLE_KEY);
    const grants = roles.flatMap((role) => this.permissionsForRole(role.id));
    const user = createSessionUser({
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      roleIds: roles.map((role) => role.id),
      roleNames: roles.map((role) => role.name),
      isOwner,
      permissions: isOwner ? [...ALL_PERMISSION_KEYS] : expandGrants(grants),
      mustChangePassword: fromBoolInt(row.must_change_password),
    });
    return loginAt ? { ...user, loginAt } : user;
  }

  permissionsForRole(roleId: number): string[] {
    const rows = this.db.prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).all(roleId) as Array<{ permission_key: string }>;
    return rows.map((row) => row.permission_key);
  }

  /** Ensure the built-in roles exist and match the shipped presets. */
  ensureSystemRoles(): void {
    const ctx = this.context();
    const now = this.context().instant();
    this.db.transaction(() => {
      for (const preset of SYSTEM_ROLES) {
        const existing = this.db.prepare(`SELECT id FROM roles WHERE key = ?`).get(preset.key) as { id: number } | undefined;
        let roleId: number;
        if (existing) {
          roleId = existing.id;
          this.db
            .prepare(`UPDATE roles SET name = ?, description = ?, is_system = 1, updated_at = ?, deleted_at = NULL WHERE id = ?`)
            .run(preset.name, preset.description, now, roleId);
        } else {
          const inserted = this.db
            .prepare(`INSERT INTO roles (key, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
            .run(preset.key, preset.name, preset.description, now, now);
          roleId = Number(inserted.lastInsertRowid);
        }
        const grants = resolveRoleGrants(preset).filter((permission) => isPermissionKey(permission));
        this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(roleId);
        const insert = this.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`);
        for (const permission of grants) insert.run(roleId, permission);
      }
    })();
    ctx.logger.debug('system roles ensured');
  }

  // --- Roles --------------------------------------------------------------

  listRoles(): Role[] {
    requireAnyPermission(this.context(), ['role.manage', 'user.manage']);
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
           FROM roles r WHERE r.deleted_at IS NULL ORDER BY r.is_system DESC, r.name`,
      )
      .all() as Array<{ id: number; key: string; name: string; description: string; is_system: number; user_count: number }>;
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      isSystem: fromBoolInt(row.is_system),
      permissions: this.permissionsForRole(row.id),
      userCount: asNumber(row.user_count),
    }));
  }

  getRole(id: number): Role {
    const role = this.listRoles().find((entry) => entry.id === id);
    if (!role) throw AppError.notFound('Role');
    return role;
  }

  saveRole(id: number | null, input: RoleInput): { id: number } {
    requirePermission(this.context(), 'role.manage');
    const name = input.name.trim();
    if (name.length < 2) throw AppError.validation('Give the role a name.', { name: 'Name is required.' });
    const unknown = input.permissions.filter((permission) => !isPermissionKey(permission));
    if (unknown.length > 0) throw AppError.validation(`Unknown permission(s): ${unknown.join(', ')}.`, { permissions: 'One or more permissions are not valid.' });
    const ctx = this.context();
    const now = this.context().instant();
    if (id) {
      const existing = this.db.prepare(`SELECT key, is_system FROM roles WHERE id = ? AND deleted_at IS NULL`).get(id) as
        | { key: string; is_system: number }
        | undefined;
      if (!existing) throw AppError.notFound('Role');
      if (existing.key === OWNER_ROLE_KEY) {
        throw AppError.precondition('The owner role always has full access and cannot be edited.');
      }
      if (fromBoolInt(existing.is_system) && input.permissions.length === 0) {
        throw AppError.validation('A built-in role must keep at least one permission.', { permissions: 'Select permissions.' });
      }
      this.db.transaction(() => {
        this.db.prepare(`UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(name, input.description.trim(), now, id);
        this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(id);
        const insert = this.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`);
        for (const permission of input.permissions) insert.run(id, permission);
        ctx.audit.record({
          action: 'update',
          entityType: 'role',
          entityId: id,
          entityLabel: name,
          detail: `Role updated with ${input.permissions.length} permission(s)`,
          severity: 'warning',
          after: { name, permissions: input.permissions.length },
        });
      })();
      return { id };
    }
    const key = (input.key ?? name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (key === '') throw AppError.validation('Role name cannot be used as a key.', { name: 'Use letters or numbers.' });
    const duplicate = this.db.prepare(`SELECT id FROM roles WHERE key = ?`).get(key) as { id: number } | undefined;
    if (duplicate) throw AppError.conflict('A role with this name already exists.');
    const roleId = this.db.transaction(() => {
      const inserted = this.db
        .prepare(`INSERT INTO roles (key, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`)
        .run(key, name, input.description.trim(), now, now);
      const newId = Number(inserted.lastInsertRowid);
      const insert = this.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`);
      for (const permission of input.permissions) insert.run(newId, permission);
      ctx.audit.record({
        action: 'create',
        entityType: 'role',
        entityId: newId,
        entityLabel: name,
        detail: `Custom role created with ${input.permissions.length} permission(s)`,
      });
      return newId;
    })();
    return { id: roleId };
  }

  deleteRole(id: number, reason: string, confirmText?: string): void {
    requirePermission(this.context(), 'role.manage');
    const role = this.db.prepare(`SELECT key, name, is_system FROM roles WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { key: string; name: string; is_system: number }
      | undefined;
    if (!role) throw AppError.notFound('Role');
    if (fromBoolInt(role.is_system)) throw AppError.precondition('Built-in roles cannot be deleted.');
    const inUse = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM user_roles WHERE role_id = ?`).get(id) as { total: number }).total);
    if (inUse > 0) throw AppError.precondition(`This role is assigned to ${inUse} user(s). Move them to another role first.`);
    if (confirmText?.trim() !== role.name) {
      throw AppError.validation(`Type the role name (${role.name}) to confirm deletion.`, { confirmText: `Type ${role.name} to confirm.` });
    }
    if (reason.trim().length < 3) throw AppError.validation('Please give a reason for deleting this role.', { reason: 'Reason is required.' });
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE roles SET deleted_at = ? WHERE id = ?`).run(ctx.instant(), id);
      this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'role',
        entityId: id,
        entityLabel: role.name,
        detail: `Role deleted. Reason: ${reason.trim()}`,
        severity: 'critical',
      });
    })();
  }

  permissionCatalogue(): Array<{ key: string; group: string; label: string; description: string; sensitive: boolean; groupLabel: string }> {
    requireAnyPermission(this.context(), ['role.manage', 'user.manage']);
    return PERMISSION_DEFINITIONS.map((definition) => ({
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description ?? '',
      sensitive: 'sensitive' in definition ? Boolean(definition.sensitive) : false,
      groupLabel: PERMISSION_GROUP_LABELS[definition.group as PermissionGroup] ?? definition.group,
    }));
  }

  rolePresets(): Array<{ key: string; name: string; description: string; permissions: string[] }> {
    return SYSTEM_ROLES.map((preset) => ({
      key: preset.key,
      name: preset.name,
      description: preset.description,
      permissions: resolveRoleGrants(preset),
    }));
  }

  /** Is this user allowed to manage users? (used by the setup wizard) */
  canManageUsers(userId: number): boolean {
    const roles = this.rolesForUser(userId);
    const grants = roles.flatMap((role) => this.permissionsForRole(role.id));
    return roles.some((role) => role.key === OWNER_ROLE_KEY) || grants.some((grant) => grant === '*' || grant.startsWith('user.'));
  }

  /** Resolve a role by key (system roles are created on first use). */
  roleIdByKey(key: string): number | null {
    const row = this.db.prepare(`SELECT id FROM roles WHERE key = ? AND deleted_at IS NULL`).get(key) as { id: number } | undefined;
    if (row) return row.id;
    const preset = rolePreset(key);
    if (!preset) return null;
    this.ensureSystemRoles();
    const created = this.db.prepare(`SELECT id FROM roles WHERE key = ?`).get(key) as { id: number } | undefined;
    return created ? created.id : null;
  }

  /** Record a login attempt for the security history. */
  recordLoginAttempt(username: string, success: boolean, reason: string, machine: string): void {
    this.db
      .prepare(`INSERT INTO login_attempts (username, success, reason, attempted_at, machine) VALUES (?, ?, ?, ?, ?)`)
      .run(username, success ? 1 : 0, reason, this.context().instant(), machine);
    this.db.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`).run(isoDaysAgo(180));
  }

  recentLoginAttempts(limit = 50): Array<{ username: string; success: boolean; reason: string; attemptedAt: string }> {
    requirePermission(this.context(), 'user.view');
    const rows = this.db
      .prepare(`SELECT username, success, reason, attempted_at FROM login_attempts ORDER BY attempted_at DESC LIMIT ?`)
      .all(limit) as Array<{ username: string; success: number; reason: string; attempted_at: string }>;
    return rows.map((row) => ({
      username: row.username,
      success: fromBoolInt(row.success),
      reason: row.reason,
      attemptedAt: row.attempted_at,
    }));
  }

  /** Username suggestions for the login screen (never passwords). */
  usernames(): Array<{ username: string; fullName: string }> {
    const rows = this.db
      .prepare(`SELECT username, full_name FROM users WHERE deleted_at IS NULL AND is_active = 1 ORDER BY full_name`)
      .all() as Array<{ username: string; full_name: string }>;
    return rows.map((row) => ({ username: row.username, fullName: row.full_name }));
  }

  /** Staff-linked account (used by the staff screen). */
  staffForUser(userId: number): { id: number; name: string } | null {
    const row = this.db.prepare(`SELECT id, name FROM staff WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as
      | { id: number; name: string }
      | undefined;
    return row ?? null;
  }

  /** Display label used in audit details and dropdowns. */
  label(userId: number): string {
    const row = this.db.prepare(`SELECT full_name, username FROM users WHERE id = ?`).get(userId) as
      | { full_name: string; username: string }
      | undefined;
    if (!row) return 'Unknown user';
    return row.full_name.trim() === '' ? row.username : `${row.full_name} (${row.username})`;
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
