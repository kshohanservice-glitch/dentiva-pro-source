/**
 * Display formatting shared by every screen.
 *
 * The clinic's own date pattern, time pattern, time zone and digit grouping are
 * pushed into this module once when settings load, so a table cell can simply
 * call `fmtMoney(...)` or `fmtDate(...)` without threading settings through
 * every component.
 */
import { formatAmount, formatMoney, formatPercent, paisaToInput, parseMoney } from '@shared/money';
import type { GroupingStyle, Paisa } from '@shared/money';
import { ageText, formatDate, formatInstant, formatTime, relativeTime, toIsoDate, zonedParts } from '@shared/dates';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, DEFAULT_TIME_ZONE } from '@shared/app-info';

interface FormatterState {
  datePattern: string;
  timePattern: string;
  timeZone: string;
  grouping: GroupingStyle;
}

const state: FormatterState = {
  datePattern: DEFAULT_DATE_FORMAT,
  timePattern: DEFAULT_TIME_FORMAT,
  timeZone: DEFAULT_TIME_ZONE,
  grouping: 'international',
};

/**
 * Display text for a value read out of an untyped row (master-data screens hand
 * back `Record<string, unknown>`). Objects never leak as “[object Object]”.
 */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return fallback;
}

/** The same idea for counts and other numbers. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function configureFormatters(patch: Partial<FormatterState>): void {
  if (patch.datePattern) state.datePattern = patch.datePattern;
  if (patch.timePattern) state.timePattern = patch.timePattern;
  if (patch.timeZone) state.timeZone = patch.timeZone;
  if (patch.grouping) state.grouping = patch.grouping;
}

export function currentFormatters(): Readonly<FormatterState> {
  return state;
}

// --- Money ----------------------------------------------------------------

export function fmtMoney(paisa: Paisa | null | undefined, options: { forceDecimals?: boolean; signed?: boolean } = {}): string {
  if (paisa === null || paisa === undefined) return '—';
  return formatMoney(paisa, { grouping: state.grouping, ...options });
}

export function fmtAmount(paisa: Paisa | null | undefined, options: { forceDecimals?: boolean } = {}): string {
  if (paisa === null || paisa === undefined) return '—';
  return formatAmount(paisa, { grouping: state.grouping, ...options });
}

export function fmtPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return formatPercent(value, digits);
}

export { paisaToInput, parseMoney };

/** `1500` → `1500`, `1500.5` → `1500.5`, `1500.25` → `1500.25` (units, not paisa). */
export function fmtDecimal(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, '');
}

/** Inventory quantities are stored in thousandths of a unit. */
export function fmtQuantity(milli: number | null | undefined, unit = ''): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return '—';
  const value = milli / 1000;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(value < 1 ? 3 : 2).replace(/\.?0+$/, '');
  return unit ? `${text} ${unit}`.trim() : text;
}

// --- Dates ----------------------------------------------------------------

export function fmtDate(date: string | null | undefined, pattern?: string): string {
  if (!date) return '—';
  return formatDate(date, pattern ?? state.datePattern);
}

export function fmtTime(time: string | null | undefined): string {
  if (!time) return '—';
  return formatTime(time, state.timePattern);
}

export function fmtRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from && !to) return '—';
  if (from && to && from === to) return fmtDate(from);
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}

export function fmtInstant(instant: string | null | undefined, options: { dateOnly?: boolean } = {}): string {
  if (!instant) return '—';
  if (options.dateOnly) {
    const parts = zonedParts(instant, state.timeZone);
    return formatDate(toIsoDate(parts.year, parts.month, parts.day), state.datePattern);
  }
  return formatInstant(instant, {
    datePattern: state.datePattern,
    timePattern: state.timePattern,
    timeZone: state.timeZone,
  });
}

export function fmtDateTime(instant: string | null | undefined): string {
  if (!instant) return '—';
  return formatInstant(instant, {
    datePattern: state.datePattern,
    timePattern: state.timePattern,
    timeZone: state.timeZone,
  });
}

export function fmtRelative(instant: string | null | undefined): string {
  if (!instant) return '—';
  return relativeTime(instant, new Date(), state.timeZone);
}

export function fmtAge(options: { dob?: string | null; years?: number | null }): string {
  const text = ageText({ dob: options.dob ?? null, age: options.years ?? null });
  return text || '—';
}

// --- Text -----------------------------------------------------------------

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return `${(parts[0] as string)[0] ?? ''}${(parts[parts.length - 1] as string)[0] ?? ''}`.toUpperCase();
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

export function truncate(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function byteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function listText(values: readonly string[], fallback = '—'): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

/** Turn `[{label, value}]` chart data into percentage widths. */
export function sharePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}
