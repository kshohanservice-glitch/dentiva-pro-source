/**
 * File-system helpers shared by attachments, photos, backups and exports.
 *
 * Everything the app stores is referenced by a path *relative to the data root*
 * so that a restored backup keeps working on another machine, and every path
 * that comes from outside (file pickers, CSV imports, backup zips) is validated
 * before use: no traversal, no absolute escapes, no surprises.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, rename, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Control characters are exactly what must not reach a Windows file name. */
// eslint-disable-next-line no-control-regex -- control characters are the point
const INVALID_NAME_CHARS = /[\u0000-\u001f<>:"/\\|?*]/g;

/** A file name that is safe on Windows and keeps its extension. */
export function sanitiseFileName(name: string, fallback = 'file'): string {
  const base = basename(name).replace(INVALID_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const withoutTrailingDots = base.replace(/[. ]+$/g, '');
  const safe = withoutTrailingDots === '' || withoutTrailingDots === '.' || withoutTrailingDots === '..' ? fallback : withoutTrailingDots;
  return safe.length > 180 ? `${safe.slice(0, 170)}${extname(safe).slice(0, 10)}` : safe;
}

export function fileExtension(name: string): string {
  return extname(name).toLowerCase();
}

/** True when the resolved path really lives inside `root`. */
export function isInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  if (candidateResolved === rootResolved) return true;
  return candidateResolved.startsWith(rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`);
}

/**
 * Resolve a stored (relative) path against the data root, rejecting absolute
 * paths and traversal attempts from data that may have been tampered with.
 */
export function resolveStoredPath(root: string, stored: string): string {
  if (stored.trim() === '') throw new Error('Empty stored path');
  if (isAbsolute(stored)) throw new Error(`Absolute stored paths are not allowed: ${stored}`);
  const candidate = resolve(root, stored);
  if (!isInside(root, candidate)) throw new Error(`Stored path escapes the data folder: ${stored}`);
  return candidate;
}

/** Convert an absolute path inside the data root into a portable relative path. */
export function toStoredPath(root: string, absolutePath: string): string {
  const candidate = resolve(absolutePath);
  if (!isInside(root, candidate)) throw new Error('File is outside the data folder');
  return relative(resolve(root), candidate).split(sep).join('/');
}

export function uniqueStoredName(originalName: string): string {
  const extension = fileExtension(originalName);
  const stem = sanitiseFileName(originalName)
    .slice(0, Math.max(0, 60 - extension.length))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  return `${stem === '' ? 'file' : stem}-${id}${extension}`;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Copy a file into the data folder, writing to a temporary name first so an
 * interrupted copy can never look like a complete file.
 */
export async function copyIntoStore(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDir(join(destinationPath, '..'));
  const tempPath = `${destinationPath}.part`;
  await copyFile(sourcePath, tempPath);
  await rename(tempPath, destinationPath);
}

/** Write a buffer/stream to disk atomically. */
export async function writeFileAtomic(destinationPath: string, data: Buffer | Uint8Array | string): Promise<void> {
  await ensureDir(join(destinationPath, '..'));
  const tempPath = `${destinationPath}.part`;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createWriteStream(tempPath);
    stream.on('error', reject);
    stream.on('finish', () => resolvePromise());
    stream.end(data);
  });
  await rename(tempPath, destinationPath);
}

export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone — nothing to do.
  }
}

export async function removeDirIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function listFiles(dir: string): Promise<Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(dir, entry.name);
      const info = await stat(full);
      files.push({ name: entry.name, path: full, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
    }
    return files;
  } catch {
    return [];
  }
}

/** Human readable size used in the UI and audit details. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Free-space check before writing a backup (returns null when unavailable). */
export function driveOf(path: string): string {
  const resolved = resolve(path);
  const root = resolved.split(sep)[0];
  return root === '' ? '/' : `${root}${sep}`;
}
