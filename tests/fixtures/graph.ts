import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/lib/graph.js';
import { mapPost, resolveReplyTargets } from '../../src/lib/model.js';
import { author, comment, neighborhood, post } from './payloads.js';

export const NOW = '2026-10-11T08:00:00.000Z';
export const SINCE = '2000-01-01T00:00:00.000Z';
export const ACME = { id: 'entity_9', name: 'Acme', slug: 'acme-bakery' };

/**
 * A small community in a real LadybugDB file: a recommendation request with a
 * reply thread (one reply names Acme), three more posts by the same author,
 * and Jev judgments and an opinion as `ndoor judge` would store them.
 */
export async function buildCommunityGraph(): Promise<string> {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ndoor-community-')), 'graph.lbug');
  const store = await GraphStore.open(dbPath);
  const p = mapPost(
    post('T1', {
      subject: 'Where to eat by the water?',
      body: 'Where to eat by the water? Visiting this weekend.',
      author: author('Alex Neighbor', 1, neighborhood(3, 'Cedar Park')),
      comments: [
        comment(10, 'where to eat?', {
          author: author('Bea', 2),
          minutesAgo: 30,
          replies: [
            comment(11, '@Bea try Acme', {
              author: author('Cal', 3),
              parent: 10,
              mentions: [2],
              minutesAgo: 20,
              businesses: [ACME],
            }),
          ],
        }),
        comment(12, 'agreed', { author: author('Dee', 4), minutesAgo: 10 }),
      ],
    }),
  )!;
  resolveReplyTargets(p.comments);
  await store.ingestPost(p, NOW);
  for (let i = 0; i < 3; i++) {
    await store.ingestPost(
      mapPost(post(`X${i}`, { author: author('Alex Neighbor', 1, neighborhood(3, 'Cedar Park')) }))!,
      NOW,
    );
  }
  await store.saveJudgments({
    subjectId: 'post_T1',
    kind: 'post',
    version: 'post-v1',
    properties: { tone: 0.7 },
    themes: { services_recommendations: 0.9, crime_safety: 0.02 },
  });
  await store.saveJudgments({
    subjectId: 'comment_11',
    kind: 'comment',
    version: 'comment-v1',
    properties: { stance: 'disagrees', tone: 0.3 },
  });
  for (const [id, tone, helpful] of [
    ['comment_10', 0.8, 0.9],
    ['comment_12', 0.5, 0.1],
  ] as const) {
    await store.saveJudgments({
      subjectId: id,
      kind: 'comment',
      version: 'comment-v1',
      properties: { stance: 'informs', tone, helpful },
    });
  }
  await store.run("MATCH (p:Post {id: 'post_T1'}) SET p.asksQuestion = 0.9, p.threadFetchedAt = timestamp($now)", {
    now: NOW,
  });
  // The reply is sour in tone, but what it says about the business is a recommendation.
  await store.saveOpinion('Comment', 'comment_11', 'entity_9', 'favorable', 0.8);
  await store.close();
  return dbPath;
}
