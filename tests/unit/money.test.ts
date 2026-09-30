import { describe, expect, it } from 'vitest';
import { applyDiscount, formatMoney, lineTotalPaisa, outstandingPaisa, overpaidPaisa, parseMoney, percentOfPaisa, sumPaisa } from '@shared/money';

describe('money', () => {
  it('keeps every amount in integer paisa', () => {
    expect(sumPaisa([100, 250, 49])).toBe(399);
    expect(percentOfPaisa(150_050, 12.5)).toBe(18_756);
    expect(percentOfPaisa(99, 33)).toBe(33);
  });

  it('rounds discounts half-up and clamps them to the subtotal', () => {
    expect(applyDiscount(100_000, { type: 'percent', value: 10 }).discount).toBe(10_000);
    expect(applyDiscount(100_001, { type: 'percent', value: 33.33 }).discount).toBe(33_330);
    expect(applyDiscount(50_000, { type: 'amount', value: 90_000 }).discount).toBe(50_000);
    expect(applyDiscount(50_000, { type: 'amount', value: 90_000 }).total).toBe(0);
  });

  it('computes a line total from unit price, quantity and discount', () => {
    const line = lineTotalPaisa(120_000, 2, { type: 'amount', value: 4_000 });
    expect(line.subtotal).toBe(240_000);
    expect(line.discount).toBe(4_000);
    expect(line.total).toBe(236_000);
  });

  it('reports outstanding and overpaid balances', () => {
    expect(outstandingPaisa(100_000, 40_000)).toBe(60_000);
    expect(outstandingPaisa(100_000, 120_000)).toBe(0);
    expect(overpaidPaisa(100_000, 120_000)).toBe(20_000);
  });

  it('formats money the way Bangladeshi clinics read it', () => {
    expect(formatMoney(200_000)).toBe('৳2,000');
    expect(formatMoney(200_050)).toBe('৳2,000.50');
    expect(formatMoney(200_000, { forceDecimals: true })).toBe('৳2,000.00');
    expect(formatMoney(-15_000)).toBe('-৳150');
    expect(formatMoney(1_234_567_80, { grouping: 'south_asian' })).toBe('৳12,34,567.80');
    expect(formatMoney(1_234_567_80)).toBe('৳1,234,567.80');
  });

  it('parses grouped, symbol-prefixed and decimal input', () => {
    expect(parseMoney('1,500').paisa).toBe(150_000);
    expect(parseMoney('৳1,500.50').paisa).toBe(150_050);
    expect(parseMoney('1500.5').paisa).toBe(150_050);
    expect(parseMoney('').ok).toBe(false);
    expect(parseMoney('', { allowEmpty: true }).paisa).toBe(0);
    expect(parseMoney('1500.555').ok).toBe(false);
    expect(parseMoney('12a').ok).toBe(false);
  });
});
