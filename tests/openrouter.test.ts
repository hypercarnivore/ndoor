import type { Questions } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { isJevUnavailable, JevAnalyzer, postState, THEMES } from '../src/lib/jev.js';
import {
  DecisionsError,
  isOpenRouterModel,
  OPENROUTER_DECISIONS_URL,
  OpenRouterDecisions,
  PRIVATE_ROUTING,
} from '../src/lib/openrouter.js';

const QUESTIONS: Questions = { lost: { type: 'noul', instructions: 'Is `post` about a lost pet?' } };
const OK = {
  model: 'microsoft/microsoft-decision-1-20261009',
  provider: 'Azure',
  answers: { lost: { type: 'noul', noul: 0.97 } },
  usage: { input_tokens: 42, output_tokens: 1, cost: 0.000002 },
};

/** Unit-level fake fetch: replies from a script and records each request. */
function fakeFetch(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const reply = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const noSleep = async () => {};

describe('OpenRouterDecisions', () => {
  it('requires zero data retention on every request and returns answers in the SDK shape', async () => {
    const { fetch, requests } = fakeFetch([{ status: 200, body: OK }]);
    const usage: unknown[] = [];
    const client = new OpenRouterDecisions({ apiKey: 'k', fetch, onUsage: (u) => usage.push(u) });
    const result = await client.systemOne({
      state: { post: 'Lost cat on Maple Grove Lane' },
      questions: QUESTIONS,
      model: 'microsoft/microsoft-decision-1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(OPENROUTER_DECISIONS_URL);
    const body = JSON.parse(String(requests[0].init.body));
    expect(body).toEqual({
      model: 'microsoft/microsoft-decision-1',
      state: { post: 'Lost cat on Maple Grove Lane' },
      questions: QUESTIONS,
      provider: { zdr: true, data_collection: 'deny' },
    });
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(result.answers.lost).toEqual({ type: 'noul', noul: 0.97 });
    expect(result.usage.input_tokens).toBe(42);
    expect(usage).toEqual([{ provider: 'Azure', cost: 0.000002, inputTokens: 42 }]);
  });

  it('retries rate limits and provider errors, honoring Retry-After', async () => {
    const { fetch, requests } = fakeFetch([
      { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } },
      { status: 502, body: { error: { message: 'upstream' } } },
      { status: 200, body: OK },
    ]);
    const waits: number[] = [];
    const client = new OpenRouterDecisions({
      apiKey: 'k',
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await client.systemOne({ state: 's', questions: QUESTIONS, model: 'a/b' });
    expect(requests).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it('fails at once on errors that retrying cannot fix, in a form the analysis treats as a stop', async () => {
    const { fetch, requests } = fakeFetch([{ status: 402, body: { error: { message: 'Insufficient credits' } } }]);
    const client = new OpenRouterDecisions({ apiKey: 'k', fetch, sleep: noSleep });
    const error = await client.systemOne({ state: 's', questions: QUESTIONS, model: 'a/b' }).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionsError);
    expect(error.status).toBe(402);
    expect(error.message).toBe('402 Insufficient credits');
    expect(isJevUnavailable(error)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const { fetch, requests } = fakeFetch(Array.from({ length: 5 }, () => ({ status: 503, body: {} })));
    const client = new OpenRouterDecisions({ apiKey: 'k', fetch, sleep: noSleep, maxRetries: 2 });
    await expect(client.systemOne({ state: 's', questions: QUESTIONS, model: 'a/b' })).rejects.toThrow(/^503/);
    expect(requests).toHaveLength(3);
  });

  it('refuses to send a request without a model id', async () => {
    const client = new OpenRouterDecisions({ apiKey: 'k', fetch: fakeFetch([]).fetch });
    await expect(client.systemOne({ state: 's', questions: QUESTIONS })).rejects.toThrow(/model id/);
  });

  it('keeps privacy routing fixed', () => {
    expect(PRIVATE_ROUTING).toEqual({ zdr: true, data_collection: 'deny' });
    expect(Object.isFrozen(PRIVATE_ROUTING)).toBe(true);
  });
});

describe('isOpenRouterModel', () => {
  it('routes vendor/model ids through OpenRouter and bare ids to TypeSafe', () => {
    expect(isOpenRouterModel('microsoft/microsoft-decision-1')).toBe(true);
    expect(isOpenRouterModel('typesafe/jev-1.13')).toBe(true);
    expect(isOpenRouterModel('jev-1.13.0')).toBe(false);
  });
});

describe.runIf(process.env.NDOOR_LIVE === '1' && Boolean(process.env.OPENROUTER_API_KEY))(
  'live OpenRouter decisions',
  () => {
    it('answers every post question through a zero-retention endpoint', async () => {
      const providers: (string | null)[] = [];
      const client = new OpenRouterDecisions({
        apiKey: process.env.OPENROUTER_API_KEY!,
        onUsage: (u) => providers.push(u.provider),
      });
      const analyzer = new JevAnalyzer(client, { model: 'microsoft/microsoft-decision-1' });
      const judgments = await analyzer.judge({
        id: 'post_1',
        kind: 'post',
        state: postState({
          subject: 'Found: gray cat near Oak Hollow park',
          body: 'Friendly gray cat, no collar, hanging around the Oak Hollow playground since Tuesday. Is it yours?',
          repostOf: null,
        }),
      });
      expect(providers).toHaveLength(1);
      expect(judgments.model).toMatch(/^microsoft\/microsoft-decision-1/);
      expect(Object.keys(judgments.nouls)).toHaveLength(Object.keys(THEMES).length + 2);
      expect(Object.keys(judgments.choices).sort()).toEqual(['intent', 'primary_theme']);
      expect(judgments.nouls['theme.lost_found_pet']).toBeGreaterThan(0.5);
    }, 60_000);
  },
);
