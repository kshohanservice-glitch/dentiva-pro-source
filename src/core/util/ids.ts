/**
 * Human-readable record codes.
 *
 * Codes are generated from the `sequences` table inside the same transaction as
 * the row they belong to, so an aborted transaction never consumes a number and
 * two concurrent writers can never collide.
 */
import type { SqliteDatabase } from '../db/connection';
import type { IsoDate } from '@shared/dates';

export interface CodeOptions {
  /** Minimum numeric width, zero padded (default 6). */
  readonly width?: number;
}

export function nextSequence(db: SqliteDatabase, name: string, increment = 1): number {
  const row = db
    .prepare(
      `INSERT INTO sequences (name, value) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET value = value + excluded.value
       RETURNING value`,
    )
    .get(name, increment) as { value: number } | undefined;
  if (!row) throw new Error(`Unable to allocate sequence ${name}`);
  return row.value;
}

export function peekSequence(db: SqliteDatabase, name: string): number {
  const row = db.prepare(`SELECT value FROM sequences WHERE name = ?`).get(name) as { value: number } | undefined;
  return row?.value ?? 0;
}

function formatNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Patient code, e.g. `P-000123`. */
export function nextPatientCode(db: SqliteDatabase): string {
  return `P-${formatNumber(nextSequence(db, 'patient_code'), 6)}`;
}

function yearKey(name: string, date: IsoDate | undefined): string {
  const year = (date ?? new Date().toISOString().slice(0, 10)).slice(0, 4);
  return `${name}:${year}`;
}

function numberWithYear(db: SqliteDatabase, name: string, prefix: string, date: IsoDate | undefined, width = 6): string {
  const year = (date ?? new Date().toISOString().slice(0, 10)).slice(0, 4);
  const value = nextSequence(db, yearKey(name, date));
  return `${prefix}-${year}-${formatNumber(value, width)}`;
}

/** Invoice number, e.g. `INV-2026-000045` (sequence restarts each year). */
export function nextInvoiceNumber(db: SqliteDatabase, date?: IsoDate): string {
  return numberWithYear(db, 'invoice_number', 'INV', date);
}

/** Receipt number, e.g. `RCP-2026-000045`. */
export function nextReceiptNumber(db: SqliteDatabase, date?: IsoDate): string {
  return numberWithYear(db, 'receipt_number', 'RCP', date, 5);
}

/** Prescription number, e.g. `RX-2026-000045`. */
export function nextPrescriptionNumber(db: SqliteDatabase, date?: IsoDate): string {
  return numberWithYear(db, 'prescription_number', 'RX', date);
}

/** Purchase reference, e.g. `PUR-2026-000012`. */
export function nextPurchaseReference(db: SqliteDatabase, date?: IsoDate): string {
  return numberWithYear(db, 'purchase_reference', 'PUR', date, 5);
}

/** Queue number for a day: 1, 2, 3 … reset per date. */
export function nextQueueNumber(db: SqliteDatabase, date: IsoDate): number {
  return nextSequence(db, `queue:${date}`);
}

export function nextStaffCode(db: SqliteDatabase): string {
  return `S-${formatNumber(nextSequence(db, 'staff_code'), 4)}`;
}

export function nextItemCode(db: SqliteDatabase, categoryPrefix = 'ITM'): string {
  return `${categoryPrefix}-${formatNumber(nextSequence(db, `item_code:${categoryPrefix}`), 5)}`;
}

/** Reset a per-year sequence; used by tests and the data-reset tool. */
export function resetSequence(db: SqliteDatabase, name: string): void {
  db.prepare(`DELETE FROM sequences WHERE name = ?`).run(name);
}
