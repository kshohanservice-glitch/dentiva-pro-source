/**
 * A deliberately small ZIP layer used for `.dentivabak` backups.
 *
 * Backups are written as a ZIP archive with **stored** (uncompressed) entries.
 * SQLite files, radiographs and photographs are already dense, so compressing
 * them costs time and gives little back; storing them lets us stream the
 * archive, hash single entries and verify a backup without inflating it into
 * memory. Archives stay ordinary ZIP files, so 7-Zip or Windows Explorer can
 * open them if the clinic ever needs to rescue data by hand.
 */
import { constants as fsConstants } from 'node:fs';
import { access, open, readFile, stat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

export interface ZipWriteEntry {
  /** Path inside the archive, using forward slashes. */
  readonly name: string;
  readonly sourcePath: string;
}

export interface ZipEntryInfo {
  readonly name: string;
  readonly offset: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  readonly crc32: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;

/**
 * Write a ZIP archive with **stored** entries, streaming straight from disk.
 *
 * The archive is written by hand rather than through a compression library so
 * the bytes are fully predictable: a local header, the raw file, a data
 * descriptor, and a central directory at the end. Entries are flagged with the
 * data-descriptor bit (and UTF-8 names), which 7-Zip, Windows Explorer and the
 * verifier in this file all read back correctly.
 */
export async function writeZipArchive(
  targetPath: string,
  entries: readonly ZipWriteEntry[],
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const handle = await open(targetPath, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  let index = 0;

  const write = async (buffer: Buffer): Promise<void> => {
    await handle.write(buffer);
    offset += buffer.length;
  };

  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
      const { crc, size } = await streamEntry(handle, entry.sourcePath, name);
      offset += 30 + name.length + size + 16;
      central.push(centralHeader(name, crc, size, offset - (30 + name.length + size + 16)));
      index += 1;
      onProgress?.(index, entries.length);
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const header of central) {
      await write(header);
      centralSize += header.length;
    }
    await write(eocd(entries.length, centralSize, centralOffset));
  } finally {
    await handle.close();
  }
}

/** Local header + file bytes + data descriptor; returns the CRC and size. */
async function streamEntry(handle: FileHandle, sourcePath: string, name: Buffer): Promise<{ crc: number; size: number }> {
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(LOCAL_SIGNATURE, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0808, 6); // UTF-8 name + data descriptor
  local.writeUInt16LE(0, 8); // stored
  writeDosDateTime(local, 10);
  // CRC and sizes are zero here; the real values follow the data.
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  await handle.write(local);

  const source = await open(sourcePath, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  let crc = 0;
  let size = 0;
  try {
    for (;;) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (bytesRead <= 0) break;
      const slice = chunk.subarray(0, bytesRead);
      await handle.write(slice);
      size += bytesRead;
      crc = crc32(slice, crc) >>> 0;
    }
  } finally {
    await source.close();
  }

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  await handle.write(descriptor);

  return { crc, size };
}

function centralHeader(name: Buffer, crc: number, size: number, offset: number): Buffer {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10); // stored
  writeDosDateTime(header, 12);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

function eocd(count: number, centralSize: number, centralOffset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(EOCD_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/** MS-DOS date/time, which every ZIP reader understands. */
function writeDosDateTime(target: Buffer, offset: number): void {
  const now = new Date();
  const year = Math.max(1980, now.getFullYear());
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  target.writeUInt16LE(time, offset);
  target.writeUInt16LE(date, offset + 2);
}

/** Locate the end-of-central-directory record and return the central directory. */
async function readCentralDirectory(path: string): Promise<ZipEntryInfo[]> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const tailLength = Math.min(info.size, MAX_COMMENT + 22 + 64);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, info.size - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const directory = Buffer.alloc(centralSize);
    await handle.read(directory, 0, centralSize, centralOffset);
    const entries: ZipEntryInfo[] = [];
    let position = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (directory.readUInt32LE(position) !== CENTRAL_SIGNATURE) break;
      const method = directory.readUInt16LE(position + 10);
      const crc32 = directory.readUInt32LE(position + 16);
      const compressedSize = directory.readUInt32LE(position + 20);
      const uncompressedSize = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const offset = directory.readUInt32LE(position + 42);
      const name = directory.subarray(position + 46, position + 46 + nameLength).toString('utf8');
      entries.push({ name, offset, compressedSize, uncompressedSize, method, crc32 });
      position += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export async function listZipEntries(path: string): Promise<ZipEntryInfo[]> {
  return readCentralDirectory(path);
}

/** Offset where the actual data of an entry starts. */
async function dataOffset(path: string, entry: ZipEntryInfo): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`Corrupt ZIP entry “${entry.name}”.`);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    return entry.offset + 30 + nameLength + extraLength;
  } finally {
    await handle.close();
  }
}

function assertStored(entry: ZipEntryInfo): void {
  if (entry.method !== 0) {
    throw new Error(`Entry “${entry.name}” is compressed; this archive was not written by Dentiva Pro.`);
  }
}

/** Read a single entry fully into memory (used for the small manifest file). */
export async function readZipEntry(path: string, entry: ZipEntryInfo): Promise<Buffer> {
  assertStored(entry);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(entry.uncompressedSize);
    if (entry.uncompressedSize > 0) {
      await handle.read(buffer, 0, entry.uncompressedSize, await dataOffset(path, entry));
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Extract an entry straight to disk (streams; used for the database file). */
export async function extractZipEntry(path: string, entry: ZipEntryInfo, destinationPath: string): Promise<void> {
  assertStored(entry);
  const source = await open(path, 'r');
  const target = await open(destinationPath, 'w');
  const start = await dataOffset(path, entry);
  try {
    const chunkSize = 4 * 1024 * 1024;
    let remaining = entry.uncompressedSize;
    let position = start;
    const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, entry.uncompressedSize)));
    while (remaining > 0) {
      const length = Math.min(buffer.length, remaining);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error(`Unexpected end of archive while extracting “${entry.name}”.`);
      await target.write(buffer, 0, bytesRead);
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await source.close();
    await target.close();
  }
}

/** SHA-256 of a single entry without loading it into memory. */
export async function hashZipEntry(path: string, entry: ZipEntryInfo): Promise<string> {
  assertStored(entry);
  const source = await open(path, 'r');
  const hash = createHash('sha256');
  const start = await dataOffset(path, entry);
  try {
    const chunkSize = 4 * 1024 * 1024;
    const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, entry.uncompressedSize)));
    let remaining = entry.uncompressedSize;
    let position = start;
    while (remaining > 0) {
      const length = Math.min(buffer.length, remaining);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error(`Unexpected end of archive while hashing “${entry.name}”.`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await source.close();
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileSizeBytes(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
