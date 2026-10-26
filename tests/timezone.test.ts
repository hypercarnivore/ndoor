import { describe, expect, it } from 'vitest';
import { dayOf, monthOf, resolveTimezone, systemTimezone, weekOf } from '../src/lib/timezone.js';

// 2026-10-26 02:46 UTC: Sunday evening in Los Angeles, already Monday in UTC.
const EVENING = Date.parse('2026-10-26T02:46:00Z');

describe('calendar math in a time zone', () => {
  it('reads the same instant as different days', () => {
    expect(dayOf(EVENING, 'UTC')).toBe('2026-10-26');
    expect(dayOf(EVENING, 'America/Los_Angeles')).toBe('2026-10-25');
    expect(dayOf(EVENING, 'Pacific/Kiritimati')).toBe('2026-10-26');
    expect(dayOf(EVENING)).toBe('2026-10-26');
  });

  it('starts weeks on Monday in that zone', () => {
    expect(weekOf(EVENING, 'UTC')).toBe('2026-10-26');
    expect(weekOf(EVENING, 'America/Los_Angeles')).toBe('2026-10-19');
    // The Monday itself, and the Sunday before it.
    expect(weekOf(Date.parse('2026-10-19T00:00:00-07:00'), 'America/Los_Angeles')).toBe('2026-10-19');
    expect(weekOf(Date.parse('2026-10-18T23:59:00-07:00'), 'America/Los_Angeles')).toBe('2026-10-12');
  });

  it('crosses month and year ends', () => {
    const newYear = Date.parse('2027-01-01T03:00:00Z');
    expect(monthOf(newYear, 'UTC')).toBe('2027-01');
    expect(monthOf(newYear, 'America/Los_Angeles')).toBe('2026-12');
    expect(weekOf(newYear, 'America/Los_Angeles')).toBe('2026-12-28');
  });

  it('stays exact across a daylight-saving change', () => {
    // Clocks fall back on 2026-11-01 in Los Angeles: 07:30 UTC and 08:30 UTC are both that day.
    expect(dayOf(Date.parse('2026-11-01T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-01');
    expect(dayOf(Date.parse('2026-11-01T08:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-01');
    expect(weekOf(Date.parse('2026-11-01T08:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-26');
  });
});

describe('resolveTimezone', () => {
  it('accepts IANA names and falls back to the machine zone for anything else', () => {
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(resolveTimezone('UTC')).toBe('UTC');
    for (const bad of [undefined, null, '', 'Not/AZone', 'x'.repeat(200), "'; DROP TABLE"]) {
      expect(resolveTimezone(bad)).toBe(systemTimezone());
    }
  });
});
