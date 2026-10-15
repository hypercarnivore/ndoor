import { describe, expect, it } from 'vitest';
import {
  at,
  isAdItem,
  mapActivityPage,
  mapAuthor,
  mapBusiness,
  mapComment,
  mapCommentPage,
  mapFeedItemDetail,
  mapFeedPage,
  mapMe,
  mapNeighborhoodProfile,
  mapNotificationPage,
  mapPost,
  mapReactions,
  mapSearchPage,
  mapUserGroups,
  mapUserPostsPage,
  mapUserProfile,
  resolveReplyTargets,
  shareIdFromUrl,
} from '../src/lib/model.js';
import {
  activityResponse,
  author,
  comment,
  feedItemResponse,
  feedResponse,
  meResponse,
  neighborhood,
  notificationResponse,
  pagedCommentsResponse,
  post,
  postItem,
  promoItem,
  repostOf,
  searchResponse,
  T0,
  userPostsResponse,
} from './fixtures/payloads.js';

describe('at', () => {
  it('walks nested objects and tolerates gaps', () => {
    expect(at({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(at({ a: null }, 'a.b')).toBeUndefined();
    expect(at([1], '0')).toBeUndefined();
  });
});

describe('mapAuthor', () => {
  it('maps a neighbor with home neighborhood', () => {
    expect(mapAuthor(author('Alex Neighbor', 7, neighborhood(3, 'Cedar Park')))).toEqual({
      id: 'user_7',
      secureId: 'secureUser_7',
      name: 'Alex Neighbor',
      type: 'NEIGHBOR',
      profileUrl: 'https://nextdoor.com/profile/7/',
      neighborhood: { id: 'neighborhood_3', name: 'Cedar Park', slug: 'cedarpark', city: 'Springfield', state: 'IL' },
      agency: null,
      pageSlug: null,
    });
  });

  it('falls back to page id and UNKNOWN type', () => {
    expect(mapAuthor({ displayName: 'Garden Club', page: { id: 'entity_9' } })).toMatchObject({
      id: 'entity_9',
      type: 'UNKNOWN',
      profileUrl: null,
      neighborhood: null,
    });
  });
});

describe('mapReactions', () => {
  it('sums counts per type and skips zeros', () => {
    expect(
      mapReactions({
        summaries: [
          { name: 'like2', count: 2 },
          { name: 'thank', count: '3' },
          { name: 'sad', count: 0 },
        ],
      }),
    ).toEqual({ total: 5, byType: { like2: 2, thank: 3 } });
    expect(mapReactions(null)).toEqual({ total: 0, byType: {} });
  });
});

describe('mapPost', () => {
  it('maps core post fields and inline comments', () => {
    const mapped = mapPost(post('AbC_1', { comments: [comment(1, 'hi')], totalComments: 4, endCursor: 'c1' }));
    expect(mapped).toMatchObject({
      id: 'post_AbC_1',
      shareId: 'AbC_1',
      url: 'https://nextdoor.com/p/AbC_1',
      subject: 'Subject AbC_1',
      body: 'Body AbC_1',
      createdAt: new Date(T0 - 3_600_000).toISOString(),
      topics: ['General'],
      visibility: 'ANYONE',
      reactions: { total: 5 },
      commentCount: 4,
      media: ['https://photos.example/AbC_1.png'],
      commentsCursor: 'c1',
    });
    expect(mapped?.comments.map((c) => c.body)).toEqual(['hi']);
  });

  it('drops the comments cursor when every comment is loaded', () => {
    expect(mapPost(post('X', { comments: [comment(1, 'a')], endCursor: 'c' }))?.commentsCursor).toBeNull();
  });

  it('returns null without ids', () => {
    expect(mapPost({ subject: 'x' })).toBeNull();
  });
});

describe('comments', () => {
  it('maps nested replies, pending reply cursors, and deletion', () => {
    const page = mapCommentPage(
      pagedCommentsResponse(
        [comment(1, 'parent', { replies: [comment(2, 'child')], pending: 2 }), comment(3, '', { deleted: true })],
        'next',
      ),
    );
    expect(page.nextCursor).toBe('next');
    const [parent, deleted] = page.comments;
    expect(parent).toMatchObject({ id: 'comment_1', replyCount: 3, repliesCursor: 'replies-1' });
    expect(parent.replies[0]).toMatchObject({ id: 'comment_2', body: 'child', author: { id: 'user_1002' } });
    expect(deleted.isDeleted).toBe(true);
  });

  it('reads legacy edges when edgesV2 is empty', () => {
    const page = mapCommentPage({
      pagedComments: { edges: [{ node: { id: 'comment_5', body: 'old' } }], edgesV2: [] },
    });
    expect(page.comments[0]).toMatchObject({ id: 'comment_5', body: 'old', replies: [], repliesCursor: null });
  });
});

describe('mapFeedPage', () => {
  it('drops promos, counts them, and keeps post labels', () => {
    const page = mapFeedPage(
      feedResponse(
        [
          promoItem('ad1'),
          postItem(post('P1'), 'Trending post'),
          { feedItemType: 'LOCAL_EVENT_CARD' },
          promoItem('ad2'),
        ],
        'page2',
      ),
    );
    expect(page.adsDropped).toBe(2);
    expect(page.skipped).toEqual({ LOCAL_EVENT_CARD: 1 });
    expect(page.nextPage).toBe('page2');
    expect(page.posts.map((p) => [p.shareId, p.label])).toEqual([['P1', 'Trending post']]);
  });

  it('recognizes ads by any of their markers', () => {
    expect(isAdItem({ __typename: 'FeedItemPromo' })).toBe(true);
    expect(isAdItem({ promo: { __typename: 'Ad' } })).toBe(true);
    expect(isAdItem(postItem(post('P')))).toBe(false);
  });

  it('handles an empty payload', () => {
    expect(mapFeedPage({})).toEqual({ posts: [], adsDropped: 0, skipped: {}, nextPage: null });
  });
});

describe('mapFeedItemDetail', () => {
  it('maps a post detail and returns null for a promo', () => {
    expect(mapFeedItemDetail(feedItemResponse(post('D1')))?.shareId).toBe('D1');
    expect(mapFeedItemDetail({ feedItem: promoItem('x') })).toBeNull();
  });
});

describe('mapNotificationPage', () => {
  it('maps notifications and the next page token', () => {
    const page = mapNotificationPage(notificationResponse([1, 2], 'n2'));
    expect(page.nextPage).toBe('n2');
    expect(page.notifications[0]).toEqual({
      id: 'notification_1',
      type: 'THANK',
      category: 'GENERAL',
      text: 'Notification 1',
      createdAt: '2026-10-10T11:00:00.000+00:00',
      url: 'https://nextdoor.com/p/N1/c/9?init_source=notification_center',
      actors: ['Actor 1'],
      isRead: false,
    });
  });
});

describe('mapSearchPage', () => {
  it('keeps POST sections, drops ads, and strips tracking params', () => {
    const page = mapSearchPage(searchResponse(['S1'], 'cur', { ad: true }));
    expect(page).toEqual({
      query: 'plumber',
      nextCursor: 'cur',
      hits: [
        {
          shareId: 'S1',
          url: 'https://nextdoor.com/p/S1',
          author: 'Author S1',
          context: 'Oak Hollow · 18 Sep',
          body: 'Need a plumber S1',
          commentCount: 3,
        },
      ],
    });
  });

  it('extracts share ids from URLs', () => {
    expect(shareIdFromUrl('https://nextdoor.com/p/a-B_9?x=1')).toBe('a-B_9');
    expect(shareIdFromUrl(null)).toBeNull();
  });
});

describe('mapMe', () => {
  it('maps the logged-in user', () => {
    expect(mapMe(meResponse())).toEqual({
      userId: 'user_42',
      secureUserId: 'secureUser_42',
      name: 'Pat Example',
      neighborhood: {
        id: 'neighborhood_1001',
        name: 'Maple Grove',
        slug: 'maplegrove',
        city: 'Springfield',
        state: 'IL',
      },
    });
  });
});

describe('reposts, mentions, and reply targets', () => {
  it('maps the reposted original post', () => {
    const p = post('R1') as Record<string, unknown>;
    p.repostInfo = { item: repostOf('ORIG', 'Earned.', 'Taxes fund roads.') };
    expect(mapPost(p)?.repostOf).toMatchObject({
      id: 'post_ORIG',
      shareId: 'ORIG',
      subject: 'Earned.',
      body: 'Taxes fund roads.',
      author: { id: 'user_77' },
    });
    expect(mapPost(post('R2'))?.repostOf).toBeNull();
  });

  it('resolves reply targets from @mentions and sorts replies oldest first', () => {
    const ann = author('Ann', 1);
    const bob = author('Bob', 2);
    const cat = author('Cat', 3);
    const page = mapCommentPage(
      pagedCommentsResponse(
        [
          comment(10, 'top by Ann', {
            author: ann,
            minutesAgo: 60,
            replies: [
              comment(13, 'Bob, no way', { author: cat, mentions: [2], parent: 10, minutesAgo: 30 }),
              comment(11, 'reply to Ann', { author: bob, parent: 10, minutesAgo: 50 }),
              comment(12, 'Ann, agreed', { author: cat, mentions: [1], parent: 10, minutesAgo: 40 }),
              comment(14, 'Dan? unknown', { author: ann, mentions: [99], parent: 10, minutesAgo: 20 }),
            ],
          }),
        ],
        null,
      ),
    );
    resolveReplyTargets(page.comments);
    const replies = page.comments[0].replies;
    expect(replies.map((r) => r.id)).toEqual(['comment_11', 'comment_12', 'comment_13', 'comment_14']);
    expect(replies.map((r) => r.replyToId)).toEqual(['comment_10', 'comment_10', 'comment_11', 'comment_10']);
    expect(replies[1].mentions).toEqual(['user_1']);
    expect(replies[0].parentId).toBe('comment_10');
  });
});

describe('own activity', () => {
  it('maps the activity log with kinds, timestamps, and lifetime counts', () => {
    const page = mapActivityPage(
      activityResponse(
        [
          [1, 'post_1', 1_700_000_000_000_000],
          [2, 'post_2', 0],
          [9, 'post_3', 1],
        ],
        'b2',
      ),
    );
    expect(page.counts).toEqual({ posts: 3, comments: 5, reactions: 9 });
    expect(page.nextBefore).toBe('b2');
    expect(page.activities.map((a) => a.kind)).toEqual(['post', 'comment', 'unknown']);
    expect(page.activities[0]).toMatchObject({
      postId: 'post_1',
      at: '2023-11-14T22:13:20.000Z',
      summary: 'Replied to "x"',
    });
    expect(page.activities[1].at).toBeNull();
  });

  it('tolerates missing or malformed counts', () => {
    const data = activityResponse([], null);
    (data.user.userProfileActivities.allActivitiesFeed as Record<string, unknown>).activitiesCount = '{';
    expect(mapActivityPage(data).counts).toBeNull();
    expect(mapActivityPage({})).toEqual({ activities: [], nextBefore: null, counts: null });
  });

  it('maps a page of own posts like the feed', () => {
    const page = mapUserPostsPage(userPostsResponse([postItem(post('U1')), promoItem('ad')], 'n2'));
    expect(page.posts.map((p) => p.shareId)).toEqual(['U1']);
    expect(page.nextPage).toBe('n2');
  });
});

describe('graph-oriented fields', () => {
  it('maps mentions, hashtags, for-sale, edits, and agency or page authors', () => {
    const raw = post('M1') as Record<string, unknown>;
    raw.hashtags = [{ text: '#reunited' }];
    raw.postType = 'USER';
    raw.classified = { id: 'classified_1' };
    raw.editedAt = { asDateTime: { relativeTime: '12 Sep' } };
    raw.actorMentionTags = [
      { type: 'USER', entityId: 'user_9' },
      {
        type: 'ENTITY_PAGE',
        entityId: 'entity_3',
        displayName: 'Acme',
        actorUrl: { url: 'https://nextdoor.com/page/acme-bakery?init_source=x' },
      },
    ];
    raw.author = {
      ...author('Deputy', 5),
      authorType: 'CITY_AGENCY',
      municipalPage: { legacyId: '4200001', name: 'County Sheriff' },
    };
    expect(mapPost(raw)).toMatchObject({
      postType: 'USER',
      hashtags: ['#reunited'],
      isForSale: true,
      isEdited: true,
      mentions: ['user_9'],
      businessMentions: [{ id: 'entity_3', name: 'Acme', slug: 'acme-bakery' }],
      author: { agency: { id: '4200001', name: 'County Sheriff' }, secureId: 'secureUser_5' },
    });
    expect(
      mapAuthor({
        authorType: 'ENTITY_PAGES',
        displayName: 'Metro Weekly',
        page: { id: 'entity_7', urlSlug: 'metro-weekly' },
      }),
    ).toMatchObject({ id: 'entity_7', pageSlug: 'metro-weekly', agency: null });
  });

  it('maps comment business mentions', () => {
    const c = mapComment(
      comment(5, 'try Acme', { businesses: [{ id: 'entity_3', name: 'Acme', slug: 'acme-bakery' }] }).node,
    );
    expect(c?.businessMentions).toEqual([{ id: 'entity_3', name: 'Acme', slug: 'acme-bakery' }]);
  });

  it('maps a user profile', () => {
    expect(
      mapUserProfile({
        user: {
          id: 'user_7',
          secureUserId: 'secureUser_7',
          name: { displayName: 'Robin Example' },
          pronouns: 'SHE',
          biography: 'Gardener',
          badges: { lead: true, foundingMember: false, __typename: 'Badges' },
          userData: { residentSinceYear: 2017 },
          userProfileState: {
            profileType: 'NEIGHBORHOOD_USER',
            location: {
              neighborhood: {
                id: 'neighborhood_3',
                shortName: 'Cedar Park',
                slug: 'cedarpark',
                city: 'Springfield',
                state: 'IL',
              },
            },
          },
          ownedBusinesses: [{ id: 'entity_1' }],
        },
      }),
    ).toEqual({
      id: 'user_7',
      secureId: 'secureUser_7',
      name: 'Robin Example',
      neighborhood: { id: 'neighborhood_3', name: 'Cedar Park', slug: 'cedarpark', city: 'Springfield', state: 'IL' },
      residentSince: 2017,
      pronouns: 'SHE',
      biography: 'Gardener',
      profileType: 'NEIGHBORHOOD_USER',
      badges: ['lead'],
      helpfulScore: null,
      ownedBusinesses: ['entity_1'],
    });
    expect(mapUserProfile({ user: null })).toBeNull();
  });

  it('maps neighborhoods, groups, and businesses', () => {
    expect(
      mapNeighborhoodProfile({
        neighborhood: {
          id: 'neighborhood_1',
          shortName: 'Maple Grove',
          city: 'Springfield',
          state: 'IL',
          neighborhoodStats: [{ text: { text: '1,261 neighbors' } }, { text: { text: '3 nearby' } }],
        },
      }),
    ).toMatchObject({ id: 'neighborhood_1', neighbors: 1261 });
    expect(
      mapUserGroups({
        me: {
          userGroupsSections: [
            { id: 'user_groups_groups_near_you', items: [{ groupId: 'group_2', title: { text: 'Nearby' } }] },
            {
              id: 'user_groups_your_groups',
              items: [
                { groupId: 'group_1', title: { text: 'Book Club' }, subtitle: { text: '46 members' } },
                { groupId: null },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      { id: 'group_2', name: 'Nearby', members: null, isMember: false },
      { id: 'group_1', name: 'Book Club', members: 46, isMember: true },
    ]);
    expect(
      mapBusiness({
        entityPage: {
          id: 'entity_3',
          urlSlug: 'acme-bakery',
          name: 'Acme',
          categoryInfo: { displayCategory: { name: { singularName: 'Seafood Restaurant' } } },
          address: { fullAddress: '1 Bay Rd, Springfield, IL' },
          faveCount: { value: '157' },
          followerCount: { value: '12' },
        },
      }),
    ).toEqual({
      id: 'entity_3',
      slug: 'acme-bakery',
      name: 'Acme',
      category: 'Seafood Restaurant',
      address: '1 Bay Rd, Springfield, IL',
      faves: 157,
      followers: 12,
    });
    expect(mapBusiness({ entityPage: null })).toBeNull();
  });
});
