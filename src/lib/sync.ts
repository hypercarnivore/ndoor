/**
 * `ndoor sync`: harvest as much of the community graph as a session can read,
 * then store it in the GraphStore.
 *
 * Phases, each isolated so one failure does not stop the rest:
 *   1. Feeds: main feed (both sorts), local news, home neighborhood, your groups,
 *      then expansion to the busiest neighborhoods, agencies, businesses seen, and
 *      the post histories of you and the most active neighbors.
 *   2. Your activity log (newest pages): your reactions, and posts to hydrate.
 *   3. Threads: full comment trees for new, grown, or recent posts. Reloads are
 *      how deletions are detected.
 *   4. Profiles: neighbors, neighborhoods, and businesses not yet looked up.
 *
 * Limits are data (SYNC_PRESETS) and every request counts against `maxRequests`.
 * Throttling that outlasts the client's backoff ends only the phase that hit it
 * and skips later work on the same operation; rerunning continues from the work
 * queues, which live in the graph itself.
 */

import { randomUUID } from 'node:crypto';
import { TOPIC_THEMES } from './analytics.js';
import { FEED_KINDS, type FeedResult, type FeedSort, type FeedSource } from './api.js';
import { assignDiscoveredThemes, type DiscoveredTheme } from './discover.js';
import type { GraphStore, Row, StoredJudgments } from './graph.js';
import {
  commentState,
  isJevUnavailable,
  type JevAnalyzer,
  type JudgmentSubject,
  type Judgments,
  leanScore,
  OPINION_QUESTION_SET,
  OPINION_QUESTIONS,
  opinionState,
  PLACE_QUESTION_SET,
  PLACE_QUESTIONS,
  POLITICS_GATE_P,
  POLITICS_GATE_THEMES,
  POLITICS_QUESTION_SET,
  POLITICS_QUESTIONS,
  placeState,
  politicsState,
  postState,
  questionSetId,
  THEMES,
} from './jev.js';
import type { ActivityPage, Business, FeedPage, Group, Me, NeighborhoodProfile, Post, UserProfile } from './model.js';
import { ThrottledError } from './nextdoor-client.js';

/** The slice of NextdoorApi sync uses. */
export interface SyncApi {
  me(): Promise<Me>;
  feed(options: { count: number; sort?: FeedSort }): Promise<FeedResult>;
  feedPages(source: FeedSource, options?: { maxPages?: number }): AsyncGenerator<FeedPage>;
  post(postId: string): Promise<Post>;
  activityPages(secureUserId: string, options?: { before?: string | null }): AsyncGenerator<ActivityPage>;
  userProfile(secureUserId: string): Promise<UserProfile | null>;
  neighborhood(slug: string): Promise<NeighborhoodProfile | null>;
  business(slug: string): Promise<Business | null>;
  myGroups(): Promise<Group[]>;
}

export interface SyncLimits {
  /** Posts read from the main feed, per sort order. */
  mainFeedPosts: number;
  /** Pages read from each other feed. */
  pagesPerFeed: number;
  /** Neighborhood feeds beyond your own, busiest first. */
  neighborhoods: number;
  agencies: number;
  groups: number;
  /** Also read open groups nearby that you have not joined (off by default: more requests, and not your neighbors). */
  openGroups: boolean;
  /** Business recommendation feeds, most mentioned first. */
  businesses: number;
  /** Post histories of the most active neighbors (yours is always read). */
  authorHistories: number;
  /** Pages of your activity log (newest first). */
  activityPages: number;
  threads: number;
  /** Threads never loaded are fetched only for posts made in the last this many days (null: any age). */
  newThreadDays: number | null;
  profiles: number;
  neighborhoodProfiles: number;
  businessProfiles: number;
  /** Threads younger than this are reloaded on each sync to catch deletions. */
  recheckDays: number;
  /** Minimum hours between reloads of the same thread. */
  refetchHours: number;
  /** Hard cap on Nextdoor requests for the whole run. */
  maxRequests: number;
}

export const SYNC_PRESETS: Record<'quick' | 'standard' | 'deep', SyncLimits> = {
  quick: {
    mainFeedPosts: 40,
    pagesPerFeed: 2,
    neighborhoods: 0,
    agencies: 0,
    groups: 3,
    openGroups: false,
    businesses: 0,
    authorHistories: 0,
    activityPages: 1,
    threads: 40,
    newThreadDays: 7,
    profiles: 20,
    neighborhoodProfiles: 5,
    businessProfiles: 5,
    recheckDays: 7,
    refetchHours: 12,
    maxRequests: 200,
  },
  standard: {
    mainFeedPosts: 100,
    pagesPerFeed: 5,
    neighborhoods: 10,
    agencies: 5,
    groups: 10,
    openGroups: false,
    businesses: 10,
    authorHistories: 10,
    activityPages: 5,
    threads: 250,
    newThreadDays: 14,
    profiles: 150,
    neighborhoodProfiles: 30,
    businessProfiles: 30,
    recheckDays: 14,
    refetchHours: 12,
    maxRequests: 1200,
  },
  deep: {
    mainFeedPosts: 300,
    pagesPerFeed: 20,
    neighborhoods: 40,
    agencies: 20,
    groups: 50,
    openGroups: false,
    businesses: 50,
    authorHistories: 100,
    activityPages: 50,
    threads: 2000,
    newThreadDays: null,
    profiles: 1000,
    neighborhoodProfiles: 200,
    businessProfiles: 200,
    recheckDays: 30,
    refetchHours: 12,
    maxRequests: 8000,
  },
};

export interface SyncStats {
  requests: number;
  /** Posts read from feeds, including ones already in the graph (their counts are refreshed). */
  posts: number;
  /** Posts and comments that were not in the graph before this run. */
  newPosts: number;
  newComments: number;
  /** Feeds that stopped early because they had nothing new left. */
  feedsCaughtUp: number;
  /** Scheduled pulls skipped because they were not due (they recently had nothing new). */
  feedsSkipped: number;
  adsDropped: number;
  feeds: number;
  reactions: number;
  threads: number;
  commentsRemoved: number;
  postsRemoved: number;
  profiles: number;
  neighborhoods: number;
  businesses: number;
  failures: number;
  /** Set when the run ended early (request budget). */
  stoppedBy: string | null;
  /** Operations Nextdoor kept throttling; the work that needed them was skipped this run. */
  throttled: string[];
}

export interface SyncOptions {
  limits: SyncLimits;
  log?: (line: string) => void;
  now?: () => string;
  /**
   * Runs before the threads phase picks its queue. Thread order favors posts Jev found asking
   * a question, so judging new posts here lets them compete for slots in the run that found them.
   */
  beforeThreads?: () => Promise<void>;
}

class Stop extends Error {}

/** Consecutive feed pages with nothing new after which a feed counts as caught up. */
export const CAUGHT_UP_PAGES = 2;

/**
 * How often each pull asks Nextdoor again. Every pull is incremental: after
 * the first run, a sync only asks about what could have changed. A feed that
 * had something new is due again next run (after `minHours`); a quiet one
 * waits `baseHours`, doubling with each quiet read up to `maxHours`.
 */
export const PULL_POLICY = {
  feeds: { minHours: 1, baseHours: 6, maxHours: 7 * 24 },
  /** Your account details and group list. */
  accountRefreshHours: 24,
  /** A neighbor's post history is read again only after this many days. */
  historyRefreshDays: 30,
} as const;

/** When a pull is due next, given whether its last run found anything new. */
export function nextRun(now: string, fresh: number, quiet: number): { next: string; quiet: number } {
  const policy = PULL_POLICY.feeds;
  const nextQuiet = fresh > 0 ? 0 : quiet + 1;
  const hours = nextQuiet === 0 ? policy.minHours : Math.min(policy.maxHours, policy.baseHours * 2 ** (nextQuiet - 1));
  return { next: new Date(Date.parse(now) + hours * 3_600_000).toISOString(), quiet: nextQuiet };
}

const MAX_LOGGED_FAILURES = 10;

/** Errors that mean Nextdoor no longer serves the post to us. */
const REMOVED = /not found|not authorized|does not exist|unavailable/i;

export async function syncGraph(api: SyncApi, store: GraphStore, options: SyncOptions): Promise<SyncStats> {
  const { limits } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const stats: SyncStats = {
    requests: 0,
    posts: 0,
    adsDropped: 0,
    feeds: 0,
    reactions: 0,
    threads: 0,
    commentsRemoved: 0,
    postsRemoved: 0,
    profiles: 0,
    neighborhoods: 0,
    businesses: 0,
    failures: 0,
    stoppedBy: null,
    throttled: [],
    newPosts: 0,
    newComments: 0,
    feedsCaughtUp: 0,
    feedsSkipped: 0,
  };
  // Nextdoor throttles per operation, so a throttled feed only skips work that needs the same operation.
  const throttled = new Set<string>();

  /** Stop the run if the request budget is used up. */
  const checkBudget = () => {
    if (stats.requests >= limits.maxRequests) throw new Stop(`request budget (${limits.maxRequests})`);
  };

  /** Count a request against the budget, or stop the run. */
  const spend = () => {
    checkBudget();
    stats.requests += 1;
  };

  /** Count a failed item and log the first few, so a systematic problem is visible. Throttling ends the run. */
  const fail = (context: string, error: unknown) => {
    if (error instanceof ThrottledError || error instanceof Stop) throw error;
    stats.failures += 1;
    if (stats.failures <= MAX_LOGGED_FAILURES) {
      log(`  ${context} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (stats.failures === MAX_LOGGED_FAILURES) log('  (further failures are counted, not logged)');
    }
  };

  const phase = async (name: string, work: () => Promise<unknown>) => {
    if (stats.stoppedBy) return;
    try {
      await work();
    } catch (error) {
      if (error instanceof Stop) stats.stoppedBy = error.message;
      else if (error instanceof ThrottledError) {
        if (!throttled.has(error.operation))
          log(`  ${name}: Nextdoor is throttling ${error.operation}; skipping it this run`);
        throttled.add(error.operation);
        stats.throttled = [...throttled];
      } else fail(name, error);
    }
  };

  /** Ingest a feed page; returns how many of its posts were new since this run started. */
  const ingestPage = async (page: FeedPage, groupId?: string): Promise<number> => {
    stats.adsDropped += page.adsDropped;
    const known = await store.postsKnownBefore(
      page.posts.map((post) => post.id),
      startedAt,
    );
    for (const post of page.posts) {
      await store.transaction(() => store.ingestPost(post, now(), { groupId }));
      stats.posts += 1;
    }
    return page.posts.filter((post) => !known.has(post.id)).length;
  };

  /** Whether a scheduled pull is due now (never run counts as due). */
  const due = async (key: string) => {
    const schedule = await store.schedule(key);
    return !schedule?.nextRunAt || schedule.nextRunAt.getTime() <= Date.parse(now());
  };

  /** Record a scheduled pull's outcome, backing off when it found nothing new. */
  const ran = async (key: string, fresh: number) => {
    const schedule = await store.schedule(key);
    await store.recordRun(key, { now: now(), ...nextRun(now(), fresh, schedule?.quiet ?? 0) });
  };

  /**
   * Read a feed newest first until it is caught up (or the page cap). With
   * `scheduled`, a feed that is not due is skipped. False when skipped (not
   * due, or its operation is throttled).
   */
  const readFeed = async (
    label: string,
    source: FeedSource,
    groupId?: string,
    options: { scheduled?: boolean; maxPages?: number; pageSize?: number } = {},
  ): Promise<boolean> => {
    if (throttled.has(FEED_KINDS[source.kind].operation)) return false;
    const key = `feed:${label}`;
    if (options.scheduled !== false && !(await due(key))) {
      stats.feedsSkipped += 1;
      return false;
    }
    log(`feed: ${label}`);
    let fresh = 0;
    const pages = api.feedPages(source, {
      maxPages: options.maxPages ?? limits.pagesPerFeed,
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    });
    // Feeds are newest first. Once CAUGHT_UP_PAGES pages in a row hold nothing new since this run
    // started, the rest is already in the graph. Two pages, not one, because "for you" ordering is
    // not strictly chronological.
    let staleRun = 0;
    while (true) {
      // Asking a pager for its next page after its last one makes no request, so count only pages that arrive.
      checkBudget();
      const next = await pages.next();
      if (next.done) break;
      stats.requests += 1;
      const pageFresh = await ingestPage(next.value, groupId);
      fresh += pageFresh;
      staleRun = pageFresh > 0 ? 0 : staleRun + 1;
      if (staleRun >= CAUGHT_UP_PAGES) {
        stats.feedsCaughtUp += 1;
        await pages.return(undefined);
        break;
      }
    }
    stats.feeds += 1;
    if (options.scheduled !== false) await ran(key, fresh);
    return true;
  };

  // Your account rarely changes: ask once a day, otherwise use the copy from the last ask.
  let me: Me;
  const account = await store.schedule('account');
  if (account?.payload && !(await due('account'))) {
    me = JSON.parse(account.payload) as Me;
  } else {
    spend();
    me = await api.me();
    const next = new Date(Date.parse(now()) + PULL_POLICY.accountRefreshHours * 3_600_000).toISOString();
    await store.recordRun('account', { now: now(), next, quiet: 0, payload: JSON.stringify(me) });
  }
  const meId = me.userId;
  if (meId) {
    await store.upsertAuthor(
      {
        id: meId,
        secureId: me.secureUserId,
        name: me.name,
        type: 'NEIGHBOR',
        profileUrl: null,
        neighborhood: me.neighborhood,
        agency: null,
        pageSlug: null,
      },
      now(),
    );
  }

  // 1. Feeds.
  // Your main feed is read every run, but only until it is caught up.
  for (const sort of ['FOR_YOU', 'RECENT_POSTS'] as const) {
    await phase(`main feed (${sort})`, () =>
      readFeed(`main (${sort})`, { kind: 'main', sort }, undefined, {
        scheduled: false,
        maxPages: Math.ceil(limits.mainFeedPosts / 20),
        pageSize: 20,
      }),
    );
  }
  await phase('local news', () => readFeed('local news', { kind: 'news' }));
  if (me.neighborhood?.slug) {
    const slug = me.neighborhood.slug;
    await phase('home neighborhood', () => readFeed(`neighborhood ${slug}`, { kind: 'neighborhood', slug }));
  }
  await phase('groups', async () => {
    let groups: Group[];
    if (await due('groups')) {
      spend();
      groups = await api.myGroups();
      await store.transaction(() => store.upsertGroups(groups, meId, now()));
      const next = new Date(Date.parse(now()) + PULL_POLICY.accountRefreshHours * 3_600_000).toISOString();
      await store.recordRun('groups', { now: now(), next, quiet: 0 });
    } else {
      groups = await store.knownGroups(meId);
    }
    // Your groups first; open groups nearby only when asked for.
    const ordered = [
      ...groups.filter((group) => group.isMember),
      ...(limits.openGroups ? groups.filter((group) => !group.isMember) : []),
    ];
    for (const group of ordered.slice(0, limits.groups)) {
      await phase(`group ${group.name}`, () =>
        readFeed(`group ${group.name}`, { kind: 'group', id: group.id }, group.id),
      );
    }
  });
  await phase('neighborhoods', async () => {
    const slugs = (await store.topNeighborhoods(limits.neighborhoods + 1)).filter(
      (slug) => slug !== me.neighborhood?.slug,
    );
    for (const slug of slugs.slice(0, limits.neighborhoods)) {
      await phase(`neighborhood ${slug}`, () => readFeed(`neighborhood ${slug}`, { kind: 'neighborhood', slug }));
    }
  });
  await phase('agencies', async () => {
    for (const id of await store.agencies(limits.agencies)) {
      await phase(`agency ${id}`, () => readFeed(`agency ${id}`, { kind: 'agency', id }));
    }
  });
  await phase('businesses', async () => {
    for (const slug of await store.topMentionedBusinesses(limits.businesses)) {
      await phase(`business ${slug}`, () => readFeed(`business ${slug}`, { kind: 'business', slug }));
    }
  });

  await phase('post histories', async () => {
    // Yours on the feed schedule; other neighbors' only if never read or read over a month ago.
    if (me.secureUserId) {
      const mine = me.secureUserId;
      await phase('your posts', async () => {
        if (await readFeed('your posts', { kind: 'user', secureId: mine })) await store.markHistoryRead(mine, now());
      });
    }
    const staleBefore = new Date(Date.parse(now()) - PULL_POLICY.historyRefreshDays * 86_400_000).toISOString();
    const secureIds = (await store.authorsNeedingHistories(limits.authorHistories + 1, staleBefore))
      .filter((id) => id !== me.secureUserId)
      .slice(0, limits.authorHistories);
    for (const secureId of secureIds) {
      await phase(`posts by ${secureId}`, async () => {
        if (await readFeed(`posts by ${secureId}`, { kind: 'user', secureId }, undefined, { scheduled: false })) {
          await store.markHistoryRead(secureId, now());
        }
      });
    }
  });

  // 2. Your activity log: reactions, plus ids of posts you touched for hydration.
  if (meId && me.secureUserId && limits.activityPages > 0) {
    const secureId = me.secureUserId;
    await phase('activity log', async () => {
      if (!(await due('activity'))) {
        stats.feedsSkipped += 1;
        return;
      }
      log('your activity log');
      const pages = api.activityPages(secureId);
      let fresh = 0;
      for (let index = 0; index < limits.activityPages; index += 1) {
        checkBudget();
        const next = await pages.next();
        if (next.done) break;
        stats.requests += 1;
        const { activities } = next.value;
        const added = await store.transaction(() => store.ingestReactions(meId, activities, now()));
        fresh += added;
        // Newest first: a page with nothing new means the rest is already stored.
        if (added === 0) {
          await pages.return(undefined);
          break;
        }
      }
      stats.reactions += fresh;
      await ran('activity', fresh);
    });
  }

  // 3. Threads.
  await phase('threads', async () => {
    await options.beforeThreads?.();
    const at = Date.parse(now());
    const queue = await store.postsNeedingThreads({
      recheckSince: new Date(at - limits.recheckDays * 86_400_000).toISOString(),
      refetchBefore: new Date(at - limits.refetchHours * 3_600_000).toISOString(),
      now: now(),
      limit: limits.threads,
      ...(limits.newThreadDays !== null && {
        unreadSince: new Date(at - limits.newThreadDays * 86_400_000).toISOString(),
      }),
    });
    log(`threads: ${queue.length} to load`);
    for (const [index, postId] of queue.entries()) {
      spend();
      try {
        const post = await api.post(postId);
        stats.commentsRemoved += await store.transaction(async () => {
          await store.ingestPost(post, now());
          return store.markThreadFetched(post, now(), limits.refetchHours);
        });
        stats.threads += 1;
      } catch (error) {
        if (error instanceof ThrottledError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (REMOVED.test(message)) {
          await store.markPostRemoved(postId, message, now());
          stats.postsRemoved += 1;
        } else {
          fail(`thread ${postId}`, error);
        }
      }
      if ((index + 1) % 25 === 0) log(`  ${index + 1}/${queue.length} threads`);
    }
  });

  // 4. Profiles.
  await phase('profiles', async () => {
    const queue = await store.usersNeedingProfiles(limits.profiles);
    log(`profiles: ${queue.length} to look up`);
    for (const secureId of queue) {
      spend();
      try {
        const profile = await api.userProfile(secureId);
        if (profile) {
          await store.transaction(() => store.upsertUserProfile(profile, now()));
          stats.profiles += 1;
        } else {
          await store.markLookedUp('User', secureId, now());
        }
      } catch (error) {
        fail(`profile ${secureId}`, error);
        await store.markLookedUp('User', secureId, now());
      }
    }
  });
  await phase('neighborhood profiles', async () => {
    for (const slug of await store.neighborhoodsNeedingProfiles(limits.neighborhoodProfiles)) {
      spend();
      const hood = await api.neighborhood(slug).catch((error) => {
        fail(`neighborhood ${slug}`, error);
        return null;
      });
      if (hood) {
        await store.upsertNeighborhoodProfile(hood, now());
        stats.neighborhoods += 1;
      } else {
        await store.markLookedUp('Neighborhood', slug, now());
      }
    }
  });
  await phase('business profiles', async () => {
    for (const slug of await store.businessesNeedingProfiles(limits.businessProfiles)) {
      spend();
      const business = await api.business(slug).catch((error) => {
        fail(`business ${slug}`, error);
        return null;
      });
      if (business) {
        await store.upsertBusiness(business, now());
        stats.businesses += 1;
      } else {
        await store.markLookedUp('Business', slug, now());
      }
    }
  });

  Object.assign(
    stats,
    await store.newSince(startedAt).then((fresh) => ({ newPosts: fresh.posts, newComments: fresh.comments })),
  );
  await store.recordSync(randomUUID(), startedAt, now(), stats, meId);
  return stats;
}

// --- Jev over the graph --------------------------------------------------------

/** Turn Jev judgments into graph properties. Scores keep their raw level; tone is normalized to [0, 1]. */
export function toStored(judgments: Judgments): StoredJudgments {
  const score = (id: string) => judgments.scores[id]?.value ?? null;
  const tone = judgments.scores.tone ? judgments.scores.tone.value / (judgments.scores.tone.levels - 1) : null;
  if (judgments.kind === 'post') {
    return {
      subjectId: judgments.subjectId,
      kind: 'post',
      version: judgments.questionSet,
      properties: {
        primaryTheme: judgments.choices.primary_theme?.label ?? null,
        primaryThemeConfidence: judgments.choices.primary_theme?.confidence ?? null,
        intent: judgments.choices.intent?.label ?? null,
        tone,
        hostility: score('hostility'),
        urgency: score('urgency'),
        asksQuestion: judgments.nouls.asks_question ?? null,
        accuses: judgments.nouls.accuses_individual ?? null,
      },
      themes: Object.fromEntries(
        Object.keys(THEMES)
          .filter((theme) => judgments.nouls[`theme.${theme}`] !== undefined)
          .map((theme) => [theme, judgments.nouls[`theme.${theme}`]]),
      ),
    };
  }
  return {
    subjectId: judgments.subjectId,
    kind: 'comment',
    version: judgments.questionSet,
    properties: {
      stance: judgments.choices.stance?.label ?? null,
      tone,
      hostility: score('hostility'),
      helpful: judgments.nouls.helpful ?? null,
      recommendsBusiness: judgments.nouls.recommends_business ?? null,
    },
  };
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function postTextFrom(row: Row, prefix = '') {
  const key = (name: string) => (prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name);
  return { subject: text(row[key('subject')]), body: text(row[key('body')]) };
}

/** Posts as the decision model sees them, from postsNeedingJudgments rows. */
export function postSubjects(rows: Row[]): JudgmentSubject[] {
  return rows.map((row) => ({
    id: String(row.id),
    kind: 'post' as const,
    state: postState({
      ...postTextFrom(row),
      repostOf: row.repostSubject || row.repostBody ? postTextFrom(row, 'repost') : null,
    }),
  }));
}

/** Comments with their post and the comment they answer, from commentsNeedingJudgments rows. */
export function commentSubjects(rows: Row[]): JudgmentSubject[] {
  return rows.map((row) => ({
    id: String(row.id),
    kind: 'comment' as const,
    state: commentState(
      { subject: text(row.postSubject), body: text(row.postBody), repostOf: null },
      { body: text(row.body) },
      row.targetBody ? { body: text(row.targetBody) } : null,
    ),
  }));
}

export interface AnalyzeStats {
  posts: number;
  comments: number;
  /** Posts judged against the discovered theme set. */
  discovered: number;
  /** Business mentions judged for the opinion they express. */
  opinions: number;
  /** Topic posts judged for where their situation is. */
  placed: number;
  /** Posts about government or politics judged for level and lean. */
  political: number;
  /** Why Jev work stopped early (for example, no credits); null when it finished. */
  stoppedBy: string | null;
  inputTokens: number;
}

export interface JudgePostsStats {
  posts: number;
  inputTokens: number;
  /** Why Jev stopped early (for example, no credits); null when it finished. */
  stoppedBy: string | null;
}

/** Judge posts that lack judgments for the current question set; saved batch by batch. */
export async function judgePosts(
  store: GraphStore,
  analyzer: JevAnalyzer,
  limit: number,
  log: (line: string) => void = () => {},
): Promise<JudgePostsStats> {
  const stats: JudgePostsStats = { posts: 0, inputTokens: 0, stoppedBy: null };
  const posts = await store.postsNeedingJudgments(questionSetId('post'), limit);
  log(`jev: ${posts.length} posts`);
  try {
    await analyzer.judgeInBatches(
      postSubjects(posts),
      (batch) =>
        store.transaction(async () => {
          for (const judgments of batch) {
            await store.saveJudgments(toStored(judgments));
            stats.posts += 1;
            stats.inputTokens += judgments.inputTokens;
          }
        }),
      { progress: (done, total) => total > 200 && log(`jev: ${done}/${total} posts`) },
    );
  } catch (error) {
    if (!isJevUnavailable(error)) throw error;
    stats.stoppedBy = `Jev unavailable: ${error instanceof Error ? error.message : String(error)}`;
    log(stats.stoppedBy);
  }
  return stats;
}

/** Judge posts and comments in the graph that lack judgments for the current question set. */
export async function analyzeGraph(
  store: GraphStore,
  analyzer: JevAnalyzer,
  options: { posts: number; comments: number; discovered?: DiscoveredTheme[]; log?: (line: string) => void },
): Promise<AnalyzeStats> {
  const log = options.log ?? (() => {});
  const stats: AnalyzeStats = {
    posts: 0,
    comments: 0,
    discovered: 0,
    opinions: 0,
    placed: 0,
    political: 0,
    stoppedBy: null,
    inputTokens: 0,
  };
  const progress = (what: string) => (done: number, total: number) => {
    if (total > 200) log(`jev: ${done}/${total} ${what}`);
  };
  // Each batch is saved as soon as it is judged (and every answer is cached as it arrives),
  // so an interrupted run keeps its work and the next run picks up the rest.
  const saveEach = (save: (judgments: Judgments) => Promise<void>) => (batch: Judgments[]) =>
    store.transaction(async () => {
      for (const judgments of batch) {
        await save(judgments);
        stats.inputTokens += judgments.inputTokens;
      }
    });

  /** Run one Jev phase; if Jev becomes unavailable, record why and skip the remaining phases. */
  const guarded = async (work: () => Promise<void>) => {
    if (stats.stoppedBy) return;
    try {
      await work();
    } catch (error) {
      if (!isJevUnavailable(error)) throw error;
      stats.stoppedBy = `Jev unavailable: ${error instanceof Error ? error.message : String(error)}`;
      log(stats.stoppedBy);
    }
  };

  const judged = await judgePosts(store, analyzer, options.posts, log);
  stats.posts += judged.posts;
  stats.inputTokens += judged.inputTokens;
  stats.stoppedBy = judged.stoppedBy;

  // Political posts: which level of government, and which way the author leans. Posts only and a small
  // batch, so they go ahead of the (much larger) comment pass.
  const political = await store.postsNeedingPolitics(
    POLITICS_GATE_THEMES,
    POLITICS_GATE_P,
    POLITICS_QUESTION_SET,
    options.posts,
  );
  log(`jev: ${political.length} possibly political posts`);
  await guarded(() =>
    analyzer.judgeInBatches(
      political.map((row) => ({
        id: String(row.id),
        kind: 'post' as const,
        questions: POLITICS_QUESTIONS,
        questionSet: POLITICS_QUESTION_SET,
        state: politicsState({ subject: text(row.subject), body: text(row.body) }),
      })),
      saveEach(async (judgment) => {
        const { level, lean } = judgment.choices;
        if (!level || !lean) return;
        await store.savePolitics(
          judgment.subjectId,
          {
            level: level.label,
            levelConfidence: level.confidence,
            lean: lean.label,
            leanConfidence: lean.confidence,
            leanScore: leanScore(lean.probabilities),
          },
          POLITICS_QUESTION_SET,
        );
        stats.political += 1;
      }),
      { progress: progress('possibly political posts') },
    ),
  );

  const comments = await store.commentsNeedingJudgments(questionSetId('comment'), options.comments);
  log(`jev: ${comments.length} comments`);
  await guarded(() =>
    analyzer.judgeInBatches(
      commentSubjects(comments),
      saveEach(async (judgments) => {
        await store.saveJudgments(toStored(judgments));
        stats.comments += 1;
      }),
      { progress: progress('comments') },
    ),
  );

  const mentions = await store.mentionsNeedingOpinions(options.comments);
  log(`jev: ${mentions.length} business mentions`);
  await guarded(() =>
    analyzer.judgeInBatches(
      mentions.map((row) => ({
        id: `${String(row.kind)}|${String(row.id)}|${String(row.business)}`,
        kind: 'comment' as const,
        questions: OPINION_QUESTIONS,
        questionSet: OPINION_QUESTION_SET,
        state: opinionState(
          { name: text(row.name), category: row.category ? text(row.category) : null },
          text(row.text),
          { topic: row.topic ? text(row.topic) : null, answering: row.answering ? text(row.answering) : null },
        ),
      })),
      saveEach(async (judgment) => {
        const choice = judgment.choices.opinion;
        if (!choice) return;
        const [kind, id, business] = judgment.subjectId.split('|');
        await store.saveOpinion(kind as 'Post' | 'Comment', id, business, choice.label, choice.confidence);
        stats.opinions += 1;
      }),
      { progress: progress('business mentions') },
    ),
  );

  // Where each topic post's situation is (topic screens map incidents, not posters' homes).
  const placed = await store.postsNeedingPlace(TOPIC_THEMES, PLACE_QUESTION_SET, options.posts);
  log(`jev: ${placed.length} topic posts to place`);
  await guarded(() =>
    analyzer.judgeInBatches(
      placed.map((row) => ({
        id: String(row.id),
        kind: 'post' as const,
        questions: PLACE_QUESTIONS,
        questionSet: PLACE_QUESTION_SET,
        state: placeState(
          { subject: text(row.subject), body: text(row.body) },
          { name: row.hood ? text(row.hood) : null, city: row.city ? text(row.city) : null },
        ),
      })),
      saveEach(async (judgment) => {
        const choice = judgment.choices.place;
        if (!choice) return;
        await store.savePlace(judgment.subjectId, choice.label, choice.confidence, PLACE_QUESTION_SET);
        stats.placed += 1;
      }),
      { progress: progress('topic posts placed') },
    ),
  );

  if (options.discovered?.length) {
    const discovered = options.discovered;
    await guarded(async () => {
      const assigned = await assignDiscoveredThemes(store, analyzer, discovered, {
        limit: options.posts,
        log,
        onProgress: (done) => {
          stats.discovered = done.posts;
        },
      });
      stats.discovered = assigned.posts;
      stats.inputTokens += assigned.inputTokens;
    });
  }
  return stats;
}
