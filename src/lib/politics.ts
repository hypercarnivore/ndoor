/**
 * Political posts: how many there are, which level of government they concern,
 * which way their authors lean, how that moves over time, and whether any
 * neighborhood differs from the rest of town by more than chance.
 *
 * Jev judges each possibly-political post once (see POLITICS_QUESTIONS); this
 * module only aggregates those stored judgments. Lean is a score from -1 (left)
 * to +1 (right) per post; the report shows it as an index of -100..+100.
 *
 * Statistical unit. Posts from one author are not independent evidence (one
 * prolific poster can make a neighborhood look partisan), so every test works
 * on one number per author: that author's mean lean. Counts shown for context
 * are still posts. Authors are never named in the report.
 */

import { DAY, plainRows } from './analytics.js';
import type { Query } from './explore.js';
import type { Row } from './graph.js';
import { benjaminiHochberg, mannKendall, mean, meanEstimate, welch, wilson } from './stats.js';

export const LEVELS = { local: 'Local', state: 'State', national: 'National' } as const;
type Level = keyof typeof LEVELS;

/** Judgments below this confidence in "is it political, and at what level" are set aside as unclear. */
export const MIN_LEVEL_CONFIDENCE = 0.5;
/** Fewest political posts in a month before that month's mean enters the trend test. */
export const MIN_MONTH_POSTS = 5;
/** Fewest such months before a trend is claimed. */
export const MIN_TREND_MONTHS = 6;
/** Fewest political posts and distinct authors before a neighborhood is compared with the rest of town. */
export const MIN_HOOD_POSTS = 3;
export const MIN_HOOD_AUTHORS = 3;
/** Fewest authors in each of two time windows before they are compared. */
export const MIN_WINDOW_AUTHORS = 8;
/** A finding is called significant when its adjusted p-value is below this. */
export const ALPHA = 0.1;
/** A neighborhood that fails the corrected test but has a raw p-value below this is flagged as "leaning": worth watching. */
export const LEANING_P = 0.1;
const WINDOW_DAYS = 90;

/** Where a post was read from: a neighborhood or feed, a group you belong to, or an open group you do not. */
export const SOURCES = { feed: 'Neighborhoods and feed', mine: 'My groups', open: 'Other groups' } as const;
export type Source = keyof typeof SOURCES;

export interface PoliticalPost {
  id: string;
  source: Source;
  at: number;
  authorId: string;
  hoodId: string | null;
  neighborhood: string | null;
  level: Level;
  lean: 'left' | 'right' | 'neutral';
  /** -1 (left) .. +1 (right). */
  score: number;
}

export interface Finding {
  /** Which analysis produced it. */
  kind: 'trend' | 'window' | 'neighborhood';
  /** The claim in plain words. */
  text: string;
  /** The test behind it, for those who want it (shown on hover). */
  detail?: string;
  significant: boolean;
}

const index = (score: number) => Math.round(score * 100);
const signed = (score: number) => `${score > 0 ? '+' : ''}${index(score)}`;
const side = (score: number) => (score > 0 ? 'right' : 'left');
const pValue = (p: number) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`);

/** Mean of each author's mean lean, the unit every test below uses. */
function authorMeans(posts: PoliticalPost[]): number[] {
  const byAuthor = new Map<string, number[]>();
  for (const post of posts) byAuthor.set(post.authorId, [...(byAuthor.get(post.authorId) ?? []), post.score]);
  return [...byAuthor.values()].map(mean);
}

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** Every month from the first with data through the current one, empty months included, so time axes stay true. */
function monthRange(first: number, now: number): string[] {
  const months: string[] = [];
  const start = new Date(first);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const last = monthOf(now);
  for (let i = 0; i < 1200; i += 1) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    if (key > last) break;
    months.push(key);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

export function summarizePolitics(posts: PoliticalPost[], allPosts: number, pending: number, now: number) {
  const count = (items: PoliticalPost[], lean: PoliticalPost['lean']) =>
    items.filter((post) => post.lean === lean).length;
  const overall = meanEstimate(authorMeans(posts));

  // --- over time ---------------------------------------------------------------
  const first = posts.reduce((earliest, post) => Math.min(earliest, post.at), Number.POSITIVE_INFINITY);
  const monthly = (posts.length ? monthRange(first, now) : []).map((month) => {
    const inMonth = posts.filter((post) => monthOf(post.at) === month);
    const left = count(inMonth, 'left');
    const right = count(inMonth, 'right');
    const neutral = count(inMonth, 'neutral');
    const estimate = meanEstimate(inMonth.map((post) => post.score));
    return {
      month,
      total: inMonth.length,
      left,
      right,
      neutral,
      local: inMonth.filter((post) => post.level === 'local').length,
      state: inMonth.filter((post) => post.level === 'state').length,
      national: inMonth.filter((post) => post.level === 'national').length,
      meanLean: inMonth.length ? mean(inMonth.map((post) => post.score)) : null,
      low: estimate?.low ?? null,
      high: estimate?.high ?? null,
    };
  });

  // --- findings ----------------------------------------------------------------
  const findings: Finding[] = [];

  const enough = monthly.filter((row) => row.total >= MIN_MONTH_POSTS && row.meanLean !== null);
  const trend = enough.length >= MIN_TREND_MONTHS ? mannKendall(enough.map((row) => row.meanLean as number)) : null;
  if (trend) {
    const significant = trend.p < ALPHA;
    findings.push({
      kind: 'trend',
      significant,
      text: significant
        ? `Over ${enough.length} months, political posts have moved ${side(trend.slope)}, about ${Math.abs(index(trend.slope))} points a month.`
        : `No clear shift left or right over ${enough.length} months.`,
      detail: `Mann-Kendall trend test, ${pValue(trend.p)}; Theil-Sen slope ${signed(trend.slope)} points per month.`,
    });
  } else {
    findings.push({
      kind: 'trend',
      significant: false,
      text: `Too early to show a trend. It needs ${MIN_TREND_MONTHS} months with at least ${MIN_MONTH_POSTS} political posts each, and there are ${enough.length}.`,
    });
  }

  const recent = posts.filter((post) => post.at >= now - WINDOW_DAYS * DAY);
  const prior = posts.filter((post) => post.at >= now - 2 * WINDOW_DAYS * DAY && post.at < now - WINDOW_DAYS * DAY);
  const recentMeans = authorMeans(recent);
  const priorMeans = authorMeans(prior);
  const window =
    recentMeans.length >= MIN_WINDOW_AUTHORS && priorMeans.length >= MIN_WINDOW_AUTHORS
      ? welch(recentMeans, priorMeans)
      : null;
  if (window) {
    const significant = window.p < ALPHA;
    findings.push({
      kind: 'window',
      significant,
      text: significant
        ? `The last ${WINDOW_DAYS} days lean more ${side(window.difference)} than the ${WINDOW_DAYS} days before, by ${Math.abs(index(window.difference))} points.`
        : `The last ${WINDOW_DAYS} days look about the same as the ${WINDOW_DAYS} days before.`,
      detail: `Welch t-test on per-author means: ${signed(window.difference)} points (95% interval ${signed(window.low)} to ${signed(window.high)}), ${pValue(window.p)}, ${recentMeans.length} and ${priorMeans.length} authors.`,
    });
  } else {
    findings.push({
      kind: 'window',
      significant: false,
      text: `Too early to compare the last ${WINDOW_DAYS} days with the ${WINDOW_DAYS} before. It needs ${MIN_WINDOW_AUTHORS} authors in each, and there are ${recentMeans.length} and ${priorMeans.length}.`,
    });
  }

  // --- neighborhoods vs the rest of town -----------------------------------------
  const byHood = new Map<string, PoliticalPost[]>();
  for (const post of posts) {
    if (post.hoodId) byHood.set(post.hoodId, [...(byHood.get(post.hoodId) ?? []), post]);
  }
  const candidates = [...byHood.entries()].map(([id, own]) => {
    const ownMeans = authorMeans(own);
    const restMeans = authorMeans(posts.filter((post) => post.hoodId !== id));
    const tested = own.length >= MIN_HOOD_POSTS && ownMeans.length >= MIN_HOOD_AUTHORS;
    const estimate = meanEstimate(own.map((post) => post.score));
    const wl = count(own, 'left');
    const wr = count(own, 'right');
    return {
      id,
      name: own[0].neighborhood ?? id,
      posts: own.length,
      authors: ownMeans.length,
      left: wl,
      right: wr,
      neutral: count(own, 'neutral'),
      meanLean: mean(own.map((post) => post.score)),
      low: estimate?.low ?? null,
      high: estimate?.high ?? null,
      rightShare: own.length ? wr / own.length : null,
      rightShareInterval: wilson(wr, own.length),
      test: tested ? welch(ownMeans, restMeans) : null,
    };
  });
  const tested = candidates.filter((row) => row.test);
  const q = benjaminiHochberg(tested.map((row) => (row.test as { p: number }).p));
  const qByHood = new Map(tested.map((row, i) => [row.id, q[i]]));
  const neighborhoods = candidates
    .map((row) => {
      const adjusted = qByHood.get(row.id) ?? null;
      return {
        id: row.id,
        name: row.name,
        posts: row.posts,
        authors: row.authors,
        left: row.left,
        right: row.right,
        neutral: row.neutral,
        meanLean: row.meanLean,
        low: row.low,
        high: row.high,
        difference: row.test?.difference ?? null,
        differenceLow: row.test?.low ?? null,
        differenceHigh: row.test?.high ?? null,
        p: row.test?.p ?? null,
        q: adjusted,
        significant: adjusted !== null && adjusted < ALPHA,
        /** Not proven after correcting for many comparisons, but the raw result points the same way. */
        leaning: row.test !== null && (adjusted === null || adjusted >= ALPHA) && row.test.p < LEANING_P,
      };
    })
    .sort((a, b) => b.posts - a.posts);

  const significantHoods = neighborhoods
    .filter((row) => row.significant && row.difference !== null)
    .sort((a, b) => Math.abs(b.difference as number) - Math.abs(a.difference as number));
  for (const row of significantHoods) {
    findings.push({
      kind: 'neighborhood',
      significant: true,
      text: `${row.name} leans more ${side(row.difference as number)} than the rest of town, by ${Math.abs(index(row.difference as number))} points (${row.authors} authors, ${row.posts} posts).`,
      detail: `Welch t-test on per-author means: ${signed(row.difference as number)} points (95% interval ${signed(row.differenceLow as number)} to ${signed(row.differenceHigh as number)}), adjusted ${pValue(row.q as number)}.`,
    });
  }
  const untested = candidates.length - tested.length;
  const leaningHoods = neighborhoods.filter((row) => row.leaning);
  findings.push({
    kind: 'neighborhood',
    significant: false,
    text: tested.length
      ? `${tested.length} neighborhoods have enough posts to compare with the rest of town, and ${significantHoods.length ? `${significantHoods.length} stand out` : 'none stand out'}.${leaningHoods.length ? ` ${leaningHoods.length} more lean away from town but need more posts to be sure.` : ''}${untested ? ` ${untested} others have too few posts.` : ''}`
      : `No neighborhood has ${MIN_HOOD_POSTS} political posts from ${MIN_HOOD_AUTHORS} authors yet, so none can be compared.`,
    detail: `Each neighborhood is tested against the rest of town and corrected for running many tests (false discovery rate ${ALPHA * 100}%).`,
  });

  // --- by level ------------------------------------------------------------------
  const levels = (Object.keys(LEVELS) as Level[]).map((level) => {
    const own = posts.filter((post) => post.level === level);
    return {
      level,
      name: LEVELS[level],
      posts: own.length,
      left: count(own, 'left'),
      right: count(own, 'right'),
      neutral: count(own, 'neutral'),
      meanLean: own.length ? mean(own.map((post) => post.score)) : null,
    };
  });

  const authors = new Set(posts.map((post) => post.authorId)).size;
  return {
    kpis: {
      posts: posts.length,
      authors,
      share: allPosts ? posts.length / allPosts : null,
      left: count(posts, 'left'),
      right: count(posts, 'right'),
      neutral: count(posts, 'neutral'),
      meanLean: overall?.mean ?? (posts.length ? mean(posts.map((post) => post.score)) : null),
      meanLow: overall?.low ?? null,
      meanHigh: overall?.high ?? null,
      last30: posts.filter((post) => post.at >= now - 30 * DAY).length,
      prior30: posts.filter((post) => post.at >= now - 60 * DAY && post.at < now - 30 * DAY).length,
      pending,
    },
    levels,
    monthly,
    neighborhoods,
    findings,
  };
}

/** Rows to PoliticalPost: judged political, confidently enough, with a usable lean. */
export function toPoliticalPosts(rows: Row[]): { posts: PoliticalPost[]; unclear: number } {
  const posts: PoliticalPost[] = [];
  let unclear = 0;
  for (const row of rows) {
    const level = String(row.level);
    if (!(level in LEVELS)) continue;
    if (Number(row.levelConfidence) < MIN_LEVEL_CONFIDENCE) {
      unclear += 1;
      continue;
    }
    const at = Date.parse(String(row.at));
    const lean = String(row.lean);
    if (Number.isNaN(at) || !['left', 'right', 'neutral'].includes(lean) || typeof row.score !== 'number') continue;
    posts.push({
      id: String(row.id),
      source: row.source === 'mine' || row.source === 'open' ? row.source : 'feed',
      at,
      authorId: String(row.authorId),
      hoodId: row.hoodId ? String(row.hoodId) : null,
      neighborhood: row.neighborhood ? String(row.neighborhood) : null,
      level: level as Level,
      lean: lean as PoliticalPost['lean'],
      score: row.score,
    });
  }
  return { posts, unclear };
}

/** Parse `?sources=feed,mine`: the known sources named, or all of them when none are. */
export function parseSources(value: string | null | undefined): Source[] {
  const all = Object.keys(SOURCES) as Source[];
  const named = (value ?? '').split(',').filter((name): name is Source => (all as string[]).includes(name));
  return named.length ? named : all;
}

/** Cypher fragment: the source of post `p`, from the groups it was read in (mine wins over open). */
const SOURCE_OF_POST = `OPTIONAL MATCH (p)-[:IN_GROUP]->(g:InterestGroup)
     OPTIONAL MATCH (:User)-[m:MEMBER_OF]->(g)`;
const SOURCE_COLUMN = `CASE WHEN count(g) = 0 THEN 'feed' WHEN count(m) > 0 THEN 'mine' ELSE 'open' END`;

export async function politicsReport(
  query: Query,
  gate: { themes: string[]; minP: number; set: string },
  options: { since: string; now?: number; sources?: Source[] },
) {
  const now = options.now ?? Date.now();
  const sources = options.sources ?? (Object.keys(SOURCES) as Source[]);
  const rows = await query(
    `MATCH (u:User)-[:POSTED]->(p:Post)
     WHERE p.removedAt IS NULL AND p.createdAt >= timestamp($since) AND p.politicsSet = $set
     OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
     ${SOURCE_OF_POST}
     RETURN p.id AS id, p.createdAt AS at, u.id AS authorId, n.id AS hoodId, n.name AS neighborhood,
            p.politicsLevel AS level, p.politicsLevelConfidence AS levelConfidence, p.politicsLean AS lean,
            p.politicsLeanScore AS score, coalesce(p.subject, '') AS subject, p.body AS body,
            coalesce(p.reactions, 0) AS reactions, coalesce(p.commentCount, 0) AS comments,
            ${SOURCE_COLUMN} AS source`,
    { since: options.since, set: gate.set },
  );
  // A post with two FROM_HOOD rows appears once.
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const everything = toPoliticalPosts(plainRows(unique));
  const sourceCounts = Object.fromEntries(
    (Object.keys(SOURCES) as Source[]).map((key) => [
      key,
      everything.posts.filter((post) => post.source === key).length,
    ]),
  ) as Record<Source, number>;
  const posts = everything.posts.filter((post) => sources.includes(post.source));
  const unclear = everything.unclear;
  const postsBySource = await query(
    `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.createdAt >= timestamp($since)
     ${SOURCE_OF_POST}
     WITH p, ${SOURCE_COLUMN} AS source
     RETURN source, count(p) AS n`,
    { since: options.since },
  );
  const allPosts = postsBySource
    .filter((row) => sources.includes(row.source as Source))
    .reduce((total, row) => total + Number(row.n), 0);
  const [{ n: pending }] = await query(
    `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.body IS NOT NULL AND p.createdAt >= timestamp($since)
       AND (p.politicsSet IS NULL OR p.politicsSet <> $set)
       AND EXISTS { MATCH (p)-[a:ABOUT]->(t:Theme) WHERE a.p >= $minP AND list_contains($themes, t.name) }
     RETURN count(p) AS n`,
    { since: options.since, set: gate.set, minP: gate.minP, themes: gate.themes },
  );
  const byId = new Map(unique.map((row) => [String(row.id), row]));
  const summary = summarizePolitics(posts, allPosts, Number(pending), now);
  return {
    ...summary,
    unclear,
    sources: { selected: sources, counts: sourceCounts, names: SOURCES },
    minimums: { hoodPosts: MIN_HOOD_POSTS, hoodAuthors: MIN_HOOD_AUTHORS, alpha: ALPHA },
    // Newest first, without authors: this report describes the community, not individuals.
    posts: posts
      .sort((a, b) => b.at - a.at)
      .slice(0, 1000)
      .map((post) => {
        const row = byId.get(post.id) ?? {};
        const text = String(row.body ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          id: post.id,
          at: new Date(post.at).toISOString(),
          subject: String(row.subject ?? ''),
          body: text.length > 300 ? `${text.slice(0, 300)}…` : text,
          level: post.level,
          lean: post.lean,
          score: post.score,
          source: post.source,
          neighborhood: post.neighborhood,
          comments: Number(row.comments ?? 0),
          reactions: Number(row.reactions ?? 0),
        };
      }),
  };
}
