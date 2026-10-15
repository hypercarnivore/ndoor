import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JevAnalyzer, type Judgments, type SystemOneClient } from '../src/lib/jev.js';
import { cacheKey, FileCache, MemoryCache } from '../src/lib/jev-cache.js';

const QUESTIONS = { q: { type: 'noul' as const, instructions: 'Is `text` kind?' } };

/** Fake Jev at the network boundary: counts requests and can fail on a chosen call. */
function client(options: { failOn?: number } = {}) {
  let calls = 0;
  const fake: SystemOneClient = {
    async systemOne(request) {
      calls += 1;
      if (calls === options.failOn) throw new Error('402 out of credits');
      const text = (request.state as { text: string }).text;
      return {
        model: 'jev-test',
        usage: { input_tokens: 10 },
        answers: { q: { type: 'noul', noul: text.length / 10 } },
      } as never;
    },
  };
  return { fake, calls: () => calls };
}

const subject = (text: string, questions: object = QUESTIONS) => ({
  id: `id-${text}`,
  kind: 'post' as const,
  questions: questions as never,
  questionSet: 'test-v1',
  state: { text },
});

describe('cacheKey', () => {
  it('ignores key order and changes with model, questions, or state', () => {
    const base = cacheKey({ model: 'm', questions: { a: 1, b: 2 }, state: { x: 'y' } });
    expect(cacheKey({ model: 'm', questions: { b: 2, a: 1 }, state: { x: 'y' } })).toBe(base);
    expect(cacheKey({ model: 'm2', questions: { a: 1, b: 2 }, state: { x: 'y' } })).not.toBe(base);
    expect(cacheKey({ model: 'm', questions: { a: 1, b: 3 }, state: { x: 'y' } })).not.toBe(base);
    expect(cacheKey({ model: 'm', questions: { a: 1, b: 2 }, state: { x: 'z' } })).not.toBe(base);
  });
});

describe('FileCache', () => {
  it('persists across opens, owner-only, and survives a torn last line', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ndoor-cache-')), 'nested', 'jev-cache.jsonl');
    const first = FileCache.open(path);
    first.set('k1', { n: 1 });
    first.set('k2', { n: 2 });
    first.set('k1', { n: 3 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    appendFileSync(path, '{"k":"k3","v":{"n"');
    const second = FileCache.open(path);
    expect(second.get('k1')).toEqual({ n: 3 });
    expect(second.get('k2')).toEqual({ n: 2 });
    expect(second.get('k3')).toBeUndefined();
    expect(second.size).toBe(2);
    expect(readFileSync(path, 'utf8')).not.toContain('text');
  });
});

describe('JevAnalyzer with a cache', () => {
  it('asks once per distinct question and state, across analyzers sharing the cache', async () => {
    const cache = new MemoryCache();
    const jev = client();
    const first = new JevAnalyzer(jev.fake, { cache });
    const a = await first.judge(subject('hello'));
    expect(a.nouls.q).toBe(0.5);
    expect(a.inputTokens).toBe(10);

    const second = new JevAnalyzer(jev.fake, { cache });
    const again = await second.judge({ ...subject('hello'), id: 'other-id' });
    expect(again).toMatchObject({ subjectId: 'other-id', questionSet: 'test-v1', inputTokens: 0, nouls: { q: 0.5 } });
    expect(jev.calls()).toBe(1);
    expect(second.usage).toEqual({ asked: 0, cached: 1 });

    await second.judge(subject('hello', { q: { type: 'noul', instructions: 'Is `text` rude?' } }));
    expect(jev.calls()).toBe(2);
  });

  it('keeps finished batches when a run fails partway, and resumes from the cache', async () => {
    const cache = new MemoryCache();
    const saved: string[] = [];
    const save = async (batch: Judgments[]) => {
      saved.push(...batch.map((j) => j.subjectId));
    };
    const subjects = ['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((text) => subject(text));
    const failing = client({ failOn: 4 });
    const analyzer = new JevAnalyzer(failing.fake, { cache, concurrency: 1 });
    await expect(analyzer.judgeInBatches(subjects, save, { size: 2 })).rejects.toThrow(/credits/);
    expect(saved).toEqual(['id-a', 'id-bb']);
    expect(cache.entries.size).toBe(3);

    const healthy = client();
    const resumed = new JevAnalyzer(healthy.fake, { cache });
    const progress: number[] = [];
    await resumed.judgeInBatches(subjects, save, { size: 2, progress: (done) => progress.push(done) });
    expect(healthy.calls()).toBe(2);
    expect(resumed.usage).toEqual({ asked: 2, cached: 3 });
    expect(progress).toEqual([2, 4, 5]);
  });
});
