import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as analytics from '../src/lib/analytics.js';
import type { Query } from '../src/lib/explore.js';
import { GraphStore } from '../src/lib/graph.js';
import { buildCommunityGraph, NOW, SINCE } from './fixtures/graph.js';

// Integration tests over a real LadybugDB file built from fixture payloads.

let store: GraphStore;
let query: Query;
const now = Date.parse(NOW);

beforeAll(async () => {
  store = await GraphStore.open(await buildCommunityGraph(), { readOnly: true });
  query = (cypher, params) => store.run(cypher, params);
});

afterAll(async () => {
  await store?.close();
});

describe('directories', () => {
  it('lists people with activity, tone, and stance shares, sorted and filtered', async () => {
    const all = await analytics.people(query, { since: SINCE, limit: 50 });
    expect(all.map((row) => row.name).sort()).toEqual(['Alex Neighbor', 'Bea', 'Cal', 'Dee']);
    expect(all.find((row) => row.name === 'Alex Neighbor')).toMatchObject({
      posts: 4,
      neighborhood: 'Cedar Park',
      tone: 0.7,
    });
    expect(all.find((row) => row.name === 'Cal')).toMatchObject({ disagreeShare: 1, comments: 1 });
    expect(all.find((row) => row.name === 'Bea')).toMatchObject({ helpful: 1, repliesReceived: 1, repliers: 1 });
    const coldest = await analytics.people(query, { since: SINCE, sort: 'coldest', limit: 1 });
    expect(coldest[0].name).toBe('Cal');
    expect(await analytics.people(query, { since: SINCE, q: 'BEA', limit: 5 })).toHaveLength(1);
    // An unknown sort falls back to the default instead of reaching Cypher.
    expect(await analytics.people(query, { since: SINCE, sort: 'name; DROP', limit: 5 })).toHaveLength(4);
  });

  it('filters posts by theme, neighborhood, and text', async () => {
    const recs = await analytics.posts(query, { since: SINCE, theme: 'services_recommendations', limit: 10 });
    expect(recs.map((row) => row.id)).toEqual(['post_T1']);
    expect(await analytics.posts(query, { since: SINCE, hood: 'neighborhood_3', limit: 10 })).toHaveLength(4);
    expect((await analytics.posts(query, { since: SINCE, q: 'water', limit: 10 }))[0]).toMatchObject({
      id: 'post_T1',
      author: 'Alex Neighbor',
      neighborhood: 'Cedar Park',
    });
    expect(await analytics.posts(query, { since: NOW, limit: 10 })).toEqual([]);
  });

  it('lists comments by stance with a stance breakdown', async () => {
    const result = await analytics.comments(query, { since: SINCE, stance: 'disagrees', limit: 10 });
    expect(result.rows.map((row) => row.id)).toEqual(['comment_11']);
    expect(result.rows[0]).toMatchObject({ author: 'Cal', postId: 'post_T1', removed: false });
    expect(Object.fromEntries(result.stances.map((row) => [row.stance, row.comments]))).toEqual({
      informs: 2,
      disagrees: 1,
    });
  });

  it('summarizes neighborhoods, themes, and groups', async () => {
    const hoods = await analytics.neighborhoods(query, SINCE);
    expect(hoods.find((row) => row.name === 'Cedar Park')).toMatchObject({
      posts: 4,
      topTheme: 'services_recommendations',
    });
    const themes = await analytics.themes(query, SINCE);
    expect(themes).toEqual([
      expect.objectContaining({
        name: 'services_recommendations',
        source: 'built-in',
        posts: 1,
        weekly: [expect.objectContaining({ posts: 1 })],
      }),
    ]);
    expect(await analytics.groups(query, SINCE)).toEqual([]);
  });
});

describe('health drill-downs', () => {
  it('explains each signal and rejects unknown ones', async () => {
    const warmth = await analytics.healthDrill(query, 'warmth', SINCE);
    const histogram = warmth.find((section) => section.kind === 'histogram')!;
    expect(histogram.rows).toHaveLength(10);
    expect(histogram.rows.reduce((total, row) => total + Number(row.items), 0)).toBe(4);
    expect(warmth.find((section) => section.title === 'Coldest')!.rows[0]).toMatchObject({
      id: 'comment_11',
      kind: 'Comment',
    });

    const help = await analytics.healthDrill(query, 'helpfulness', SINCE);
    expect(help[0].rows).toEqual([]);
    expect(help[1].rows).toEqual([expect.objectContaining({ name: 'Bea', helpful: 1 })]);

    expect((await analytics.healthDrill(query, 'civility', SINCE)).map((section) => section.rows)).toEqual([[], []]);
    expect((await analytics.healthDrill(query, 'agreement', SINCE))[0].rows).toEqual([]);
    await expect(analytics.healthDrill(query, 'vibes', SINCE)).rejects.toMatchObject({ status: 404 });
  });
});

describe('business analytics', () => {
  it('scores every mentioned business with opinions and momentum', async () => {
    const list = await analytics.businesses(query, { since: SINCE, now });
    expect(list).toEqual([
      expect.objectContaining({
        id: 'entity_9',
        mentions: 1,
        people: 1,
        favorable: 1,
        unfavorable: 0,
        judged: 1,
        net: 1,
        last30: 1,
        prior30: 0,
      }),
    ]);
  });

  it('summarizes businesses, categories, standouts, and recommendation demand', async () => {
    const summary = await analytics.businessSummary(query, { since: SINCE, now });
    expect(summary.kpis).toEqual({
      businesses: 1,
      mentions: 1,
      people: 1,
      favorable: 1,
      neutral: 0,
      unfavorable: 0,
      judged: 1,
    });
    expect(summary.categories).toEqual([]);
    expect(summary.uncategorized).toBe(1);
    expect(summary.loved).toEqual([]);
    expect(summary.rising).toEqual([]);
    expect(summary.demand).toMatchObject({ requests: 1, loaded: 1, answered: 1, unanswered: [] });
    expect(summary.weekly).toEqual([expect.objectContaining({ mentions: 1, favorable: 1 })]);
  });

  it('details one business: mentions with opinions, weekly trend, and peers', async () => {
    const detail = await analytics.businessDetail(query, 'entity_9', { since: SINCE, now });
    expect(detail.business).toMatchObject({ name: 'Acme', slug: 'acme-bakery' });
    expect(detail.mentions).toEqual([
      expect.objectContaining({ kind: 'Comment', author: 'Cal', opinion: 'favorable', postId: 'post_T1' }),
    ]);
    expect(detail.weekly).toEqual([expect.objectContaining({ favorable: 1 })]);
    expect(detail.peers).toEqual([]);
    expect(detail.ownPosts).toEqual([]);
    await expect(analytics.businessDetail(query, 'entity_none', { since: SINCE })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('topic screens', () => {
  it('sorts posts into kinds by keyword and recognizes join announcements', () => {
    const kinds = analytics.TOPICS.safety.kinds;
    expect(analytics.kindsOf('Package stolen from the porch; called the sheriff', kinds)).toEqual([
      'Theft and break-ins',
      'Police and sheriff activity',
    ]);
    expect(analytics.kindsOf('A beautiful sunset tonight', kinds)).toEqual([]);
    // Whole words with plurals; a trailing * marks a stem.
    expect(analytics.kindsOf('scatter the seeds', analytics.TOPICS.safety.exclude!.kinds)).toEqual([]);
    expect(analytics.kindsOf('scraped the gunsmith', kinds)).toEqual([]);
    expect(analytics.kindsOf('two guns were taken', kinds)).toEqual(['Violence and threats']);
    expect(analytics.kindsOf('the scammers called again', kinds)).toEqual(['Scams and fraud']);
    expect(analytics.kindsOf('firefighters and fireworks', kinds)).toEqual([]);
    expect(analytics.isJoinAnnouncement('Pat Example just joined Cedar Park.')).toBe(true);
    expect(analytics.isJoinAnnouncement('Pat just joined the PTA and loves it. Anyone else?')).toBe(false);
  });

  it('reports volume, kinds, neighborhoods, sources, and posts for a topic', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { mapPost } = await import('../src/lib/model.js');
    const { author, neighborhood, post } = await import('./fixtures/payloads.js');
    const topicStore = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-topic-')), 'graph.lbug'));
    try {
      const hood = neighborhood(5, 'Maple Grove');
      const posts = [
        post('S1', { subject: 'Package stolen', body: 'Package stolen from my porch', author: author('Bea', 2, hood) }),
        post('S2', {
          subject: 'Advisory',
          body: 'Deputies are patrolling after a break-in',
          author: author('County Sheriff', 9, hood, 'CITY_AGENCY'),
        }),
        post('S3', { subject: '', body: 'Pat Example just joined Maple Grove.', author: author('Pat', 3, hood) }),
        post('S4', { subject: 'Sunset', body: 'What a sunset', author: author('Cal', 4, hood) }),
        post('S5', { subject: 'Lost cat', body: 'Our cat is lost near the park', author: author('Dee', 5, hood) }),
      ];
      for (const raw of posts) await topicStore.ingestPost(mapPost(raw)!, NOW);
      for (const id of ['post_S1', 'post_S2', 'post_S3', 'post_S5']) {
        await topicStore.saveJudgments({
          subjectId: id,
          kind: 'post',
          version: 'post-v1',
          properties: { tone: 0.3, urgency: id === 'post_S2' ? 2 : 0 },
          themes: { crime_safety: 0.9 },
        });
      }
      // Bea's theft happened in her own neighborhood; the sheriff's advisory is general.
      await topicStore.savePlace('post_S1', 'own_neighborhood', 0.9, 'place-v1');
      await topicStore.savePlace('post_S2', 'general', 0.8, 'place-v1');
      const report = await analytics.topicReport((c, p) => topicStore.run(c, p), 'safety', { since: SINCE, now });
      expect(report.kpis.local).toBe(1);
      expect(Object.fromEntries(report.placeBuckets.map((row) => [row.key, row.posts]))).toMatchObject({
        neighborhood: 1,
        general: 1,
        unjudged: 0,
      });
      expect(report.incidentNeighborhoods).toEqual([expect.objectContaining({ name: 'Maple Grove', posts: 1 })]);
      expect(report.posts.map((row) => row.id).sort()).toEqual(['post_S1', 'post_S2']);
      // The lost cat was tagged as safety, but says nothing about how safe the area is.
      expect(report.kpis).toMatchObject({ posts: 2, urgent: 1, fromAgencies: 1, last30: 2, prior30: 0, excluded: 1 });
      expect(report.excludedReason).toMatch(/lost or found pets/);
      expect(report.kpis.share).toBeCloseTo(2 / 5);
      expect(report.kpis.tone).toBeCloseTo(0.3);
      const counts = Object.fromEntries(report.kindCounts.map((row) => [row.kind, row.posts]));
      expect(counts).toMatchObject({ 'Theft and break-ins': 2, 'Police and sheriff activity': 1, Other: 0 });
      expect(report.neighborhoods).toEqual([
        expect.objectContaining({ name: 'Maple Grove', posts: 2, allPosts: 5, share: 0.4 }),
      ]);
      expect(Object.fromEntries(report.sources.map((row) => [row.source, row.posts]))).toEqual({
        Neighbors: 1,
        Agencies: 1,
      });
      expect(report.weekly.reduce((total, row) => total + Number(row.posts), 0)).toBe(2);
      const joined = await analytics.newcomers((c, p) => topicStore.run(c, p), { since: SINCE, now });
      expect(joined.kpis).toMatchObject({ joins: 1, last30: 1, neighborhoods: 1, residentsWithYear: 0 });
      expect(joined.recent).toEqual([
        expect.objectContaining({ name: 'Pat Example', neighborhood: 'Maple Grove', userId: 'user_3' }),
      ]);
      expect(joined.weekly.reduce((total, row) => total + Number(row.joins), 0)).toBe(1);
      expect(joined.residentSince).toEqual([]);

      await expect(
        analytics.topicReport((c, p) => topicStore.run(c, p), 'weather', { since: SINCE }),
      ).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      await topicStore.close();
    }
  });
});

describe('placing topic posts', () => {
  const home = { hoodId: 'n1', neighborhood: 'Maple Grove' };
  const oak = { id: 'n2', name: 'Oak Hollow' };
  it('uses the poster\'s neighborhood only for confident "own neighborhood" judgments', () => {
    expect(analytics.placeOf({ ...home, placeScope: 'own_neighborhood', placeConfidence: 0.9 }, [])).toEqual({
      placeBucket: 'neighborhood',
      placeHoodId: 'n1',
      placeName: 'Maple Grove',
    });
    expect(analytics.placeOf({ ...home, placeScope: 'own_neighborhood', placeConfidence: 0.3 }, [])).toMatchObject({
      placeBucket: 'unclear',
      placeHoodId: null,
    });
    expect(analytics.placeOf({ placeScope: 'own_neighborhood', placeConfidence: 0.9 }, [])).toMatchObject({
      placeBucket: 'elsewhere',
    });
  });

  it('places local incidents elsewhere in the neighborhood the text names', () => {
    expect(analytics.placeOf({ ...home, placeScope: 'elsewhere_local', placeConfidence: 0.8 }, [oak])).toEqual({
      placeBucket: 'neighborhood',
      placeHoodId: 'n2',
      placeName: 'Oak Hollow',
    });
    // Naming one's own neighborhood, or several others, does not identify the place.
    expect(
      analytics.placeOf({ ...home, placeScope: 'elsewhere_local', placeConfidence: 0.8 }, [
        { id: 'n1', name: 'Maple Grove' },
      ]),
    ).toMatchObject({ placeBucket: 'elsewhere' });
    expect(
      analytics.placeOf({ ...home, placeScope: 'elsewhere_local', placeConfidence: 0.8 }, [
        oak,
        { id: 'n3', name: 'Cedar Park' },
      ]),
    ).toMatchObject({ placeBucket: 'elsewhere' });
  });

  it('keeps outside, general, and unjudged posts out of every neighborhood', () => {
    expect(analytics.placeOf({ ...home, placeScope: 'outside_area', placeConfidence: 0.9 }, [oak]).placeBucket).toBe(
      'outside',
    );
    expect(analytics.placeOf({ ...home, placeScope: 'general', placeConfidence: 0.2 }, []).placeBucket).toBe('general');
    expect(analytics.placeOf({ ...home }, [oak]).placeBucket).toBe('unjudged');
  });
});

describe('new neighbors helpers', () => {
  it('parses join announcements', () => {
    expect(analytics.parseJoin('Pat Example just joined Cedar Park.')).toEqual({
      name: 'Pat Example',
      neighborhood: 'Cedar Park',
    });
    expect(analytics.parseJoin('We just joined the gym. Great place!')).toBeNull();
  });

  it("fills weeks up to the current week in the viewer's zone", () => {
    // 2026-10-26 02:46 UTC is still Sunday evening in Los Angeles: that week has not started yet.
    const now = Date.parse('2026-10-26T02:46:00Z');
    const counts = new Map([['2026-10-12', 1]]);
    expect(analytics.fillWeeks(counts, now, 'America/Los_Angeles').map(([week]) => week)).toEqual([
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(analytics.fillWeeks(counts, now).map(([week]) => week)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('fills empty weeks and years so time axes stay true', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const weeks = analytics.fillWeeks(
      new Map([
        ['2026-09-28', 2],
        ['2026-10-12', 1],
      ]),
      now,
    );
    expect(weeks).toEqual([
      ['2026-09-28', 2],
      ['2026-10-05', 0],
      ['2026-10-12', 1],
      ['2026-10-19', 0],
    ]);
    expect(analytics.fillWeeks(new Map(), now)).toEqual([]);
    // Garbage from Nextdoor must not turn into an endless series.
    expect(analytics.fillWeeks(new Map([['not-a-date', 1]]), now)).toEqual([]);
    expect(analytics.fillWeeks(new Map([['1800-01-06', 1]]), now).length).toBeLessThanOrEqual(5300);
    expect(
      analytics.fillYears(
        [
          { year: 2147483647, residents: 1 },
          { year: -5, residents: 1 },
          { year: 2025, residents: 2 },
        ],
        now,
      ),
    ).toEqual([{ year: 2025, residents: 2 }]);
    expect(
      analytics.fillYears([
        { year: 2020, residents: 3 },
        { year: 2022, residents: 1 },
      ]),
    ).toEqual([
      { year: 2020, residents: 3 },
      { year: 2021, residents: 0 },
      { year: 2022, residents: 1 },
    ]);
  });
});

describe("calendar buckets follow the viewer's time zone", () => {
  const week = (row: { week?: unknown }) => String(row.week);

  it('labels weekly series with the local Monday, as a bare date', async () => {
    // The fixture's posts and comments are Saturday 2026-10-10 UTC: the week of Monday 2026-10-05 everywhere.
    const themes = await analytics.themes(query, SINCE, 'America/Los_Angeles');
    expect((themes[0].weekly as Array<{ week: string }>).map(week)).toEqual(['2026-10-05']);
    const summary = await analytics.businessSummary(query, { since: SINCE, now, zone: 'Asia/Tokyo' });
    expect(summary.weekly.map(week)).toEqual(['2026-10-05']);
    const detail = await analytics.businessDetail(query, 'entity_9', { since: SINCE, now, zone: 'Asia/Tokyo' });
    expect(detail.weekly.map(week)).toEqual(['2026-10-05']);
  });

  it('rolls hourly graph counts into weeks, tone, and hostile shares', async () => {
    const rows = await analytics.mood(query, { since: SINCE, weeks: 52, zone: 'UTC' });
    expect(rows).toEqual([
      { week: '2026-10-05', posts: 1, postTone: 70, hostilePostPct: 0, comments: 3, hostileCommentPct: 0 },
    ]);
  });

  it('puts an evening post in the local week, not the next UTC one', async () => {
    const hour = new Date('2026-10-26T02:00:00Z');
    const stub: Query = async (cypher) =>
      cypher.includes(':Post') ? [{ hour, n: 4, tone: 2, hostile: 1 }] : [{ hour, n: 3, hostile: 3 }];
    const local = await analytics.mood(stub, { since: SINCE, weeks: 52, zone: 'America/Los_Angeles' });
    const utc = await analytics.mood(stub, { since: SINCE, weeks: 52, zone: 'UTC' });
    expect(local.map(week)).toEqual(['2026-10-19']);
    expect(utc.map(week)).toEqual(['2026-10-26']);
    expect(local[0]).toMatchObject({ posts: 4, postTone: 50, hostilePostPct: 25, comments: 3, hostileCommentPct: 100 });
  });

  it('keeps comments only in weeks that have posts, newest first, capped at the requested weeks', async () => {
    const stub: Query = async (cypher) =>
      cypher.includes(':Post')
        ? [
            { hour: new Date('2026-10-06T12:00:00Z'), n: 1, tone: 0.4, hostile: 0 },
            { hour: new Date('2026-10-13T12:00:00Z'), n: 1, tone: 0.6, hostile: 0 },
          ]
        : [
            { hour: new Date('2026-10-07T12:00:00Z'), n: 2, hostile: 0 },
            { hour: new Date('2026-09-01T12:00:00Z'), n: 9, hostile: 9 },
          ];
    expect((await analytics.mood(stub, { since: SINCE, weeks: 52 })).map(week)).toEqual(['2026-10-12', '2026-10-05']);
    const [newest] = await analytics.mood(stub, { since: SINCE, weeks: 1 });
    expect(newest).toMatchObject({ week: '2026-10-12', comments: 0, hostileCommentPct: 0 });
  });
});
