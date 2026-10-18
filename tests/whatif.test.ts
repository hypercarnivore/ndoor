import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { health, type Query } from '../src/lib/explore.js';
import { GraphStore } from '../src/lib/graph.js';
import { mapPost, resolveReplyTargets } from '../src/lib/model.js';
import { whatIf } from '../src/lib/whatif.js';
import { author, comment, neighborhood, post } from './fixtures/payloads.js';

// Integration tests over a real LadybugDB file: a small community with one troll, one helper, and two questions.

const NOW = '2026-10-11T08:00:00.000Z';
const SINCE = '2000-01-01T00:00:00.000Z';

const nice = author('Nina', 1, neighborhood(3, 'Cedar Park'));
const troll = author('Trent', 2, neighborhood(4, 'Maple Grove'));
const helper = author('Hana', 3, neighborhood(3, 'Cedar Park'));

let store: GraphStore;
let query: Query;

async function ingest(shareId: string, by: ReturnType<typeof author>, comments: unknown[] = []) {
  const p = mapPost(post(shareId, { author: by, comments }))!;
  resolveReplyTargets(p.comments);
  await store.ingestPost(p, NOW);
}

async function judge(
  id: string,
  kind: 'post' | 'comment',
  tone: number,
  extra: Record<string, string | number | null> = {},
) {
  await store.saveJudgments({ subjectId: id, kind, version: 'v1', properties: { tone, ...extra } });
}

beforeAll(async () => {
  store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-whatif-')), 'graph.lbug'));
  // Q1: a question the helper answered; the troll sneers twice, and Nina replies to one sneer.
  await ingest('Q1', nice, [
    comment(1, 'sneer', { author: troll, minutesAgo: 30 }),
    comment(2, 'try this', { author: helper, minutesAgo: 20 }),
    comment(3, 'more sneering', { author: troll, parent: 2, minutesAgo: 10 }),
    comment(5, 'please stop', { author: nice, parent: 1, minutesAgo: 5 }),
  ]);
  // Q2: a question nobody helped with; the troll sneers once.
  await ingest('Q2', nice, [comment(4, 'sneer', { author: troll })]);
  await ingest('P3', troll);
  await ingest('P5', troll);
  await ingest('P4', nice);
  await judge('post_Q1', 'post', 0.7, { primaryTheme: 'services_recommendations' });
  await judge('post_Q2', 'post', 0.7, { primaryTheme: 'services_recommendations' });
  await judge('post_P3', 'post', 0.2, { primaryTheme: 'crime_safety', hostility: 2 });
  await judge('post_P5', 'post', 0.2, { primaryTheme: 'crime_safety', hostility: 2 });
  await judge('post_P4', 'post', 0.8, { primaryTheme: 'events_community' });
  await judge('comment_1', 'comment', 0.1, { stance: 'disagrees', hostility: 2 });
  await judge('comment_2', 'comment', 0.8, { stance: 'informs', helpful: 0.9 });
  await judge('comment_3', 'comment', 0.1, { stance: 'disagrees', hostility: 2 });
  await judge('comment_4', 'comment', 0.1, { stance: 'disagrees', hostility: 2 });
  await judge('comment_5', 'comment', 0.6, { stance: 'informs' });
  for (const id of ['post_Q1', 'post_Q2']) {
    await store.run('MATCH (p:Post {id: $id}) SET p.asksQuestion = 0.9, p.threadFetchedAt = timestamp($now)', {
      id,
      now: NOW,
    });
  }
  query = (cypher, params) => store.run(cypher, params);
});

afterAll(async () => {
  await store?.close();
});

describe('what-if scenarios', () => {
  it('starts from the dashboard score', async () => {
    const dashboard = await health(query, SINCE);
    const result = await whatIf(query, 'people', { since: SINCE, n: 0 });
    expect(result.before.score).toBe(dashboard.score);
    expect(result.after.score).toBe(dashboard.score);
    expect(result.delta).toBe(0);
    expect(result.before.signals.civility.raw).toBeCloseTo(dashboard.signals.civility.raw!);
    expect(result.removed).toMatchObject({ people: 0, posts: 0, comments: 0, share: 0 });
  });

  it('removes the most hostile people and shows what each would change alone', async () => {
    const result = await whatIf(query, 'people', { since: SINCE, n: 1, rank: 'hostile' });
    expect(result.subjects?.[0]).toMatchObject({ name: 'Trent', hostile: 5, items: 5 });
    expect(result.subjects?.[0].alone).toBeGreaterThan(0);
    expect(result.after.signals.civility.raw).toBe(0);
    expect(result.delta).toBeGreaterThan(0);
    // Only the troll's own writing: three comments and two posts.
    expect(result.removed).toMatchObject({ people: 1, posts: 2, comments: 3 });
    expect(result.curve?.[0]).toEqual({ n: 0, score: result.before.exact });
    expect(result.curve?.[1].score).toBeGreaterThan(result.curve![0].score!);
  });

  it('also removes replies to removed comments when asked', async () => {
    const on = await whatIf(query, 'people', { since: SINCE, n: 1, rank: 'hostile', cascade: true });
    expect(on.removed.comments).toBe(4);
    const off = await whatIf(query, 'people', { since: SINCE, n: 1, rank: 'hostile' });
    expect(off.removed.comments).toBe(3);
    expect(on.delta).toBeGreaterThanOrEqual(off.delta!);
  });

  it('keeps small effects that the rounded score would hide', async () => {
    const result = await whatIf(query, 'themes', { since: SINCE });
    // Deltas keep two decimals, finer than the dashboard's tenth.
    expect(result.table!.some((row) => Math.round((row.delta as number) * 10) / 10 !== row.delta)).toBe(true);
  });

  it('shows what losing the most helpful people would cost', async () => {
    const result = await whatIf(query, 'people', { since: SINCE, n: 1, rank: 'helpful' });
    expect(result.subjects?.[0]).toMatchObject({ name: 'Hana', helpful: 1 });
    expect(result.after.signals.helpfulness.raw).toBe(0);
  });

  it('ranks by hostile share, individual impact, and negativity', async () => {
    for (const rank of ['hostileShare', 'impact', 'negativity']) {
      const result = await whatIf(query, 'people', { since: SINCE, n: 1, rank });
      expect(result.subjects?.[0].name, rank).toBe('Trent');
    }
  });

  it('removes the worst threads', async () => {
    const result = await whatIf(query, 'threads', { since: SINCE, n: 1 });
    expect(result.subjects?.[0]).toMatchObject({ id: 'post_Q1', hostile: 2, author: 'Nina' });
    expect(result.removed).toMatchObject({ posts: 1, comments: 4 });
    expect(result.curve?.length).toBe(5);
  });

  it('removes a share of hostile writing', async () => {
    const all = await whatIf(query, 'hostility', { since: SINCE });
    expect(all.after.signals.civility.raw).toBe(0);
    expect(all.delta).toBeGreaterThan(0);
    const none = await whatIf(query, 'hostility', { since: SINCE, share: 0 });
    expect(none.delta).toBe(0);
    expect(none.removed.share).toBe(0);
  });

  it('answers open questions and moves only helpfulness', async () => {
    const result = await whatIf(query, 'answers', { since: SINCE, share: 1 });
    expect(result.subjects?.map((row) => row.id)).toEqual(['post_Q2']);
    expect(result.before.signals.helpfulness.raw).toBe(0.5);
    expect(result.after.signals.helpfulness.raw).toBe(1);
    expect(result.after.signals.civility.raw).toBe(result.before.signals.civility.raw);
    expect(result.delta).toBeGreaterThan(0);
  });

  it('scores the community without each topic', async () => {
    const result = await whatIf(query, 'themes', { since: SINCE });
    const rows = result.table!;
    expect(rows[0]).toMatchObject({ key: 'crime_safety', posts: 2 });
    expect(rows[0].delta).toBeGreaterThan(0);
    expect(rows.map((row) => row.key)).toContain('events_community');
    expect(result.removed.share).toBe(0);
  });

  it('lists neighborhoods that have enough judged posts', async () => {
    const result = await whatIf(query, 'places', { since: SINCE });
    expect(result.table).toEqual([]);
  });

  it('warns when most of the community would be removed', async () => {
    const result = await whatIf(query, 'people', { since: SINCE, n: 3, rank: 'negativity', cascade: true });
    expect(result.removed.share).toBeGreaterThan(0.25);
    expect(result.caveats.join(' ')).toMatch(/much smaller community/);
  });

  it('rejects unknown scenarios', async () => {
    await expect(whatIf(query, 'vibes', { since: SINCE })).rejects.toMatchObject({ status: 404 });
  });
});
