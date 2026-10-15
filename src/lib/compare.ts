/**
 * Compare two decision models on the same posts and comments: how often they
 * agree on each question, how far apart their probabilities are, how fast
 * they answer, and what they cost. Both see identical states and questions,
 * built the same way the analysis builds them.
 *
 * Nothing is written to the graph. Answers go through the shared answer cache
 * (keyed by model), so rerunning a comparison is free unless `fresh` is set to
 * measure speed and cost again.
 */

import { type JevAnalyzer, type JudgmentSubject, type Judgments, mapPool } from './jev.js';

export interface QuestionAgreement {
  question: string;
  type: 'noul' | 'choice' | 'score';
  /** Items both models answered. */
  n: number;
  /**
   * Fraction of items where both reach the same decision: the same side of
   * 0.5 for a Noul, the same label for a Choice, the same nearest level for a Score.
   */
  agreement: number;
  /**
   * Mean distance between the two answers, from 0 (identical) to 1: the
   * probability gap for a Noul, total variation distance for a Choice, and the
   * gap in expected level as a share of the scale for a Score.
   */
  meanDiff: number;
}

export interface ModelRun {
  model: string;
  /** Requests sent (the rest came from the cache). */
  asked: number;
  cached: number;
  inputTokens: number;
  /** Reported by the API, in USD; null when it does not report cost. */
  cost: number | null;
  /** Latency of requests actually sent, in milliseconds. */
  latency: { p50: number; p90: number } | null;
  wallMs: number;
}

export interface Comparison {
  items: number;
  baseline: ModelRun;
  candidate: ModelRun;
  questions: QuestionAgreement[];
  /** Mean agreement across all questions, each item and question counted once. */
  overall: number;
}

/** Bin a Noul at 0.5. */
const side = (p: number) => p >= 0.5;

/** Agreement and distance for each question both judgments answered. */
export function compareJudgments(pairs: Array<[Judgments, Judgments]>): QuestionAgreement[] {
  const acc = new Map<string, { type: QuestionAgreement['type']; n: number; same: number; diff: number }>();
  const add = (question: string, type: QuestionAgreement['type'], same: boolean, diff: number) => {
    const entry = acc.get(question) ?? { type, n: 0, same: 0, diff: 0 };
    entry.n += 1;
    entry.same += same ? 1 : 0;
    entry.diff += diff;
    acc.set(question, entry);
  };
  for (const [a, b] of pairs) {
    for (const [question, p] of Object.entries(a.nouls)) {
      const q = b.nouls[question];
      if (q !== undefined) add(question, 'noul', side(p) === side(q), Math.abs(p - q));
    }
    for (const [question, x] of Object.entries(a.choices)) {
      const y = b.choices[question];
      if (!y) continue;
      const labels = new Set([...Object.keys(x.probabilities), ...Object.keys(y.probabilities)]);
      let tv = 0;
      for (const label of labels) tv += Math.abs((x.probabilities[label] ?? 0) - (y.probabilities[label] ?? 0));
      add(question, 'choice', x.label === y.label, tv / 2);
    }
    for (const [question, x] of Object.entries(a.scores)) {
      const y = b.scores[question];
      if (!y) continue;
      const span = Math.max(1, x.levels - 1);
      add(question, 'score', Math.round(x.value) === Math.round(y.value), Math.abs(x.value - y.value) / span);
    }
  }
  return [...acc.entries()]
    .map(([question, e]) => ({ question, type: e.type, n: e.n, agreement: e.same / e.n, meanDiff: e.diff / e.n }))
    .sort((a, b) => a.agreement - b.agreement || a.question.localeCompare(b.question));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Judge every subject with one analyzer, timing each request that was not served from the cache. */
async function runModel(
  analyzer: JevAnalyzer,
  subjects: JudgmentSubject[],
  cost: () => number | null,
  concurrency: number,
): Promise<{ run: ModelRun; judgments: Map<string, Judgments> }> {
  const before = { ...analyzer.usage };
  const latencies: number[] = [];
  let inputTokens = 0;
  const started = Date.now();
  const results = await mapPool(subjects, concurrency, async (subject) => {
    const asked = analyzer.usage.asked;
    const t0 = Date.now();
    const judgments = await analyzer.judge(subject);
    if (analyzer.usage.asked > asked) latencies.push(Date.now() - t0);
    inputTokens += judgments.inputTokens;
    return judgments;
  });
  latencies.sort((a, b) => a - b);
  return {
    run: {
      model: analyzer.model,
      asked: analyzer.usage.asked - before.asked,
      cached: analyzer.usage.cached - before.cached,
      inputTokens,
      cost: cost(),
      latency: latencies.length ? { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) } : null,
      wallMs: Date.now() - started,
    },
    judgments: new Map(results.map((j) => [`${j.kind}|${j.subjectId}`, j])),
  };
}

export async function compareModels(
  baseline: { analyzer: JevAnalyzer; cost?: () => number | null },
  candidate: { analyzer: JevAnalyzer; cost?: () => number | null },
  subjects: JudgmentSubject[],
  options: { concurrency?: number } = {},
): Promise<Comparison> {
  const concurrency = options.concurrency ?? 8;
  // One after the other, so neither model's timing is skewed by the other's traffic.
  const a = await runModel(baseline.analyzer, subjects, baseline.cost ?? (() => null), concurrency);
  const b = await runModel(candidate.analyzer, subjects, candidate.cost ?? (() => null), concurrency);
  const pairs: Array<[Judgments, Judgments]> = [];
  for (const [key, judgments] of a.judgments) {
    const other = b.judgments.get(key);
    if (other) pairs.push([judgments, other]);
  }
  const questions = compareJudgments(pairs);
  const total = questions.reduce((sum, q) => sum + q.n, 0);
  const agreed = questions.reduce((sum, q) => sum + q.agreement * q.n, 0);
  return { items: pairs.length, baseline: a.run, candidate: b.run, questions, overall: total ? agreed / total : 0 };
}
