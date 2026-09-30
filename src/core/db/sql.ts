/**
 * Small SQL helpers shared by the repositories: row decoding, JSON columns,
 * identifier quoting and value coercion.
 */

export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function parseJsonObject<T extends Record<string, unknown>>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    return fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function toJsonArray(values: readonly string[] | undefined | null): string {
  return JSON.stringify(values ?? []);
}

export function toBoolInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

export function fromBoolInt(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = asString(value, '');
  return text === '' ? null : text;
}

/** Escape a `LIKE` pattern fragment so user input cannot inject wildcards. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Build `%term%` for LIKE queries with escaping applied. */
export function likeTerm(value: string): string {
  return `%${escapeLike(value.trim())}%`;
}

/** Turn user input into a safe FTS5 prefix query. */
export function ftsQuery(value: string): string | null {
  const terms = value
    .split(/\s+/)
    .map((term) => term.replace(/["*():^]/g, '').trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(' AND ');
}

export function paginate(
  page: number | undefined,
  pageSize: number | undefined,
): { limit: number; offset: number; page: number; pageSize: number } {
  const safePageSize = Math.min(Math.max(Math.trunc(pageSize ?? 50), 1), 500);
  const safePage = Math.max(Math.trunc(page ?? 1), 1);
  return { limit: safePageSize, offset: (safePage - 1) * safePageSize, page: safePage, pageSize: safePageSize };
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Compose an optional date-range filter fragment. */
export function dateRangeClause(column: string, from: string | undefined, to: string | undefined, params: unknown[]): string {
  const clauses: string[] = [];
  if (from) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

export function buildWhere(clauses: Array<string | null | undefined | false>): string {
  const active = clauses.filter((clause): clause is string => typeof clause === 'string' && clause.trim() !== '');
  return active.length > 0 ? ` WHERE ${active.join(' AND ')}` : '';
}

export function buildSet(columns: readonly string[]): string {
  return columns.map((column) => `${column} = @${column}`).join(', ');
}

/** Convert 0/1 columns into booleans in a single place. */
export function decodeBooleans<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  const clone: Record<string, unknown> = { ...row };
  for (const key of keys) {
    if (key in clone) clone[key] = fromBoolInt(clone[key]);
  }
  return clone as T;
}

export function sumColumn(
  db: { prepare: (sql: string) => { get: (...params: unknown[]) => unknown } },
  sql: string,
  params: unknown[] = [],
): number {
  const row = db.prepare(sql).get(...params) as { total?: number | null } | undefined;
  return asNumber(row?.total ?? 0, 0);
}
