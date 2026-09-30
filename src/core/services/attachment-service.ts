/**
 * Attachments and profile images.
 *
 * Files live under the data folder and are referenced by *relative* paths so a
 * restored backup keeps working. Only allow-listed extensions, capped sizes and
 * sanitised names are accepted, and every stored path is re-resolved inside the
 * data root before it is opened, copied or deleted.
 */
import { existsSync } from 'node:fs';
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requireAnyPermission, requirePermission } from '../context';
import type { Attachment } from '@shared/types';
import type { AttachmentCategory } from '@shared/constants';
import { ATTACHMENT_ALLOWED_EXTENSIONS, ATTACHMENT_IMAGE_EXTENSIONS, ATTACHMENT_MAX_BYTES } from '@shared/constants';
import { AppError } from '@shared/errors';
import {
  copyIntoStore,
  ensureDir,
  fileExtension,
  fileSize,
  formatBytes,
  pathExists,
  removeFileIfExists,
  resolveStoredPath,
  sanitiseFileName,
  sha256File,
  toStoredPath,
  uniqueStoredName,
} from '../util/files';
import { asNumber, asString, buildWhere } from '../db/sql';

/** Entities that may carry files, and how to prove the record exists. */
const ENTITY_TABLES: Readonly<Record<string, { table: string; softDeleted: boolean; label: string }>> = {
  patient: { table: 'patients', softDeleted: true, label: 'Patient' },
  visit: { table: 'visits', softDeleted: true, label: 'Visit' },
  prescription: { table: 'prescriptions', softDeleted: true, label: 'Prescription' },
  invoice: { table: 'invoices', softDeleted: true, label: 'Invoice' },
  payment: { table: 'payments', softDeleted: false, label: 'Payment' },
  treatment_plan: { table: 'treatment_plans', softDeleted: true, label: 'Treatment plan' },
  treatment_record: { table: 'treatment_records', softDeleted: true, label: 'Treatment record' },
  accounting_transaction: { table: 'accounting_transactions', softDeleted: false, label: 'Accounting entry' },
  staff: { table: 'staff', softDeleted: true, label: 'Staff member' },
  dentist: { table: 'dentists', softDeleted: true, label: 'Dentist' },
  clinic: { table: 'clinic', softDeleted: false, label: 'Clinic' },
};

export class AttachmentService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  private root(): string {
    return this.context().paths.root;
  }

  private attachmentsRoot(): string {
    return this.context().paths.attachmentsDir;
  }

  private map(row: Record<string, unknown>): Attachment {
    const storedPath = resolveStoredPathSafe(this.root(), asString(row['relative_path']));
    const extension = asString(row['extension']).toLowerCase();
    return {
      id: asNumber(row['id']),
      entityType: asString(row['entity_type']),
      entityId: asNumber(row['entity_id']),
      patientId: row['patient_id'] === null ? null : asNumber(row['patient_id']),
      patientName: row['patient_name'] === null || row['patient_name'] === undefined ? null : asString(row['patient_name']),
      fileName: asString(row['file_name']),
      mimeType: asString(row['mime_type'], 'application/octet-stream'),
      extension,
      sizeBytes: asNumber(row['size_bytes']),
      category: asString(row['category'], 'other') as AttachmentCategory,
      description: asString(row['description']),
      uploadedByName: asString(row['uploaded_by_name'], '—'),
      createdAt: asString(row['created_at']),
      isImage: ATTACHMENT_IMAGE_EXTENSIONS.includes(extension),
      missingFile: storedPath === null,
    };
  }

  private readonly select = `
    SELECT a.*, (SELECT full_name FROM users u WHERE u.id = a.uploaded_by) AS uploaded_by_name,
           (SELECT trim(p.first_name || ' ' || p.last_name) FROM patients p WHERE p.id = a.patient_id) AS patient_name
      FROM attachments a
  `;

  list(input: { entityType?: string; entityId?: number; patientId?: number }): Attachment[] {
    requirePermission(this.context(), 'patient.view');
    const clauses: string[] = ['a.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (input.entityType && input.entityId !== undefined) {
      clauses.push('a.entity_type = ? AND a.entity_id = ?');
      params.push(input.entityType, input.entityId);
    } else if (input.patientId) {
      clauses.push('a.patient_id = ?');
      params.push(input.patientId);
    } else {
      throw AppError.validation('Choose which record to list files for.');
    }
    const where = buildWhere(clauses);
    const rows = this.db.prepare(`${this.select}${where} ORDER BY` + ` a.created_at DESC, a.id DESC`).all(...params) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.map(row));
  }

  byPatient(patientId: number): Attachment[] {
    return this.list({ patientId });
  }

  get(id: number): Attachment {
    requirePermission(this.context(), 'patient.view');
    const row = this.db.prepare(`${this.select} WHERE a.id = ? AND a.deleted_at IS NULL`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw AppError.notFound('File');
    return this.map(row);
  }

  /** Absolute path for opening/revealing a stored file. */
  absolutePath(id: number): string {
    const attachment = this.get(id);
    const path = resolveStoredPathSafe(this.root(), this.relativePathOf(id));
    if (!path || !attachment) throw AppError.notFound('File');
    return path;
  }

  /** Absolute path of the folder that contains the stored file. */
  folderPath(id: number): string {
    const absolute = this.absolutePath(id);
    return absolute.slice(0, Math.max(absolute.lastIndexOf('\\'), absolute.lastIndexOf('/')));
  }

  private relativePathOf(id: number): string {
    const row = this.db.prepare(`SELECT relative_path FROM attachments WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { relative_path: string }
      | undefined;
    if (!row) throw AppError.notFound('File');
    return row.relative_path;
  }

  /**
   * Copy a file (chosen in the main process) into managed storage. `copyFromPath`
   * is the only way files enter the app — paths are never trusted from the
   * renderer for anything except display.
   */
  async add(input: {
    entityType: string;
    entityId: number;
    patientId: number | null;
    category: AttachmentCategory;
    description: string;
    sourcePath: string;
  }): Promise<Attachment> {
    requirePermission(this.context(), 'patient.attachment.manage');
    const entity = ENTITY_TABLES[input.entityType];
    if (!entity)
      throw AppError.validation(`Files cannot be attached` + ` to “${input.entityType}”.`, { entityType: 'Unsupported record type.' });
    this.assertEntityExists(input.entityType, input.entityId);

    const originalName = sanitiseFileName(basenameOf(input.sourcePath), 'attachment');
    const extension = fileExtension(originalName);
    if (!ATTACHMENT_ALLOWED_EXTENSIONS.includes(extension)) {
      throw AppError.validation(
        `“${extension || 'This file type'}” files cannot be attached. Allowed: ${ATTACHMENT_ALLOWED_EXTENSIONS.join(', ')}.`,
        { file: 'This file type is not allowed.' },
      );
    }
    if (!(await pathExists(input.sourcePath))) {
      throw AppError.validation('The selected file could not be read. It may have been moved or deleted.', { file: 'File not found.' });
    }
    const size = await fileSize(input.sourcePath);
    if (size <= 0) throw AppError.validation('The selected file is empty.', { file: 'File is empty.' });
    if (size > ATTACHMENT_MAX_BYTES) {
      throw AppError.validation(`Files must be ${formatBytes(ATTACHMENT_MAX_BYTES)} or smaller (this one is ${formatBytes(size)}).`, {
        file: 'File is too large.',
      });
    }

    const ctx = this.context();
    const month = ctx.today().slice(0, 7);
    const storedName = uniqueStoredName(originalName);
    const relativePath = `attachments/${input.entityType}/${month}/${storedName}`;
    const absolutePath = resolveStoredPath(this.root(), relativePath);
    const digest = await sha256File(input.sourcePath);
    await copyIntoStore(input.sourcePath, absolutePath);

    const result = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO attachments (entity_type, entity_id, patient_id, file_name, stored_name, relative_path, mime_type,
             extension, size_bytes, sha256, category, description, uploaded_by, created_at)
           VALUES (@entityType, @entityId, @patientId, @fileName, @storedName, @relativePath, @mimeType,
             @extension, @sizeBytes, @sha256, @category, @description, @uploadedBy, @createdAt)`,
        )
        .run({
          entityType: input.entityType,
          entityId: input.entityId,
          patientId: input.patientId,
          fileName: originalName,
          storedName,
          relativePath,
          mimeType: guessMimeType(extension),
          extension,
          sizeBytes: size,
          sha256: digest,
          category: input.category,
          description: input.description.trim(),
          uploadedBy: currentUserId(ctx),
          createdAt: ctx.instant(),
        });
      const id = Number(inserted.lastInsertRowid);
      ctx.audit.record({
        action: 'create',
        entityType: 'attachment',
        entityId: id,
        entityLabel: originalName,
        detail: `File attached to ${entity.label} #${input.entityId} (${formatBytes(size)})`,
        after: { fileName: originalName, category: input.category, sizeBytes: size },
      });
      return id;
    })();

    return this.get(result);
  }

  update(id: number, patch: { fileName?: string; category?: AttachmentCategory; description?: string }): Attachment {
    requirePermission(this.context(), 'patient.attachment.manage');
    const before = this.db
      .prepare(`SELECT file_name, category, description FROM` + ` attachments WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as { file_name: string; category: string; description: string } | undefined;
    if (!before) throw AppError.notFound('File');
    const fileName = patch.fileName === undefined ? before.file_name : sanitiseFileName(patch.fileName, before.file_name);
    if (fileName.trim() === '') throw AppError.validation('Give the file a name.', { fileName: 'Name is required.' });
    const extension = fileExtension(fileName);
    if (!ATTACHMENT_ALLOWED_EXTENSIONS.includes(extension)) {
      throw AppError.validation('Keep the file extension unchanged.', { fileName: 'This extension is not allowed.' });
    }
    const ctx = this.context();
    this.db
      .prepare(`UPDATE attachments SET file_name = ?, category = ?, description = ? WHERE id = ?`)
      .run(fileName, patch.category ?? before.category, (patch.description ?? before.description).trim(), id);
    ctx.audit.record({
      action: 'update',
      entityType: 'attachment',
      entityId: id,
      entityLabel: fileName,
      detail: 'File details updated',
      before: { fileName: before.file_name, category: before.category, description: before.description },
      after: { fileName, category: patch.category ?? before.category, description: patch.description ?? before.description },
    });
    return this.get(id);
  }

  /** Soft-delete the record and remove the stored file. */
  async delete(id: number, reason?: string): Promise<void> {
    requirePermission(this.context(), 'patient.attachment.delete');
    const row = this.db
      .prepare(`SELECT file_name, relative_path, entity_type, entity_id` + ` FROM attachments WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as { file_name: string; relative_path: string; entity_type: string; entity_id: number } | undefined;
    if (!row) throw AppError.notFound('File');
    const ctx = this.context();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE attachments SET deleted_at = ? WHERE id = ?`).run(ctx.instant(), id);
      ctx.audit.record({
        action: 'delete',
        entityType: 'attachment',
        entityId: id,
        entityLabel: row.file_name,
        detail:
          `File deleted from ${row.entity_type}` +
          ` #${row.entity_id}${reason && reason.trim() !== '' ? `. Reason: ${reason.trim()}` : ''}`,
        severity: 'warning',
        before: { fileName: row.file_name },
      });
    })();
    const absolute = resolveStoredPathSafe(this.root(), row.relative_path);
    if (absolute) await removeFileIfExists(absolute);
  }

  /**
   * Store a profile image (staff photo, dentist photo/signature, clinic logo).
   * Returns a data-root-relative path suitable for `photo_path`-style columns.
   */
  async storeProfileImage(input: { sourcePath: string; kind: 'staff' | 'dentist' | 'dentist_signature' | 'clinic_logo' }): Promise<string> {
    requireAnyPermission(this.context(), ['settings.manage', 'staff.manage', 'dentist.manage']);
    return this.storeProfileImageInternal(input);
  }

  /** Trusted variant used by the setup wizard (no session exists yet). */
  async storeProfileImageInternal(input: {
    sourcePath: string;
    kind: 'staff' | 'dentist' | 'dentist_signature' | 'clinic_logo';
  }): Promise<string> {
    const extension = fileExtension(input.sourcePath);
    if (!ATTACHMENT_IMAGE_EXTENSIONS.includes(extension)) {
      throw AppError.validation('Choose a PNG, JPEG, WEBP, BMP or TIFF image.', { file: 'Unsupported image type.' });
    }
    if (!(await pathExists(input.sourcePath)))
      throw AppError.validation('The selected image could not be read.', { file: 'Image not found.' });
    const size = await fileSize(input.sourcePath);
    if (size > ATTACHMENT_MAX_BYTES) {
      throw AppError.validation(`Images must be ${formatBytes(ATTACHMENT_MAX_BYTES)} or smaller.`, { file: 'Image is too large.' });
    }
    const storedName = uniqueStoredName(`${input.kind}${extension}`);
    const relativePath = `profiles/${input.kind}/${storedName}`;
    const absolutePath = resolveStoredPath(this.root(), relativePath);
    await ensureDir(absolutePath.slice(0, Math.max(absolutePath.lastIndexOf('\\'), absolutePath.lastIndexOf('/'))));
    await copyIntoStore(input.sourcePath, absolutePath);
    this.context().logger.debug(`stored profile image ${relativePath}`);
    return relativePath;
  }

  /** Remove a profile image referenced by a relative path (best effort). */
  async removeProfileImage(relativePath: string | null): Promise<void> {
    if (!relativePath) return;
    const absolute = resolveStoredPathSafe(this.root(), relativePath);
    if (absolute) await removeFileIfExists(absolute);
  }

  /** Absolute path for a stored profile image (used by the print layer and UI). */
  profileImagePath(relativePath: string | null): string | null {
    if (!relativePath) return null;
    return resolveStoredPathSafe(this.root(), relativePath);
  }

  /** Import an external file into the data folder verbatim (CSV imports, logos). */
  async importFile(sourcePath: string, relativeTarget: string): Promise<string> {
    const absolute = resolveStoredPath(this.root(), relativeTarget);
    await copyIntoStore(sourcePath, absolute);
    return toStoredPath(this.root(), absolute);
  }

  /** Statistics used by the data summary screen. */
  statistics(): { total: number; totalBytes: number; missing: number } {
    requirePermission(this.context(), 'settings.view');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS total_bytes FROM attachments WHERE deleted_at IS NULL`)
      .get() as { total: number; total_bytes: number };
    const rows = this.db.prepare(`SELECT relative_path FROM attachments WHERE deleted_at IS NULL`).all() as Array<{
      relative_path: string;
    }>;
    let missing = 0;
    for (const entry of rows) {
      if (resolveStoredPathSafe(this.root(), entry.relative_path) === null) missing += 1;
    }
    return { total: asNumber(row.total), totalBytes: asNumber(row.total_bytes), missing };
  }

  /** Copies every stored file into the backup staging folder. */
  async stageForBackup(
    stagingDir: string,
    progress?: (copied: number, total: number) => void,
  ): Promise<{ copied: number; skipped: number }> {
    const rows = this.db.prepare(`SELECT relative_path FROM attachments WHERE deleted_at IS NULL`).all() as Array<{
      relative_path: string;
    }>;
    let copied = 0;
    let skipped = 0;
    for (const [index, entry] of rows.entries()) {
      const absolute = resolveStoredPathSafe(this.root(), entry.relative_path);
      if (!absolute || !(await pathExists(absolute))) {
        skipped += 1;
        continue;
      }
      const target = resolveStoredPath(stagingDir, entry.relative_path);
      await ensureDir(target.slice(0, Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'))));
      await copyIntoStore(absolute, target);
      copied += 1;
      progress?.(index + 1, rows.length);
    }
    return { copied, skipped };
  }

  private assertEntityExists(entityType: string, entityId: number): void {
    const entity = ENTITY_TABLES[entityType];
    if (!entity) return;
    const soft = entity.softDeleted ? ' AND deleted_at IS NULL' : '';
    const row = this.db.prepare(`SELECT id FROM ${entity.table} WHERE id = ?${soft}`).get(entityId);
    if (!row) throw AppError.notFound(entity.label);
  }

  /** Duplicate check: the same file already attached to the same record. */
  findByDigest(entityType: string, entityId: number, sha256: string): Attachment | null {
    const row = this.db
      .prepare(`${this.select} WHERE a.entity_type = ? AND a.entity_id = ? AND a.sha256 = ? AND a.deleted_at IS NULL LIMIT 1`)
      .get(entityType, entityId, sha256) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  /** True when the attachment belongs to the given patient (permission scoping). */
  belongsToPatient(id: number, patientId: number): boolean {
    const row = this.db.prepare(`SELECT patient_id FROM attachments WHERE id = ? AND deleted_at IS NULL`).get(id) as
      | { patient_id: number | null }
      | undefined;
    return Boolean(row && (row.patient_id === patientId || row.patient_id === null));
  }

  /** Count for a patient profile tab. */
  countForPatient(patientId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM attachments WHERE patient_id = ? AND deleted_at IS NULL`).get(patientId) as {
      total: number;
    };
    return asNumber(row.total);
  }

  /** Images only, used by the patient gallery. */
  imagesForPatient(patientId: number): Attachment[] {
    return this.byPatient(patientId).filter((attachment) => attachment.isImage && !attachment.missingFile);
  }

  /** Documents only, used by the documents tab. */
  documentsForPatient(patientId: number): Attachment[] {
    return this.byPatient(patientId).filter((attachment) => !attachment.isImage);
  }

  /** Used by the integrity report: which attachment rows lost their file. */
  missingFiles(): Array<{ id: number; fileName: string; relativePath: string }> {
    const rows = this.db.prepare(`SELECT id, file_name, relative_path FROM attachments WHERE deleted_at IS NULL`).all() as Array<{
      id: number;
      file_name: string;
      relative_path: string;
    }>;
    const missing: Array<{ id: number; fileName: string; relativePath: string }> = [];
    for (const row of rows) {
      if (resolveStoredPathSafe(this.root(), row.relative_path) === null) {
        missing.push({ id: row.id, fileName: row.file_name, relativePath: row.relative_path });
      }
    }
    return missing;
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function guessMimeType(extension: string): string {
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.doc':
      return 'application/msword';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

/** Resolve a stored path without throwing (missing/invalid → null). */
function resolveStoredPathSafe(root: string, stored: string): string | null {
  if (!stored) return null;
  try {
    const absolute = resolveStoredPath(root, stored);
    return existsSync(absolute) ? absolute : null;
  } catch {
    return null;
  }
}
