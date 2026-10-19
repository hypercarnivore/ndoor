/**
 * Small, dependency-free statistics for the dashboard's assertions: confidence
 * intervals, two-sample and trend tests, and multiple-comparison control.
 *
 * Everything here is a pure function over numbers. Callers decide the unit of
 * observation (the politics report uses one value per author, so a prolific
 * poster cannot masquerade as a neighborhood-wide pattern).
 */

export const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Unbiased sample variance; 0 for fewer than two values. */
export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

// --- distributions -------------------------------------------------------------------

function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  let series = 1.000000000190015;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  for (const c of coefficients) series += c / ++y;
  return -tmp + Math.log((2.5066282746310007 * series) / x);
}

/** Continued fraction for the regularized incomplete beta function (Lentz's method). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let step = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + step * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + step / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    step = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + step * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + step / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p-value of Student's t with `df` degrees of freedom. */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/** Two-sided critical t value at the given confidence (bisection on the p-value; df is small and this is rare). */
export function tCritical(df: number, confidence = 0.95): number {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df) > 1 - confidence) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Two-sided p-value of a standard normal z score. */
export function normalTwoSidedP(z: number): number {
  // erfc via Abramowitz-Stegun 7.1.26 (absolute error under 1.5e-7).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return Math.min(1, poly * Math.exp(-x * x));
}

// --- estimates and tests -------------------------------------------------------------

export interface MeanEstimate {
  n: number;
  mean: number;
  /** 95% confidence interval for the mean. */
  low: number;
  high: number;
}

/** Mean with a t-based 95% interval; null when there are fewer than two values. */
export function meanEstimate(values: number[]): MeanEstimate | null {
  if (values.length < 2) return null;
  const m = mean(values);
  const half = tCritical(values.length - 1) * Math.sqrt(variance(values) / values.length);
  return { n: values.length, mean: m, low: m - half, high: m + half };
}

/** Wilson score interval for a proportion (well behaved for small counts and extremes). */
export function wilson(successes: number, total: number, z = 1.96): { low: number; high: number } | null {
  if (total <= 0) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface TwoSample {
  /** mean(a) - mean(b) */
  difference: number;
  p: number;
  /** 95% interval for the difference. */
  low: number;
  high: number;
}

/** Welch's unequal-variance t-test of mean(a) against mean(b); null unless both have two or more values. */
export function welch(a: number[], b: number[]): TwoSample | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const difference = mean(a) - mean(b);
  const se = Math.sqrt(va + vb);
  if (se === 0) return { difference, p: difference === 0 ? 1 : 0, low: difference, high: difference };
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const half = tCritical(df) * se;
  return { difference, p: tTwoSidedP(difference / se, df), low: difference - half, high: difference + half };
}

export interface Trend {
  /** Kendall's tau, -1..1. */
  tau: number;
  p: number;
  /** Theil-Sen slope: the median change per step. */
  slope: number;
}

/**
 * Mann-Kendall trend test with the Theil-Sen slope, for a series in time order.
 * Rank-based, so a single odd month cannot drive it; normal approximation with
 * tie correction, adequate from about 8 points.
 */
export function mannKendall(series: number[]): Trend | null {
  const n = series.length;
  if (n < 4) return null;
  let s = 0;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      s += Math.sign(series[j] - series[i]);
      slopes.push((series[j] - series[i]) / (j - i));
    }
  }
  const ties = new Map<number, number>();
  for (const value of series) ties.set(value, (ties.get(value) ?? 0) + 1);
  const tieTerm = [...ties.values()].reduce((sum, t) => sum + t * (t - 1) * (2 * t + 5), 0);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (varS <= 0) return { tau: 0, p: 1, slope: 0 };
  const z = s === 0 ? 0 : (s - Math.sign(s)) / Math.sqrt(varS);
  slopes.sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  const slope = slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
  return { tau: s / ((n * (n - 1)) / 2), p: normalTwoSidedP(z), slope };
}

/**
 * Benjamini-Hochberg adjusted p-values (q-values), in input order. Testing
 * many neighborhoods at once guarantees some false positives at p < 0.05;
 * reporting q instead keeps the expected share of false findings near q.
 */
export function benjaminiHochberg(p: number[]): number[] {
  const order = p.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const q = new Array<number>(p.length);
  let running = 1;
  for (let rank = order.length; rank >= 1; rank -= 1) {
    const { value, index } = order[rank - 1];
    running = Math.min(running, (value * order.length) / rank);
    q[index] = running;
  }
  return q;
}
