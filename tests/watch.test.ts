import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from '../src/lib/graph.js';
import { mapPost, type Post, resolveReplyTargets } from '../src/lib/model.js';
import {
  checkWatches,
  EXAMPLE_WATCHES,
  parseWatches,
  readWatches,
  readWatchState,
  type Watch,
  watchQuery,
  writeWatchState,
} from '../src/lib/watch.js';
import { author, comment, neighborhood, post } from './fixtures/payloads.js';

const BEFORE = '2026-10-10T00:00:00.000Z';
const NOW = '2026-10-11T08:00:00.000Z';
const LATER = '2026-10-12T08:00:00.000Z';
const ME = author('Me', 42, neighborhood(3, 'Cedar Park'));

function mapped(shareId: string, options: Parameters<typeof post>[1] = {}): Post {
  const p = mapPost(post(shareId, options))!;
  resolveReplyTargets(p.comments);
  return p;
}

let store: GraphStore;
const run = (cypher: string, params: Record<string, unknown>) => store.run(cypher, params);

beforeEach(async () => {
  store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-watch-')), 'graph.lbug'));
  await store.ingestPost(
    mapped('WATER', { subject: 'Water main break on 5th', author: author('Ann', 1, neighborhood(3, 'Cedar Park')) }),
    NOW,
  );
  await store.ingestPost(
    mapped('CAT', { subject: 'Lost cat', author: author('Bo', 2, neighborhood(4, 'Oak Hollow')) }),
    NOW,
  );
  await store.ingestPost(
    mapped('MINE', {
      subject: 'My question',
      author: ME,
      comments: [
        comment(1, 'my own note', { author: ME, minutesAgo: 30 }),
        comment(2, 'an answer', { author: author('Cy', 3), minutesAgo: 20 }),
      ],
    }),
    NOW,
  );
  await store.saveJudgments({
    subjectId: 'post_CAT',
    kind: 'post',
    version: 'post-v1',
    properties: { urgency: 2.4 },
    themes: { lost_found_pet: 0.95 },
  });
});

afterEach(async () => {
  await store?.close();
});

async function hits(watch: Watch, since = BEFORE) {
  const { cypher, params } = watchQuery(watch, { since, meId: 'user_42', limit: 10 });
  return (await store.run(cypher, params)).map((row) => row.id);
}

describe('watch rules', () => {
  it('match keywords, case-insensitively, with regex characters escaped', async () => {
    expect(await hits({ name: 'w', keywords: ['WATER MAIN'] })).toEqual(['post_WATER']);
    expect(await hits({ name: 'w', keywords: ['5th.*'] })).toEqual([]);
  });

  it('match themes, urgency, neighborhoods, and authors together', async () => {
    expect(await hits({ name: 'w', themes: ['lost_found_pet'], minUrgency: 2 })).toEqual(['post_CAT']);
    expect(await hits({ name: 'w', themes: ['lost_found_pet'], minUrgency: 3 })).toEqual([]);
    expect(await hits({ name: 'w', neighborhoods: ['cedarpark'] })).toEqual(expect.arrayContaining(['post_WATER']));
    expect(await hits({ name: 'w', neighborhoods: ['oakhollow'] })).toEqual(['post_CAT']);
    expect(await hits({ name: 'w', authors: ['ann'] })).toEqual(['post_WATER']);
  });

  it('only report content first seen after the last check', async () => {
    expect(await hits({ name: 'w', keywords: ['water'] }, LATER)).toEqual([]);
  });

  it('find replies to me, excluding my own comments', async () => {
    expect(await hits({ name: 'r', repliesToMe: true })).toEqual(['comment_2']);
  });
});

describe('checkWatches', () => {
  it('reports hits and advances each watch independently', async () => {
    const watches = parseWatches(EXAMPLE_WATCHES);
    const first = await checkWatches(watches, run, { state: {}, now: LATER, meId: 'user_42', firstRunSince: BEFORE });
    // No crime posts from Maple Grove in the fixtures, so the first example rule stays quiet.
    expect(first.hits.map((hit) => hit.watch)).toEqual(['urgent', 'utilities', 'replies to me']);
    expect(first.hits.find((hit) => hit.watch === 'utilities')?.rows[0]).toMatchObject({
      post: 'Water main break on 5th',
    });
    expect(Object.values(first.state)).toEqual([LATER, LATER, LATER, LATER]);

    const second = await checkWatches(watches, run, {
      state: first.state,
      now: LATER,
      meId: 'user_42',
      firstRunSince: BEFORE,
    });
    expect(second.hits).toEqual([]);
  });
});

describe('watch files', () => {
  it('parses JSON5 and rejects unknown fields and themes', () => {
    expect(parseWatches(EXAMPLE_WATCHES)).toHaveLength(4);
    expect(() => parseWatches('{ watches: [{ name: "x", keyword: ["typo"] }] }')).toThrow(/Invalid watches file/);
    expect(() => parseWatches('{ watches: [{ name: "x", themes: ["aliens"] }] }')).toThrow(/Invalid watches file/);
  });

  it('round-trips state privately and treats missing files as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndoor-watch-state-'));
    expect(readWatches(join(dir, 'none.json5'))).toEqual([]);
    expect(readWatchState(join(dir, 'state.json'))).toEqual({});
    writeWatchState(join(dir, 'nested', 'state.json'), { a: NOW });
    expect(readWatchState(join(dir, 'nested', 'state.json'))).toEqual({ a: NOW });
  });
});
