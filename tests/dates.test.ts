import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { day } from '../web/src/dates.js';

// The browser formats days in its own zone; Node follows TZ, so pin it for the run.
let zone: string | undefined;

beforeAll(() => {
  zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
});

afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe('day', () => {
  it("shows a timestamp as the viewer's calendar day", () => {
    expect(day('2026-10-26T02:46:00.000Z')).toBe('2026-10-25');
    expect(day('2026-10-26T15:00:00.000Z')).toBe('2026-10-26');
  });

  it('leaves a bare date, already bucketed by the server, alone', () => {
    expect(day('2026-10-19')).toBe('2026-10-19');
  });

  it('is empty for anything that is not text, and passes other text through', () => {
    expect(day(null)).toBe('');
    expect(day(42)).toBe('');
    expect(day('not a date')).toBe('not a date');
  });
});
