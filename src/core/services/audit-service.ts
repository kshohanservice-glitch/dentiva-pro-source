/**
 * Audit trail.
 *
 * Entries are append-only: the application exposes no API that edits or deletes
 * an audit row. Sensitive actions (authentication, permissions, destructive
 * operations, financial reversals, restore) record before/after state where it
 * is meaningful.
 */
import type { SqliteDatabase } from '../db/connection';
import type { AuditEntryInput, CoreContext, AuditWriter } from '../context';
import { currentUserId, currentUserName } from '../context';
import type { AuditEntry, AuditEntryDetail, AuditListQuery, Paged } from '@shared/types';
import { AUDIT_ACTION_LABELS, type AuditAction } from '@shared/constants';
import { asNumber, asNullableString, asString, buildWhere, dateRangeClause, likeTerm, paginate, pageCount } from '../db/sql';
import { nowInstant, resolveDateRange } from '@shared/dates';
import { AppError } from '@shared/errors';

interface AuditRow {
  id: number;
  action: string;
  entity_type: string;
  entity_id: number | null;
  entity_label: string;
  user_id: number | null;
  user_name: string;
  detail: string;
  severity: string;
  before_json: string | null;
  after_json: string | null;
  context_json: string | null;
  created_at: string;
}

function actionLabel(action: string): string {
  return (AUDIT_ACTION_LABELS as Record<string, string | undefined>)[action] ?? action;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    action: row.action,
    actionLabel: actionLabel(row.action),
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    userId: row.user_id,
    userName: row.user_name,
    detail: row.detail,
    severity: (row.severity === 'critical' || row.severity === 'warning' ? row.severity : 'info'),
    createdAt: row.created_at,
    hasBeforeAfter: Boolean(row.before_json || row.after_json),
  };
}

export class AuditService implements AuditWriter {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly getContext: () => CoreContext | null,
  ) {}

  record(entry: AuditEntryInput): void {
    const ctx = this.getContext();
    const actorId = entry.actor ? entry.actor.id : ctx ? currentUserId(ctx) : null;
    const actorName = entry.actor ? entry.actor.name : ctx ? currentUserName(ctx) : 'system';
    const context: Record<string, string> = { ...(entry.context ?? {}) };
    if (ctx) {
      context.appVersion = ctx.appVersion;
      context.timeZone = ctx.timeZone();
    }
    this.db
      .prepare(
        `INSERT INTO audit_logs
           (action, entity_type, entity_id, entity_label, user_id, user_name, detail, severity,
            before_json, after_json, context_json, session_id, machine, created_at)
         VALUES (@action, @entityType, @entityId, @entityLabel, @userId, @userName, @detail, @severity,
                 @beforeJson, @afterJson, @contextJson, '', '', @createdAt)`,
      )
      .run({
        action: entry.action,
        entityType: entry.entityType ?? '',
        entityId: entry.entityId ?? null,
        entityLabel: entry.entityLabel ?? '',
        userId: actorId,
        userName: actorName,
        detail: entry.detail ?? '',
        severity: entry.severity ?? 'info',
        beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
        afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
        contextJson: Object.keys(context).length > 0 ? JSON.stringify(context) : null,
        createdAt: ctx ? ctx.instant() : nowInstant(),
      });
    ctx?.notify?.('audit.recorded');
  }

  /** Convenience wrapper used by security-sensitive code paths. */
  recordAction(action: AuditAction, entityType: string, entityId: number | null, detail: string, severity: AuditEntryInput['severity'] = 'info'): void {
    this.record({ action, entityType, entityId, detail, severity });
  }

  list(query: AuditListQuery): Paged<AuditEntry> {
    const { limit, offset, page, pageSize } = paginate(query.page, query.pageSize);
    const params: unknown[] = [];
    const preset = query.preset && query.preset !== 'all' ? (query.preset as Parameters<typeof resolveDateRange>[0]) : undefined;
    const range = preset ? resolveDateRange(preset, { custom: { from: query.from, to: query.to } }) : { from: query.from, to: query.to };
    const clauses: Array<string | null> = [
      range.from ? `created_at >= ?` : null,
      range.to ? `substr(created_at, 1, 10) <= ?` : null,
    ];
    if (range.from) params.push(range.from);
    if (range.to) params.push(range.to);
    if (query.action && query.action.length > 0) {
      clauses.push(`action IN (${query.action.map(() => '?').join(', ')})`);
      params.push(...query.action);
    }
    if (query.userId !== undefined && query.userId !== null) {
      clauses.push(`user_id = ?`);
      params.push(query.userId);
    }
    if (query.entityType) {
      clauses.push(`entity_type = ?`);
      params.push(query.entityType);
    }
    if (query.severity && query.severity.length > 0) {
      clauses.push(`severity IN (${query.severity.map(() => '?').join(', ')})`);
      params.push(...query.severity);
    }
    if (query.search && query.search.trim() !== '') {
      clauses.push(`(detail LIKE ? ESCAPE '\\' OR entity_label LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\')`);
      const term = likeTerm(query.search);
      params.push(term, term, term);
    }
    const where = buildWhere(clauses);
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM audit_logs${where}`).get(...params) as { total: number }).total);
    const rows = this.db
      .prepare(`SELECT * FROM audit_logs${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AuditRow[];
    return { items: rows.map(toEntry), total, page, pageSize, pageCount: pageCount(total, pageSize) };
  }

  get(id: number): AuditEntryDetail {
    const row = this.db.prepare(`SELECT * FROM audit_logs WHERE id = ?`).get(id) as AuditRow | undefined;
    if (!row) throw AppError.notFound('Audit entry');
    const parse = (value: string | null): unknown => {
      if (!value) return null;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    };
    const context = parse(row.context_json);
    const contextRecord: Record<string, string> = {};
    if (context && typeof context === 'object') {
      for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
        contextRecord[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    return {
      ...toEntry(row),
      before: parse(row.before_json),
      after: parse(row.after_json),
      context: contextRecord,
    };
  }

  /** Rows for CSV/PDF export within a date range. */
  exportRows(from: string | undefined, to: string | undefined, limit = 100_000): AuditEntry[] {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (from) {
      clauses.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('substr(created_at, 1, 10) <= ?');
      params.push(to);
    }
    const where = buildWhere(clauses);
    const rows = this.db
      .prepare(`SELECT * FROM audit_logs${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as AuditRow[];
    return rows.map(toEntry);
  }

  actions(): Array<{ action: string; label: string; count: number }> {
    const rows = this.db
      .prepare(`SELECT action, COUNT(*) AS count FROM audit_logs GROUP BY action ORDER BY count DESC`)
      .all() as Array<{ action: string; count: number }>;
    return rows.map((row) => ({ action: row.action, label: actionLabel(row.action), count: asNumber(row.count) }));
  }

  counts(): { total: number; critical: number; last24h: number } {
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM audit_logs`).get() as { total: number }).total);
    const critical = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM audit_logs WHERE severity IN ('critical','warning')`).get() as { total: number }).total,
    );
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const last24h = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM audit_logs WHERE created_at >= ?`).get(since) as { total: number }).total,
    );
    return { total, critical, last24h };
  }

  /** Entity change history used by clinical screens ("who changed this?"). */
  forEntity(entityType: string, entityId: number, limit = 50): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(entityType, entityId, limit) as AuditRow[];
    return rows.map(toEntry);
  }
}

export function describeEntity(entityType: string, id: number | null, label = ''): string {
  if (label) return label;
  return id === null ? entityType : `${entityType} #${id}`;
}

export function auditFieldDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before || !after) return '';
  const changes: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push(`${key}: ${formatValue(a)} → ${formatValue(b)}`);
    }
  }
  return changes.slice(0, 25).join('; ');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export { asNullableString, asString, dateRangeClause };
