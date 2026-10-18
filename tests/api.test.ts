import { describe, expect, it } from 'vitest';
import { NextdoorApi, toFeedItemId } from '../src/lib/api.js';
import { at } from '../src/lib/model.js';
import type { NextdoorClient } from '../src/lib/nextdoor-client.js';
import { DEFAULT_OPERATIONS, type OperationName, resolveHashes } from '../src/lib/operations.js';
import {
  activityResponse,
  comment,
  feedItemResponse,
  feedResponse,
  meResponse,
  notificationResponse,
  pagedCommentsResponse,
  post,
  postItem,
  promoItem,
  searchResponse,
  userPostsResponse,
} from './fixtures/payloads.js';

type Call = { operation: string; hash: string; variables: Record<string, unknown> };

/** Unit-level fake: replays scripted responses per operation and records calls. */
function fakeApi(script: Partial<Record<OperationName, unknown[]>>) {
  const calls: Call[] = [];
  const client = {
    persisted: async (operation: OperationName, hash: string, variables: Record<string, unknown>) => {
      calls.push({ operation, hash, variables });
      const queue = script[operation];
      if (!queue || queue.length === 0) throw new Error(`unexpected ${operation} call`);
      return queue.shift();
    },
  } as unknown as NextdoorClient;
  return {
    api: new NextdoorApi(client, { delayMs: 0, timeZone: 'America/New_York', hashes: resolveHashes({}) }),
    calls,
  };
}

describe('toFeedItemId', () => {
  it('normalizes share ids and numeric legacy ids', () => {
    expect(toFeedItemId('abc')).toBe('sharedPost_abc');
    expect(toFeedItemId('sharedPost_abc')).toBe('sharedPost_abc');
    expect(toFeedItemId('post_123')).toBe('post_123');
    expect(toFeedItemId('123')).toBe('post_123');
  });
});

describe('NextdoorApi', () => {
  it('uses default hashes', async () => {
    const { api, calls } = fakeApi({ getMe: [meResponse()] });
    expect((await api.me()).name).toBe('Pat Example');
    expect(calls[0].hash).toBe(DEFAULT_OPERATIONS.getMe.hash);
  });

  it('pages the feed, drops ads, and dedupes posts', async () => {
    const { api, calls } = fakeApi({
      PersonalizedFeed: [
        feedResponse([postItem(post('A')), promoItem('ad'), postItem(post('B'))], 'p2'),
        feedResponse([postItem(post('B')), promoItem('ad2'), postItem(post('C')), postItem(post('D'))], 'p3'),
      ],
    });
    const result = await api.feed({ count: 3, sort: 'RECENT_POSTS' });
    expect(result.posts.map((p) => p.shareId)).toEqual(['A', 'B', 'C']);
    expect(result.adsDropped).toBe(2);
    expect(result.pagesFetched).toBe(2);
    const args = calls.map((c) => c.variables.mainFeedArgs as Record<string, unknown>);
    expect(args[0]).toMatchObject({ nextPage: null, sortOrder: 'RECENT_POSTS', pageSize: 5 });
    expect(args[1]).toMatchObject({ nextPage: 'p2', feedRequestId: args[0].feedRequestId });
  });

  it('stops when the feed has no next page', async () => {
    const { api } = fakeApi({ PersonalizedFeed: [feedResponse([postItem(post('A'))], null)] });
    expect((await api.feed({ count: 10 })).posts).toHaveLength(1);
  });

  it('loads the full comment tree for a post', async () => {
    const detail = post('P', {
      comments: [comment(1, 'first', { replies: [comment(2, 'r1')], pending: 1 })],
      totalComments: 3,
      endCursor: 'top-2',
    });
    const { api, calls } = fakeApi({
      FeedItem: [feedItemResponse(detail)],
      PagedComments: [
        pagedCommentsResponse([comment(3, 'second')], null),
        pagedCommentsResponse([comment(2, 'r1'), comment(4, 'r2', { minutesAgo: 1 })], null),
      ],
    });
    const result = await api.post('P');
    expect(calls[0].variables).toMatchObject({ feedItemId: 'sharedPost_P', pagedCommentsMode: 'DETAILS' });
    expect(calls.slice(1).map((c) => c.variables.after)).toEqual(['top-2', 'replies-1']);
    expect(calls[1].variables.includeDeletedComments).toBe(true);
    expect(result.comments.map((c) => c.body)).toEqual(['first', 'second']);
    expect(result.comments[0].replies.map((c) => c.body)).toEqual(['r1', 'r2']);
    expect(result.commentsCursor).toBeNull();
  });

  it('skips comment paging when asked', async () => {
    const { api, calls } = fakeApi({
      FeedItem: [feedItemResponse(post('P', { comments: [comment(1, 'x')], totalComments: 5, endCursor: 'c' }))],
    });
    expect((await api.post('P', { allComments: false })).commentsCursor).toBe('c');
    expect(calls).toHaveLength(1);
  });

  it('fails clearly when a post is missing', async () => {
    const { api } = fakeApi({ FeedItem: [{ feedItem: null }] });
    await expect(api.post('nope')).rejects.toThrow(/not found/);
  });

  it('pages search results with postSearchArgs.cursor', async () => {
    const { api, calls } = fakeApi({
      searchPost: [searchResponse(['S1', 'S2'], 'c2'), searchResponse(['S3', 'S4'], 'c3')],
    });
    const page = await api.search('plumber', { count: 3 });
    expect(page.hits.map((h) => h.shareId)).toEqual(['S1', 'S2', 'S3']);
    expect(page.nextCursor).toBe('c3');
    const args = calls.map((c) => c.variables.postSearchArgs as Record<string, unknown>);
    expect(args[0].cursor).toBeUndefined();
    expect(args[1]).toMatchObject({ cursor: 'c2', requestId: args[0].requestId });
  });

  it('pages notifications', async () => {
    const { api, calls } = fakeApi({
      NotificationFeed: [notificationResponse([1, 2], 'n2'), notificationResponse([3], null)],
    });
    expect((await api.notifications({ count: 10 })).map((n) => n.id)).toEqual([
      'notification_1',
      'notification_2',
      'notification_3',
    ]);
    expect((calls[1].variables.notificationFeedArgs as Record<string, unknown>).nextPage).toBe('n2');
  });

  it('walks the activity log page by page, resuming from a cursor', async () => {
    const { api, calls } = fakeApi({
      allActivities: [
        activityResponse(
          [
            [1, 'post_1', 3],
            [2, 'post_2', 2],
          ],
          'b1',
        ),
        activityResponse([[3, 'post_3', 1]], null),
        activityResponse([], null),
      ],
    });
    const pages = [];
    for await (const page of api.activityPages('secureUser_42', { delayMs: 0 })) pages.push(page);
    expect(pages.map((p) => p.activities.map((a) => a.postId))).toEqual([['post_1', 'post_2'], ['post_3']]);
    expect(pages[0].counts).toEqual({ posts: 3, comments: 5, reactions: 9 });
    expect(calls.map((c) => c.variables.feedArgs)).toEqual([
      { beforeTimestamp: null, pageSize: 10 },
      { beforeTimestamp: 'b1', pageSize: null },
    ]);
    expect(calls[0].variables.input).toBe('secureUser_42');

    for await (const _ of api.activityPages('secureUser_42', { before: 'b9', delayMs: 0 })) break;
    expect(calls[2].variables.feedArgs).toEqual({ beforeTimestamp: 'b9', pageSize: null });
  });

  it("pages through a user's own posts", async () => {
    const { api, calls } = fakeApi({
      feedActivity: [userPostsResponse([postItem(post('U1'))], 'n2'), userPostsResponse([postItem(post('U2'))], null)],
    });
    const posts: string[] = [];
    for await (const p of api.userPosts('secureUser_42')) posts.push(p.shareId);
    expect(posts).toEqual(['U1', 'U2']);
    expect((calls[1].variables.feedArgs as Record<string, unknown>).nextPage).toBe('n2');
  });
});

describe('feed sources', () => {
  it('builds each feed operation and pages with its cursor', async () => {
    const page = (next: string | null) => ({ wrapper: { feedItems: [postItem(post('X'))], nextPage: next } });
    const cases = [
      {
        source: { kind: 'neighborhood', slug: 'maplegrove' },
        op: 'ContentFromHoodFeed',
        root: ['neighborhood', 'contentFromHoodFeed'],
        cursor: 'input.nextPage',
      },
      {
        source: { kind: 'agency', id: '4200001' },
        op: 'agencyFeed',
        root: ['me', 'agencyFeed'],
        cursor: 'agencyFeedArgs.nextPage',
      },
      {
        source: { kind: 'group', id: 'group_47' },
        op: 'groupsWithPromosFeed',
        root: ['me', 'groupsWithPromosFeed'],
        cursor: 'groupsFeedArgs.nextPage',
      },
      {
        source: { kind: 'business', slug: 'acme-bakery' },
        op: 'EntityPageInteractionsFeedQuery',
        root: ['entityPage', 'entityPageInteractionsFeed'],
        cursor: 'nextPage',
      },
      { source: { kind: 'news' }, op: 'ThemeFeed', root: ['me', 'themeFeed'], cursor: 'nextPage' },
    ] as const;
    for (const c of cases) {
      const wrap = (next: string | null) => ({ [c.root[0]]: { [c.root[1]]: page(next).wrapper } });
      const { api, calls } = fakeApi({ [c.op]: [wrap('p2'), wrap(null)] } as never);
      const posts: string[] = [];
      for await (const p of api.feedPages(c.source as never)) posts.push(...p.posts.map((x) => x.id));
      expect(posts, c.op).toEqual(['post_X', 'post_X']);
      expect(
        calls.map((call) => at(call.variables, c.cursor) ?? null),
        c.op,
      ).toEqual([null, 'p2']);
    }
  });

  it('passes ids in the shapes Nextdoor expects', async () => {
    const { api, calls } = fakeApi({
      agencyFeed: [{ me: { agencyFeed: { feedItems: [], nextPage: null } } }],
      groupsWithPromosFeed: [{ me: { groupsWithPromosFeed: { feedItems: [], nextPage: null } } }],
    });
    for await (const _ of api.feedPages({ kind: 'agency', id: '4200001' })) break;
    for await (const _ of api.feedPages({ kind: 'group', id: 'group_47' })) break;
    expect((calls[0].variables.agencyFeedArgs as Record<string, unknown>).agencyId).toBe('group_4200001');
    expect((calls[1].variables.groupsFeedArgs as Record<string, unknown>).groupId).toBe('47');
  });

  it('looks up profiles, neighborhoods, businesses, and groups', async () => {
    const { api, calls } = fakeApi({
      userProfile: [{ user: { id: 'user_7', name: { displayName: 'Robin' } } }],
      NeighborhoodProfile: [
        { neighborhood: { id: 'neighborhood_1', shortName: 'Maple Grove', neighborhoodStats: [] } },
      ],
      entityPage: [{ entityPage: { id: 'entity_3', name: 'Acme' } }],
      UserGroupsSections: [{ me: { userGroupsSections: [] } }],
    });
    expect((await api.userProfile('secureUser_7'))?.name).toBe('Robin');
    expect(await api.neighborhood('maplegrove')).toMatchObject({ slug: 'maplegrove', neighbors: null });
    expect((await api.business('acme-bakery'))?.id).toBe('entity_3');
    expect(await api.myGroups()).toEqual([]);
    expect(calls.map((c) => c.operation)).toEqual([
      'userProfile',
      'NeighborhoodProfile',
      'entityPage',
      'UserGroupsSections',
    ]);
  });
});
