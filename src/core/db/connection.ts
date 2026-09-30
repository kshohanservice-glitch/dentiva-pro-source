/**
 * SQLite connection management: pragmas, migrations, transactions and the
 * integrity helpers used by the backup and diagnostic paths.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, LATEST_SCHEMA_VERSION, FTS_TABLES, type Migration } from './schema';

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  /** Skip running migrations (used when inspecting a backup file). */
  readonly skipMigrations?: boolean;
  readonly onLog?: (message: string) => void;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly version: number;
}

function ensureDirectory(filePath: string): void {
  if (filePath === ':memory:') return;
  mkdirSync(dirname(filePath), { recursive: true });
}

export function applyConnectionPragmas(db: SqliteDatabase, readonly = false): void {
  db.pragma('journal_mode = WAL');
  // FULL synchronous keeps clinical writes durable across power loss.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 8000');
  db.pragma('temp_store = MEMORY');
  // A negative cache size is interpreted in KiB; ~64 MiB keeps hot pages in memory.
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  if (readonly) db.pragma('query_only = ON');
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  ensureDirectory(options.path);
  const db = new Database(options.path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
    timeout: 8000,
  });
  applyConnectionPragmas(db, options.readonly ?? false);
  if (!options.skipMigrations && !options.readonly) {
    runMigrations(db, options.onLog);
  }
  return db;
}

function currentVersion(db: SqliteDatabase): number {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
    .get() as { name?: string } | undefined;
  if (!exists?.name) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get() as { count: number };
  return row.count;
}

/**
 * Apply pending migrations. Migration bodies are written to be idempotent
 * (`IF NOT EXISTS`) so a partially-applied database can always recover.
 */
export function runMigrations(db: SqliteDatabase, onLog?: (message: string) => void): MigrationResult {
  // The migration bookkeeping table has to exist before the first record is
  // written — it is part of the baseline migration, so create it up front.
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT;`,
  );
  const applied: string[] = [];
  const startVersion = currentVersion(db);
  const alreadyApplied = new Set<string>(
    startVersion === 0
      ? []
      : (db.prepare(`SELECT id FROM schema_migrations`).all() as Array<{ id: string }>).map((row) => row.id),
  );

  const pending: Migration[] = MIGRATIONS.filter((migration) => !alreadyApplied.has(migration.id));
  if (pending.length === 0) {
    return { applied, version: startVersion };
  }

  const runAll = db.transaction((list: readonly Migration[]) => {
    const record = db.prepare(`INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)`);
    for (const migration of list) {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
      applied.push(migration.id);
      onLog?.(`Applied migration ${migration.id} (${migration.name})`);
    }
  });

  runAll(pending);
  return { applied, version: currentVersion(db) };
}

export function schemaVersion(db: SqliteDatabase): number {
  return currentVersion(db);
}

export function isSchemaCurrent(db: SqliteDatabase): boolean {
  return currentVersion(db) >= LATEST_SCHEMA_VERSION;
}

/** Run `fn` inside a transaction, rolling back on any error. */
export function withTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped();
}

export interface IntegrityResult {
  readonly ok: boolean;
  readonly messages: string[];
}

/** `PRAGMA integrity_check` plus foreign key verification. */
export function checkIntegrity(db: SqliteDatabase): IntegrityResult {
  const messages: string[] = [];
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  for (const row of integrity) {
    if (row.integrity_check !== 'ok') messages.push(`integrity_check: ${row.integrity_check}`);
  }
  const foreignKeys = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
  for (const row of foreignKeys) {
    messages.push(`foreign_key_check: ${JSON.stringify(row)}`);
  }
  return { ok: messages.length === 0, messages };
}

export function databaseSizeBytes(db: SqliteDatabase): number {
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    return pageCount * pageSize;
  } catch {
    return 0;
  }
}

/** Rebuild every FTS index from the source tables (used by integrity repair). */
export function rebuildSearchIndexes(db: SqliteDatabase): void {
  for (const table of FTS_TABLES) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`
    INSERT INTO patients_fts (rowid, code, name, phone, address)
    SELECT id,
           code,
           trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')),
           trim(coalesce(phone, '') || ' ' || coalesce(alternate_phone, '')),
           coalesce(address, '')
      FROM patients WHERE deleted_at IS NULL;
  `);
  db.exec(`
    INSERT INTO treatments_fts (rowid, code, name, category, description)
    SELECT id, code, name, coalesce(category, ''), coalesce(description, '')
      FROM treatment_catalog WHERE deleted_at IS NULL;
  `);
  db.exec(`
    INSERT INTO medications_fts (rowid, name, strength)
    SELECT id, name, coalesce(strength, '') FROM medications WHERE deleted_at IS NULL;
  `);
  db.exec(`
    INSERT INTO inventory_fts (rowid, code, name, batch)
    SELECT id, code, name, coalesce(batch_number, '') FROM inventory_items WHERE deleted_at IS NULL;
  `);
}

export function getMeta(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function markCleanShutdown(db: SqliteDatabase, clean: boolean): void {
  setMeta(db, 'clean_shutdown', clean ? '1' : '0');
}

export function hadAbnormalExit(db: SqliteDatabase): boolean {
  return getMeta(db, 'clean_shutdown') === '0';
}

export function recordSystemEvent(
  db: SqliteDatabase,
  type: string,
  message: string,
  detail?: unknown,
): void {
  db.prepare(`INSERT INTO system_events (type, message, detail_json, created_at) VALUES (?, ?, ?, ?)`).run(
    type,
    message,
    detail === undefined ? null : JSON.stringify(detail),
    new Date().toISOString(),
  );
}
