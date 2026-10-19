import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FeedSource } from '../src/lib/api.js';
import { GraphStore } from '../src/lib/graph.js';
import {
  isJevUnavailable,
  JevAnalyzer,
  OPINION_QUESTIONS,
  PLACE_QUESTION_SET,
  PLACE_QUESTIONS,
  POLITICS_QUESTION_SET,
  POLITICS_QUESTIONS,
  POST_QUESTIONS,
  questionSetId,
} from '../src/lib/jev.js';
import { MemoryCache } from '../src/lib/jev-cache.js';
import { type FeedPage, mapPost, type Post, resolveReplyTargets } from '../src/lib/model.js';
import { ThrottledError } from '../src/lib/nextdoor-client.js';
import {
  analyzeGraph,
  judgePosts,
  SYNC_PRESETS,
  type SyncApi,
  type SyncLimits,
  syncGraph,
  toStored,
} from '../src/lib/sync.js';
import { author, comment, neighborhood, post } from './fixtures/payloads.js';

// The API is faked (unit boundary); the graph is a real LadybugDB file.

const LIMITS: SyncLimits = { ...SYNC_PRESETS.standard, maxRequests: 500 };

function mapped(
  shareId: string,
  comments: unknown[] = [],
  by = author('Alex', 1, neighborhood(3, 'Cedar Park')),
): Post {
  const p = mapPost(post(shareId, { author: by, comments }))!;
  resolveReplyTargets(p.comments);
  return p;
}

function page(posts: Post[], ads = 0): FeedPage {
  return { posts, adsDropped: ads, skipped: {}, nextPage: null };
}

/** Your main feed: post A, which has a comment, with two ads dropped. */
function mainPage(): FeedPage {
  const a = mapped('A');
  a.commentCount = 1;
  return page([a], 2);
}

function fakeApi(overrides: Partial<SyncApi> = {}) {
  const calls: string[] = [];
  const threads = new Map<string, Post>([
    ['post_A', mapped('A', [comment(1, 'hello', { author: author('Bea', 2) })])],
    ['post_B', mapped('B')],
  ]);
  const api: SyncApi = {
    async me() {
      calls.push('me');
      return {
        userId: 'user_42',
        secureUserId: 'secureUser_42',
        name: 'Me',
        neighborhood: { id: 'neighborhood_3', name: 'Cedar Park', slug: 'cedarpark', city: null, state: null },
      };
    },
    async feed({ sort }) {
      calls.push(`feed:${sort}`);
      const a = mapped('A');
      a.commentCount = 1;
      return { posts: [a], adsDropped: 2, skipped: {}, pagesFetched: 1 };
    },
    async *feedPages(source: FeedSource) {
      calls.push(`feedPages:${source.kind}`);
      if (source.kind === 'main') yield mainPage();
      if (source.kind === 'group') yield page([mapped(source.id === 'group_7' ? 'G' : 'N')]);
      else if (source.kind === 'neighborhood') yield page([mapped('B')], 1);
    },
    async post(postId) {
      calls.push(`post:${postId}`);
      const thread = threads.get(postId);
      if (!thread) throw new Error(`Post ${postId} not found (or it is not a regular post).`);
      return thread;
    },
    async *activityPages() {
      calls.push('activity');
      yield {
        activities: [{ kind: 'reaction_to_post', postId: 'post_GONE', at: '2026-10-01T00:00:00Z', summary: '' }],
        nextBefore: null,
        counts: null,
      };
    },
    async userProfile(secureId) {
      calls.push(`profile:${secureId}`);
      return null;
    },
    async neighborhood(slug) {
      calls.push(`hood:${slug}`);
      const ids: Record<string, string> = {
        cedarpark: 'neighborhood_3',
        maplegrove: 'neighborhood_1',
        oakhollow: 'neighborhood_2',
      };
      return { id: ids[slug], name: slug, slug, city: 'Springfield', state: 'IL', neighbors: 300 };
    },
    async business(slug) {
      calls.push(`business:${slug}`);
      return null;
    },
    async myGroups() {
      calls.push('groups');
      return [
        { id: 'group_7', name: 'Gardeners', members: 40, isMember: true },
        { id: 'group_8', name: 'Nearby', members: 9, isMember: false },
      ];
    },
    ...overrides,
  };
  return { api, calls };
}

let store: GraphStore;
const NOW = () => '2026-10-11T08:00:00.000Z';

beforeEach(async () => {
  store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-sync-')), 'graph.lbug'));
});
afterEach(async () => {
  await store?.close();
});

describe('syncGraph', () => {
  it('reads open groups nearby only when asked', async () => {
    const { api, calls } = fakeApi();
    await syncGraph(api, store, { limits: { ...LIMITS, openGroups: true }, now: NOW });
    expect(calls.filter((call) => call === 'feedPages:group')).toHaveLength(2);
    const groups = await store.run(
      'MATCH (p:Post)-[:IN_GROUP]->(g:InterestGroup) RETURN DISTINCT g.name AS name ORDER BY name',
    );
    expect(groups).toEqual([{ name: 'Gardeners' }, { name: 'Nearby' }]);
  });

  it('harvests feeds, groups, threads, reactions, and neighborhoods into the graph', async () => {
    const { api, calls } = fakeApi();
    const stats = await syncGraph(api, store, { limits: LIMITS, now: NOW });

    expect(stats).toMatchObject({ adsDropped: 5, reactions: 1, postsRemoved: 1, neighborhoods: 2, stoppedBy: null });
    expect(calls).toContain('feedPages:news');
    // Your own post history, plus the most active neighbors'.
    expect(calls.filter((call) => call === 'feedPages:user').length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain('feedPages:group');
    expect(calls).toContain('post:post_A');
    // A post known only from the activity log is hydrated; Nextdoor no longer serves it.
    expect(calls).toContain('post:post_GONE');

    const groupPosts = await store.run(
      'MATCH (p:Post)-[:IN_GROUP]->(g:InterestGroup) RETURN p.id AS id, g.name AS g ORDER BY id',
    );
    // Only the group you belong to is read; open groups nearby are skipped unless asked for.
    expect(groupPosts).toEqual([{ id: 'post_G', g: 'Gardeners' }]);
    const member = await store.run("MATCH (:User {id: 'user_42'})-[:MEMBER_OF]->(g) RETURN g.id AS id");
    expect(member).toEqual([{ id: 'group_7' }]);
    expect(calls.filter((call) => call === 'feedPages:group')).toHaveLength(1);
    const gone = await store.run("MATCH (p:Post {id: 'post_GONE'}) RETURN p.removedReason AS reason");
    expect(gone[0].reason).toMatch(/not found/);
    const hood = await store.run("MATCH (n:Neighborhood {slug: 'cedarpark'}) RETURN n.neighbors AS n");
    expect(hood[0].n).toBe(300);
    expect((await store.run('MATCH (s:Sync) RETURN count(s) AS n'))[0].n).toBe(1);
  });

  it('stops cleanly at the request budget', async () => {
    const { api } = fakeApi();
    const stats = await syncGraph(api, store, { limits: { ...LIMITS, maxRequests: 3 }, now: NOW });
    expect(stats.stoppedBy).toMatch(/budget/);
    expect(stats.requests).toBe(3);
  });

  it('runs beforeThreads first, so posts it marks as questions win the thread slots', async () => {
    const big = mapped('P1');
    big.commentCount = 9;
    const small = mapped('P2');
    small.commentCount = 1;
    const { api, calls } = fakeApi({
      async *feedPages(source: FeedSource) {
        if (source.kind === 'main') yield page([big, small]);
      },
      async post(postId) {
        calls.push(`post:${postId}`);
        return mapped(postId.replace('post_', ''));
      },
    });
    const limits = { ...LIMITS, threads: 1 };
    await syncGraph(api, store, {
      limits,
      now: NOW,
      beforeThreads: () =>
        store.saveJudgments({
          subjectId: 'post_P2',
          kind: 'post',
          version: questionSetId('post'),
          properties: { asksQuestion: 0.9 },
        }),
    });
    expect(calls.filter((call) => call.startsWith('post:'))).toEqual(['post:post_P2']);
  });

  it('skips only the throttled operation and keeps going', async () => {
    const { api, calls } = fakeApi({
      async *feedPages(source: FeedSource) {
        calls.push(`feedPages:${source.kind}`);
        if (source.kind === 'neighborhood') throw new ThrottledError('ContentFromHoodFeed');
        if (source.kind === 'main') yield mainPage();
        if (source.kind === 'group') yield page([mapped('G')]);
      },
    });
    const stats = await syncGraph(api, store, { limits: LIMITS, now: NOW });
    expect(stats.stoppedBy).toBeNull();
    expect(stats.throttled).toEqual(['ContentFromHoodFeed']);
    // Only the first neighborhood feed is attempted; threads still load.
    expect(calls.filter((call) => call === 'feedPages:neighborhood')).toHaveLength(1);
    expect(calls).toContain('post:post_A');
    expect(stats.threads).toBeGreaterThan(0);
  });

  it('reads each post history once, then moves on to authors not read yet', async () => {
    const histories: string[][] = [];
    const run = async (throttle = false) => {
      const read: string[] = [];
      const { api } = fakeApi({
        async *feedPages(source: FeedSource) {
          if (source.kind === 'user') {
            if (throttle) throw new ThrottledError('feedActivity');
            read.push(source.secureId);
          } else if (source.kind === 'main') yield mainPage();
          else if (source.kind === 'group') yield page([mapped(source.id === 'group_7' ? 'G' : 'N')]);
        },
      });
      await syncGraph(api, store, { limits: { ...LIMITS, authorHistories: 1 }, now: NOW });
      histories.push(read);
    };
    await run(true);
    expect(await store.run('MATCH (u:User) WHERE u.historyFetchedAt IS NOT NULL RETURN u.id')).toEqual([]);

    await run();
    await run();
    const [first, second] = histories.slice(1).map((read) => read.filter((id) => id !== 'secureUser_42'));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    const read = await store.run(
      'MATCH (u:User) WHERE u.historyFetchedAt IS NOT NULL RETURN u.secureId AS id ORDER BY id',
    );
    expect(read.map((row) => row.id)).toEqual(['secureUser_42', ...[first[0], second[0]].sort()].sort());
  });

  it('stops reading a feed once two pages in a row hold nothing new, and counts what is new', async () => {
    let pagesServed = 0;
    const { api } = fakeApi({
      async *feedPages(source: FeedSource) {
        if (source.kind !== 'group') return;
        for (let index = 0; index < 5; index++) {
          pagesServed += 1;
          yield page([mapped(`F${index}a`), mapped(`F${index}b`)]);
        }
      },
    });
    const limits = { ...LIMITS, pagesPerFeed: 5 };
    const first = await syncGraph(api, store, { limits, now: () => '2026-10-11T08:00:00.000Z' });
    expect(first.feedsCaughtUp).toBe(0);
    expect(first.newPosts).toBeGreaterThanOrEqual(10);
    const firstPages = pagesServed;

    pagesServed = 0;
    const second = await syncGraph(api, store, { limits, now: () => '2026-10-12T08:00:00.000Z' });
    // Each group feed stops after two pages of known posts instead of reading all five.
    expect(pagesServed).toBeLessThan(firstPages);
    expect(second.feedsCaughtUp).toBeGreaterThan(0);
    expect(second.newPosts).toBe(0);
    expect(second.posts).toBeLessThan(first.posts);
  });

  it('asks Nextdoor almost nothing on a run right after a full one', async () => {
    const { api, calls } = fakeApi();
    const first = await syncGraph(api, store, { limits: LIMITS, now: () => '2026-10-11T08:00:00.000Z' });
    expect(first.requests).toBeGreaterThan(10);
    // The second run still does first-time work the first one uncovered (a newly seen author's history).
    await syncGraph(api, store, { limits: LIMITS, now: () => '2026-10-11T08:05:00.000Z' });
    calls.length = 0;
    const third = await syncGraph(api, store, { limits: LIMITS, now: () => '2026-10-11T08:10:00.000Z' });
    // Only the main feed (once per sort order) is asked; everything else is stored, cached, or not due.
    // Profiles that came back empty are not asked again.
    expect(calls.filter((call) => call !== 'feedPages:main')).toEqual([]);
    expect(third.requests).toBe(2);
    expect(third.feedsSkipped).toBeGreaterThan(0);
    expect(third.newPosts).toBe(0);
  });

  it('keeps going when one feed fails', async () => {
    const { api } = fakeApi({
      async myGroups() {
        throw new Error('boom');
      },
    });
    const lines: string[] = [];
    const stats = await syncGraph(api, store, { limits: LIMITS, now: NOW, log: (line) => lines.push(line) });
    expect(stats.failures).toBe(1);
    expect(stats.threads).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('groups failed: boom');
  });
});

describe('analyzeGraph', () => {
  it('judges unjudged posts and comments and stores the results', async () => {
    const { api } = fakeApi();
    await syncGraph(api, store, { limits: LIMITS, now: NOW });
    const seen: unknown[] = [];
    const analyzer = new JevAnalyzer({
      async systemOne(request) {
        seen.push(request.state);
        const isPost = request.questions === POST_QUESTIONS;
        return {
          model: 'jev-test',
          usage: { input_tokens: 10 },
          answers: isPost
            ? {
                'theme.services_recommendations': { type: 'noul', noul: 0.8 },
                primary_theme: {
                  type: 'choice',
                  choice: 'services_recommendations',
                  confidence: 0.9,
                  probabilities: {},
                },
                tone: { type: 'score', score: 3, confidence: 0.8, legend: { 0: '', 1: '', 2: '', 3: '', 4: '' } },
                hostility: { type: 'score', score: 0, confidence: 0.9, legend: { 0: '', 1: '', 2: '', 3: '' } },
              }
            : { stance: { type: 'choice', choice: 'informs', confidence: 0.7, probabilities: {} } },
        } as never;
      },
    });
    const stats = await analyzeGraph(store, analyzer, { posts: 50, comments: 50 });
    expect(stats.posts).toBeGreaterThan(0);
    expect(stats.comments).toBe(1);
    const rows = await store.run(
      "MATCH (p:Post {id: 'post_A'})-[a:ABOUT]->(t:Theme) RETURN p.tone AS tone, p.primaryTheme AS theme, p.jevVersion AS v, a.p AS prob",
    );
    expect(rows).toEqual([{ tone: 0.75, theme: 'services_recommendations', v: questionSetId('post'), prob: 0.8 }]);
    expect(await store.postsNeedingJudgments(questionSetId('post'), 10)).toEqual([]);
  });
});

describe('judgePosts', () => {
  it('judges only unjudged posts and reports why it stopped when Jev is unavailable', async () => {
    for (let i = 0; i < 3; i++) await store.ingestPost(mapped(`K${i}`), NOW);
    const ok = new JevAnalyzer({
      async systemOne() {
        return {
          model: 'jev-test',
          usage: { input_tokens: 4 },
          answers: { asks_question: { type: 'noul', noul: 0.9 } },
        } as never;
      },
    });
    const first = await judgePosts(store, ok, 50);
    expect(first).toMatchObject({ posts: 3, inputTokens: 12, stoppedBy: null });
    expect((await judgePosts(store, ok, 50)).posts).toBe(0);

    await store.ingestPost(mapped('K9'), NOW);
    const broke = new JevAnalyzer({
      async systemOne() {
        throw Object.assign(new Error('402 no credits'), { status: 402 });
      },
    });
    const stopped = await judgePosts(store, broke, 50);
    expect(stopped.posts).toBe(0);
    expect(stopped.stoppedBy).toMatch(/Jev unavailable: 402/);
  });
});

describe('business opinions', () => {
  it('judges each business mention once and stores the opinion on the mention', async () => {
    const acme = { id: 'entity_9', name: 'Acme', slug: 'acme-bakery' };
    const thread = mapped('R', [
      comment(1, 'Acme overcharged me twice, avoid', { author: author('Bea', 2), businesses: [acme] }),
    ]);
    await store.ingestPost(thread, NOW);
    const asked: unknown[] = [];
    const analyzer = new JevAnalyzer({
      async systemOne(request) {
        if (request.questions !== OPINION_QUESTIONS) {
          return { model: 'jev-test', usage: { input_tokens: 1 }, answers: {} } as never;
        }
        asked.push(request.state);
        return {
          model: 'jev-test',
          usage: { input_tokens: 7 },
          answers: {
            opinion: {
              type: 'choice',
              choice: 'unfavorable',
              confidence: 0.9,
              probabilities: { unfavorable: 0.9, favorable: 0.05, neutral: 0.05 },
            },
          },
        } as never;
      },
    });
    const stats = await analyzeGraph(store, analyzer, { posts: 50, comments: 50 });
    expect(stats.opinions).toBe(1);
    expect(asked[0]).toMatchObject({
      business: { name: 'Acme' },
      text: 'Acme overcharged me twice, avoid',
      thread_topic: 'Subject R',
    });
    const rows = await store.run(
      'MATCH (:Comment)-[m:MENTIONS_BUSINESS]->(:Business {id: $id}) RETURN m.opinion AS opinion, m.opinionConfidence AS c',
      { id: 'entity_9' },
    );
    expect(rows).toEqual([{ opinion: 'unfavorable', c: 0.9 }]);
    expect(await store.mentionsNeedingOpinions(10)).toEqual([]);
    expect((await analyzeGraph(store, analyzer, { posts: 50, comments: 50 })).opinions).toBe(0);
  });
});

describe('placing topic posts', () => {
  it("asks once where each topic post is, with the poster's neighborhood as context", async () => {
    await store.ingestPost(mapped('P1'), NOW);
    await store.saveJudgments({
      subjectId: 'post_P1',
      kind: 'post',
      version: questionSetId('post'),
      properties: { tone: 0.4 },
      themes: { crime_safety: 0.9 },
    });
    const asked: unknown[] = [];
    const analyzer = new JevAnalyzer({
      async systemOne(request) {
        if (request.questions !== PLACE_QUESTIONS) {
          return { model: 'jev-test', usage: { input_tokens: 1 }, answers: {} } as never;
        }
        asked.push(request.state);
        return {
          model: 'jev-test',
          usage: { input_tokens: 3 },
          answers: {
            place: {
              type: 'choice',
              choice: 'own_neighborhood',
              confidence: 0.8,
              probabilities: { own_neighborhood: 0.8 },
            },
          },
        } as never;
      },
    });
    const stats = await analyzeGraph(store, analyzer, { posts: 50, comments: 50 });
    expect(stats.placed).toBe(1);
    expect(asked).toEqual([expect.objectContaining({ author_neighborhood: 'Cedar Park' })]);
    const [row] = await store.run(
      "MATCH (p:Post {id: 'post_P1'}) RETURN p.placeScope AS scope, p.placeScopeConfidence AS c, p.placeSet AS set",
    );
    expect(row).toEqual({ scope: 'own_neighborhood', c: 0.8, set: PLACE_QUESTION_SET });
    expect((await analyzeGraph(store, analyzer, { posts: 50, comments: 50 })).placed).toBe(0);
  });
});

describe('judging political posts', () => {
  it('asks only about posts that touch government, once, and stores level, lean, and a signed score', async () => {
    await store.ingestPost(mapped('P1'), NOW);
    await store.ingestPost(mapped('P2'), NOW);
    await store.saveJudgments({
      subjectId: 'post_P1',
      kind: 'post',
      version: questionSetId('post'),
      properties: {},
      themes: { local_government: 0.6 },
    });
    await store.saveJudgments({
      subjectId: 'post_P2',
      kind: 'post',
      version: questionSetId('post'),
      properties: {},
      themes: { events_community: 0.9 },
    });
    const asked: unknown[] = [];
    const analyzer = new JevAnalyzer({
      async systemOne(request) {
        if (request.questions !== POLITICS_QUESTIONS) {
          return { model: 'jev-test', usage: { input_tokens: 1 }, answers: {} } as never;
        }
        asked.push(request.state);
        return {
          model: 'jev-test',
          usage: { input_tokens: 3 },
          answers: {
            level: { type: 'choice', choice: 'state', confidence: 0.85, probabilities: { state: 0.85 } },
            lean: {
              type: 'choice',
              choice: 'right',
              confidence: 0.6,
              probabilities: { left: 0.1, right: 0.6, neutral: 0.3 },
            },
          },
        } as never;
      },
    });
    const stats = await analyzeGraph(store, analyzer, { posts: 50, comments: 50 });
    expect(stats.political).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({ post: expect.objectContaining({ subject: expect.any(String) }) });
    expect(JSON.stringify(asked[0])).not.toMatch(/Cedar Park|Alex/);
    const [row] = await store.run(
      `MATCH (p:Post {id: 'post_P1'}) RETURN p.politicsLevel AS level, p.politicsLean AS lean,
         p.politicsLeanScore AS score, p.politicsSet AS set`,
    );
    expect(row.level).toBe('state');
    expect(row.lean).toBe('right');
    expect(row.score).toBeCloseTo(0.5);
    expect(row.set).toBe(POLITICS_QUESTION_SET);
    const [unasked] = await store.run("MATCH (p:Post {id: 'post_P2'}) RETURN p.politicsSet AS set");
    expect(unasked.set).toBeNull();
    expect((await analyzeGraph(store, analyzer, { posts: 50, comments: 50 })).political).toBe(0);
  });

  it('judges political posts before the comment pass, so they are not stuck behind it', async () => {
    const withComment = mapped('P3', [comment(7, 'agreed', { author: author('Bea', 2) })]);
    await store.ingestPost(withComment, NOW);
    await store.saveJudgments({
      subjectId: 'post_P3',
      kind: 'post',
      version: questionSetId('post'),
      properties: {},
      themes: { national_politics: 0.9 },
    });
    const order: string[] = [];
    const analyzer = new JevAnalyzer({
      async systemOne(request) {
        if (request.questions === POLITICS_QUESTIONS) order.push('politics');
        else if (request.questions !== POST_QUESTIONS && request.questions !== PLACE_QUESTIONS) order.push('comment');
        return { model: 'jev-test', usage: { input_tokens: 1 }, answers: {} } as never;
      },
    });
    await analyzeGraph(store, analyzer, { posts: 50, comments: 50 });
    expect(order).toContain('politics');
    expect(order).toContain('comment');
    expect(order.indexOf('politics')).toBeLessThan(order.indexOf('comment'));
  });
});

describe('when Jev becomes unavailable', () => {
  it('stops asking, keeps what was judged, and resumes from the cache', async () => {
    for (let i = 0; i < 6; i++) await store.ingestPost(mapped(`J${i}`), NOW);
    let calls = 0;
    const out = (request: { questions: unknown }) => {
      calls += 1;
      if (calls > 3)
        throw Object.assign(new Error('402 Your organization has no available TypeSafe API credits.'), { status: 402 });
      return {
        model: 'jev-test',
        usage: { input_tokens: 2 },
        answers:
          request.questions === POST_QUESTIONS
            ? { tone: { type: 'score', score: 2, confidence: 1, legend: { 0: '', 1: '', 2: '', 3: '', 4: '' } } }
            : {},
      };
    };
    const cache = new MemoryCache();
    const lines: string[] = [];
    const broke = new JevAnalyzer({ systemOne: async (request) => out(request) as never }, { cache, concurrency: 1 });
    const stats = await analyzeGraph(store, broke, { posts: 50, comments: 50, log: (line) => lines.push(line) });
    expect(stats.stoppedBy).toMatch(/Jev unavailable: 402/);
    expect(calls).toBe(4);
    expect(cache.entries.size).toBe(3);
    expect(lines.join('\n')).toMatch(/Jev unavailable/);

    calls = -100;
    const fresh = new JevAnalyzer({ systemOne: async (request) => out(request) as never }, { cache, concurrency: 1 });
    const resumed = await analyzeGraph(store, fresh, { posts: 50, comments: 50 });
    expect(resumed.stoppedBy).toBeNull();
    expect(fresh.usage.cached).toBe(3);
    expect(await store.postsNeedingJudgments(questionSetId('post'), 50)).toEqual([]);
  });

  it('recognizes errors that retrying will not fix', () => {
    expect(isJevUnavailable(Object.assign(new Error('nope'), { status: 402 }))).toBe(true);
    expect(isJevUnavailable(new Error('401 Unauthorized'))).toBe(true);
    expect(isJevUnavailable(new Error('Your organization has no available TypeSafe API credits'))).toBe(true);
    expect(isJevUnavailable(new Error('socket hang up'))).toBe(false);
    expect(isJevUnavailable(Object.assign(new Error('busy'), { status: 429 }))).toBe(false);
  });
});

describe('toStored', () => {
  it('keeps raw levels and normalizes tone', () => {
    const stored = toStored({
      subjectId: 'comment_1',
      kind: 'comment',
      model: 'jev',
      questionSet: 'v1',
      nouls: { helpful: 0.7 },
      choices: {},
      scores: { tone: { value: 2, levels: 5, confidence: 1 }, hostility: { value: 1.2, levels: 4, confidence: 1 } },
      inputTokens: 0,
    });
    expect(stored.properties).toEqual({
      stance: null,
      tone: 0.5,
      hostility: 1.2,
      helpful: 0.7,
      recommendsBusiness: null,
    });
  });
});
