/**
 * Session state.
 *
 * Sessions live only in the main process: the renderer holds the resulting
 * profile (name, roles, permission list) which is never trusted for
 * authorisation. The manager also owns the idle auto-lock deadline.
 */
import type { SessionUser } from '@shared/types';
import { nowInstant } from '@shared/dates';

export type LockReason = 'manual' | 'idle' | 'security';

export interface SessionSnapshot {
  readonly user: SessionUser;
  readonly locked: boolean;
  readonly lastActivityAt: string;
}

export class SessionManager {
  private user: SessionUser | null = null;
  private locked = true;
  private lastActivityAt = 0;
  private autoLockMinutes = 10;

  constructor(autoLockMinutes = 10) {
    this.autoLockMinutes = autoLockMinutes;
  }

  setAutoLockMinutes(minutes: number): void {
    this.autoLockMinutes = minutes;
  }

  getAutoLockMinutes(): number {
    return this.autoLockMinutes;
  }

  start(user: SessionUser): void {
    this.user = user;
    this.locked = false;
    this.lastActivityAt = Date.now();
  }

  end(): void {
    this.user = null;
    this.locked = true;
    this.lastActivityAt = 0;
  }

  lock(): void {
    if (this.user) this.locked = true;
  }

  unlock(): void {
    if (this.user) {
      this.locked = false;
      this.lastActivityAt = Date.now();
    }
  }

  isAuthenticated(): boolean {
    return this.user !== null;
  }

  isLocked(): boolean {
    return this.user === null || this.locked;
  }

  currentUser(): SessionUser | null {
    return this.user;
  }

  /** Refresh the idle deadline; called on every authorised API call. */
  touch(): void {
    if (this.user && !this.locked) this.lastActivityAt = Date.now();
  }

  /** Auto-lock deadline in epoch milliseconds, or null when disabled/free. */
  autoLockDeadline(): number | null {
    if (!this.user || this.locked || this.autoLockMinutes <= 0) return null;
    return this.lastActivityAt + this.autoLockMinutes * 60_000;
  }

  shouldAutoLock(now = Date.now()): boolean {
    const deadline = this.autoLockDeadline();
    return deadline !== null && now >= deadline;
  }

  updateUser(patch: Partial<SessionUser>): void {
    if (!this.user) return;
    this.user = { ...this.user, ...patch };
  }

  snapshot(): SessionSnapshot | null {
    if (!this.user) return null;
    return {
      user: this.user,
      locked: this.locked,
      lastActivityAt: new Date(this.lastActivityAt || Date.now()).toISOString(),
    };
  }

  /** Remaining idle time in seconds before auto-lock (null when disabled). */
  remainingSeconds(now = Date.now()): number | null {
    const deadline = this.autoLockDeadline();
    if (deadline === null) return null;
    return Math.max(0, Math.round((deadline - now) / 1000));
  }

  descriptor(): { authenticated: boolean; locked: boolean; user: SessionUser | null; since: string | null } {
    return {
      authenticated: this.user !== null,
      locked: this.isLocked(),
      user: this.user,
      since: this.user ? this.user.loginAt : null,
    };
  }
}

export function createSessionUser(input: {
  id: number;
  username: string;
  fullName: string;
  roleIds: number[];
  roleNames: string[];
  isOwner: boolean;
  permissions: string[];
  mustChangePassword: boolean;
}): SessionUser {
  return {
    id: input.id,
    username: input.username,
    fullName: input.fullName,
    roleIds: input.roleIds,
    roleNames: input.roleNames,
    isOwner: input.isOwner,
    permissions: input.permissions,
    mustChangePassword: input.mustChangePassword,
    loginAt: nowInstant(),
  };
}
