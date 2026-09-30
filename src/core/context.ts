/**
 * Core execution context.
 *
 * Every service receives this object: it carries the database handle, the local
 * paths, the logger, the audit writer, the session and an injectable clock (so
 * tests can control time without mocking modules).
 */
import type { SqliteDatabase } from './db/connection';
import type { Logger } from './util/logger';
import type { SessionManager } from './security/session';

import { AppError } from '@shared/errors';
import { permissionMatches } from '@shared/permissions';

export interface CorePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly attachmentsDir: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  readonly configDir: string;
  readonly tempDir: string;
  readonly exportsDir: string;
}

export interface AuditEntryInput {
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: number | null;
  readonly entityLabel?: string;
  readonly detail?: string;
  readonly severity?: 'info' | 'warning' | 'critical';
  readonly before?: unknown;
  readonly after?: unknown;
  readonly context?: Record<string, string>;
  /** Attribution when the action was not performed by the signed-in user. */
  readonly actor?: { id: number | null; name: string };
}

export interface AuditWriter {
  record(entry: AuditEntryInput): void;
}

export interface CoreContext {
  readonly db: SqliteDatabase;
  readonly logger: Logger;
  readonly paths: CorePaths;
  readonly session: SessionManager;
  readonly audit: AuditWriter;
  readonly appVersion: string;
  readonly appBuild: string;
  readonly machineGuid: string;
  /** Wall clock — injectable for deterministic tests. */
  now(): Date;
  /** ISO date (`YYYY-MM-DD`) in the clinic's time zone. */
  today(): string;
  /** ISO instant. */
  instant(): string;
  /** Clinic time zone from settings. */
  timeZone(): string;
  /** Called after a successful mutation so the main process can refresh caches. */
  notify?(event: string, payload?: Record<string, unknown>): void;
}

export function hasPermission(ctx: CoreContext, permission: string): boolean {
  const user = ctx.session.currentUser();
  if (!user) return false;
  if (user.isOwner) return true;
  return permissionMatches(user.permissions, permission);
}

export function hasEveryPermission(ctx: CoreContext, permissions: readonly string[]): boolean {
  return permissions.every((permission) => hasPermission(ctx, permission));
}

/** Throws a FORBIDDEN AppError unless the session holds `permission`. */
/** Accepts any permission string so callers can pass a computed key. */
export function requirePermission(ctx: CoreContext, permission: string): void {
  const user = ctx.session.currentUser();
  if (!user) throw AppError.unauthenticated();
  if (ctx.session.isLocked()) throw AppError.locked();
  if (!hasPermission(ctx, permission)) {
    throw AppError.forbidden(
      `Your role does not include the “${permission}” permission. Ask the clinic owner or an administrator to grant it.`,
    );
  }
}

export function requireAnyPermission(ctx: CoreContext, permissions: readonly string[]): void {
  const user = ctx.session.currentUser();
  if (!user) throw AppError.unauthenticated();
  if (ctx.session.isLocked()) throw AppError.locked();
  if (!permissions.some((permission) => hasPermission(ctx, permission))) {
    throw AppError.forbidden('Your role does not include permission for this action.');
  }
}

/** Requires an authenticated, unlocked session without a specific permission. */
export function requireSession(ctx: CoreContext): void {
  const user = ctx.session.currentUser();
  if (!user) throw AppError.unauthenticated();
  if (ctx.session.isLocked()) throw AppError.locked();
}

export function currentUserName(ctx: CoreContext): string {
  return ctx.session.currentUser()?.fullName || ctx.session.currentUser()?.username || 'system';
}

export function currentUserId(ctx: CoreContext): number | null {
  return ctx.session.currentUser()?.id ?? null;
}

/** Create a lightweight context clone with a different clock (used in tests). */
export function withClock(ctx: CoreContext, now: () => Date): CoreContext {
  return { ...ctx, now };
}
