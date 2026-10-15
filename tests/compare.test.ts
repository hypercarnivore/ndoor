import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { compareJudgments, compareModels } from '../src/lib/compare.js';
import { JevAnalyzer, type Judgments, type SystemOneClient } from '../src/lib/jev.js';
import { MemoryCache } from '../src/lib/jev-cache.js';

function judgments(partial: Partial<Judgments>): Judgments {
  return {
    subjectId: 'post_1',
    kind: 'post',
    model: 'm',
    questionSet: 'post-v1',
    nouls: {},
    choices: {},
    scores: {},
    inputTokens: 0,
    ...partial,
  };
}

describe('compareJudgments', () => {
  it('scores agreement and distance per question type', () => {
    const a = judgments({
      nouls: { asks: 0.9, alert: 0.2 },
      choices: { intent: { label: 'inform', confidence: 0.6, probabilities: { inform: 0.6, alert: 0.4 } } },
      scores: { tone: { value: 2.2, levels: 5, confidence: 0.7 } },
    });
    const b = judgments({
      nouls: { asks: 0.7, alert: 0.6 },
      choices: { intent: { label: 'alert', confidence: 0.8, probabilities: { inform: 0.2, alert: 0.8 } } },
      scores: { tone: { value: 1.8, levels: 5, confidence: 0.7 } },
    });
    const byQuestion = Object.fromEntries(compareJudgments([[a, b]]).map((q) => [q.question, q]));
    expect(byQuestion.asks).toMatchObject({ type: 'noul', n: 1, agreement: 1 });
    expect(byQuestion.asks.meanDiff).toBeCloseTo(0.2);
    expect(byQuestion.alert).toMatchObject({ agreement: 0 });
    expect(byQuestion.intent).toMatchObject({ type: 'choice', agreement: 0 });
    expect(byQuestion.intent.meanDiff).toBeCloseTo(0.4);
    // 2.2 and 1.8 both round to level 2; the gap is 0.4 of a 4-step scale.
    expect(byQuestion.tone).toMatchObject({ type: 'score', agreement: 1 });
    expect(byQuestion.tone.meanDiff).toBeCloseTo(0.1);
  });

  it('skips questions only one side answered and lists the least agreed first', () => {
    const a = judgments({ nouls: { x: 0.9, only_a: 0.1, y: 0.9 } });
    const b = judgments({ nouls: { x: 0.9, y: 0.1 } });
    expect(compareJudgments([[a, b]]).map((q) => q.question)).toEqual(['y', 'x']);
  });
});

/** Unit-level fake: answers every Noul with a fixed probability. */
function fakeClient(model: string, p: number) {
  let calls = 0;
  const client: SystemOneClient = {
    async systemOne(request) {
      calls += 1;
      const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: p }]));
      return { model, answers, usage: { input_tokens: 10, output_tokens: 1 } } as SystemOneResult<Questions>;
    },
  };
  return { client, calls: () => calls };
}

describe('compareModels', () => {
  const questions: Questions = { q: { type: 'noul', instructions: 'Is it about pets?' } };
  const subjects = ['a', 'b', 'c'].map((id) => ({ id, kind: 'post' as const, state: id, questions }));

  it('judges the same subjects with both models and reports usage', async () => {
    const base = fakeClient('base', 0.8);
    const cand = fakeClient('cand', 0.3);
    const result = await compareModels(
      { analyzer: new JevAnalyzer(base.client, { model: 'base' }) },
      { analyzer: new JevAnalyzer(cand.client, { model: 'cand' }), cost: () => 0.01 },
      subjects,
    );
    expect(result.items).toBe(3);
    expect(result.overall).toBe(0);
    expect(result.questions).toEqual([
      { question: 'q', type: 'noul', n: 3, agreement: 0, meanDiff: expect.any(Number) },
    ]);
    expect(result.baseline).toMatchObject({ model: 'base', asked: 3, cached: 0, inputTokens: 30, cost: null });
    expect(result.candidate).toMatchObject({ model: 'cand', asked: 3, cost: 0.01 });
    expect(result.candidate.latency?.p50).toBeGreaterThanOrEqual(0);
  });

  it('reuses cached answers, which cost nothing and have no latency', async () => {
    const cache = new MemoryCache();
    const base = fakeClient('base', 0.8);
    const analyzer = () => new JevAnalyzer(base.client, { model: 'base', cache });
    const cand = { analyzer: new JevAnalyzer(fakeClient('cand', 0.9).client, { model: 'cand' }) };
    await compareModels({ analyzer: analyzer() }, cand, subjects);
    const again = await compareModels({ analyzer: analyzer() }, cand, subjects);
    expect(base.calls()).toBe(3);
    expect(again.baseline).toMatchObject({ asked: 0, cached: 3, latency: null });
    expect(again.overall).toBe(1);
  });
});
