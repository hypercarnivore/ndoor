/**
 * High-level, read-only Nextdoor API: builds operation variables, pages
 * through results, and maps payloads into the domain model.
 *
 * Requests are paced (`delayMs` between pages) to stay well inside what a
 * human scrolling the site would generate.
 */

import { randomUUID } from 'node:crypto';
import {
  type ActivityPage,
  type Business,
  type Comment,
  type FeedPage,
  type Group,
  type Me,
  mapActivityPage,
  mapBusiness,
  mapCommentPage,
  mapFeedItemDetail,
  mapFeedPage,
  mapMe,
  mapNeighborhoodProfile,
  mapNotificationPage,
  mapSearchPage,
  mapUserGroups,
  mapUserProfile,
  type NeighborhoodProfile,
  type Notification,
  type Post,
  resolveReplyTargets,
  type SearchPage,
  type UserProfile,
} from './model.js';
import type { NextdoorClient } from './nextdoor-client.js';
import { type OperationName, resolveHashes } from './operations.js';

const FEED_FEATURES = {
  numCommentsForNewsPosts: 2,
  rollupItemTypes: [
    'IMAGE_CARD',
    'LIST_CARD',
    'POST',
    'PUBLISHER_DISCOVERY',
    'ONBOARDING_CAROUSEL_CARD',
    'LOCAL_EVENT_CARD',
  ],
  rollupTypes: ['CAROUSEL', 'LIST', 'GRID'],
};

const MAX_PAGES = 50;

export const FEED_SORTS = ['FOR_YOU', 'RECENT_POSTS'] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export interface FeedResult extends Omit<FeedPage, 'nextPage'> {
  pagesFetched: number;
}

export interface NextdoorApiOptions {
  hashes?: Record<OperationName, string>;
  timeZone?: string;
  /** Pause between paginated requests (default 400ms). */
  delayMs?: number;
}

/** A paged stream of posts. Every kind maps to one Nextdoor feed operation (see FEED_KINDS). */
export type FeedSource =
  | { kind: 'main'; sort: FeedSort }
  | { kind: 'neighborhood'; slug: string }
  | { kind: 'agency'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'business'; slug: string }
  | { kind: 'news' }
  | { kind: 'user'; secureId: string };

interface FeedKind<S extends FeedSource> {
  operation: OperationName;
  /** Where the feed sits in the response. */
  path: string;
  variables(
    source: S,
    page: { nextPage: string | null; feedRequestId: string; pageSize: number },
  ): Record<string, unknown>;
}

const COMMENT_MODE = { pagedCommentsMode: 'FEED', useEdgesV2: false, includeModerationInfo: true };

/** Feed operations as data: adding a feed is one entry here. */
export const FEED_KINDS: { [K in FeedSource['kind']]: FeedKind<Extract<FeedSource, { kind: K }>> } = {
  main: {
    operation: 'PersonalizedFeed',
    path: 'me.personalizedFeed',
    variables: (source, page) => ({
      mainFeedArgs: {
        feedRequestId: page.feedRequestId,
        nextPage: page.nextPage,
        pageSize: page.pageSize,
        sortOrder: source.sort,
        supportedFeatures: FEED_FEATURES,
      },
      includeAskAiFeatures: false,
      includeModerationInfo: true,
    }),
  },
  neighborhood: {
    operation: 'ContentFromHoodFeed',
    path: 'neighborhood.contentFromHoodFeed',
    variables: (source, page) => ({
      ...COMMENT_MODE,
      slug: source.slug,
      input: { pageSize: page.pageSize, nextPage: page.nextPage, supportedFeatures: FEED_FEATURES },
    }),
  },
  agency: {
    operation: 'agencyFeed',
    path: 'me.agencyFeed',
    variables: (source, page) => ({
      ...COMMENT_MODE,
      agencyFeedArgs: { agencyId: `group_${source.id}`, pageSize: page.pageSize, nextPage: page.nextPage },
    }),
  },
  group: {
    operation: 'groupsWithPromosFeed',
    path: 'me.groupsWithPromosFeed',
    variables: (source, page) => ({
      ...COMMENT_MODE,
      groupsFeedArgs: {
        groupId: source.id.replace(/^group_/, ''),
        pageSize: page.pageSize,
        nextPage: page.nextPage,
        feedPageSourceType: 'GROUP_DIRECTORY_PAGE_TYPE',
      },
      nuxStates: [],
    }),
  },
  business: {
    operation: 'EntityPageInteractionsFeedQuery',
    path: 'entityPage.entityPageInteractionsFeed',
    variables: (source, page) => ({
      ...COMMENT_MODE,
      input: { urlSlug: source.slug },
      pageSize: page.pageSize,
      nextPage: page.nextPage,
      feedRequestId: page.feedRequestId,
      feedType: 'RECS_AND_MENTIONS',
    }),
  },
  news: {
    operation: 'ThemeFeed',
    path: 'me.themeFeed',
    variables: (_source, page) => ({
      ...COMMENT_MODE,
      theme: 'PUBLISHER_TOP_LOCAL_NEWS',
      feedRequestId: page.feedRequestId,
      pageSize: page.pageSize,
      nextPage: page.nextPage,
      supportedFeatures: { numCommentsForNewsPosts: 2 },
    }),
  },
  user: {
    operation: 'feedActivity',
    path: 'user.userProfileActivities.activityFeed',
    variables: (source, page) => ({
      ...COMMENT_MODE,
      input: source.secureId,
      feedArgs: {
        feedRequestId: page.feedRequestId,
        nextPage: page.nextPage,
        pageSize: page.pageSize,
        supportedFeatures: { ...FEED_FEATURES, isStickyCommentEnabled: true },
      },
    }),
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function toFeedItemId(postIdOrShareId: string): string {
  if (postIdOrShareId.startsWith('post_')) return postIdOrShareId;
  // Numeric ids (from /post/<n> links and the activity log) resolve as legacy post ids.
  if (/^\d+$/.test(postIdOrShareId)) return `post_${postIdOrShareId}`;
  return postIdOrShareId.startsWith('sharedPost_') ? postIdOrShareId : `sharedPost_${postIdOrShareId}`;
}

export class NextdoorApi {
  private readonly hashes: Record<OperationName, string>;
  private readonly timeZone: string;
  private readonly delayMs: number;

  constructor(
    private readonly client: NextdoorClient,
    options: NextdoorApiOptions = {},
  ) {
    this.hashes = options.hashes ?? resolveHashes();
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.delayMs = options.delayMs ?? 400;
  }

  /** Run a registered operation with explicit variables and return raw data. */
  raw<T = unknown>(operation: OperationName, variables: Record<string, unknown>): Promise<T> {
    return this.client.persisted<T>(operation, this.hashes[operation], variables);
  }

  async me(): Promise<Me> {
    return mapMe(await this.raw('getMe', { includeCurrentDraft: false }));
  }

  /** Collect at least `count` non-ad posts (or until the feed ends). */
  async feed(options: { count: number; sort?: FeedSort }): Promise<FeedResult> {
    const result: FeedResult = { posts: [], adsDropped: 0, skipped: {}, pagesFetched: 0 };
    const feedRequestId = randomUUID();
    const seen = new Set<string>();
    let nextPage: string | null = null;

    while (result.posts.length < options.count && result.pagesFetched < MAX_PAGES) {
      if (result.pagesFetched > 0) await sleep(this.delayMs);
      const page = mapFeedPage(
        await this.raw('PersonalizedFeed', {
          mainFeedArgs: {
            feedRequestId,
            nextPage,
            pageSize: Math.min(Math.max(options.count - result.posts.length, 5), 20),
            sortOrder: options.sort ?? 'FOR_YOU',
            supportedFeatures: FEED_FEATURES,
          },
          timeZone: this.timeZone,
          includeAskAiFeatures: false,
          includeModerationInfo: true,
        }),
      );
      result.pagesFetched += 1;
      result.adsDropped += page.adsDropped;
      for (const [type, n] of Object.entries(page.skipped)) result.skipped[type] = (result.skipped[type] ?? 0) + n;
      for (const post of page.posts) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        result.posts.push(post);
      }
      if (!page.nextPage || page.nextPage === nextPage) break;
      nextPage = page.nextPage;
    }

    result.posts = result.posts.slice(0, options.count);
    return result;
  }

  /** One post with its full comment tree (all pages and replies unless `allComments` is false). */
  async post(postIdOrShareId: string, options: { allComments?: boolean } = {}): Promise<Post> {
    const data = await this.raw('FeedItem', {
      feedItemId: toFeedItemId(postIdOrShareId),
      feedItemQueryType: 'POST',
      pagedCommentsMode: 'DETAILS',
      useEdgesV2: true,
      includeModerationInfo: true,
      timeZone: this.timeZone,
      supportedFeatures: { ...FEED_FEATURES, isStickyCommentEnabled: true },
    });
    const post = mapFeedItemDetail(data);
    if (!post) throw new Error(`Post ${postIdOrShareId} not found (or it is not a regular post).`);
    if (options.allComments === false) return post;

    if (post.commentsCursor) {
      post.comments.push(...(await this.commentsAfter(post.commentsCursor)));
      post.commentsCursor = null;
    }
    await this.expandReplies(post.comments);
    resolveReplyTargets(post.comments);
    return post;
  }

  private async commentsAfter(cursor: string): Promise<Comment[]> {
    const collected: Comment[] = [];
    let after: string | null = cursor;
    for (let pages = 0; after && pages < MAX_PAGES; pages += 1) {
      await sleep(this.delayMs);
      const page = mapCommentPage(
        await this.raw('PagedComments', {
          after,
          first: 20,
          useEdgesV2: true,
          pagedCommentsMode: 'DETAILS',
          includeDeletedComments: true,
          timeZone: this.timeZone,
        }),
      );
      if (page.comments.length === 0) break;
      collected.push(...page.comments);
      after = page.nextCursor === after ? null : page.nextCursor;
    }
    return collected;
  }

  private async expandReplies(comments: Comment[]): Promise<void> {
    for (const comment of comments) {
      if (comment.repliesCursor) {
        const known = new Set(comment.replies.map((reply) => reply.id));
        for (const reply of await this.commentsAfter(comment.repliesCursor)) {
          if (!known.has(reply.id)) comment.replies.push(reply);
        }
        comment.repliesCursor = null;
      }
      await this.expandReplies(comment.replies);
    }
  }

  /** Search posts, paging until `count` hits are collected or results run out. */
  async search(query: string, options: { count?: number } = {}): Promise<SearchPage> {
    const count = options.count ?? 20;
    const requestId = randomUUID();
    const result: SearchPage = { query, hits: [], nextCursor: null };
    let cursor: string | null = null;

    for (let pages = 0; result.hits.length < count && pages < MAX_PAGES; pages += 1) {
      if (pages > 0) await sleep(this.delayMs);
      const page = mapSearchPage(
        await this.raw('searchPost', {
          postSearchArgs: {
            query,
            requestId,
            enableSpellCorrection: true,
            filters: [{}],
            ...(cursor ? { cursor } : {}),
          },
        }),
      );
      result.query = page.query || query;
      result.hits.push(...page.hits);
      result.nextCursor = page.nextCursor;
      if (!page.nextCursor || page.nextCursor === cursor || page.hits.length === 0) break;
      cursor = page.nextCursor;
    }

    result.hits = result.hits.slice(0, count);
    return result;
  }

  async notifications(options: { count: number }): Promise<Notification[]> {
    const collected: Notification[] = [];
    const feedRequestId = randomUUID();
    let nextPage: string | null = null;

    for (let pages = 0; collected.length < options.count && pages < MAX_PAGES; pages += 1) {
      if (pages > 0) await sleep(this.delayMs);
      const page = mapNotificationPage(
        await this.raw('NotificationFeed', {
          notificationFeedArgs: {
            supportedFeatures: { is2021RedesignEnabled: true },
            feedRequestId,
            notificationCenterTab: 'ALL',
            ...(nextPage ? { nextPage } : {}),
          },
        }),
      );
      collected.push(...page.notifications);
      if (!page.nextPage || page.nextPage === nextPage || page.notifications.length === 0) break;
      nextPage = page.nextPage;
    }
    return collected.slice(0, options.count);
  }

  /**
   * Walk a user's whole activity log, newest first (posts, replies, reactions),
   * one page at a time so callers can checkpoint the cursor. Paged by timestamp
   * with a gentler pace than the feed, since a lifetime of activity can take
   * hundreds of pages and Nextdoor throttles bursts.
   */
  async *activityPages(
    secureUserId: string,
    options: { before?: string | null; delayMs?: number } = {},
  ): AsyncGenerator<ActivityPage> {
    let before = options.before ?? null;
    for (let pages = 0; pages < 10_000; pages += 1) {
      if (pages > 0) await sleep(options.delayMs ?? 2500);
      const page = mapActivityPage(
        await this.raw('allActivities', {
          feedArgs: { beforeTimestamp: before, pageSize: before ? null : 10 },
          input: secureUserId,
        }),
      );
      yield page;
      if (!page.nextBefore || page.nextBefore === before || page.activities.length === 0) return;
      before = page.nextBefore;
    }
  }

  /** Every post a user authored, newest first, with full content (comments not expanded). */
  async *userPosts(secureUserId: string): AsyncGenerator<Post> {
    for await (const page of this.feedPages({ kind: 'user', secureId: secureUserId }, { delayMs: this.delayMs * 3 })) {
      yield* page.posts;
    }
  }

  /** Page through any feed source. Ads are dropped by the mapper and counted in each page. */
  async *feedPages(
    source: FeedSource,
    options: { maxPages?: number; pageSize?: number; delayMs?: number } = {},
  ): AsyncGenerator<FeedPage> {
    const kind = FEED_KINDS[source.kind] as FeedKind<FeedSource>;
    const feedRequestId = randomUUID();
    let nextPage: string | null = null;
    for (let pages = 0; pages < (options.maxPages ?? 10_000); pages += 1) {
      if (pages > 0) await sleep(options.delayMs ?? this.delayMs);
      const variables = kind.variables(source, { nextPage, feedRequestId, pageSize: options.pageSize ?? 10 });
      const page = mapFeedPage(await this.raw(kind.operation, { ...variables, timeZone: this.timeZone }), kind.path);
      yield page;
      if (!page.nextPage || page.nextPage === nextPage) return;
      nextPage = page.nextPage;
    }
  }

  async userProfile(secureUserId: string): Promise<UserProfile | null> {
    return mapUserProfile(
      await this.raw('userProfile', { profileOwnerId: secureUserId, facepileArgs: { variant: 'FULL_LINK' } }),
    );
  }

  async neighborhood(slug: string): Promise<NeighborhoodProfile | null> {
    const hood = mapNeighborhoodProfile(await this.raw('NeighborhoodProfile', { slug }));
    return hood && { ...hood, slug: hood.slug ?? slug };
  }

  async business(slug: string): Promise<Business | null> {
    return mapBusiness(await this.raw('entityPage', { urlSlug: slug }));
  }

  /** Groups the logged-in user belongs to. */
  async myGroups(): Promise<Group[]> {
    return mapUserGroups(await this.raw('UserGroupsSections', { excludeSectionItemTypeIds: [], cursors: [] }));
  }
}
