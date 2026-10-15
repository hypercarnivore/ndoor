/**
 * Normalized domain model and mappers from raw Nextdoor GraphQL payloads.
 *
 * The gateway returns deeply nested, presentation-oriented JSON. Everything
 * downstream (formatting, JSON output, the future graph store) works on these
 * flat records instead. Mappers are total: missing fields become null/empty
 * rather than throwing, because Nextdoor changes shapes without notice.
 *
 * Ads never survive mapping. A feed item is an ad when its feedItemType is
 * PROMO (typename FeedItemPromo, promo typename Ad); those are counted, then
 * dropped.
 */

export interface Neighborhood {
  id: string;
  name: string;
  /** URL slug (nextdoor.com/neighborhood/<slug>--<city>--<state>), used by neighborhood queries. */
  slug: string | null;
  city: string | null;
  state: string | null;
}

export interface Author {
  /** Stable user id (e.g. "user_123") when the author is a person, else null. */
  id: string | null;
  /** Opaque profile id (secureUser_...) used by profile and activity queries. */
  secureId: string | null;
  name: string;
  /** NEIGHBOR, ENTITY_PAGES (business/org page), CITY_AGENCY, ... */
  type: string;
  profileUrl: string | null;
  neighborhood: Neighborhood | null;
  /** For agency staff: the agency they post for (its numeric id feeds `agencyFeed`). */
  agency: { id: string; name: string } | null;
  /** For business or publisher pages: the page's URL slug. */
  pageSlug: string | null;
}

export interface Reactions {
  total: number;
  /** Count per reaction name as Nextdoor reports it (like2, thank, ...). */
  byType: Record<string, number>;
}

/** A business or organization page @mentioned in a post or comment. */
export interface BusinessRef {
  id: string;
  name: string;
  slug: string | null;
}

export interface Comment {
  id: string;
  /** Top-level comment this reply hangs under (Nextdoor threads are two levels deep). */
  parentId: string | null;
  /**
   * The comment this one actually answers. Nextdoor shows replies flat under a
   * top-level comment and signals the addressee with an @mention, so this is
   * resolved from mentions (see resolveReplyTargets); defaults to parentId.
   */
  replyToId: string | null;
  /** User ids @mentioned in the body. */
  mentions: string[];
  /** Business pages @mentioned in the body (Nextdoor's recommendation mechanism). */
  businessMentions: BusinessRef[];
  author: Author;
  body: string;
  createdAt: string | null;
  reactions: Reactions;
  isDeleted: boolean;
  replies: Comment[];
  /** Replies known to exist, including ones not loaded into `replies`. */
  replyCount: number;
  /** Cursor for loading the remaining replies, if any. */
  repliesCursor: string | null;
}

export interface RepostRef {
  id: string;
  shareId: string;
  author: Author;
  subject: string;
  body: string;
  createdAt: string | null;
}

export interface Post {
  id: string;
  /** Public share id used in URLs (nextdoor.com/p/<shareId>). */
  shareId: string;
  url: string;
  subject: string;
  body: string;
  createdAt: string | null;
  author: Author;
  topics: string[];
  visibility: string | null;
  reactions: Reactions;
  commentCount: number;
  media: string[];
  /** Nextdoor's "top hat" label, e.g. "Trending post". */
  label: string | null;
  /** The original post when this post reposts (quotes) another one. */
  repostOf: RepostRef | null;
  /** USER, NEWS, AGENCY, ... as Nextdoor classifies the post. */
  postType: string | null;
  hashtags: string[];
  /** User ids @mentioned in the post. */
  mentions: string[];
  businessMentions: BusinessRef[];
  /** A For Sale & Free listing. */
  isForSale: boolean;
  isEdited: boolean;
  comments: Comment[];
  commentsCursor: string | null;
}

export interface FeedPage {
  posts: Post[];
  adsDropped: number;
  /** Feed item types that were neither posts nor promos, with counts. */
  skipped: Record<string, number>;
  nextPage: string | null;
}

export interface CommentPage {
  comments: Comment[];
  nextCursor: string | null;
}

export interface Notification {
  id: string;
  type: string;
  category: string | null;
  text: string;
  createdAt: string | null;
  url: string | null;
  actors: string[];
  isRead: boolean;
}

export interface NotificationPage {
  notifications: Notification[];
  nextPage: string | null;
}

export interface SearchHit {
  shareId: string | null;
  url: string | null;
  author: string;
  /** "Neighborhood · date" line as shown by Nextdoor. */
  context: string;
  body: string;
  commentCount: number;
}

export interface SearchPage {
  query: string;
  hits: SearchHit[];
  nextCursor: string | null;
}

export interface Me {
  userId: string | null;
  /** Opaque profile id used by profile/activity queries (secureUser_...). */
  secureUserId: string | null;
  name: string;
  neighborhood: Neighborhood | null;
}

type Json = Record<string, unknown>;

// --- generic accessors -------------------------------------------------------

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

/** Walk a dotted path through nested objects. */
export function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    const record = obj(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function instantToIso(value: unknown): string | null {
  const millis = num(at(value, 'epochMillis'));
  if (millis > 0) return new Date(millis).toISOString();
  return str(at(value, 'asDateTimeUTC.iso8601'));
}

function absoluteUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith('http') ? path : `https://nextdoor.com${path.startsWith('/') ? '' : '/'}${path}`;
}

// --- mappers -----------------------------------------------------------------

export function mapNeighborhood(value: unknown): Neighborhood | null {
  const id = str(at(value, 'id'));
  if (!id) return null;
  return {
    id,
    name: str(at(value, 'shortName')) ?? str(at(value, 'name')) ?? '',
    slug: str(at(value, 'slug')),
    city: str(at(value, 'city')),
    state: str(at(value, 'state')),
  };
}

export function mapAuthor(value: unknown): Author {
  return {
    id: str(at(value, 'user.id')) ?? str(at(value, 'page.id')),
    secureId: str(at(value, 'user.secureUserId')),
    name: str(at(value, 'displayName')) ?? str(at(value, 'user.name.displayName')) ?? '',
    type: str(at(value, 'authorType')) ?? 'UNKNOWN',
    profileUrl: absoluteUrl(str(at(value, 'url'))),
    neighborhood: mapNeighborhood(at(value, 'originationNeighborhood')),
    agency: str(at(value, 'municipalPage.legacyId'))
      ? { id: str(at(value, 'municipalPage.legacyId')) ?? '', name: str(at(value, 'municipalPage.name')) ?? '' }
      : null,
    pageSlug: str(at(value, 'page.urlSlug')),
  };
}

/** Mention tags: USER tags carry user ids, ENTITY_PAGE tags carry business pages. */
function mentionedUsers(tags: unknown): string[] {
  return arr(tags)
    .filter((tag) => at(tag, 'type') === 'USER')
    .map((tag) => str(at(tag, 'entityId')))
    .filter((userId): userId is string => Boolean(userId));
}

function mentionedBusinesses(tags: unknown): BusinessRef[] {
  const refs = new Map<string, BusinessRef>();
  for (const tag of arr(tags)) {
    const id = str(at(tag, 'entityId'));
    if (at(tag, 'type') !== 'ENTITY_PAGE' || !id) continue;
    const url = str(at(tag, 'actorUrl.url')) ?? '';
    refs.set(id, {
      id,
      name: str(at(tag, 'displayName')) ?? '',
      slug: url.match(/\/page\/([^/?]+)/)?.[1] ?? null,
    });
  }
  return [...refs.values()];
}

export function mapReactions(value: unknown): Reactions {
  const byType: Record<string, number> = {};
  for (const summary of arr(at(value, 'summaries'))) {
    const name = str(at(summary, 'name'));
    const count = num(at(summary, 'count'));
    if (name && count > 0) byType[name] = (byType[name] ?? 0) + count;
  }
  return { total: Object.values(byType).reduce((sum, n) => sum + n, 0), byType };
}

/** Comment connections come as `edgesV2` (node.comment) or legacy `edges` (node). */
function commentEdges(connection: unknown): unknown[] {
  const v2 = arr(at(connection, 'edgesV2'));
  return v2.length > 0 ? v2 : arr(at(connection, 'edges'));
}

function endCursor(connection: unknown): string | null {
  return str(at(connection, 'pageInfo.endCursor'));
}

export function mapComment(edgeNode: unknown): Comment | null {
  const comment = obj(at(edgeNode, 'comment')) ?? obj(edgeNode);
  const id = str(comment?.id);
  if (!comment || !id) return null;

  const repliesConnection = at(edgeNode, 'replies');
  const replies = mapCommentEdges(repliesConnection);
  const pendingReplies = num(at(repliesConnection, 'afterCount')) + num(at(repliesConnection, 'beforeCount'));

  const parentId = str(at(comment, 'parentComment.id'));
  return {
    id,
    parentId,
    replyToId: parentId,
    mentions: mentionedUsers(comment.tags),
    businessMentions: mentionedBusinesses(comment.tags),
    author: mapAuthor(comment.author),
    body: str(comment.body) ?? str(at(comment, 'styledBody.text')) ?? '',
    createdAt: instantToIso(comment.createdAt),
    reactions: mapReactions(comment.reactionSummaries),
    isDeleted: comment.isDeleted === true,
    replies,
    replyCount: replies.length + pendingReplies,
    repliesCursor: pendingReplies > 0 ? endCursor(repliesConnection) : null,
  };
}

export function mapCommentEdges(connection: unknown): Comment[] {
  return commentEdges(connection)
    .map((edge) => mapComment(at(edge, 'node')))
    .filter((comment): comment is Comment => comment !== null);
}

export function mapPost(value: unknown): Post | null {
  const id = str(at(value, 'id'));
  const shareIdFull = str(at(value, 'shareId'));
  if (!id || !shareIdFull) return null;

  const shareId = shareIdFull.replace(/^sharedPost_/, '');
  const paged = at(value, 'comments.pagedComments');
  const comments = mapCommentEdges(paged);
  const commentCount = Math.max(num(at(value, 'comments.totalCommentCount')), comments.length);

  return {
    id,
    shareId,
    url: `https://nextdoor.com/p/${shareId}`,
    subject: str(at(value, 'subject')) ?? '',
    body: str(at(value, 'body')) ?? str(at(value, 'styledBody.text')) ?? '',
    createdAt: instantToIso(at(value, 'createdAt')),
    author: mapAuthor(at(value, 'author')),
    topics: arr(at(value, 'topics'))
      .map((topic) => str(at(topic, 'name.singularName')))
      .filter((name): name is string => Boolean(name)),
    visibility: str(at(value, 'audience.visibilityScopeV2.visibilityScope')),
    reactions: mapReactions(at(value, 'reactionSummaries')),
    commentCount,
    media: arr(at(value, 'mediaAttachments'))
      .map((media) => str(at(media, 'url')))
      .filter((url): url is string => Boolean(url)),
    label: null,
    repostOf: mapRepost(at(value, 'repostInfo.item')),
    postType: str(at(value, 'postType')),
    hashtags: arr(at(value, 'hashtags'))
      .map((tag) => str(at(tag, 'text')))
      .filter((text): text is string => Boolean(text)),
    mentions: mentionedUsers([...arr(at(value, 'actorMentionTags')), ...arr(at(value, 'tags'))]),
    businessMentions: mentionedBusinesses([...arr(at(value, 'actorMentionTags')), ...arr(at(value, 'tags'))]),
    isForSale: obj(at(value, 'classified')) !== null,
    isEdited: at(value, 'editedAt') != null,
    comments,
    commentsCursor: comments.length < commentCount ? endCursor(paged) : null,
  };
}

function mapRepost(value: unknown): RepostRef | null {
  const id = str(at(value, 'id'));
  const shareId = str(at(value, 'shareId'));
  if (!id || !shareId) return null;
  return {
    id,
    shareId: shareId.replace(/^sharedPost_/, ''),
    author: mapAuthor(at(value, 'author')),
    subject: str(at(value, 'subject')) ?? '',
    body: str(at(value, 'body')) ?? '',
    createdAt: instantToIso(at(value, 'createdAt')),
  };
}

/**
 * Resolve which comment each reply answers. Within one top-level comment's
 * reply list (sorted oldest first), a reply that @mentions a user answers that
 * user's most recent earlier comment in the chain; otherwise it answers the
 * top-level comment. Mutates replyToId and sorts replies chronologically.
 */
export function resolveReplyTargets(comments: Comment[]): void {
  for (const top of comments) {
    top.replies.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    const chain: Comment[] = [top];
    for (const reply of top.replies) {
      const target = chain.findLast(
        (earlier) => earlier.author.id !== null && reply.mentions.includes(earlier.author.id),
      );
      reply.replyToId = (target ?? top).id;
      chain.push(reply);
    }
  }
}

export function isAdItem(item: unknown): boolean {
  return (
    at(item, 'feedItemType') === 'PROMO' ||
    at(item, '__typename') === 'FeedItemPromo' ||
    at(item, 'promo.__typename') === 'Ad'
  );
}

/** Map a single feed item to a post, or null for ads and non-post items. */
export function mapFeedItem(item: unknown): Post | null {
  if (isAdItem(item)) return null;
  const post = mapPost(at(item, 'post'));
  if (post) post.label = str(at(item, 'topHats.feedTopHat.topHatText.text'));
  return post;
}

/** Every Nextdoor feed (main, neighborhood, group, agency, ...) shares this shape at some path. */
export function mapFeedPage(data: unknown, path = 'me.personalizedFeed'): FeedPage {
  const feed = at(data, path);
  const page: FeedPage = { posts: [], adsDropped: 0, skipped: {}, nextPage: str(at(feed, 'nextPage')) };

  for (const item of arr(at(feed, 'feedItems'))) {
    if (isAdItem(item)) {
      page.adsDropped += 1;
      continue;
    }
    const post = mapFeedItem(item);
    if (post) {
      page.posts.push(post);
    } else {
      const type = str(at(item, 'feedItemType')) ?? 'UNKNOWN';
      page.skipped[type] = (page.skipped[type] ?? 0) + 1;
    }
  }
  return page;
}

export function mapFeedItemDetail(data: unknown): Post | null {
  return mapFeedItem(at(data, 'feedItem'));
}

export function mapCommentPage(data: unknown): CommentPage {
  const connection = at(data, 'pagedComments');
  return { comments: mapCommentEdges(connection), nextCursor: endCursor(connection) };
}

export function mapNotificationPage(data: unknown): NotificationPage {
  const feed = at(data, 'me.notificationFeed');
  const notifications = arr(at(feed, 'feedItems'))
    .map((item): Notification | null => {
      const notification = at(item, 'notification');
      const id = str(at(notification, 'id'));
      if (!id) return null;
      return {
        id,
        type: str(at(notification, 'notificationType')) ?? 'UNKNOWN',
        category: str(at(notification, 'category')),
        text: str(at(notification, 'body.text')) ?? '',
        createdAt: instantToIso(at(notification, 'createdAt')),
        url: str(at(notification, 'action.url')),
        actors: arr(at(notification, 'actors'))
          .map((actor) => str(at(actor, 'name')))
          .filter((name): name is string => Boolean(name)),
        isRead: at(notification, 'isRead') === true,
      };
    })
    .filter((notification): notification is Notification => notification !== null);

  return { notifications, nextPage: str(at(feed, 'nextPage')) };
}

export function shareIdFromUrl(url: string | null): string | null {
  return url?.match(/\/p\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

export function mapSearchPage(data: unknown): SearchPage {
  const feed = at(data, 'searchPostFeed');
  const hits: SearchHit[] = [];
  let nextCursor: string | null = null;

  for (const section of arr(at(feed, 'searchResultView'))) {
    if (at(section, 'type') !== 'POST') continue;
    const connection = at(section, 'searchResultItems');
    if (at(connection, 'pageInfo.hasNextPage') === true) nextCursor = endCursor(connection);

    for (const edge of arr(at(connection, 'edges'))) {
      const node = at(edge, 'node');
      if (at(node, 'adFormat')) continue;
      const url = str(at(node, 'url'));
      hits.push({
        shareId: shareIdFromUrl(url),
        url: url ? url.split('?')[0] : null,
        author: str(at(node, 'title.text')) ?? '',
        context: str(at(node, 'subtitle.text')) ?? '',
        body: str(at(node, 'body.text')) ?? '',
        commentCount: num(at(node, 'postReactions.commentsCount.text')),
      });
    }
  }

  return { query: str(at(feed, 'query')) ?? '', hits, nextCursor };
}

export function mapMe(data: unknown): Me {
  const me = at(data, 'me');
  return {
    userId: str(at(me, 'user.id')),
    secureUserId: str(at(me, 'user.secureUserId')),
    name: str(at(me, 'user.name.displayName')) ?? '',
    neighborhood: mapNeighborhood(at(me, 'neighborhood')),
  };
}

// --- a user's own activity ---------------------------------------------------

export type ActivityKind = 'post' | 'comment' | 'reaction_to_post' | 'reaction_to_comment' | 'unknown';

/** Nextdoor's numeric activityType codes, as observed 2026-10. */
const ACTIVITY_KINDS: Record<number, ActivityKind> = {
  1: 'post',
  2: 'comment',
  3: 'reaction_to_post',
  4: 'reaction_to_comment',
};

export interface Activity {
  kind: ActivityKind;
  /** The post the activity happened on (post_<legacyId>). */
  postId: string;
  at: string | null;
  /** Nextdoor's one-line description, e.g. "Replied to Jane D.'s post: ...". */
  summary: string;
}

export interface ActivityPage {
  activities: Activity[];
  nextBefore: string | null;
  counts: { posts: number; comments: number; reactions: number } | null;
}

export function mapActivityPage(data: unknown): ActivityPage {
  const feed = at(data, 'user.userProfileActivities.allActivitiesFeed');
  const activities = arr(at(feed, 'activities'))
    .map((activity): Activity | null => {
      const postId = str(at(activity, 'postIdV2'));
      if (!postId) return null;
      const micros = num(at(activity, 'creationDate'));
      return {
        kind: ACTIVITY_KINDS[num(at(activity, 'activityType'))] ?? 'unknown',
        postId,
        at: micros > 0 ? new Date(micros / 1000).toISOString() : null,
        summary: arr(at(activity, 'messageParts'))
          .map((part) => str(at(part, 'text')) ?? '')
          .join(''),
      };
    })
    .filter((activity): activity is Activity => activity !== null);

  let counts: ActivityPage['counts'] = null;
  const rawCounts = str(at(feed, 'activitiesCount'));
  if (rawCounts) {
    try {
      const parsed = JSON.parse(rawCounts);
      counts = {
        posts: num(parsed.post_count),
        comments: num(parsed.comment_count),
        reactions: num(parsed.like_count),
      };
    } catch {
      counts = null;
    }
  }
  return { activities, nextBefore: str(at(feed, 'nextBeforeTimestamp')), counts };
}

/** A page of a user's own posts (feedActivity), mapped like the main feed. */
export function mapUserPostsPage(data: unknown): FeedPage {
  return mapFeedPage(data, 'user.userProfileActivities.activityFeed');
}

// --- profiles, neighborhoods, groups, businesses -----------------------------

export interface UserProfile {
  id: string;
  secureId: string | null;
  name: string;
  neighborhood: Neighborhood | null;
  residentSince: number | null;
  pronouns: string | null;
  biography: string;
  /** NEIGHBORHOOD_USER, ... */
  profileType: string | null;
  /** Names of the badges set on the profile (lead, foundingMember, ...). */
  badges: string[];
  helpfulScore: number | null;
  /** Business page ids the user owns. */
  ownedBusinesses: string[];
}

export function mapUserProfile(data: unknown): UserProfile | null {
  const user = at(data, 'user');
  const id = str(at(user, 'id'));
  if (!id) return null;
  const badges = obj(at(user, 'badges')) ?? {};
  const year = num(at(user, 'userData.residentSinceYear'));
  const helpful = at(user, 'helpfulScore');
  return {
    id,
    secureId: str(at(user, 'secureUserId')),
    name: str(at(user, 'name.displayName')) ?? '',
    neighborhood: mapNeighborhood(at(user, 'userProfileState.location.neighborhood') ?? at(user, 'neighborhood')),
    residentSince: year > 0 ? year : null,
    pronouns: str(at(user, 'pronouns')),
    biography: str(at(user, 'biography')) ?? '',
    profileType: str(at(user, 'userProfileState.profileType')),
    badges: Object.entries(badges)
      .filter(([key, value]) => key !== '__typename' && value === true)
      .map(([key]) => key),
    helpfulScore: typeof helpful === 'number' ? helpful : null,
    ownedBusinesses: arr(at(user, 'ownedBusinesses'))
      .map((business) => str(at(business, 'id')))
      .filter((businessId): businessId is string => Boolean(businessId)),
  };
}

export interface NeighborhoodProfile extends Neighborhood {
  /** Member count parsed from "261 neighbors", when shown. */
  neighbors: number | null;
}

/** Leading integer of a label such as "261 neighbors" or "1,204 members". */
function countIn(text: string | null): number | null {
  const match = text?.match(/^([\d,]+)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

export function mapNeighborhoodProfile(data: unknown): NeighborhoodProfile | null {
  const hood = mapNeighborhood(at(data, 'neighborhood'));
  if (!hood) return null;
  const stat = arr(at(data, 'neighborhood.neighborhoodStats'))
    .map((row) => str(at(row, 'text.text')))
    .find((text) => /neighbors?$/.test(text ?? ''));
  return { ...hood, neighbors: countIn(stat ?? null) };
}

export interface Group {
  id: string;
  name: string;
  members: number | null;
  /** True for groups the logged-in user belongs to; false for suggestions such as "Groups near you". */
  isMember: boolean;
}

export function mapUserGroups(data: unknown): Group[] {
  const groups = new Map<string, Group>();
  for (const section of arr(at(data, 'me.userGroupsSections'))) {
    const isMember = str(at(section, 'id'))?.endsWith('your_groups') ?? false;
    for (const item of arr(at(section, 'items'))) {
      const id = str(at(item, 'groupId'));
      if (!id) continue;
      groups.set(id, {
        id,
        name: str(at(item, 'title.text')) ?? '',
        members: countIn(str(at(item, 'subtitle.text'))),
        isMember: isMember || (groups.get(id)?.isMember ?? false),
      });
    }
  }
  return [...groups.values()];
}

export interface Business {
  id: string;
  slug: string | null;
  name: string;
  category: string | null;
  address: string | null;
  faves: number | null;
  followers: number | null;
}

export function mapBusiness(data: unknown): Business | null {
  const page = at(data, 'entityPage');
  const id = str(at(page, 'id'));
  if (!id) return null;
  const followers = at(page, 'followerCount');
  return {
    id,
    slug: str(at(page, 'urlSlug')),
    name: str(at(page, 'name')) ?? '',
    category: str(at(page, 'categoryInfo.displayCategory.name.singularName')),
    address: str(at(page, 'address.fullAddress')) ?? str(at(page, 'address.address')),
    faves: countIn(str(at(page, 'faveCount.value'))),
    followers: typeof followers === 'number' ? followers : countIn(str(at(followers, 'value'))),
  };
}
