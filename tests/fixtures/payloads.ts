/**
 * Synthetic GraphQL payloads shaped like real Nextdoor responses (captured
 * 2026-10), trimmed to the fields ndoor reads. All names and ids are fake.
 */

export const T0 = Date.parse('2026-10-10T12:00:00Z');

export function neighborhood(id: number, shortName: string) {
  return {
    id: `neighborhood_${id}`,
    name: `Nextdoor ${shortName}`,
    shortName,
    slug: shortName.toLowerCase().replace(/\W/g, ''),
    city: 'Springfield',
    state: 'IL',
    __typename: 'Neighborhood',
  };
}

export function author(name: string, userId: number, hood = neighborhood(1, 'Maple Grove'), authorType = 'NEIGHBOR') {
  return {
    authorType,
    displayName: name,
    url: `/profile/${userId}/`,
    originationNeighborhood: hood,
    user: { id: `user_${userId}`, secureUserId: `secureUser_${userId}`, name: { displayName: name } },
  };
}

export function reactions(entries: Record<string, number>) {
  return {
    summaries: Object.entries(entries).map(([name, count]) => ({ name, count, __typename: 'ReactionSummary' })),
  };
}

export function comment(
  id: number,
  body: string,
  options: {
    replies?: unknown[];
    pending?: number;
    deleted?: boolean;
    author?: ReturnType<typeof author>;
    mentions?: number[];
    parent?: number;
    minutesAgo?: number;
    businesses?: { id: string; name: string; slug: string }[];
  } = {},
) {
  const businessTags = (options.businesses ?? []).map((business) => ({
    type: 'ENTITY_PAGE',
    entityId: business.id,
    displayName: business.name,
    actorUrl: { url: `https://nextdoor.com/page/${business.slug}?init_source=at_mention_in_comment_click` },
  }));
  return {
    __typename: 'PagedCommentItemsEdge',
    adOpportunityEvent: null,
    node: {
      __typename: 'PagedComment',
      hidden: false,
      comment: {
        id: `comment_${id}`,
        body,
        author: options.author ?? author(`Commenter ${id}`, 1000 + id, neighborhood(2, 'Oak Hollow')),
        createdAt: { epochMillis: String(T0 - (options.minutesAgo ?? id) * 60_000) },
        parentComment: options.parent ? { id: `comment_${options.parent}` } : null,
        tags: [
          ...(options.mentions ?? []).map((userId) => ({ type: 'USER', entityId: `user_${userId}` })),
          ...businessTags,
        ],
        reactionSummaries: reactions({ like2: 1 }),
        isDeleted: options.deleted ?? false,
      },
      replies: options.replies
        ? {
            afterCount: options.pending ?? 0,
            beforeCount: 0,
            edges: [],
            edgesV2: options.replies,
            pageInfo: { endCursor: options.pending ? `replies-${id}` : null },
          }
        : null,
    },
  };
}

export function post(
  shareId: string,
  options: {
    subject?: string;
    body?: string;
    author?: ReturnType<typeof author>;
    comments?: unknown[];
    totalComments?: number;
    endCursor?: string | null;
  } = {},
) {
  const comments = options.comments ?? [];
  return {
    __typename: 'Post',
    id: `post_${shareId}`,
    shareId: `sharedPost_${shareId}`,
    subject: options.subject ?? `Subject ${shareId}`,
    body: options.body ?? `Body ${shareId}`,
    createdAt: { epochMillis: String(T0 - 3_600_000), asDateTime: { relativeTime: '1 hr ago' } },
    author: options.author ?? author('Alex Neighbor', 1),
    topics: [{ name: { singularName: 'General' } }],
    audience: { visibilityScopeV2: { visibilityScope: 'ANYONE' } },
    reactionSummaries: reactions({ like2: 3, thank: 2 }),
    mediaAttachments: [{ type: 'PHOTO', url: `https://photos.example/${shareId}.png` }],
    comments: {
      totalCommentCount: options.totalComments ?? comments.length,
      pagedComments: {
        edges: [],
        edgesV2: comments,
        pageInfo: { endCursor: options.endCursor ?? null },
      },
    },
  };
}

export function postItem(p: ReturnType<typeof post>, topHat: string | null = null) {
  return {
    __typename: 'FeedItemPost',
    feedItemType: 'POST',
    post: p,
    topHats: topHat ? { feedTopHat: { topHatText: { text: topHat } } } : null,
  };
}

export function promoItem(id: string) {
  return {
    __typename: 'FeedItemPromo',
    feedItemType: 'PROMO',
    contentId: id,
    promo: { __typename: 'Ad', promoType: 'NAMPLUS_AD', creative: { sponsorName: { text: 'Acme Gutters' } } },
  };
}

export function feedResponse(items: unknown[], nextPage: string | null) {
  return { me: { personalizedFeed: { feedItems: items, nextPage } } };
}

export function feedItemResponse(p: ReturnType<typeof post>) {
  return { feedItem: postItem(p) };
}

export function pagedCommentsResponse(comments: unknown[], endCursor: string | null) {
  return { pagedComments: { edges: [], edgesV2: comments, pageInfo: { endCursor } } };
}

export function notificationResponse(ids: number[], nextPage: string | null) {
  return {
    me: {
      notificationFeed: {
        nextPage,
        feedItems: ids.map((id) => ({
          __typename: 'FeedItemNotification',
          notification: {
            id: `notification_${id}`,
            notificationType: id % 2 ? 'THANK' : 'POST',
            category: 'GENERAL',
            body: { text: `Notification ${id}` },
            createdAt: { asDateTimeUTC: { iso8601: '2026-10-10T11:00:00.000+00:00' } },
            action: { url: `https://nextdoor.com/p/N${id}/c/9?init_source=notification_center` },
            actors: [{ name: `Actor ${id}` }],
            isRead: id > 1,
          },
        })),
      },
    },
  };
}

export function searchResponse(shareIds: string[], endCursor: string | null, options: { ad?: boolean } = {}) {
  return {
    searchPostFeed: {
      query: 'plumber',
      searchResultView: [
        { type: 'BUSINESS', searchResultItems: { edges: [{ node: { url: 'https://nextdoor.com/page/x' } }] } },
        {
          type: 'POST',
          searchResultItems: {
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            edges: [
              ...shareIds.map((id) => ({
                node: {
                  __typename: 'SearchResult',
                  adFormat: null,
                  url: `https://nextdoor.com/p/${id}?view=detail&init_source=search`,
                  title: { text: `Author ${id}` },
                  subtitle: { text: 'Oak Hollow · 18 Sep' },
                  body: { text: `Need a plumber ${id}` },
                  postReactions: { commentsCount: { text: '3' } },
                },
              })),
              ...(options.ad ? [{ node: { adFormat: 'SPONSORED', url: 'https://ads.example' } }] : []),
            ],
          },
        },
      ],
    },
  };
}

export function meResponse() {
  return {
    me: {
      user: { id: 'user_42', secureUserId: 'secureUser_42', name: { displayName: 'Pat Example' } },
      neighborhood: neighborhood(1001, 'Maple Grove'),
    },
  };
}

export function repostOf(shareId: string, subject: string, body: string) {
  return {
    id: `post_${shareId}`,
    shareId: `sharedPost_${shareId}`,
    subject,
    body,
    author: author('Original Author', 77),
    createdAt: { epochMillis: String(T0 - 86_400_000) },
  };
}

export function activityResponse(entries: [number, string, number][], nextBefore: string | null) {
  return {
    user: {
      userProfileActivities: {
        allActivitiesFeed: {
          activitiesCount: JSON.stringify({ has_counts: true, post_count: 3, comment_count: 5, like_count: 9 }),
          nextBeforeTimestamp: nextBefore,
          activities: entries.map(([activityType, postId, micros]) => ({
            activityType,
            postIdV2: postId,
            creationDate: String(micros),
            messageParts: [{ text: 'Replied to ' }, { text: '"x"' }],
          })),
        },
      },
    },
  };
}

export function userPostsResponse(items: unknown[], nextPage: string | null) {
  return { user: { userProfileActivities: { activityFeed: { feedItems: items, nextPage } } } };
}
