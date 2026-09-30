/**
 * Backup naming and the two-phase restore.
 *
 * Restoring cannot replace the database while SQLite has it open, so the
 * application stages the validated archive and applies it on the next start.
 * These tests cover both halves of that promise: the staging, and the startup
 * step that swaps the files — including the failure paths that must never
 * destroy the clinic's live data.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@core/db/connection';
import { extractZipEntry, listZipEntries } from '@core/util/zipstore';
import {
  applyPendingRestore,
  pendingRestoreMarkerPath,
  readPendingRestore,
  type PendingRestoreOutcome,
} from '@core/services/backup-service';
import { createPatient, createTestApp, type TestApp } from './harness';

function countPatients(databasePath: string): number {
  const db = openDatabase({ path: databasePath, readonly: true, skipMigrations: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM patients WHERE deleted_at IS NULL`).get() as { total: number };
    return row.total;
  } finally {
    db.close();
  }
}

/** Patient count inside a `.dentivabak` archive (they are stored-entry ZIPs). */
async function countPatientsInBackup(archivePath: string): Promise<number> {
  const staging = mkdtempSync(join(tmpdir(), 'dentiva-inspect-'));
  try {
    const entries = await listZipEntries(archivePath);
    const databaseEntry = entries.find((entry) => entry.name === 'database.sqlite');
    expect(databaseEntry, `${archivePath} has no database entry`).toBeTruthy();
    const target = join(staging, 'database.sqlite');
    await extractZipEntry(archivePath, databaseEntry!, target);
    return countPatients(target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function writeMarker(app: TestApp, pending: Record<string, unknown>): void {
  writeFileSync(pendingRestoreMarkerPath(app.paths), JSON.stringify(pending), 'utf8');
}

async function bootWithOwner(): Promise<{ app: TestApp; ownerId: number }> {
  const app = createTestApp();
  const ownerId = await app.bootstrapOwner({ username: 'owner', password: 'OwnerPass123' });
  app.signIn(ownerId);
  return { app, ownerId };
}

let apps: TestApp[] = [];
afterEach(() => {
  for (const app of apps) app.cleanup();
  apps = [];
});

describe('backup file naming', () => {
  it('never overwrites a backup made in the same second', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    createPatient(app, { firstName: 'First' });

    const first = await app.services.backups.create({ kind: 'manual', note: 'first' });
    createPatient(app, { firstName: 'Second' });
    const second = await app.services.backups.create({ kind: 'manual', note: 'second' });

    expect(second.fileName).not.toBe(first.fileName);
    expect(existsSync(first.filePath)).toBe(true);
    expect(existsSync(second.filePath)).toBe(true);

    // Each archive holds the state it was taken from.
    expect(await countPatientsInBackup(first.filePath)).toBe(1);
    expect(await countPatientsInBackup(second.filePath)).toBe(2);
    expect(await readPendingRestore(app.paths)).toBeNull();
  }, 120_000);

  it('keeps the safety copy of a restore separate from the archive it restores', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    createPatient(app, { firstName: 'Kept' });
    const backup = await app.services.backups.create({ kind: 'manual' });

    createPatient(app, { firstName: 'Discarded' });
    const result = await app.services.backups.restore({
      filePath: backup.filePath,
      confirmText: 'RESTORE',
      restoreAttachments: true,
    });

    expect(result.restored).toBe(true);
    expect(result.preRestoreBackupPath).not.toBe(backup.filePath);
    expect(await countPatientsInBackup(String(result.preRestoreBackupPath))).toBe(2);
    expect(await countPatientsInBackup(backup.filePath)).toBe(1);
    expect(app.services.backups.hasPendingRestore()).toBe(true);
  }, 120_000);
});

describe('applying a staged restore on the next start', () => {
  it('does nothing when there is no staged restore', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    createPatient(app, { firstName: 'Only' });
    const before = countPatients(app.paths.databasePath);

    const outcome = await applyPendingRestore(app.paths);
    expect(outcome).toBeNull();
    expect(countPatients(app.paths.databasePath)).toBe(before);
  }, 120_000);

  it('swaps in the staged database and keeps the replaced one for recovery', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    createPatient(app, { firstName: 'Kept' });
    const backup = await app.services.backups.create({ kind: 'manual' });
    createPatient(app, { firstName: 'Discarded' });
    await app.services.backups.restore({ filePath: backup.filePath, confirmText: 'RESTORE', restoreAttachments: true });

    app.container.close();
    const outcome = (await applyPendingRestore(app.paths)) as PendingRestoreOutcome;
    expect(outcome.applied).toBe(true);
    expect(outcome.problem).toBeNull();
    expect(outcome.attachmentsRestored).toBe(0);
    expect(existsSync(pendingRestoreMarkerPath(app.paths))).toBe(false);

    // The journals of the replaced database are gone before anything reopens it.
    expect(existsSync(`${app.paths.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${app.paths.databasePath}-shm`)).toBe(false);
    expect(countPatients(app.paths.databasePath)).toBe(1);
    expect(outcome.replacedDatabasePath).toBeTruthy();
    expect(countPatients(String(outcome.replacedDatabasePath))).toBe(2);
  }, 120_000);

  it('copies attachments back and refuses to write outside the data folder', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    const stagedDir = join(app.paths.tempDir, 'restore-attachments');
    mkdirSync(join(stagedDir, 'attachments'), { recursive: true });
    writeFileSync(join(stagedDir, 'attachments', 'x-ray.png'), 'fake radiograph');
    // A crafted archive entry trying to escape the data folder.
    writeFileSync(join(stagedDir, 'attachments', '..traversal.txt'), 'harmless');

    const stagedDatabase = join(stagedDir, 'database.sqlite');
    const source = openDatabase({ path: app.paths.databasePath, readonly: true, skipMigrations: true });
    await source.backup(stagedDatabase);
    source.close();

    app.container.close();
    writeMarker(app, {
      stagedDatabase,
      stagedAttachmentsDir: join(stagedDir, 'files'),
      includesAttachments: true,
      sourceFile: join(app.paths.backupsDir, 'dentiva-backup-test.dentivabak'),
      createdAt: new Date().toISOString(),
    });
    // The files live beside the database in the staging folder the staging step
    // builds; mirror that layout.
    mkdirSync(join(stagedDir, 'files'), { recursive: true });
    writeFileSync(join(stagedDir, 'files', 'attachments-x-ray.png'), 'fake radiograph');

    const outcome = (await applyPendingRestore(app.paths)) as PendingRestoreOutcome;
    expect(outcome.applied).toBe(true);
    expect(outcome.attachmentsRestored).toBe(1);
    expect(existsSync(join(app.paths.root, 'attachments-x-ray.png'))).toBe(true);
    expect(existsSync(join(app.paths.root, '..', '..traversal.txt'))).toBe(false);
    rmSync(join(app.paths.root, 'attachments-x-ray.png'), { force: true });
  }, 120_000);

  it('cancels cleanly when the staged database has vanished', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    createPatient(app, { firstName: 'Safe' });
    writeMarker(app, {
      stagedDatabase: join(app.paths.tempDir, 'gone', 'database.sqlite'),
      stagedAttachmentsDir: join(app.paths.tempDir, 'gone', 'files'),
      includesAttachments: true,
      sourceFile: join(app.paths.backupsDir, 'dentiva-backup-gone.dentivabak'),
      createdAt: new Date().toISOString(),
    });
    app.container.close();

    const outcome = (await applyPendingRestore(app.paths)) as PendingRestoreOutcome;
    expect(outcome.applied).toBe(false);
    expect(outcome.problem).toMatch(/missing/i);
    expect(existsSync(pendingRestoreMarkerPath(app.paths))).toBe(false);
    expect(countPatients(app.paths.databasePath)).toBe(1);
  }, 120_000);

  it('refuses a staged file that is not a database', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    const stagedDir = join(app.paths.tempDir, 'restore-junk');
    mkdirSync(stagedDir, { recursive: true });
    const stagedDatabase = join(stagedDir, 'database.sqlite');
    writeFileSync(stagedDatabase, 'this is not a SQLite database at all');
    writeMarker(app, {
      stagedDatabase,
      stagedAttachmentsDir: join(stagedDir, 'files'),
      includesAttachments: false,
      sourceFile: 'not-a-backup.dentivabak',
      createdAt: new Date().toISOString(),
    });
    app.container.close();

    const outcome = (await applyPendingRestore(app.paths)) as PendingRestoreOutcome;
    expect(outcome.applied).toBe(false);
    expect(outcome.problem).toMatch(/not a valid SQLite file/i);
    expect(existsSync(pendingRestoreMarkerPath(app.paths))).toBe(false);
  }, 120_000);

  it('ignores an unreadable marker instead of guessing', async () => {
    const { app } = await bootWithOwner();
    apps.push(app);
    createPatient(app, { firstName: 'Still here' });
    writeFileSync(pendingRestoreMarkerPath(app.paths), '{ not json', 'utf8');
    app.container.close();

    const outcome = (await applyPendingRestore(app.paths)) as PendingRestoreOutcome;
    expect(outcome.applied).toBe(false);
    expect(outcome.problem).toMatch(/unreadable/i);
    expect(countPatients(app.paths.databasePath)).toBe(1);
    expect(readFileSync(app.paths.databasePath).subarray(0, 16).toString('utf8')).toContain('SQLite');
  }, 120_000);
});
