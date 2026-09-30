/**
 * Filesystem layout for the desktop application.
 *
 * Everything the clinic owns lives under one folder inside the Windows user
 * profile, so a backup can copy exactly one directory and a reinstall never
 * finds the data in two places.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CorePaths } from '@core/context';

export interface ResolvedPaths extends CorePaths {
  /** Folder holding the machine id, saved window state and other small files. */
  readonly configDir: string;
}

export function resolveCorePaths(overrides: Partial<CorePaths> = {}): ResolvedPaths {
  // `DENTIVA_DATA_DIR` relocates the entire data folder. IT departments use it to
  // keep clinic records on a chosen drive, support uses it to inspect a copy of a
  // clinic's folder, and the packaged smoke test uses it so it can never touch a
  // real installation's records.
  const root = overrides.root ?? process.env['DENTIVA_DATA_DIR'] ?? app.getPath('userData');
  const paths: ResolvedPaths = {
    root,
    dataDir: overrides.dataDir ?? join(root, 'data'),
    databasePath: overrides.databasePath ?? join(root, 'data', 'dentiva.sqlite'),
    attachmentsDir: overrides.attachmentsDir ?? join(root, 'attachments'),
    backupsDir: overrides.backupsDir ?? join(root, 'backups'),
    logsDir: overrides.logsDir ?? join(root, 'logs'),
    configDir: overrides.configDir ?? join(root, 'config'),
    tempDir: overrides.tempDir ?? join(root, 'temp'),
    exportsDir: overrides.exportsDir ?? join(root, 'exports'),
  };
  for (const directory of [
    paths.dataDir,
    paths.attachmentsDir,
    paths.backupsDir,
    paths.logsDir,
    paths.configDir,
    paths.tempDir,
    paths.exportsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return paths;
}

/**
 * Stable per-machine identifier used to bind an activation to this PC.
 * It is *not* a secret: it only prevents a copied data folder from carrying the
 * activation to another computer, which is the strongest claim a fully offline
 * activation can honestly make.
 */
export function machineGuid(configDir: string): string {
  const file = join(configDir, 'machine.json');
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { guid?: string };
      if (typeof parsed.guid === 'string' && parsed.guid.length >= 16) return parsed.guid;
    }
  } catch {
    // Fall through and mint a new identifier.
  }
  const guid = randomUUID();
  try {
    writeFileSync(file, JSON.stringify({ guid, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // A read-only profile must not stop the application from starting.
  }
  return guid;
}
