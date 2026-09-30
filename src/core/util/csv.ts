/**
 * CSV writing shared by the audit export and the report exporter.
 *
 * Excel is the tool most Bangladeshi clinics will open this in, so the file is
 * written with a UTF-8 BOM (so Bengali text is not mangled) and with CRLF line
 * endings, and every field is quoted when it contains a separator, quote or
 * line break.
 */
import { writeFileAtomic } from './files';

/** Text for one CSV cell. Objects are never written as “[object Object]”. */
export function csvText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = csvText(value);
  if (text === '') return '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [columns.map((column) => csvEscape(column)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function writeCsvFile(
  path: string,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<{ path: string; rowCount: number }> {
  await writeFileAtomic(path, toCsv(columns, rows));
  return { path, rowCount: rows.length };
}
