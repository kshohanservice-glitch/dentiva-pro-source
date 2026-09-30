/**
 * Date & time utilities.
 *
 * Two shapes of time exist in Dentiva Pro and they must never be mixed:
 *  - `IsoInstant`  – `YYYY-MM-DDTHH:mm:ss.sssZ` UTC instant (created_at, audit, payments).
 *  - `IsoDate`     – `YYYY-MM-DD` local business calendar date (visit date, expiry date).
 *  - `IsoTime`     – `HH:mm` local clock time (appointment start, visiting hours).
 *
 * Conversions always take the clinic time zone explicitly, so behaviour is
 * deterministic in tests and identical on every workstation.
 */
import { DEFAULT_TIME_ZONE } from './app-info';

export type IsoDate = string;
export type IsoTime = string;
export type IsoInstant = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [y = 0, m = 0, d = 0] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return d <= daysInMonth(y, m);
}

export function isIsoTime(value: unknown): value is IsoTime {
  return typeof value === 'string' && ISO_TIME_RE.test(value);
}

export function isIsoInstant(value: unknown): value is IsoInstant {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function nowInstant(): IsoInstant {
  return new Date().toISOString();
}

/** Convert any Date/instant to the canonical UTC instant string (millisecond precision). */
export function toInstant(value: Date | number | string): IsoInstant {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`Unparsable instant: ${value}`);
  return parsed.toISOString();
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Break a UTC instant into calendar parts in the requested time zone. */
export function zonedParts(instant: IsoInstant, timeZone: string = DEFAULT_TIME_ZONE): ZonedParts {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid instant: ${instant}`);
  const parts = partsFormatter(timeZone).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(lookup('year')),
    month: Number(lookup('month')),
    day: Number(lookup('day')),
    hour: Number(lookup('hour')) % 24,
    minute: Number(lookup('minute')),
    second: Number(lookup('second')),
    weekday: WEEKDAY_INDEX[lookup('weekday')] ?? 0,
  };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function toIsoDate(year: number, month: number, day: number): IsoDate {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function formatIsoDate(date: IsoDate): IsoDate {
  if (!isIsoDate(date)) throw new RangeError(`Invalid ISO date: ${String(date)}`);
  return date;
}

export function isoDateParts(date: IsoDate): { year: number; month: number; day: number } {
  if (!isIsoDate(date)) throw new RangeError(`Invalid ISO date: ${String(date)}`);
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return { year, month, day };
}

export function parseIsoDate(value: string): Date {
  const { year, month, day } = isoDateParts(value);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Today's calendar date in the given zone. */
export function todayIso(now: Date | string = new Date(), timeZone: string = DEFAULT_TIME_ZONE): IsoDate {
  const parts = zonedParts(typeof now === 'string' ? now : now.toISOString(), timeZone);
  return toIsoDate(parts.year, parts.month, parts.day);
}

/** Current wall-clock time (`HH:mm`) in the given zone. */
export function currentTimeIso(now: Date | string = new Date(), timeZone: string = DEFAULT_TIME_ZONE): IsoTime {
  const parts = zonedParts(typeof now === 'string' ? now : now.toISOString(), timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Current local date-time as `YYYY-MM-DDTHH:mm:ss` (no zone) — for display-only snapshots. */
export function currentLocalDateTime(timeZone: string = DEFAULT_TIME_ZONE, now: Date | string = new Date()): string {
  const parts = zonedParts(typeof now === 'string' ? now : now.toISOString(), timeZone);
  return `${toIsoDate(parts.year, parts.month, parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const base = parseIsoDate(date);
  base.setUTCDate(base.getUTCDate() + days);
  return toIsoDate(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const { year, month, day } = isoDateParts(date);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalisedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const maxDay = daysInMonth(targetYear, normalisedMonth + 1);
  return toIsoDate(targetYear, normalisedMonth + 1, Math.min(day, maxDay));
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = isoDateParts(date);
  return toIsoDate(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = isoDateParts(date);
  return toIsoDate(year, month, daysInMonth(year, month));
}

/** Monday-based week start. */
export function startOfWeek(date: IsoDate): IsoDate {
  // Bangladesh reads a week as Sunday → Saturday (Friday is the quiet day), so
  // range presets such as "this week" follow the local habit rather than ISO.
  const day = parseIsoDate(date).getUTCDay();
  return addDays(date, -day);
}

export function endOfWeek(date: IsoDate): IsoDate {
  return addDays(startOfWeek(date), 6);
}

export function startOfYear(date: IsoDate): IsoDate {
  const { year } = isoDateParts(date);
  return toIsoDate(year, 1, 1);
}

export function endOfYear(date: IsoDate): IsoDate {
  const { year } = isoDateParts(date);
  return toIsoDate(year, 12, 31);
}

export function startOfQuarter(date: IsoDate): IsoDate {
  const { year, month } = isoDateParts(date);
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return toIsoDate(year, quarterStartMonth, 1);
}

export function endOfQuarter(date: IsoDate): IsoDate {
  const { year, month } = isoDateParts(date);
  const quarterEndMonth = Math.floor((month - 1) / 3) * 3 + 3;
  return toIsoDate(year, quarterEndMonth, daysInMonth(year, quarterEndMonth));
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  const start = parseIsoDate(a).getTime();
  const end = parseIsoDate(b).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function isBetween(date: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return date >= from && date <= to;
}

export interface DateRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export type DateRangePreset =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'last_365_days'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'all'
  | 'custom';

export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'last_365_days',
  'this_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'all',
  'custom',
];

export const EPOCH_DATE: IsoDate = '1900-01-01';
export const FAR_FUTURE_DATE: IsoDate = '2999-12-31';

/**
 * Resolve a named range preset into concrete dates. `custom` requires both
 * bounds. Invalid custom ranges fall back to the supplied defaults instead of
 * silently returning an empty window.
 */
export function resolveDateRange(preset: DateRangePreset, options: { today?: IsoDate; custom?: Partial<DateRange> } = {}): DateRange {
  const today = options.today ?? todayIso();
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'last_365_days':
      return { from: addDays(today, -364), to: today };
    case 'this_week':
      return { from: startOfWeek(today), to: endOfWeek(today) };
    case 'this_month':
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'last_month': {
      const previous = addMonths(today, -1);
      return { from: startOfMonth(previous), to: endOfMonth(previous) };
    }
    case 'this_quarter':
      return { from: startOfQuarter(today), to: endOfQuarter(today) };
    case 'this_year':
      return { from: startOfYear(today), to: endOfYear(today) };
    case 'all':
      return { from: EPOCH_DATE, to: FAR_FUTURE_DATE };
    case 'custom': {
      const from = options.custom?.from;
      const to = options.custom?.to;
      if (from && to && isIsoDate(from) && isIsoDate(to) && from <= to) return { from, to };
      if (from && isIsoDate(from)) return { from, to: today >= from ? today : from };
      return { from: addDays(today, -29), to: today };
    }
    default:
      return { from: addDays(today, -29), to: today };
  }
}

export function rangeLabel(preset: DateRangePreset): string {
  const labels: Record<DateRangePreset, string> = {
    today: 'Today',
    yesterday: 'Yesterday',
    last_7_days: 'Last 7 days',
    last_30_days: 'Last 30 days',
    last_90_days: 'Last 90 days',
    last_365_days: 'Last 1 year',
    this_week: 'This week',
    this_month: 'This month',
    last_month: 'Last month',
    this_quarter: 'This quarter',
    this_year: 'This year',
    all: 'All time',
    custom: 'Custom range',
  };
  return labels[preset];
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

export interface AgeBreakdown {
  readonly years: number;
  readonly months: number;
  readonly days: number;
}

export function ageBreakdown(dob: IsoDate, on: IsoDate = todayIso()): AgeBreakdown {
  if (!isIsoDate(dob) || !isIsoDate(on) || dob > on) return { years: 0, months: 0, days: 0 };
  const birth = isoDateParts(dob);
  const target = isoDateParts(on);
  let years = target.year - birth.year;
  let months = target.month - birth.month;
  let days = target.day - birth.day;
  if (days < 0) {
    months -= 1;
    const previousMonth = target.month - 1 === 0 ? 12 : target.month - 1;
    const previousMonthYear = target.month - 1 === 0 ? target.year - 1 : target.year;
    days += daysInMonth(previousMonthYear, previousMonth);
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) };
}

export function ageYears(dob: IsoDate, on: IsoDate = todayIso()): number {
  return ageBreakdown(dob, on).years;
}

export function formatAge(age: AgeBreakdown): string {
  const parts: string[] = [];
  if (age.years > 0) parts.push(`${age.years} yr`);
  if (age.months > 0) parts.push(`${age.months} mo`);
  if (age.years === 0 && age.days > 0) parts.push(`${age.days} d`);
  return parts.length > 0 ? parts.join(' ') : '0 d';
}

/** Age text for a patient row: uses the recorded age when no DOB is known. */
export function ageText(options: { dob?: IsoDate | null; age?: number | null; on?: IsoDate }): string {
  const { dob, age, on } = options;
  if (dob && isIsoDate(dob)) {
    const breakdown = ageBreakdown(dob, on ?? todayIso());
    if (breakdown.years >= 2) return `${breakdown.years} years`;
    return formatAge(breakdown);
  }
  if (typeof age === 'number' && Number.isFinite(age) && age >= 0) return `${Math.round(age)} years`;
  return '—';
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function timeToMinutes(time: IsoTime): number {
  if (!isIsoTime(time)) throw new RangeError(`Invalid time: ${String(time)}`);
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function minutesToTime(minutes: number): IsoTime {
  const normalised = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalised / 60))}:${pad(normalised % 60)}`;
}

export function addMinutesToTime(time: IsoTime, minutes: number): IsoTime {
  return minutesToTime(timeToMinutes(time) + minutes);
}

export function durationMinutes(start: IsoTime, end: IsoTime): number {
  return Math.max(0, timeToMinutes(end) - timeToMinutes(start));
}

/** Do two `[start, end)` time windows overlap? */
export function timesOverlap(startA: IsoTime, endA: IsoTime, startB: IsoTime, endB: IsoTime): boolean {
  return timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(startB) < timeToMinutes(endA);
}

export function formatTime(time: IsoTime, pattern = 'hh:mm A'): string {
  if (!isIsoTime(time)) return '—';
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const isPm = hours >= 12;
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return pattern
    .replace('hh', String(hour12).padStart(2, '0'))
    .replace('HH', pad(hours))
    .replace('mm', pad(minutes))
    .replace('A', isPm ? 'PM' : 'AM');
}

/**
 * Render an ISO date with a token pattern.
 * Supported tokens: `YYYY` `YY` `MMMM` `MMM` `MM` `M` `DD` `D` `ddd` `dddd`.
 */
export function formatDate(date: IsoDate, pattern = 'DD MMM YYYY'): string {
  if (!isIsoDate(date)) return '—';
  const { year, month, day } = isoDateParts(date);
  const weekday = parseIsoDate(date).getUTCDay();
  // One pass so a substituted value can never be re-substituted (the old
  // sequential replaces turned "ddd" into "1on").
  const tokens: Record<string, string> = {
    YYYY: String(year),
    YY: String(year).slice(-2),
    MMMM: MONTHS_LONG[month - 1] ?? '',
    MMM: MONTHS_SHORT[month - 1] ?? '',
    MM: pad(month),
    M: String(month),
    DD: pad(day),
    D: String(day),
    dddd: WEEKDAYS_LONG[weekday] ?? '',
    ddd: WEEKDAYS_SHORT[weekday] ?? '',
  };
  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g, (match) => tokens[match] ?? match);
}

/** Render a UTC instant in a clinic-local pattern (date + time). */
export function formatInstant(
  instant: IsoInstant,
  options: { datePattern?: string; timePattern?: string; timeZone?: string } = {},
): string {
  const { datePattern = 'DD MMM YYYY', timePattern = 'hh:mm A', timeZone = DEFAULT_TIME_ZONE } = options;
  if (!isIsoInstant(instant)) return '—';
  const parts = zonedParts(instant, timeZone);
  const date = toIsoDate(parts.year, parts.month, parts.day);
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  return `${formatDate(date, datePattern)} ${formatTime(time, timePattern)}`;
}

export function formatDateRangeLabel(range: DateRange, datePattern = 'DD MMM YYYY'): string {
  if (range.from === EPOCH_DATE && range.to === FAR_FUTURE_DATE) return 'All time';
  if (range.from === range.to) return formatDate(range.from, datePattern);
  return `${formatDate(range.from, datePattern)} – ${formatDate(range.to, datePattern)}`;
}

/** Human-friendly relative label used by notifications and the audit view. */
export function relativeTime(instant: IsoInstant, now: Date = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  const then = new Date(instant).getTime();
  if (Number.isNaN(then)) return '—';
  const deltaSeconds = Math.round((now.getTime() - then) / 1000);
  const future = deltaSeconds < 0;
  const absolute = Math.abs(deltaSeconds);
  const units: Array<{ limit: number; divisor: number; name: string }> = [
    { limit: 60, divisor: 1, name: 'second' },
    { limit: 3600, divisor: 60, name: 'minute' },
    { limit: 86_400, divisor: 3600, name: 'hour' },
    { limit: 2_592_000, divisor: 86_400, name: 'day' },
    { limit: 31_536_000, divisor: 2_592_000, name: 'month' },
    { limit: Number.POSITIVE_INFINITY, divisor: 31_536_000, name: 'year' },
  ];
  for (const unit of units) {
    if (absolute < unit.limit) {
      const value = Math.max(1, Math.round(absolute / unit.divisor));
      const plural = value === 1 ? '' : 's';
      return future ? `in ${value} ${unit.name}${plural}` : `${value} ${unit.name}${plural} ago`;
    }
  }
  return formatInstant(instant, { timeZone });
}

/**
 * Parse user date input into an ISO date. Accepts `DD MMM YYYY`,
 * `DD/MM/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY` and `D MMMM YYYY`.
 * Returns null when the text cannot be understood.
 */
export function parseDateInput(input: string): IsoDate | null {
  const text = input.trim().replace(/\s+/g, ' ');
  if (text === '') return null;
  if (isIsoDate(text)) return text;

  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(text);
  if (slash) {
    const [, d = '', m = '', y = ''] = slash;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const candidate = toIsoDate(year, Number(m), Number(d));
    return isIsoDate(candidate) ? candidate : null;
  }

  const named = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s,-]+(\d{2,4})$/.exec(text);
  if (named) {
    const [, d = '', monthName = '', y = ''] = named;
    const monthIndex = MONTHS_LONG.findIndex((m) => m.toLowerCase().startsWith(monthName.toLowerCase().slice(0, 3)));
    if (monthIndex < 0) return null;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const candidate = toIsoDate(year, monthIndex + 1, Number(d));
    return isIsoDate(candidate) ? candidate : null;
  }
  return null;
}

/** Number of months covered by a range, inclusive (used by report summaries). */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = isoDateParts(from);
  const b = isoDateParts(to);
  return (b.year - a.year) * 12 + (b.month - a.month) + 1;
}
