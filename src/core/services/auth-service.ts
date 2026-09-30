/**
 * Authentication.
 *
 * Passwords are verified with Argon2id; failures are counted and the account is
 * temporarily locked after the configured number of attempts (settings centre →
 * Security). Everything here runs in the main process — the renderer only ever
 * receives the resulting `SessionUser`.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { requireSession } from '../context';
import type { SessionUser } from '@shared/types';
import type { LockReason } from '../security/session';
import { AppError } from '@shared/errors';
import { hashPassword, validatePassword, verifyPassword } from '../security/password';
import {} from '@shared/dates';
import type { UserService } from './user-service';
import type { SettingsService } from './settings-service';

export interface LoginResult {
  user: SessionUser;
  mustChangePassword: boolean;
}

export class AuthService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly users: UserService,
    private readonly settings: SettingsService,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  /**
   * Sign in. The session is only started on success; every outcome (success or
   * failure) is recorded in `login_attempts` and the audit log.
   */
  async login(username: string, password: string): Promise<LoginResult> {
    const ctx = this.context();
    const machine = ctx.machineGuid;
    const cleanUsername = username.trim();
    if (cleanUsername === '' || password === '') {
      const fieldErrors: Record<string, string> = {};
      if (cleanUsername === '') fieldErrors['username'] = 'Enter your username.';
      if (password === '') fieldErrors['password'] = 'Enter your password.';
      throw AppError.validation('Enter your username and password.', fieldErrors);
    }

    const row = this.db
      .prepare(`SELECT * FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL`)
      .get(cleanUsername) as
      | {
          id: number;
          username: string;
          password_hash: string;
          is_active: number;
          failed_attempts: number;
          locked_until: string | null;
        }
      | undefined;

    // A single generic message: never reveal whether the username exists.
    const invalid = () => AppError.unauthenticated('The username or password is not correct.');

    if (!row) {
      this.users.recordLoginAttempt(cleanUsername, false, 'unknown username', machine);
      ctx.audit.record({
        action: 'login_failed',
        entityType: 'user',
        entityLabel: cleanUsername,
        detail: 'Sign-in attempt with an unknown username',
        severity: 'warning',
        actor: { id: null, name: cleanUsername },
      });
      throw invalid();
    }

    if (row.locked_until && row.locked_until > ctx.instant()) {
      this.users.recordLoginAttempt(row.username, false, 'account locked', machine);
      throw AppError.rateLimited(
        `This account is temporarily locked after too many failed attempts. Try again after ${this.formatLockTime(row.locked_until)}.`,
        this.settings.getSettings().lockoutMinutes,
      );
    }

    if (row.is_active !== 1) {
      this.users.recordLoginAttempt(row.username, false, 'inactive account', machine);
      throw AppError.forbidden('This account has been deactivated. Ask an administrator to reactivate it.');
    }

    const passwordOk = await verifyPassword(password, row.password_hash);
    if (!passwordOk) {
      const attempts = row.failed_attempts + 1;
      const appSettings = this.settings.getSettings();
      const maxAttempts = Math.max(1, appSettings.maxFailedAttempts);
      const lockedUntil = attempts >= maxAttempts ? instantPlusMinutes(ctx.instant(), Math.max(1, appSettings.lockoutMinutes)) : null;
      this.db
        .prepare(`UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?`)
        .run(attempts, lockedUntil, ctx.instant(), row.id);
      this.users.recordLoginAttempt(row.username, false, 'wrong password', machine);
      ctx.audit.record({
        action: 'login_failed',
        entityType: 'user',
        entityId: row.id,
        entityLabel: row.username,
        detail:
          lockedUntil === null
            ? `Incorrect password (attempt ${attempts} of ${maxAttempts})`
            : `Incorrect password — account locked until ${lockedUntil}`,
        severity: lockedUntil === null ? 'warning' : 'critical',
        actor: { id: null, name: row.username },
      });
      if (lockedUntil) {
        throw AppError.rateLimited(
          `Too many failed attempts. This account is locked for ${appSettings.lockoutMinutes} minutes.`,
          appSettings.lockoutMinutes,
        );
      }
      const remaining = Math.max(0, maxAttempts - attempts);
      throw AppError.unauthenticated(
        `The username or password is not correct.${remaining > 0 ? ` ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : ''}`,
      );
    }

    const sessionUser = this.users.buildSessionUser(row.id);
    this.db
      .prepare(`UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`)
      .run(ctx.instant(), ctx.instant(), row.id);
    this.users.recordLoginAttempt(row.username, true, '', machine);
    ctx.session.setAutoLockMinutes(this.settings.getSettings().autoLockMinutes);
    ctx.session.start(sessionUser);
    ctx.audit.record({
      action: 'login',
      entityType: 'user',
      entityId: row.id,
      entityLabel: row.username,
      detail: `Signed in${sessionUser.roleNames.length > 0 ? ` as ${sessionUser.roleNames.join(', ')}` : ''}`,
    });
    ctx.notify?.('session.changed', {});
    return { user: sessionUser, mustChangePassword: sessionUser.mustChangePassword };
  }

  /** Sign out; the audit entry stays behind for the security history. */
  logout(): void {
    const ctx = this.context();
    const user = ctx.session.currentUser();
    if (!user) {
      ctx.session.end();
      return;
    }
    ctx.audit.record({ action: 'logout', entityType: 'user', entityId: user.id, entityLabel: user.username, detail: 'Signed out' });
    ctx.session.end();
    ctx.notify?.('session.changed', {});
  }

  /** Lock the screen (manual lock, idle auto-lock or a security event). */
  lock(reason: LockReason = 'manual'): void {
    const ctx = this.context();
    const user = ctx.session.currentUser();
    if (!user) throw AppError.unauthenticated();
    ctx.session.lock();
    ctx.audit.record({
      action: 'lock',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.username,
      detail: reason === 'idle' ? 'Screen locked automatically after inactivity' : `Screen locked (${reason})`,
    });
    ctx.notify?.('session.locked', { reason });
  }

  /** Unlock with the signed-in user's own password. */
  async unlock(password: string): Promise<SessionUser> {
    const ctx = this.context();
    const user = ctx.session.currentUser();
    if (!user) throw AppError.unauthenticated('Your session has ended. Please sign in again.');
    if (!ctx.session.isLocked()) return user;
    const row = this.db.prepare(`SELECT password_hash, is_active FROM users WHERE id = ? AND deleted_at IS NULL`).get(user.id) as
      | { password_hash: string; is_active: number }
      | undefined;
    if (!row) throw AppError.unauthenticated('Your account is no longer available. Please sign in again.');
    if (row.is_active !== 1) throw AppError.forbidden('This account has been deactivated.');
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      ctx.audit.record({
        action: 'unlock_failed',
        entityType: 'user',
        entityId: user.id,
        entityLabel: user.username,
        detail: 'Incorrect password on the lock screen',
        severity: 'warning',
      });
      throw AppError.unauthenticated('That password is not correct.');
    }
    ctx.session.unlock();
    ctx.audit.record({ action: 'unlock', entityType: 'user', entityId: user.id, entityLabel: user.username, detail: 'Screen unlocked' });
    ctx.notify?.('session.unlocked', {});
    return ctx.session.currentUser() ?? user;
  }

  /** Change your own password (also clears the "must change" flag). */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const ctx = this.context();
    requireSession(ctx);
    const user = ctx.session.currentUser();
    if (!user) throw AppError.unauthenticated();
    const row = this.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(user.id) as { password_hash: string } | undefined;
    if (!row) throw AppError.unauthenticated();
    const ok = await verifyPassword(currentPassword, row.password_hash);
    if (!ok) throw AppError.validation('Your current password is not correct.', { currentPassword: 'Incorrect password.' });
    const validation = validatePassword(newPassword, { username: user.username, fullName: user.fullName });
    if (!validation.ok) {
      const message = validation.problems.join(' ');
      throw AppError.validation(message, { newPassword: message });
    }
    const sameAsOld = await verifyPassword(newPassword, row.password_hash);
    if (sameAsOld) throw AppError.validation('Choose a password you have not used before.', { newPassword: 'This is your current password.' });
    const hash = await hashPassword(newPassword);
    this.db
      .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, last_password_change_at = ?, updated_at = ? WHERE id = ?`)
      .run(hash, ctx.instant(), ctx.instant(), user.id);
    ctx.session.updateUser({ mustChangePassword: false });
    ctx.audit.record({
      action: 'password_change',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.username,
      detail: 'Password changed by the account holder',
      severity: 'warning',
    });
    ctx.notify?.('session.changed', {});
  }

  /** Current session (null when signed out). */
  session(): SessionUser | null {
    return this.context().session.currentUser();
  }

  /** Called by the main process on a timer; returns true when it locked. */
  enforceAutoLock(): boolean {
    const ctx = this.context();
    if (!ctx.session.shouldAutoLock()) return false;
    this.lock('idle');
    return true;
  }

  /** Refresh the idle deadline (called after every authorised API call). */
  touch(): void {
    this.context().session.touch();
  }

  /** Refresh the cached session model after roles/permissions change. */
  refreshSession(): SessionUser | null {
    const ctx = this.context();
    const current = ctx.session.currentUser();
    if (!current) return null;
    const updated = this.users.buildSessionUser(current.id, current.loginAt);
    ctx.session.updateUser(updated);
    ctx.notify?.('session.changed', {});
    return updated;
  }

  /** Is there at least one active user account? (setup wizard + bootstrap) */
  hasAnyUser(): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM users WHERE deleted_at IS NULL AND is_active = 1`).get() as { total: number };
    return Number(row.total) > 0;
  }

  /** Are any users still on a temporary password? (dashboard security hint) */
  pendingPasswordChangeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM users WHERE deleted_at IS NULL AND is_active = 1 AND must_change_password = 1`)
      .get() as { total: number };
    return Number(row.total);
  }

  /** Lock-screen hint: the account that is currently signed in. */
  accountLabel(): string | null {
    const user = this.context().session.currentUser();
    return user ? `${user.fullName || user.username}` : null;
  }

  /** Small helper for the login screen: remembers the last signed-in name. */
  lastUsername(): string | null {
    const row = this.db
      .prepare(`SELECT username FROM login_attempts WHERE success = 1 ORDER BY attempted_at DESC LIMIT 1`)
      .get() as { username: string } | undefined;
    return row?.username ?? null;
  }

  /** Time until the auto-lock, for the header countdown (null when disabled). */
  autoLockRemainingSeconds(): number | null {
    return this.context().session.remainingSeconds();
  }

  private formatLockTime(instant: string): string {
    const date = new Date(instant);
    if (Number.isNaN(date.getTime())) return 'a few minutes';
    const minutes = Math.max(1, Math.round((date.getTime() - Date.now()) / 60_000));
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }

  /** Current instant helper (kept for callers that need the clock convention). */
  now(): string {
    return this.context().instant();
  }
}

/** ISO instant shifted by whole minutes (used for the lockout window). */
function instantPlusMinutes(instant: string, minutes: number): string {
  const date = new Date(instant);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}
