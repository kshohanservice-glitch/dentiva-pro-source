/**
 * Money utilities.
 *
 * All monetary values in Dentiva Pro are integer *paisa* (1 BDT = 100 paisa).
 * Floating point arithmetic is never used for money: percentages, discounts and
 * tax are rounded to whole paisa with half-up rounding at the point of
 * calculation, and every total is an exact integer sum.
 */
import { APP_CURRENCY_SYMBOL } from './app-info';

export type Paisa = number;

export type GroupingStyle = 'international' | 'south_asian';

/** Practical ceiling: 10 million crore BDT; far beyond any clinic's lifetime volume. */
export const MAX_SAFE_PAISA = 1e15;

export function isPaisa(value: unknown): value is Paisa {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_SAFE_PAISA;
}

export function assertPaisa(value: number, label = 'amount'): Paisa {
  if (!isPaisa(value)) {
    throw new RangeError(`${label} is out of the supported monetary range`);
  }
  return value;
}

export function sumPaisa(values: Iterable<number>): Paisa {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError('Cannot total a non-numeric amount');
    total += value;
  }
  return assertPaisa(total, 'total');
}

/** Half-up rounding of `paisa * percent / 100` without floating point drift. */
export function percentOfPaisa(paisa: number, percent: number): Paisa {
  if (!Number.isFinite(percent)) throw new RangeError('Percent must be a number');
  if (percent < 0) throw new RangeError('Percent cannot be negative');
  // Work in integer space: (paisa * percent * 100) / 10000 with half-up rounding.
  const scaled = paisa * Math.round(percent * 100);
  const divisor = 10_000;
  const rounded = Math.floor((scaled + Math.sign(scaled) * (divisor / 2)) / divisor);
  return assertPaisa(rounded, 'discount');
}

export type DiscountSpec =
  | { readonly type: 'none' }
  | { readonly type: 'percent'; readonly value: number }
  | { readonly type: 'amount'; readonly value: Paisa };

export interface LineAmounts {
  readonly subtotal: Paisa;
  readonly discount: Paisa;
  readonly total: Paisa;
}

/**
 * Apply a discount to a subtotal, clamped so that a discount can never push a
 * total below zero and can never exceed the subtotal.
 */
export function applyDiscount(subtotal: Paisa, discount: DiscountSpec): LineAmounts {
  assertPaisa(subtotal, 'subtotal');
  let discountPaisa = 0;
  if (discount.type === 'percent') {
    discountPaisa = percentOfPaisa(subtotal, Math.min(discount.value, 100));
  } else if (discount.type === 'amount') {
    discountPaisa = assertPaisa(discount.value, 'discount');
  }
  discountPaisa = Math.max(0, Math.min(discountPaisa, subtotal));
  return { subtotal, discount: discountPaisa, total: subtotal - discountPaisa };
}

/** Outstanding balance for an invoice; never negative. */
export function outstandingPaisa(total: Paisa, paid: Paisa): Paisa {
  const due = assertPaisa(total, 'total') - assertPaisa(paid, 'paid');
  return due > 0 ? due : 0;
}

/** Overpayment (advance credit) for an invoice; never negative. */
export function overpaidPaisa(total: Paisa, paid: Paisa): Paisa {
  const excess = assertPaisa(paid, 'paid') - assertPaisa(total, 'total');
  return excess > 0 ? excess : 0;
}

export function lineTotalPaisa(unitPrice: Paisa, quantity: number, discount: DiscountSpec = { type: 'none' }): LineAmounts {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new RangeError('Quantity must be greater than zero');
  const bruto = assertPaisa(Math.round(unitPrice * quantity), 'line total');
  return applyDiscount(bruto, discount);
}

// ---------------------------------------------------------------------------
// Formatting & parsing
// ---------------------------------------------------------------------------

function groupDigits(digits: string, style: GroupingStyle): string {
  if (style === 'international') {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // South Asian grouping: last three digits, then pairs (12,34,567).
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

export interface FormatMoneyOptions {
  /** Show the ৳ symbol (default true). */
  readonly symbol?: boolean;
  /** Force two decimal places even when the paisa part is zero (default false). */
  readonly forceDecimals?: boolean;
  /** Digit grouping style (default international). */
  readonly grouping?: GroupingStyle;
  /** Always show a leading + or - sign (default false; negatives always show '-'). */
  readonly signed?: boolean;
}

/** `150050` → `৳1,500.50`; `150000` → `৳1,500`. */
export function formatMoney(paisa: Paisa, options: FormatMoneyOptions = {}): string {
  const { symbol = true, forceDecimals = false, grouping = 'international', signed = false } = options;
  if (!Number.isFinite(paisa)) return symbol ? `${APP_CURRENCY_SYMBOL}0` : '0';
  const negative = paisa < 0;
  const absolute = Math.abs(Math.round(paisa));
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  const wholeText = groupDigits(String(whole), grouping);
  const fractionText = fraction === 0 && !forceDecimals ? '' : `.${String(fraction).padStart(2, '0')}`;
  const sign = negative ? '-' : signed ? '+' : '';
  const body = `${wholeText}${fractionText}`;
  return symbol ? `${sign}${APP_CURRENCY_SYMBOL}${body}` : `${sign}${body}`;
}

/** Amount without the currency symbol, for table columns that show a currency header. */
export function formatAmount(paisa: Paisa, options: FormatMoneyOptions = {}): string {
  return formatMoney(paisa, { ...options, symbol: false });
}

/** Plain decimal text for form inputs (no grouping, no symbol): `150050` → `1500.50`. */
export function paisaToInput(paisa: Paisa): string {
  const negative = paisa < 0;
  const absolute = Math.abs(Math.round(paisa));
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  const text = fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

export interface MoneyParseResult {
  readonly ok: boolean;
  readonly paisa: Paisa;
  readonly error?: string;
}

/**
 * Parse user input into paisa. Accepts `1,500`, `1500.5`, `৳1,500.50`, `1500.555`
 * (rejected: more than two decimals). Empty input is treated as zero when
 * `allowEmpty` is set, otherwise it is an error.
 */
export function parseMoney(input: string | number | null | undefined, options: { allowEmpty?: boolean } = {}): MoneyParseResult {
  const { allowEmpty = false } = options;
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    return allowEmpty ? { ok: true, paisa: 0 } : { ok: false, paisa: 0, error: 'Amount is required' };
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, paisa: 0, error: 'Amount must be a number' };
    const rounded = Math.round(input * 100);
    return isPaisa(rounded) ? { ok: true, paisa: rounded } : { ok: false, paisa: 0, error: 'Amount is out of range' };
  }
  const cleaned = input
    .trim()
    .replace(/\u09F3/g, '')
    .replace(/[,\s\u00A0]/g, '')
    .replace(/\u066B/g, '.');
  if (cleaned === '') return allowEmpty ? { ok: true, paisa: 0 } : { ok: false, paisa: 0, error: 'Amount is required' };
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return { ok: false, paisa: 0, error: 'Enter a valid amount' };
  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '', fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > 2) return { ok: false, paisa: 0, error: 'Amount cannot have more than two decimals' };
  const whole = wholePart === '' ? 0 : Number(wholePart);
  const fraction = fractionPart === '' ? 0 : Number(fractionPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) {
    return { ok: false, paisa: 0, error: 'Amount is out of range' };
  }
  const paisa = whole * 100 + fraction;
  if (!isPaisa(paisa)) return { ok: false, paisa: 0, error: 'Amount is out of range' };
  return { ok: true, paisa: negative ? -paisa : paisa };
}

/** Format a percentage value for display, trimming trailing zeros. */
export function formatPercent(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '0%';
  const fixed = value.toFixed(fractionDigits);
  return `${fixed.replace(/\.?0+$/, '')}%`;
}
