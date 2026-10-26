import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphStore } from '../src/lib/graph.js';
import { leanScore, POLITICS_GATE_P, POLITICS_GATE_THEMES, POLITICS_QUESTION_SET } from '../src/lib/jev.js';
import { mapPost } from '../src/lib/model.js';
import {
  type PoliticalPost,
  parseSources,
  politicsReport,
  summarizePolitics,
  toPoliticalPosts,
} from '../src/lib/politics.js';
import { author, neighborhood, post } from './fixtures/payloads.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const DAY = 86_400_000;

/** A political post `daysAgo` days before NOW. */
function political(
  id: string,
  authorId: string,
  hood: string | null,
  score: number,
  daysAgo: number,
  level: PoliticalPost['level'] = 'local',
): PoliticalPost {
  return {
    id,
    at: NOW - daysAgo * DAY,
    authorId,
    hoodId: hood,
    neighborhood: hood && `Hood ${hood}`,
    level,
    lean: score > 0.2 ? 'right' : score < -0.2 ? 'left' : 'neutral',
    score,
  };
}

/** Deterministic spread around a center, so variance is nonzero without randomness. */
const wobble = (center: number, i: number) => center + ((i % 5) - 2) * 0.2;

describe('lean score', () => {
  it('is P(right) - P(left), so uncertain posts sit near the middle', () => {
    expect(leanScore({ left: 0.1, right: 0.8, neutral: 0.1 })).toBeCloseTo(0.7);
    expect(leanScore({ left: 0.45, right: 0.35, neutral: 0.2 })).toBeCloseTo(-0.1);
    expect(leanScore({ neutral: 1 })).toBe(0);
  });
});

describe('summarizePolitics', () => {
  // Six neighborhoods, 12 authors each, one post each, spread over the last 60 days; only "a" differs.
  const posts: PoliticalPost[] = [];
  for (const [hood, center] of [
    ['a', 0.6],
    ['b', -0.05],
    ['c', 0],
    ['d', 0.05],
    ['e', 0],
    ['f', -0.05],
  ] as const) {
    for (let i = 0; i < 12; i += 1)
      posts.push(political(`${hood}${i}`, `${hood}-user${i}`, hood, wobble(center, i), 5 + i * 4));
  }

  it('counts, splits by level, and flags only the neighborhood that truly differs', () => {
    const report = summarizePolitics(posts, 360, 4, NOW);
    expect(report.kpis).toMatchObject({ posts: 72, authors: 72, pending: 4 });
    expect(report.kpis.share).toBeCloseTo(0.2);
    expect(report.kpis.left + report.kpis.right + report.kpis.neutral).toBe(72);
    const flagged = report.neighborhoods.filter((row) => row.significant).map((row) => row.id);
    expect(flagged).toEqual(['a']);
    expect(report.neighborhoods.find((row) => row.id === 'a')).toMatchObject({ posts: 12, authors: 12 });
    expect(
      report.findings.some((f) => f.kind === 'neighborhood' && f.significant && /Hood a leans more right/.test(f.text)),
    ).toBe(true);
    expect(report.levels.map((row) => row.level)).toEqual(['local', 'state', 'national']);
    expect(report.levels[0].posts).toBe(72);
  });

  it('flags a neighborhood as leaning when the raw result points one way but the corrected test does not', () => {
    const town = (center: number) => {
      const crowd: PoliticalPost[] = [];
      for (const hood of ['b', 'c', 'd', 'e', 'f', 'h']) {
        for (let i = 0; i < 12; i += 1)
          crowd.push(political(`${hood}${i}`, `${hood}-u${i}`, hood, wobble(0, i), 5 + i * 4));
      }
      for (let i = 0; i < 6; i += 1) crowd.push(political(`g${i}`, `g-u${i}`, 'g', wobble(center, i), 5 + i * 4));
      return summarizePolitics(crowd, 500, 0, NOW);
    };
    const leaning = town(0.3);
    const hood = leaning.neighborhoods.find((row) => row.id === 'g')!;
    expect(hood).toMatchObject({ significant: false, leaning: true });
    expect(hood.p).toBeLessThan(0.1);
    expect(hood.q).toBeGreaterThan(0.1);
    expect(leaning.findings.at(-1)!.text).toMatch(/1 more lean away from town but need more posts to be sure/);
    // A smaller gap is neither significant nor leaning; untested neighborhoods never lean.
    expect(town(0.1).neighborhoods.find((row) => row.id === 'g')).toMatchObject({ significant: false, leaning: false });
    const sparse = summarizePolitics([political('x', 'u1', 'z', 0.9, 3)], 10, 0, NOW);
    expect(sparse.neighborhoods[0]).toMatchObject({ p: null, leaning: false, significant: false });
  });

  it('does not let one prolific author make a neighborhood look partisan', () => {
    const crowd: PoliticalPost[] = [];
    for (let i = 0; i < 30; i += 1) crowd.push(political(`z${i}`, 'loud-user', 'z', 0.9, 3 + i));
    for (const hood of ['b', 'c', 'd']) {
      for (let i = 0; i < 12; i += 1)
        crowd.push(political(`${hood}${i}`, `${hood}-user${i}`, hood, wobble(0, i), 5 + i * 4));
    }
    const report = summarizePolitics(crowd, 1000, 0, NOW);
    const zed = report.neighborhoods.find((row) => row.id === 'z')!;
    expect(zed.posts).toBe(30);
    expect(zed.authors).toBe(1);
    expect(zed.p).toBeNull();
    expect(zed.significant).toBe(false);
  });

  it('claims a trend only with enough months, and reports its direction', () => {
    const drifting: PoliticalPost[] = [];
    // Ten months, 8 posts each, lean rising steadily from left to right.
    for (let m = 0; m < 10; m += 1) {
      for (let i = 0; i < 8; i += 1)
        drifting.push(political(`m${m}-${i}`, `u${m}-${i}`, 'a', wobble(-0.4 + m * 0.08, i), (9 - m) * 30 + i));
    }
    const trend = summarizePolitics(drifting, 500, 0, NOW).findings.find((f) => f.kind === 'trend')!;
    expect(trend.significant).toBe(true);
    expect(trend.text).toMatch(/moved right/);

    const sparse = summarizePolitics(posts.slice(0, 5), 50, 0, NOW).findings.find((f) => f.kind === 'trend')!;
    expect(sparse.significant).toBe(false);
    expect(sparse.text).toMatch(/Too early to show a trend/);
  });

  it('compares the last 90 days with the 90 before, and says so when there are too few authors', () => {
    const shifted: PoliticalPost[] = [];
    for (let i = 0; i < 12; i += 1) {
      shifted.push(political(`new${i}`, `new-user${i}`, 'a', wobble(0.4, i), 5 + i * 6));
      shifted.push(political(`old${i}`, `old-user${i}`, 'a', wobble(-0.2, i), 100 + i * 6));
    }
    const window = summarizePolitics(shifted, 500, 0, NOW).findings.find((f) => f.kind === 'window')!;
    expect(window.significant).toBe(true);
    expect(window.text).toMatch(/lean more right than the 90 days before/);
    expect(summarizePolitics(posts.slice(0, 3), 10, 0, NOW).findings.find((f) => f.kind === 'window')!.text).toMatch(
      /Too early to compare/,
    );
  });

  it('is empty-safe', () => {
    const report = summarizePolitics([], 0, 0, NOW);
    expect(report.kpis).toMatchObject({ posts: 0, share: null, meanLean: null });
    expect(report.monthly).toEqual([]);
    expect(report.neighborhoods).toEqual([]);
  });

  it('fills months with no posts so the time axis stays true', () => {
    const gap = [political('x', 'u1', 'a', 0.5, 100), political('y', 'u2', 'a', -0.5, 5)];
    const months = summarizePolitics(gap, 10, 0, NOW).monthly;
    expect(months.length).toBeGreaterThanOrEqual(4);
    expect(months.some((row) => row.total === 0 && row.meanLean === null)).toBe(true);
  });

  it("assigns months by the viewer's calendar", () => {
    // 2026-11-01 03:00 UTC is still the evening of Oct 31 in Los Angeles.
    const edge = Date.parse('2026-11-01T03:00:00Z');
    const post = { ...political('x', 'u1', 'a', 0.5, 0), at: edge };
    expect(summarizePolitics([post], 10, 0, edge, 'America/Los_Angeles').monthly.map((row) => row.month)).toEqual([
      '2026-10',
    ]);
    expect(summarizePolitics([post], 10, 0, edge, 'UTC').monthly.map((row) => row.month)).toEqual(['2026-11']);
  });
});

describe('toPoliticalPosts', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'p',
    at: '2026-06-01T00:00:00.000Z',
    authorId: 'u',
    hoodId: null,
    neighborhood: null,
    level: 'local',
    levelConfidence: 0.9,
    lean: 'left',
    score: -0.6,
    ...over,
  });

  it('drops non-political posts, sets doubtful ones aside, and skips malformed rows', () => {
    const result = toPoliticalPosts([
      row({}),
      row({ id: 'q', level: 'not_political' }),
      row({ id: 'r', levelConfidence: 0.3 }),
      row({ id: 's', lean: 'sideways' }),
      row({ id: 't', score: null }),
    ]);
    expect(result.posts.map((p) => p.id)).toEqual(['p']);
    expect(result.unclear).toBe(1);
  });
});

describe('politicsReport', () => {
  let store: GraphStore;
  const gate = { themes: POLITICS_GATE_THEMES, minP: POLITICS_GATE_P, set: POLITICS_QUESTION_SET };

  beforeAll(async () => {
    store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-politics-')), 'graph.lbug'));
    const hood = neighborhood(5, 'Maple Grove');
    const now = new Date(NOW).toISOString();
    const raws = [
      post('G1', { subject: 'Council vote', body: 'The council approved the levy', author: author('Bea', 2, hood) }),
      post('G2', { subject: 'Senate bill', body: 'Congress passed the bill', author: author('Cal', 3, hood) }),
      post('G3', { subject: 'Bake sale', body: 'Cookies at the church', author: author('Dee', 4, hood) }),
      post('G4', { subject: 'Zoning hearing', body: 'Hearing on Tuesday', author: author('Eli', 5, hood) }),
    ];
    for (const raw of raws) await store.ingestPost(mapPost(raw)!, now);
    for (const id of ['post_G1', 'post_G2', 'post_G4']) {
      await store.saveJudgments({
        subjectId: id,
        kind: 'post',
        version: 'post-v1',
        properties: {},
        themes: { [id === 'post_G2' ? 'national_politics' : 'local_government']: 0.8 },
      });
    }
    await store.savePolitics(
      'post_G1',
      { level: 'local', levelConfidence: 0.9, lean: 'left', leanConfidence: 0.7, leanScore: -0.6 },
      POLITICS_QUESTION_SET,
    );
    await store.savePolitics(
      'post_G2',
      { level: 'national', levelConfidence: 0.95, lean: 'right', leanConfidence: 0.8, leanScore: 0.7 },
      POLITICS_QUESTION_SET,
    );
    // Gated in, then judged not political: counted by neither pending nor the report.
    await store.savePolitics(
      'post_G3',
      { level: 'not_political', levelConfidence: 0.9, lean: 'neutral', leanConfidence: 0.9, leanScore: 0 },
      POLITICS_QUESTION_SET,
    );
  });

  afterAll(async () => {
    await store?.close();
  });

  it('reports judged political posts, excludes the rest, and counts what is still pending', async () => {
    const report = await politicsReport((c, p) => store.run(c, p), gate, { since: '2026-01-01T00:00:00Z', now: NOW });
    expect(report.kpis).toMatchObject({ posts: 2, left: 1, right: 1, neutral: 0, pending: 1 });
    expect(report.kpis.share).toBeCloseTo(2 / 4);
    expect(report.levels.find((row) => row.level === 'national')).toMatchObject({ posts: 1, right: 1 });
    expect(report.posts.map((p) => p.id).sort()).toEqual(['post_G1', 'post_G2']);
    expect(report.minimums.hoodPosts).toBeGreaterThan(0);
  });

  it('never names authors in the post list', async () => {
    const report = await politicsReport((c, p) => store.run(c, p), gate, { since: '2026-01-01T00:00:00Z', now: NOW });
    expect(JSON.stringify(report.posts)).not.toMatch(/Bea|Cal|authorId|author/);
  });

  it('asks again when the question set changes', async () => {
    const stale = await store.postsNeedingPolitics(POLITICS_GATE_THEMES, POLITICS_GATE_P, 'politics-v2', 100);
    expect(stale.map((row) => row.id).sort()).toEqual(['post_G1', 'post_G2', 'post_G4']);
    const current = await store.postsNeedingPolitics(POLITICS_GATE_THEMES, POLITICS_GATE_P, POLITICS_QUESTION_SET, 100);
    expect(current.map((row) => row.id)).toEqual(['post_G4']);
  });
});

describe('sources', () => {
  let store: GraphStore;
  const gate = { themes: POLITICS_GATE_THEMES, minP: POLITICS_GATE_P, set: POLITICS_QUESTION_SET };
  const since = '2026-01-01T00:00:00Z';

  beforeAll(async () => {
    store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-politics-src-')), 'graph.lbug'));
    const hood = neighborhood(5, 'Maple Grove');
    const now = new Date(NOW).toISOString();
    const posts: Array<[string, string, number, string | undefined, number]> = [
      ['H1', 'Bea', 2, undefined, -0.6],
      ['H2', 'Cal', 3, 'group_1', 0.7],
      ['H3', 'Dee', 4, 'group_2', 0.8],
    ];
    for (const [id, name, userId, groupId] of posts.map(([a, b, c, d]) => [a, b, c, d] as const)) {
      await store.ingestPost(
        mapPost(post(id, { subject: `Vote ${id}`, body: 'About the election', author: author(name, userId, hood) }))!,
        now,
        { groupId },
      );
    }
    // The signed-in user (Bea) belongs to group_1 only.
    await store.upsertGroups(
      [
        { id: 'group_1', name: 'My Group', members: 5, isMember: true },
        { id: 'group_2', name: 'Open Group', members: 50, isMember: false },
      ],
      'user_2',
      now,
    );
    for (const [id, , , , score] of posts) {
      await store.savePolitics(
        `post_${id}`,
        {
          level: 'local',
          levelConfidence: 0.9,
          lean: score > 0 ? 'right' : 'left',
          leanConfidence: 0.8,
          leanScore: score,
        },
        POLITICS_QUESTION_SET,
      );
    }
  });

  afterAll(async () => {
    await store?.close();
  });

  const report = (sources?: Array<'feed' | 'mine' | 'open'>) =>
    politicsReport((c, p) => store.run(c, p), gate, { since, now: NOW, sources });

  it('tells feed posts, my groups, and other groups apart', async () => {
    const all = await report();
    expect(all.sources.counts).toEqual({ feed: 1, mine: 1, open: 1 });
    expect(all.kpis.posts).toBe(3);
    expect(Object.fromEntries(all.posts.map((p) => [p.id, p.source]))).toEqual({
      post_H1: 'feed',
      post_H2: 'mine',
      post_H3: 'open',
    });
  });

  it('leaves out unselected sources, but still reports how many each has', async () => {
    const mine = await report(['feed', 'mine']);
    expect(mine.kpis).toMatchObject({ posts: 2, left: 1, right: 1 });
    expect(mine.posts.map((p) => p.id).sort()).toEqual(['post_H1', 'post_H2']);
    expect(mine.sources.counts).toEqual({ feed: 1, mine: 1, open: 1 });
    expect(mine.kpis.share).toBeCloseTo(2 / 2);
  });

  it('parses the sources parameter, falling back to all', () => {
    expect(parseSources('feed,mine')).toEqual(['feed', 'mine']);
    expect(parseSources('bogus')).toEqual(['feed', 'mine', 'open']);
    expect(parseSources(null)).toEqual(['feed', 'mine', 'open']);
  });
});
