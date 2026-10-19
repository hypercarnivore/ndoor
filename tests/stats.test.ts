import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg,
  mannKendall,
  mean,
  meanEstimate,
  normalTwoSidedP,
  tCritical,
  tTwoSidedP,
  variance,
  welch,
  wilson,
} from '../src/lib/stats.js';

describe('distributions', () => {
  it('matches textbook t and normal values', () => {
    expect(tTwoSidedP(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(tTwoSidedP(0, 10)).toBeCloseTo(1, 6);
    expect(tTwoSidedP(12, 30)).toBeLessThan(1e-10);
    expect(tCritical(10)).toBeCloseTo(2.228, 3);
    expect(tCritical(1000)).toBeCloseTo(1.962, 3);
    expect(normalTwoSidedP(1.96)).toBeCloseTo(0.05, 3);
    expect(normalTwoSidedP(0)).toBeCloseTo(1, 6);
  });

  it('refuses nonsense instead of returning a confident p', () => {
    expect(tTwoSidedP(Number.NaN, 5)).toBe(1);
    expect(tTwoSidedP(2, 0)).toBe(1);
  });
});

describe('estimates', () => {
  it('computes means, variances, and intervals', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(variance([1, 2, 3])).toBe(1);
    expect(variance([5])).toBe(0);
    const estimate = meanEstimate([1, 2, 3, 4, 5])!;
    expect(estimate.mean).toBe(3);
    expect(estimate.low).toBeCloseTo(3 - 2.776 * Math.sqrt(2.5 / 5), 2);
    expect(meanEstimate([1])).toBeNull();
  });

  it('gives a Wilson interval that stays inside 0..1', () => {
    const half = wilson(5, 10)!;
    expect(half.low).toBeCloseTo(0.237, 2);
    expect(half.high).toBeCloseTo(0.763, 2);
    expect(wilson(0, 4)!.low).toBe(0);
    expect(wilson(4, 4)!.high).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('welch', () => {
  it('finds a clear shift and no difference between identical groups', () => {
    const a = [0.5, 0.6, 0.55, 0.7, 0.65, 0.6];
    const b = [-0.1, 0, 0.05, -0.05, 0.1, 0];
    const shifted = welch(a, b)!;
    expect(shifted.difference).toBeGreaterThan(0.5);
    expect(shifted.p).toBeLessThan(0.001);
    expect(shifted.low).toBeGreaterThan(0);
    expect(welch(a, a)!.p).toBeCloseTo(1, 6);
  });

  it('handles zero variance and tiny groups', () => {
    expect(welch([1, 1, 1], [1, 1, 1])).toMatchObject({ difference: 0, p: 1 });
    expect(welch([1, 1, 1], [2, 2, 2])).toMatchObject({ difference: -1, p: 0 });
    expect(welch([1], [1, 2])).toBeNull();
  });
});

describe('mannKendall', () => {
  it('detects a monotone trend and reports the Theil-Sen slope', () => {
    const trend = mannKendall([1, 2, 3, 4, 5, 6, 7, 8])!;
    expect(trend.tau).toBe(1);
    expect(trend.slope).toBe(1);
    expect(trend.p).toBeLessThan(0.01);
  });

  it('sees nothing in a flat or too-short series', () => {
    expect(mannKendall([2, 2, 2, 2, 2, 2])).toMatchObject({ tau: 0, p: 1, slope: 0 });
    expect(mannKendall([1, 2, 3])).toBeNull();
  });

  it('is not driven by one outlier month', () => {
    const trend = mannKendall([0, 0.01, -0.01, 0.02, 0, 5, 0.01, 0])!;
    expect(trend.p).toBeGreaterThan(0.1);
  });
});

describe('benjaminiHochberg', () => {
  it('adjusts in input order and never lowers a p-value', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    expect(q[0]).toBeCloseTo(0.02);
    expect(q[1]).toBeCloseTo(0.04);
    expect(q[2]).toBeCloseTo(0.04);
    expect(q[3]).toBeCloseTo(0.02);
    expect(benjaminiHochberg([0.5, 0.9]).every((value, i) => value >= [0.5, 0.9][i])).toBe(true);
    expect(benjaminiHochberg([])).toEqual([]);
  });
});
