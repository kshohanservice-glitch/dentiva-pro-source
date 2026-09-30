import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  ageText,
  ageYears,
  DATE_RANGE_PRESETS,
  endOfMonth,
  formatDate,
  formatTime,
  monthsBetween,
  parseDateInput,
  relativeTime,
  resolveDateRange,
  startOfMonth,
  startOfWeek,
  timeToMinutes,
  timesOverlap,
} from '@shared/dates';

describe('dates', () => {
  it('formats and parses the clinic date patterns', () => {
    expect(formatDate('2026-09-30')).toBe('30 Sep 2026');
    expect(formatDate('2026-09-30', 'DD/MM/YYYY')).toBe('30/09/2026');
    expect(formatDate('2026-01-05', 'ddd, DD MMM YYYY')).toBe('Mon, 05 Jan 2026');
    expect(parseDateInput('30/09/2026')).toBe('2026-09-30');
    expect(parseDateInput('30 Sep 2026')).toBe('2026-09-30');
    expect(parseDateInput('nonsense')).toBeNull();
  });

  it('formats times and converts them to minutes', () => {
    expect(formatTime('13:05')).toBe('01:05 PM');
    expect(formatTime('00:30')).toBe('12:30 AM');
    expect(timeToMinutes('09:45')).toBe(585);
  });

  it('detects overlapping appointment slots', () => {
    expect(timesOverlap('10:00', '10:30', '10:15', '10:45')).toBe(true);
    expect(timesOverlap('10:00', '10:30', '10:30', '11:00')).toBe(false);
  });

  it('resolves the shared range presets against a fixed today', () => {
    expect(startOfMonth('2026-09-30')).toBe('2026-09-01');
    expect(endOfMonth('2026-09-30')).toBe('2026-09-30');
    expect(startOfWeek('2026-09-30')).toBe('2026-09-27'); // Sunday, following the local week
    expect(addDays('2026-09-30', 3)).toBe('2026-10-03');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(monthsBetween('2026-01-01', '2026-03-31')).toBe(3);

    const today = '2026-09-30';
    expect(resolveDateRange('today', { today })).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(resolveDateRange('this_month', { today })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveDateRange('last_30_days', { today })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveDateRange('last_7_days', { today })).toEqual({ from: '2026-09-24', to: '2026-09-30' });
    expect(resolveDateRange('this_year', { today })).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    // Every advertised preset must resolve without throwing.
    for (const preset of DATE_RANGE_PRESETS) {
      const range = resolveDateRange(preset, { today });
      expect(range.from <= range.to).toBe(true);
    }
  });

  it('describes ages from a date of birth or a stated age', () => {
    expect(ageYears('2000-09-30', '2026-09-30')).toBe(26);
    expect(ageText({ dob: '2000-09-30', on: '2026-09-30' })).toContain('26');
    expect(ageText({ age: 7 })).toContain('7');
  });

  it('renders relative times for notifications', () => {
    const now = new Date('2026-09-30T10:00:00.000Z');
    expect(relativeTime('2026-09-30T09:40:00.000Z', now)).toBe('20 minutes ago');
    expect(relativeTime('2026-09-30T11:00:00.000Z', now)).toBe('in 1 hour');
  });
});
