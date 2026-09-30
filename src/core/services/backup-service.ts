/**
 * Backup and restore.
 *
 * A backup is a single `.dentivabak` file — a stored-entry ZIP containing the
 * database (copied online via SQLite's backup API, so a busy clinic never sees
 * a torn file), every attachment, and a manifest with counts, versions and a
 * SHA-256 of the database. Every backup is verified immediately after writing.
 *
 * Restoring is deliberately two-phase: everything is validated and staged
 * first, then the main process closes the database, swaps the files and
 * relaunches. Windows will not let a running process replace its own database.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SqliteDatabase } from '../db/connection';
import { checkIntegrity, schemaVersion } from '../db/connection';
import { openDatabase } from '../db/connection';
import type { CoreContext, CorePaths } from '../context';
import { currentUserId, requirePermission } from '../context';
import type { BackupCandidate, BackupRecord, BackupStatus, RestorePreview, RestoreResult } from '@shared/types';
import { AppError } from '@shared/errors';
import { APP_BUILD_NUMBER, APP_VERSION } from '@shared/app-info';
import { addDays } from '@shared/dates';
import { asNumber, asString } from '../db/sql';
import { copyIntoStore, ensureDir, formatBytes, pathExists, removeFileIfExists } from '../util/files';
import { extractZipEntry, hashZipEntry, listZipEntries, readZipEntry, writeZipArchive, type ZipEntryInfo } from '../util/zipstore';
import type { SettingsService } from './settings-service';

export const BACKUP_EXTENSION = '.dentivabak';
const MANIFEST_NAME = 'manifest.json';
const DATABASE_NAME = 'database.sqlite';
const ATTACHMENTS_PREFIX = 'attachments/';
const PROFILES_PREFIX = 'profiles/';
const PENDING_RESTORE_FILE = 'restore-pending.json';

export interface BackupProgress {
  phase: 'starting' | 'database' | 'attachments' | 'manifest' | 'verifying' | 'done' | 'failed';
  percent: number;
  message: string;
}

interface Manifest {
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  clinicName: string;
  machine: string;
  patientCount: number;
  invoiceCount: number;
  attachmentCount: number;
  containsAttachments: boolean;
  visitCount: number;
  databaseBytes: number;
  databaseChecksum: string;
  files: string[];
}

export interface PendingRestore {
  readonly stagedDatabase: string;
  readonly stagedAttachmentsDir: string;
  readonly includesAttachments: boolean;
  readonly sourceFile: string;
  readonly createdAt: string;
}

/** Where the marker for a staged restore lives. */
export function pendingRestoreMarkerPath(paths: CorePaths): string {
  return join(paths.configDir, PENDING_RESTORE_FILE);
}

/** Read the staged-restore marker, or null when there is nothing pending. */
export async function readPendingRestore(paths: CorePaths): Promise<PendingRestore | null> {
  try {
    const raw = await readFile(pendingRestoreMarkerPath(paths), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PendingRestore>;
    if (
      typeof parsed.stagedDatabase !== 'string' ||
      typeof parsed.stagedAttachmentsDir !== 'string' ||
      typeof parsed.sourceFile !== 'string'
    ) {
      return null;
    }
    return {
      stagedDatabase: parsed.stagedDatabase,
      stagedAttachmentsDir: parsed.stagedAttachmentsDir,
      includesAttachments: parsed.includesAttachments === true,
      sourceFile: parsed.sourceFile,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    };
  } catch {
    return null;
  }
}

export interface PendingRestoreOutcome {
  readonly applied: boolean;
  /** The backup file the staged data came from. */
  readonly sourceFile: string;
  /** Files copied back into the data folder (attachments, profile images…). */
  readonly attachmentsRestored: number;
  /** Where the database that was replaced was moved, for recovery. */
  readonly replacedDatabasePath: string | null;
  /** Set when the staged data could not be applied. */
  readonly problem: string | null;
}

/**
 * Finish a restore that was staged before the last shutdown.
 *
 * The database cannot be replaced while SQLite has it open, so the restore is
 * staged by the running application and applied here — before anything opens
 * the database. The replaced database is kept beside the data folder until the
 * new one has been opened and checked, so a failure never destroys data.
 */
export async function applyPendingRestore(
  paths: CorePaths,
  options: { now?: () => Date; logger?: { info(message: string): void; error(message: string): void } } = {},
): Promise<PendingRestoreOutcome | null> {
  const markerPath = pendingRestoreMarkerPath(paths);
  if (!existsSync(markerPath)) return null;
  const pending = await readPendingRestore(paths);

  const finish = async (outcome: PendingRestoreOutcome): Promise<PendingRestoreOutcome> => {
    await removeFileIfExists(markerPath);
    if (pending) {
      // Never leave staged copies of clinic data lying in the temp folder.
      await rm(dirname(pending.stagedDatabase), { recursive: true, force: true }).catch(() => undefined);
    }
    return outcome;
  };

  if (!pending) {
    return finish({
      applied: false,
      sourceFile: '',
      attachmentsRestored: 0,
      replacedDatabasePath: null,
      problem: 'The restore marker' + ' was unreadable.',
    });
  }
  if (!existsSync(pending.stagedDatabase)) {
    return finish({
      applied: false,
      sourceFile: pending.sourceFile,
      attachmentsRestored: 0,
      replacedDatabasePath: null,
      problem: 'The staged database is missing, so the restore was cancelled. Restore the backup again.',
    });
  }
  const header = (await readFile(pending.stagedDatabase)).subarray(0, 16).toString('utf8');
  if (!header.startsWith('SQLite format 3')) {
    return finish({
      applied: false,
      sourceFile: pending.sourceFile,
      attachmentsRestored: 0,
      replacedDatabasePath: null,
      problem: 'The staged database is not a valid SQLite file, so the restore was cancelled.',
    });
  }

  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const stash = join(paths.dataDir, `dentiva-replaced-${stamp}.sqlite`);
  let replacedDatabasePath: string | null = null;

  // 1. Move the live database (and its journals) out of the way.
  if (existsSync(paths.databasePath)) {
    await rename(paths.databasePath, stash);
    replacedDatabasePath = stash;
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await removeFileIfExists(`${paths.databasePath}${suffix}`);
  }

  try {
    await ensureDir(dirname(paths.databasePath));
    await copyFile(pending.stagedDatabase, paths.databasePath);

    // 2. Attachments and profile images, when the archive carried them.
    let attachmentsRestored = 0;
    if (pending.includesAttachments && existsSync(pending.stagedAttachmentsDir)) {
      attachmentsRestored = await copyStagedFiles(pending.stagedAttachmentsDir, paths.root);
    }

    options.logger?.info(
      `Restore applied from ${basename(pending.sourceFile)} (${attachmentsRestored}` +
        ` file(s), previous database kept at ${replacedDatabasePath ?? 'none'})`,
    );
    return finish({
      applied: true,
      sourceFile: pending.sourceFile,
      attachmentsRestored,
      replacedDatabasePath,
      problem: null,
    });
  } catch (error) {
    // 3. Roll back to the database that was in use before this attempt.
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.error(`Restore failed while applying the staged database: ${message}`);
    if (replacedDatabasePath && existsSync(replacedDatabasePath)) {
      await copyFile(replacedDatabasePath, paths.databasePath).catch(() => undefined);
    }
    return finish({
      applied: false,
      sourceFile: pending.sourceFile,
      attachmentsRestored: 0,
      replacedDatabasePath: null,
      problem: `The staged database could not be applied: ${message}`,
    });
  }
}

/** Copy every file staged under `sourceRoot` into the data folder, safely. */
async function copyStagedFiles(sourceRoot: string, targetRoot: string): Promise<number> {
  let copied = 0;
  const walk = async (relative: string): Promise<void> => {
    const from = join(sourceRoot, relative);
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const nextRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(nextRelative);
        continue;
      }
      // Never let a crafted archive write outside the data folder.
      const normalised = nextRelative.replace(/\\/g, '/');
      if (normalised.startsWith('/') || normalised.includes('../') || /^[a-zA-Z]:/.test(normalised)) continue;
      const target = join(targetRoot, ...normalised.split('/'));
      if (!target.startsWith(targetRoot)) continue;
      await ensureDir(dirname(target));
      await copyFile(join(sourceRoot, ...normalised.split('/')), target);
      copied += 1;
    }
  };
  await walk('');
  return copied;
}

export class BackupService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly settings: SettingsService,
    private readonly reportProgress?: (progress: BackupProgress) => void,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private progress(phase: BackupProgress['phase'], percent: number, message: string): void {
    this.reportProgress?.({ phase, percent: Math.max(0, Math.min(100, Math.round(percent))), message });
    const ctx = this.context();
    ctx.notify?.('backup.progress', { phase, percent: Math.round(percent), message });
  }

  /** Folder backups are written to (settings override, else the data folder). */
  folder(): string {
    const configured = this.settings.getSettings().backupFolder;
    return configured && configured.trim() !== '' ? configured : this.context().paths.backupsDir;
  }

  async setFolder(folder: string): Promise<BackupStatus> {
    requirePermission(this.context(), 'backup.manage');
    const target = folder.trim();
    if (target === '') throw AppError.validation('Choose a folder for backups.', { folder: 'Folder is required.' });
    await mkdir(target, { recursive: true });
    try {
      const probe = join(target, `.dentiva-write-test-${Date.now()}`);
      await writeFile(probe, 'ok', 'utf8');
      await removeFileIfExists(probe);
    } catch {
      throw AppError.validation('That folder cannot be written to. Choose another location.', { folder: 'Folder is not writable.' });
    }
    this.settings.updateSettingsInternal({ backupFolder: target });
    const ctx = this.context();
    ctx.audit.record({
      action: 'settings_change',
      entityType: 'backup',
      entityLabel: 'Backup folder',
      detail: `Backup folder set to ${target}`,
      severity: 'warning',
    });
    return this.status();
  }

  // --- Creating -----------------------------------------------------------

  async create(input: { kind?: BackupRecord['kind']; note?: string; silent?: boolean; actorName?: string } = {}): Promise<BackupRecord> {
    if (!input.silent) requirePermission(this.context(), 'backup.create');
    const ctx = this.context();
    const kind = input.kind ?? 'manual';
    const folder = this.folder();
    await ensureDir(folder);
    const stamp = this.stamp();
    // Two backups can be asked for inside the same second (a manual backup and
    // the automatic safety copy before a restore, for example). The name must
    // stay unique, otherwise the second one would overwrite the first and a
    // restore could bring back the wrong snapshot.
    const stem = `dentiva-backup-${stamp}`;
    let fileName = `${stem}${BACKUP_EXTENSION}`;
    let filePath = join(folder, fileName);
    let counter = 2;
    while (existsSync(filePath)) {
      fileName = `${stem}-${counter}${BACKUP_EXTENSION}`;
      filePath = join(folder, fileName);
      counter += 1;
    }
    this.progress('starting', 2, `Preparing backup ${fileName}`);

    const workingDir = join(ctx.paths.tempDir, `backup-${stamp}`);
    await ensureDir(workingDir);
    const databaseCopy = join(workingDir, DATABASE_NAME);

    try {
      // 1. Consistent copy of the live database.
      this.progress('database', 8, 'Copying the database');
      await this.backupDatabase(databaseCopy);
      const databaseBytes = (await stat(databaseCopy)).size;
      const databaseChecksum = await this.hashFile(databaseCopy);

      // 2. Attachments (files may be missing — the manifest records what exists).
      const attachmentEntries = await this.collectAttachments(workingDir);
      this.progress('attachments', 45, `${attachmentEntries.length} attachment file(s) staged`);

      // 3. Manifest with counts and checksum.
      this.progress('manifest', 60, 'Writing manifest');
      const counts = this.counts();
      const manifest: Manifest = {
        formatVersion: 1,
        appVersion: `${APP_VERSION} (${APP_BUILD_NUMBER})`,
        schemaVersion: schemaVersion(this.db),
        createdAt: ctx.instant(),
        clinicName: this.clinicName(),
        machine: ctx.machineGuid,
        visitCount: counts.visits,
        patientCount: counts.patients,
        invoiceCount: counts.invoices,
        attachmentCount: attachmentEntries.length,
        containsAttachments: attachmentEntries.length > 0,
        databaseBytes,
        databaseChecksum,
        files: [DATABASE_NAME, ...attachmentEntries.map((entry) => entry.name)],
      };
      const manifestPath = join(workingDir, MANIFEST_NAME);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      // 4. Archive (stored entries, streamed).
      const archiveEntries = [
        { name: MANIFEST_NAME, sourcePath: manifestPath },
        { name: DATABASE_NAME, sourcePath: databaseCopy },
        ...attachmentEntries.map((entry) => ({ name: entry.name, sourcePath: entry.sourcePath })),
      ];
      await writeZipArchive(filePath, archiveEntries, (written, total) => {
        this.progress('verifying', 60 + (written / Math.max(1, total)) * 25, `Archiving ${written}/${total} file(s)`);
      });

      const sizeBytes = (await stat(filePath)).size;
      const recordId = this.insertRecord({
        fileName,
        filePath,
        sizeBytes,
        kind,
        status: 'completed',
        note: input.note?.trim() ?? '',
        checksum: databaseChecksum,
        counts,
        placeholder: false,
      });

      // 5. Verify immediately: checksum + structure + integrity of the copy.
      this.progress('verifying', 92, 'Verifying the backup');
      const verified = await this.verifyFilePath(filePath);
      if (!verified.ok) {
        this.markFailed(recordId, verified.problem);
        throw AppError.io(`The backup was written but failed verification: ${verified.problem}`);
      }
      this.db.prepare(`UPDATE backup_records SET verified_at = ? WHERE id = ?`).run(ctx.instant(), recordId);

      if (kind === 'automatic') {
        this.settings.updateSettingsInternal({ lastAutomaticBackupAt: ctx.instant() });
      }
      this.pruneOldAutomaticBackups();

      ctx.audit.record({
        action: 'backup_create',
        entityType: 'backup',
        entityId: recordId,
        entityLabel: fileName,
        detail: `Backup created (${formatBytes(sizeBytes)}, ${counts.patients} patients, ${attachmentEntries.length} files)`,
        actor: input.silent ? { id: null, name: input.actorName ?? 'automatic schedule' } : undefined,
      });
      this.progress('done', 100, 'Backup completed and verified');
      return this.getRecord(recordId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.progress('failed', 100, `Backup failed: ${message}`);
      if (existsSync(filePath)) await removeFileIfExists(filePath);
      const ctx2 = this.context();
      ctx2.audit.record({
        action: 'backup_failed',
        entityType: 'backup',
        entityLabel: fileName,
        detail: `Backup failed: ${message}`,
        severity: 'critical',
      });
      throw error instanceof AppError ? error : AppError.io(`Backup failed: ${message}`);
    } finally {
      await rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** SQLite's online backup: safe while the app is in use. */
  private async backupDatabase(destination: string): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.db
        .backup(destination)
        .then(() => resolvePromise())
        .catch(reject);
    });
  }

  private async collectAttachments(workingDir: string): Promise<Array<{ name: string; sourcePath: string }>> {
    const ctx = this.context();
    const entries: Array<{ name: string; sourcePath: string }> = [];
    const rows = this.db.prepare(`SELECT relative_path FROM attachments WHERE deleted_at IS NULL ORDER BY id`).all() as Array<{
      relative_path: string;
    }>;
    for (const row of rows) {
      const relative = row.relative_path.replace(/\\/g, '/');
      if (relative.startsWith('../') || relative.includes('/../')) continue;
      const source = join(ctx.paths.root, relative);
      if (!existsSync(source)) continue;
      entries.push({ name: relative, sourcePath: source });
    }
    // Profile images and the clinic logo live outside the attachments table.
    for (const folderName of ['profiles']) {
      const folder = join(ctx.paths.root, folderName);
      if (!existsSync(folder)) continue;
      entries.push(...(await this.walkFolder(folder, folderName)));
    }
    void workingDir;
    return entries;
  }

  private async walkFolder(folder: string, prefix: string): Promise<Array<{ name: string; sourcePath: string }>> {
    const entries: Array<{ name: string; sourcePath: string }> = [];
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, item.name);
      const relative = `${prefix}/${item.name}`;
      if (item.isDirectory()) entries.push(...(await this.walkFolder(full, relative)));
      else if (item.isFile()) entries.push({ name: relative, sourcePath: full });
    }
    return entries;
  }

  /** Verify an archived backup: manifest, checksum and SQLite integrity. */
  async verifyFilePath(filePath: string): Promise<{ ok: boolean; problem: string; manifest: Manifest | null; entryNames: string[] }> {
    try {
      const entries = await listZipEntries(filePath);
      const manifestEntry = entries.find((entry) => entry.name === MANIFEST_NAME);
      const databaseEntry = entries.find((entry) => entry.name === DATABASE_NAME);
      if (!manifestEntry) return { ok: false, problem: 'The archive has no manifest.', manifest: null, entryNames: [] };
      if (!databaseEntry) return { ok: false, problem: 'The archive has no database file.', manifest: null, entryNames: [] };
      const manifest = JSON.parse((await readZipEntry(filePath, manifestEntry)).toString('utf8')) as Manifest;
      const checksum = await hashZipEntry(filePath, databaseEntry);
      if (manifest.databaseChecksum && checksum !== manifest.databaseChecksum) {
        return {
          ok: false,
          problem: 'The database inside the archive' + ' does not match its checksum.',
          manifest,
          entryNames: entries.map((e) => e.name),
        };
      }
      if (manifest.databaseBytes && databaseEntry.uncompressedSize !== manifest.databaseBytes) {
        return { ok: false, problem: 'The database inside the archive is truncated.', manifest, entryNames: entries.map((e) => e.name) };
      }
      const missing = (manifest.files ?? []).filter((name) => !entries.some((entry) => entry.name === name));
      if (missing.length > 0) {
        return {
          ok: false,
          problem: `The archive is` + ` missing ${missing.length} file(s).`,
          manifest,
          entryNames: entries.map((e) => e.name),
        };
      }
      // Open the embedded database read-only and check it.
      const tempPath = join(this.context().paths.tempDir, `verify-${Date.now()}.sqlite`);
      await extractZipEntry(filePath, databaseEntry, tempPath);
      const probe = openDatabase({ path: tempPath, readonly: true, skipMigrations: true, fileMustExist: true });
      const integrity = checkIntegrity(probe);
      probe.close();
      await removeFileIfExists(tempPath);
      if (!integrity.ok) {
        return {
          ok: false,
          problem: `The database inside the archive is not intact` + ` (${integrity.messages[0] ?? 'unknown problem'}).`,
          manifest,
          entryNames: entries.map((e) => e.name),
        };
      }
      return { ok: true, problem: '', manifest, entryNames: entries.map((entry) => entry.name) };
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error), manifest: null, entryNames: [] };
    }
  }

  async verify(id: number): Promise<BackupRecord> {
    requirePermission(this.context(), 'backup.create');
    const record = this.getRecord(id);
    const result = await this.verifyFilePath(record.filePath);
    const ctx = this.context();
    if (result.ok) {
      this.db
        .prepare(`UPDATE backup_records SET verified_at = ?, status` + ` = 'completed', failure_message = '' WHERE id = ?`)
        .run(ctx.instant(), id);
      ctx.audit.record({
        action: 'backup_verify',
        entityType: 'backup',
        entityId: id,
        entityLabel: record.fileName,
        detail: 'Backup' + ' verified' + ' successfully',
      });
      return this.getRecord(id);
    }
    this.markFailed(id, result.problem);
    ctx.audit.record({
      action: 'backup_verify_failed',
      entityType: 'backup',
      entityId: id,
      entityLabel: record.fileName,
      detail: `Backup verification failed: ${result.problem}`,
      severity: 'critical',
    });
    throw AppError.integrity(`Backup verification failed: ${result.problem}`);
  }

  // --- Reading ------------------------------------------------------------

  getRecord(id: number): BackupRecord {
    const row = this.db.prepare(`SELECT * FROM backup_records WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw AppError.notFound('Backup');
    return this.mapRecord(row);
  }

  private mapRecord(row: Record<string, unknown>): BackupRecord {
    return {
      id: asNumber(row['id']),
      fileName: asString(row['file_name']),
      filePath: asString(row['file_path']),
      sizeBytes: asNumber(row['size_bytes']),
      kind: asString(row['kind'], 'manual') as BackupRecord['kind'],
      status: asString(row['status'], 'completed') as BackupRecord['status'],
      note: asString(row['note']),
      createdAt: asString(row['created_at']),
      createdByName: asString(row['created_by_name'], asString(row['failure_message']) !== '' ? asString(row['failure_message']) : '—'),
      appVersion: asString(row['app_version']),
      schemaVersion: asNumber(row['schema_version']),
      patientCount: asNumber(row['patient_count']),
      invoiceCount: asNumber(row['invoice_count']),
      attachmentCount: asNumber(row['attachment_count']),
      checksum: asString(row['checksum']),
      verifiedAt: row['verified_at'] === null ? null : asString(row['verified_at']),
    };
  }

  private records(limit = 50): BackupRecord[] {
    const rows = this.db
      .prepare(
        `SELECT b.*, (SELECT full_name FROM users u WHERE u.id = b.created_by) AS created_by_name
           FROM backup_records b ORDER BY b.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRecord(row));
  }

  async status(): Promise<BackupStatus> {
    requirePermission(this.context(), 'backup.create');
    const settings = this.settings.getSettings();
    const folder = this.folder();
    const writable = await this.isWritable(folder);
    const records = this.records(100);
    const completed = records.filter((record) => record.status === 'completed' && existsSync(record.filePath));
    const lastBackup = completed[0] ?? null;
    const nextDueAt = lastBackup ? addDays(lastBackup.createdAt.slice(0, 10), settings.backupIntervalDays) : this.context().today();
    const failed = records.find((record) => record.status === 'failed') ?? null;
    return {
      folder,
      folderWritable: writable,
      intervalDays: settings.backupIntervalDays,
      lastBackupAt: lastBackup ? lastBackup.createdAt : null,
      nextDueAt: settings.backupIntervalDays === 0 ? null : `${nextDueAt}T00:00:00.000Z`,
      isDue: settings.backupIntervalDays > 0 && (!lastBackup || nextDueAt <= this.context().today()),
      lastFailure: failed ? { message: failed.note || 'Backup failed', at: failed.createdAt } : null,
      backups: records.filter((record) => record.kind !== 'pre_restore'),
      preRestoreBackups: records.filter((record) => record.kind === 'pre_restore'),
      externalFiles: await this.scanFolder(folder, records),
    };
  }

  private async isWritable(folder: string): Promise<boolean> {
    try {
      await mkdir(folder, { recursive: true });
      const probe = join(folder, `.dentiva-write-test-${Date.now()}`);
      await writeFile(probe, 'ok', 'utf8');
      await removeFileIfExists(probe);
      return true;
    } catch {
      return false;
    }
  }

  async scanFolder(folder?: string, knownRecords?: readonly BackupRecord[]): Promise<BackupCandidate[]> {
    requirePermission(this.context(), 'backup.create');
    const target = folder && folder.trim() !== '' ? folder : this.folder();
    const known = knownRecords ?? this.records(100);
    const candidates: BackupCandidate[] = [];
    let names: string[] = [];
    try {
      names = (await readdir(target)).filter((name) => name.toLowerCase().endsWith(BACKUP_EXTENSION));
    } catch {
      return [];
    }
    for (const name of names) {
      const filePath = join(target, name);
      const info = await stat(filePath);
      const record = known.find((entry) => entry.filePath === filePath);
      const verification = await this.verifyFilePath(filePath);
      candidates.push({
        filePath,
        fileName: name,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        valid: verification.ok,
        metadata: verification.manifest
          ? {
              appVersion: verification.manifest.appVersion,
              schemaVersion: verification.manifest.schemaVersion,
              createdAt: verification.manifest.createdAt,
              clinicName: verification.manifest.clinicName,
              patientCount: verification.manifest.patientCount,
              invoiceCount: verification.manifest.invoiceCount,
              attachmentCount: verification.manifest.attachmentCount,
              checksum: verification.manifest.databaseChecksum,
              containsAttachments: verification.manifest.containsAttachments,
            }
          : null,
        problem: verification.ok ? null : verification.problem,
      });
      void record;
    }
    return candidates.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async deleteBackup(id: number, deleteFile: boolean, confirmText?: string): Promise<void> {
    requirePermission(this.context(), 'backup.manage');
    const record = this.getRecord(id);
    if (confirmText?.trim() !== record.fileName) {
      throw AppError.validation(`Type the file name` + ` (${record.fileName}) to confirm.`, {
        confirmText: `Type ${record.fileName} to confirm.`,
      });
    }
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM backup_records WHERE id = ?`).run(id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'backup',
        entityId: id,
        entityLabel: record.fileName,
        detail: `Backup record removed${deleteFile ? ' and file deleted' : ' (file kept on disk)'}`,
        severity: 'warning',
      });
    })();
    if (deleteFile && existsSync(record.filePath)) await removeFileIfExists(record.filePath);
  }

  /** Called by the scheduler in the main process. */
  async runAutomaticIfDue(): Promise<BackupRecord | null> {
    const status = await this.status();
    if (!status.isDue || !status.folderWritable) return null;
    return this.create({ kind: 'automatic', note: 'Automatic scheduled backup', silent: true, actorName: 'automatic schedule' });
  }

  // --- Restore ------------------------------------------------------------

  async previewRestore(filePath: string): Promise<RestorePreview> {
    requirePermission(this.context(), 'backup.restore');
    if (!existsSync(filePath)) throw AppError.notFound('Backup file');
    const verification = await this.verifyFilePath(filePath);
    const candidates = await this.scanFolder(dirname(filePath));
    const candidate =
      candidates.find((entry) => entry.filePath === filePath) ??
      ({
        filePath,
        fileName: basename(filePath),
        sizeBytes: (await stat(filePath)).size,
        modifiedAt: (await stat(filePath)).mtime.toISOString(),
        valid: verification.ok,
        metadata: null,
        problem: verification.problem || null,
      } satisfies BackupCandidate);
    const counts = this.counts();
    const warnings: string[] = [];
    if (!verification.ok) warnings.push(`This backup cannot be used: ${verification.problem}`);
    if (verification.manifest) {
      const manifest = verification.manifest;
      const current = schemaVersion(this.db);
      if (manifest.schemaVersion > current) {
        warnings.push(
          `This backup was made by a newer version of Dentiva Pro (data format ${manifest.schemaVersion};` +
            ` this installation uses ${current}). Update the application before restoring it.`,
        );
      } else if (manifest.schemaVersion < current) {
        warnings.push('This backup was made by an older version. Its data will be upgraded automatically after restoring.');
      }
      if (manifest.clinicName && this.clinicName() && manifest.clinicName !== this.clinicName()) {
        warnings.push(`This backup belongs to “${manifest.clinicName}”, not “${this.clinicName()}”. Restoring replaces all current data.`);
      }
      if (manifest.createdAt < addDays(this.context().today(), -400)) {
        warnings.push('This backup is more than a year old.');
      }
      if (!manifest.containsAttachments) warnings.push('This backup contains no attachments.');
    }
    return {
      candidate,
      currentData: { patients: counts.patients, invoices: counts.invoices, visits: counts.visits },
      warnings,
      requiresTypedConfirmation: 'RESTORE',
    };
  }

  /**
   * Stage a restore: validate, take a safety backup of the live data, extract
   * the archive into the temp folder and leave a pending-restore file behind.
   * The main process performs the swap after closing the database.
   */
  async restore(input: { filePath: string; confirmText: string; restoreAttachments: boolean }): Promise<RestoreResult> {
    requirePermission(this.context(), 'backup.restore');
    if (input.confirmText.trim() !== 'RESTORE') {
      throw AppError.validation('Type RESTORE to confirm replacing all current data.', { confirmText: 'Type RESTORE to confirm.' });
    }
    if (!existsSync(input.filePath)) throw AppError.notFound('Backup file');
    const ctx = this.context();
    this.progress('starting', 2, 'Preparing restore');

    const preRestore = await this.create({
      kind: 'pre_restore',
      note: `Automatic safety copy before` + ` restoring ${basename(input.filePath)}`,
    });
    this.progress('verifying', 35, 'Validating the backup file');
    const verification = await this.verifyFilePath(input.filePath);
    if (!verification.ok) throw AppError.integrity(`This backup cannot be restored: ${verification.problem}`);

    const stagedDir = join(ctx.paths.tempDir, `restore-${Date.now()}`);
    await ensureDir(stagedDir);
    const stagedDatabase = join(stagedDir, DATABASE_NAME);
    const entries = await listZipEntries(input.filePath);
    const databaseEntry = entries.find((entry) => entry.name === DATABASE_NAME);
    if (!databaseEntry) throw AppError.integrity('The archive has no database file.');
    this.progress('database', 45, 'Extracting the database');
    await extractZipEntry(input.filePath, databaseEntry, stagedDatabase);

    let attachmentsRestored = 0;
    const stagedAttachmentsDir = join(stagedDir, 'files');
    if (input.restoreAttachments) {
      this.progress('attachments', 60, 'Extracting attachments');
      const fileEntries = entries.filter(
        (entry: ZipEntryInfo) =>
          (entry.name.startsWith(ATTACHMENTS_PREFIX) || entry.name.startsWith(PROFILES_PREFIX)) && entry.name !== MANIFEST_NAME,
      );
      for (const entry of fileEntries) {
        const target = join(stagedAttachmentsDir, entry.name);
        await ensureDir(dirname(target));
        await extractZipEntry(input.filePath, entry, target);
        attachmentsRestored += 1;
      }
    }

    const pending: PendingRestore = {
      stagedDatabase,
      stagedAttachmentsDir,
      includesAttachments: input.restoreAttachments,
      sourceFile: input.filePath,
      createdAt: ctx.instant(),
    };
    await writeFile(join(ctx.paths.configDir, PENDING_RESTORE_FILE), JSON.stringify(pending, null, 2), 'utf8');

    ctx.audit.record({
      action: 'restore_start',
      entityType: 'backup',
      entityLabel: basename(input.filePath),
      detail:
        `Restore staged: safety copy ${preRestore.fileName}, ${attachmentsRestored}` +
        ` attachment file(s) ready. The application will restart to finish.`,
      severity: 'critical',
    });
    this.progress('done', 100, 'Restore prepared — the application will restart');
    ctx.notify?.('restore.relaunching', {
      message: 'The backup has been validated. Dentiva Pro will close and reopen to finish restoring your data.',
    });
    return {
      restored: true,
      databaseRestored: false,
      attachmentsRestored,
      preRestoreBackupPath: preRestore.filePath,
      integrityOk: true,
      relaunchRequired: true,
      message: 'The backup has been validated and staged. Dentiva Pro will close and restart to finish restoring your data.',
    };
  }

  // --- Helpers ------------------------------------------------------------

  private counts(): { patients: number; invoices: number; visits: number; attachments: number } {
    const row = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL) AS patients,
                (SELECT COUNT(*) FROM invoices WHERE deleted_at IS NULL) AS invoices,
                (SELECT COUNT(*) FROM visits WHERE deleted_at IS NULL) AS visits,
                (SELECT COUNT(*) FROM attachments WHERE deleted_at IS NULL) AS attachments`,
      )
      .get() as { patients: number; invoices: number; visits: number; attachments: number };
    return {
      patients: asNumber(row.patients),
      invoices: asNumber(row.invoices),
      visits: asNumber(row.visits),
      attachments: asNumber(row.attachments),
    };
  }

  private clinicName(): string {
    const row = this.db.prepare(`SELECT name FROM clinic WHERE id = 1`).get() as { name: string } | undefined;
    return row?.name ?? '';
  }

  private stamp(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.context().timeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(this.context().now());
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolvePromise());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  private insertRecord(input: {
    fileName: string;
    filePath: string;
    sizeBytes: number;
    kind: BackupRecord['kind'];
    status: BackupRecord['status'];
    note: string;
    checksum: string;
    counts: { patients: number; invoices: number; attachments: number };
    placeholder: boolean;
  }): number {
    const ctx = this.context();
    const result = this.db
      .prepare(
        `INSERT INTO backup_records (file_name, file_path, size_bytes, kind, status, note, created_at, created_by,
           app_version, schema_version, patient_count, invoice_count, attachment_count, checksum, failure_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      )
      .run(
        input.fileName,
        input.filePath,
        input.sizeBytes,
        input.kind,
        input.status,
        input.note,
        ctx.instant(),
        currentUserId(ctx),
        `${APP_VERSION} (${APP_BUILD_NUMBER})`,
        schemaVersion(this.db),
        input.counts.patients,
        input.counts.invoices,
        input.counts.attachments,
        input.checksum,
      );
    return Number(result.lastInsertRowid);
  }

  private markFailed(id: number, problem: string): void {
    this.db.prepare(`UPDATE backup_records SET status = 'failed', failure_message = ? WHERE id = ?`).run(problem.slice(0, 500), id);
  }

  private pruneOldAutomaticBackups(keep = 30): void {
    const rows = this.db
      .prepare(`SELECT id, file_path FROM backup_records WHERE kind = 'automatic' ORDER BY created_at DESC LIMIT -1 OFFSET ?`)
      .all(keep) as Array<{ id: number; file_path: string }>;
    for (const row of rows) {
      this.db.prepare(`DELETE FROM backup_records WHERE id = ?`).run(row.id);
      if (existsSync(row.file_path)) void removeFileIfExists(row.file_path);
    }
  }

  /** Failure notice used by the notification centre. */
  lastFailure(): { message: string; at: string } | null {
    const row = this.db
      .prepare(
        `SELECT failure_message, created_at FROM backup_records WHERE status =` +
          ` 'failed' AND failure_message <> '' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { failure_message: string; created_at: string } | undefined;
    return row ? { message: row.failure_message, at: row.created_at } : null;
  }

  /** True when a restore is staged and the app must restart. */
  hasPendingRestore(): boolean {
    return existsSync(join(this.context().paths.configDir, PENDING_RESTORE_FILE));
  }

  /** Adopt an outside `.dentivabak` file into the managed backup folder. */
  async adoptFile(sourcePath: string): Promise<BackupCandidate> {
    requirePermission(this.context(), 'backup.restore');
    const folder = this.folder();
    await ensureDir(folder);
    const name = basename(sourcePath);
    if (!name.toLowerCase().endsWith(BACKUP_EXTENSION)) {
      throw AppError.validation(`Only ${BACKUP_EXTENSION} files can be imported.`, { file: 'Unsupported file type.' });
    }
    const target = join(folder, name);
    if (existsSync(target)) throw AppError.conflict('A backup with this file name already exists in the backup folder.');
    if (!(await pathExists(sourcePath))) throw AppError.notFound('Backup file');
    await copyIntoStore(sourcePath, target);
    const candidates = await this.scanFolder(folder);
    const adopted = candidates.find((candidate) => candidate.filePath === target);
    if (!adopted) throw AppError.io('The backup file could not be read after copying.');
    const ctx = this.context();
    ctx.audit.record({
      action: 'backup_create',
      entityType: 'backup',
      entityLabel: name,
      detail: `External backup file imported into the backup folder (${formatBytes(adopted.sizeBytes)})`,
    });
    return adopted;
  }
}
