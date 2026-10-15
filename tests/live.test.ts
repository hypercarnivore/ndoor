/**
 * Live integration tests: real browser cookies, real Nextdoor gateway, no
 * mocks. Skipped unless NDOOR_LIVE=1 (`make test-live`). They issue roughly
 * ten read-only requests.
 */
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { NextdoorApi } from '../src/lib/api.js';
import { isLoggedIn, resolveCredentials } from '../src/lib/cookies.js';
import { JevAnalyzer, THEMES } from '../src/lib/jev.js';
import { NextdoorClient, StaleOperationError } from '../src/lib/nextdoor-client.js';

const live = process.env.NDOOR_LIVE === '1';

describe.runIf(live)('live Nextdoor', () => {
  const { cookies } = resolveCredentials({});
  const client = new NextdoorClient(cookies);
  const api = new NextdoorApi(client);

  it('resolves a logged-in browser session', () => {
    expect(isLoggedIn(cookies.jar)).toBe(true);
    expect(cookies.csrfToken).toBeTruthy();
  });

  it('identifies the account', async () => {
    const me = await api.me();
    expect(me.userId).toMatch(/^user_\d+$/);
    expect(me.neighborhood?.id).toMatch(/^neighborhood_/);
  });

  it('reads an ad-free feed and a full post thread', async () => {
    const feed = await api.feed({ count: 8 });
    expect(feed.posts.length).toBeGreaterThan(0);
    for (const post of feed.posts) {
      expect(post.id).toMatch(/^post_/);
      expect(post.author.name).not.toBe('');
    }

    const target = feed.posts.find((p) => p.commentCount > 0) ?? feed.posts[0];
    const post = await api.post(target.shareId);
    expect(post.id).toBe(target.id);
    const count = (comments: typeof post.comments): number => comments.reduce((n, c) => n + 1 + count(c.replies), 0);
    expect(count(post.comments)).toBeGreaterThanOrEqual(Math.min(post.commentCount, 1));
  }, 60_000);

  it('searches and lists notifications', async () => {
    const page = await api.search('recommend', { count: 5 });
    expect(page.hits.length).toBeGreaterThan(0);
    expect(page.hits[0].shareId).toBeTruthy();
    const notifications = await api.notifications({ count: 5 });
    expect(Array.isArray(notifications)).toBe(true);
  }, 60_000);

  it('detects stale persisted-query hashes', async () => {
    await expect(client.persisted('getMe', '0'.repeat(64), {})).rejects.toBeInstanceOf(StaleOperationError);
  });
});

describe.runIf(live && Boolean(process.env.TYPESAFE_API_KEY))('live Jev analysis', () => {
  it('judges real feed posts with every post question answered', async () => {
    const api = new NextdoorApi(new NextdoorClient(resolveCredentials({}).cookies));
    const { posts } = await api.feed({ count: 3 });
    const judgments = await new JevAnalyzer(new TypeSafeClient()).analyzePosts(posts);
    expect(judgments).toHaveLength(posts.length);
    for (const j of judgments) {
      expect(j.model).toMatch(/^jev-/);
      expect(Object.keys(j.nouls)).toHaveLength(Object.keys(THEMES).length + 2);
      expect(Object.keys(j.choices).sort()).toEqual(['intent', 'primary_theme']);
      expect(j.scores.tone.value).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});
