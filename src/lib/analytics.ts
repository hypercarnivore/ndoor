/**
 * Analytics views for the UI's drill-down screens: directories of people,
 * posts, comments, neighborhoods, themes, and groups; what lies behind each
 * community-health signal; and business analytics (sentiment, trends, demand).
 *
 * Read-only queries over the cached graph. Sort orders are whitelisted per
 * view; everything user-supplied travels as a parameter.
 */

import { ExploreError, type Query } from './explore.js';
import type { Row } from './graph.js';
import { UTC, weekOf } from './timezone.js';

const HOSTILE = 1.5;
const THEME_P = 0.5;
/** Recommendation requests: posts about finding a local service that ask a question. */
const RECOMMENDATION_THEME = 'services_recommendations';

/** Milliseconds of a timestamp column; the graph returns Dates. */
const hourMs = (value: unknown) => (value instanceof Date ? value.getTime() : Date.parse(String(value)));

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value === null ? null : value);
const clipText = (value: unknown, max = 280) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Dates as ISO strings, so rows serialize the same in every view. */
export function plainRows(rows: Row[]): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, iso(value)])));
}

function pick<T extends string>(value: string | null | undefined, allowed: Record<T, string>, fallback: T): string {
  return allowed[(value && value in allowed ? value : fallback) as T];
}

// --- directories -------------------------------------------------------------------

const PEOPLE_SORTS = {
  influence: 'reactions + 3 * repliesReceived DESC',
  reactions: 'reactions DESC',
  posts: 'posts DESC',
  comments: 'comments DESC',
  warmest: 'coalesce(tone, -1) DESC',
  coldest: 'coalesce(tone, 2) ASC',
  hostile: 'coalesce(hostileShare, -1) DESC, comments DESC',
  contrarian: 'coalesce(disagreeShare, -1) DESC, comments DESC',
};
export type PeopleSort = keyof typeof PEOPLE_SORTS;

/** Everyone who posted or commented in the period, with activity, reach, and tone. */
export async function people(
  query: Query,
  options: { since: string; sort?: string | null; q?: string; limit: number },
): Promise<Row[]> {
  const rows = await query(
    `MATCH (u:User) WHERE u.kind = 'NEIGHBOR' AND ($q = '' OR lower(u.name) CONTAINS $q)
     OPTIONAL MATCH (u)-[:POSTED]->(p:Post) WHERE p.createdAt >= timestamp($since)
     WITH u, count(p) AS posts, sum(coalesce(p.reactions, 0)) AS postReactions,
          sum(coalesce(p.tone, 0)) AS postTone, sum(CASE WHEN p.tone IS NULL THEN 0 ELSE 1 END) AS postJudged,
          sum(CASE WHEN p.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS postHostile
     OPTIONAL MATCH (u)-[:COMMENTED]->(c:Comment) WHERE c.createdAt >= timestamp($since)
     WITH u, posts, postReactions, postTone, postJudged, postHostile, count(c) AS comments,
          sum(coalesce(c.reactions, 0)) AS commentReactions, sum(coalesce(c.tone, 0)) AS commentTone,
          sum(CASE WHEN c.tone IS NULL THEN 0 ELSE 1 END) AS commentJudged,
          sum(CASE WHEN c.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS commentHostile,
          sum(CASE WHEN c.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements,
          sum(CASE WHEN c.helpful >= 0.5 THEN 1 ELSE 0 END) AS helpful
     WHERE posts + comments > 0
     OPTIONAL MATCH (u)-[:COMMENTED]->(:Comment)<-[:REPLY_TO]-(r:Comment)<-[:COMMENTED]-(o:User)
       WHERE o.id <> u.id AND r.createdAt >= timestamp($since)
     WITH u, posts, comments, postReactions + commentReactions AS reactions, count(r) AS repliesReceived,
          count(DISTINCT o) AS repliers, postTone + commentTone AS toneSum, postJudged + commentJudged AS judged,
          postHostile + commentHostile AS hostile, disagreements, helpful
     OPTIONAL MATCH (u)-[:LIVES_IN]->(n:Neighborhood)
     WITH u, n, posts, comments, reactions, repliesReceived, repliers, helpful,
          CASE WHEN judged = 0 THEN null ELSE toneSum / judged END AS tone,
          CASE WHEN judged = 0 THEN null ELSE 1.0 * hostile / judged END AS hostileShare,
          CASE WHEN comments = 0 THEN null ELSE 1.0 * disagreements / comments END AS disagreeShare
     RETURN u.id AS id, u.name AS name, n.name AS neighborhood, posts, comments, reactions, repliesReceived,
            repliers, helpful, tone, hostileShare, disagreeShare, u.historyFetchedAt IS NOT NULL AS historyRead
     ORDER BY ${pick(options.sort, PEOPLE_SORTS, 'influence')} LIMIT $limit`,
    { since: options.since, q: (options.q ?? '').trim().toLowerCase(), limit: options.limit },
  );
  // A person with two home neighborhoods on record appears once.
  return plainRows([...new Map(rows.map((row) => [row.id, row])).values()]);
}

const POST_SORTS = {
  recent: 'p.createdAt DESC',
  reactions: 'coalesce(p.reactions, -1) DESC',
  comments: 'coalesce(p.commentCount, -1) DESC',
  hostile: 'coalesce(p.hostility, -1) DESC',
  urgent: 'coalesce(p.urgency, -1) DESC',
  warmest: 'coalesce(p.tone, -1) DESC',
  coldest: 'coalesce(p.tone, 2) ASC',
};

export async function posts(
  query: Query,
  options: { since: string; sort?: string | null; q?: string; theme?: string; hood?: string; limit: number },
): Promise<Row[]> {
  const rows = await query(
    `MATCH (u:User)-[:POSTED]->(p:Post)
     WHERE p.removedAt IS NULL AND p.createdAt >= timestamp($since)
       AND ($q = '' OR lower(coalesce(p.subject, '') + ' ' + coalesce(p.body, '')) CONTAINS $q)
       AND ($theme = '' OR EXISTS { MATCH (p)-[a:ABOUT]->(t:Theme) WHERE t.name = $theme AND a.p >= ${THEME_P} })
       AND ($hood = '' OR EXISTS { MATCH (p)-[:FROM_HOOD]->(h:Neighborhood) WHERE h.id = $hood })
     OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
     RETURN p.id AS id, coalesce(p.subject, '') AS subject, p.body AS body, p.createdAt AS at, u.id AS authorId,
            u.name AS author, n.name AS neighborhood, p.reactions AS reactions, p.commentCount AS comments,
            p.tone AS tone, p.hostility AS hostility, p.urgency AS urgency, p.primaryTheme AS theme,
            p.intent AS intent, p.url AS url
     ORDER BY ${pick(options.sort, POST_SORTS, 'recent')} LIMIT $limit`,
    {
      since: options.since,
      q: (options.q ?? '').trim().toLowerCase(),
      theme: options.theme ?? '',
      hood: options.hood ?? '',
      limit: options.limit,
    },
  );
  return plainRows(rows.map((row): Row => ({ ...row, body: clipText(row.body) })));
}

const COMMENT_SORTS = {
  recent: 'c.createdAt DESC',
  reactions: 'coalesce(c.reactions, -1) DESC',
  hostile: 'coalesce(c.hostility, -1) DESC',
  helpful: 'coalesce(c.helpful, -1) DESC',
  coldest: 'coalesce(c.tone, 2) ASC',
};

export async function comments(
  query: Query,
  options: { since: string; sort?: string | null; q?: string; stance?: string; limit: number },
): Promise<{ rows: Row[]; stances: Row[] }> {
  const params = { since: options.since, q: (options.q ?? '').trim().toLowerCase(), stance: options.stance ?? '' };
  const where = `c.createdAt >= timestamp($since) AND c.body IS NOT NULL AND c.body <> ''
       AND ($q = '' OR lower(c.body) CONTAINS $q) AND ($stance = '' OR c.stance = $stance)`;
  const rows = await query(
    `MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:ON_POST]->(p:Post) WHERE ${where}
     RETURN c.id AS id, c.body AS body, c.createdAt AS at, a.id AS authorId, a.name AS author, p.id AS postId,
            coalesce(p.subject, '') AS post, c.reactions AS reactions, c.stance AS stance, c.tone AS tone,
            c.hostility AS hostility, c.helpful AS helpful, c.removedAt IS NOT NULL OR c.isDeleted = true AS removed
     ORDER BY ${pick(options.sort, COMMENT_SORTS, 'recent')} LIMIT $limit`,
    { ...params, limit: options.limit },
  );
  const stances = await query(
    `MATCH (c:Comment) WHERE c.createdAt >= timestamp($since) AND c.stance IS NOT NULL
     RETURN c.stance AS stance, count(c) AS comments, avg(c.tone) AS tone ORDER BY comments DESC`,
    { since: options.since },
  );
  return { rows: plainRows(rows.map((row) => ({ ...row, body: clipText(row.body, 400) }))), stances };
}

export async function neighborhoods(query: Query, since: string): Promise<Row[]> {
  const rows = await query(
    `MATCH (n:Neighborhood)
     OPTIONAL MATCH (p:Post)-[:FROM_HOOD]->(n) WHERE p.createdAt >= timestamp($since)
     WITH n, count(p) AS posts, sum(coalesce(p.reactions, 0)) AS reactions, sum(coalesce(p.commentCount, 0)) AS comments,
          avg(p.tone) AS tone, sum(CASE WHEN p.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS hostile
     OPTIONAL MATCH (u:User)-[:LIVES_IN]->(n)
     WITH n, posts, reactions, comments, tone, hostile, count(u) AS residents
     WHERE posts > 0 OR residents > 0
     RETURN n.id AS id, n.name AS name, n.city AS city, n.neighbors AS neighbors, residents, posts, reactions,
            comments, tone, CASE WHEN posts = 0 THEN null ELSE 1.0 * hostile / posts END AS hostileShare
     ORDER BY posts DESC, residents DESC`,
    { since },
  );
  const themes = await query(
    `MATCH (p:Post)-[:FROM_HOOD]->(n:Neighborhood), (p)-[a:ABOUT]->(t:Theme)
     WHERE a.p >= ${THEME_P} AND p.createdAt >= timestamp($since)
     RETURN n.id AS id, t.name AS theme, count(p) AS posts ORDER BY posts DESC`,
    { since },
  );
  const top = new Map<string, string>();
  for (const row of themes) if (!top.has(String(row.id))) top.set(String(row.id), String(row.theme));
  return plainRows(rows.map((row) => ({ ...row, topTheme: top.get(String(row.id)) ?? null })));
}

/** Themes with volume, engagement, mood, and a weekly series for trend lines. */
export async function themes(query: Query, since: string, zone = UTC): Promise<Row[]> {
  const rows = await query(
    `MATCH (p:Post)-[a:ABOUT]->(t:Theme) WHERE a.p >= ${THEME_P} AND p.createdAt >= timestamp($since)
     RETURN t.name AS name, coalesce(t.source, 'built-in') AS source, t.description AS description,
            count(p) AS posts, avg(coalesce(p.reactions, 0)) AS avgReactions, sum(coalesce(p.commentCount, 0)) AS comments,
            avg(p.tone) AS tone, 1.0 * sum(CASE WHEN p.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) / count(p) AS hostileShare
     ORDER BY posts DESC`,
    { since },
  );
  const weekly = await query(
    `MATCH (p:Post)-[a:ABOUT]->(t:Theme) WHERE a.p >= ${THEME_P} AND p.createdAt >= timestamp($since)
     RETURN t.name AS name, date_trunc('hour', p.createdAt) AS hour, count(p) AS posts`,
    { since },
  );
  // Hourly counts roll up into the viewer's calendar weeks.
  const series = new Map<string, Map<string, number>>();
  for (const row of weekly) {
    const weeks = series.get(String(row.name)) ?? new Map<string, number>();
    const week = weekOf(hourMs(row.hour), zone);
    weeks.set(week, (weeks.get(week) ?? 0) + Number(row.posts));
    series.set(String(row.name), weeks);
  }
  return plainRows(rows).map((row) => ({
    ...row,
    weekly: [...(series.get(String(row.name)) ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, posts]) => ({ week, posts })),
  }));
}

export async function groups(query: Query, since: string): Promise<Row[]> {
  return plainRows(
    await query(
      `MATCH (g:InterestGroup)
       OPTIONAL MATCH (p:Post)-[:IN_GROUP]->(g) WHERE p.createdAt >= timestamp($since)
       WITH g, count(p) AS posts, sum(coalesce(p.reactions, 0)) AS reactions, avg(p.tone) AS tone
       OPTIONAL MATCH (u:User)-[:MEMBER_OF]->(g)
       RETURN g.id AS id, g.name AS name, g.members AS members, count(u) > 0 AS joined, posts, reactions, tone
       ORDER BY posts DESC, members DESC`,
      { since },
    ),
  );
}

// --- health drill-downs -----------------------------------------------------------

export interface DrillSection {
  title: string;
  hint?: string;
  kind: 'items' | 'people' | 'threads' | 'histogram' | 'pairs';
  rows: Row[];
}

async function items(query: Query, where: string, order: string, since: string, limit = 25): Promise<Row[]> {
  // Posts and comments are queried apart (their columns differ) and merged.
  const postRows = await query(
    `MATCH (u:User)-[:POSTED]->(x:Post) WHERE x.createdAt >= timestamp($since) AND ${where}
     RETURN x.id AS id, 'Post' AS kind, coalesce(x.subject, '') AS subject, x.body AS body, x.createdAt AS at,
            x.tone AS tone, x.hostility AS hostility, x.reactions AS reactions, u.id AS authorId, u.name AS author,
            x.id AS postId
     ORDER BY ${order} LIMIT $limit`,
    { since, limit },
  );
  const commentRows = await query(
    `MATCH (u:User)-[:COMMENTED]->(x:Comment)-[:ON_POST]->(p:Post) WHERE x.createdAt >= timestamp($since) AND ${where}
     RETURN x.id AS id, 'Comment' AS kind, coalesce(p.subject, '') AS subject, x.body AS body, x.createdAt AS at,
            x.tone AS tone, x.hostility AS hostility, x.reactions AS reactions, u.id AS authorId, u.name AS author,
            p.id AS postId
     ORDER BY ${order} LIMIT $limit`,
    { since, limit },
  );
  const sortKey = order.split(' ')[0].replace('x.', '');
  const descending = order.includes('DESC');
  return plainRows([...postRows, ...commentRows])
    .map((row): Row => ({ ...row, body: clipText(row.body) }))
    .sort((a, b) => {
      const av = Number(a[sortKey] ?? 0);
      const bv = Number(b[sortKey] ?? 0);
      return descending ? bv - av : av - bv;
    })
    .slice(0, limit);
}

export const DRILL_SIGNALS = ['civility', 'warmth', 'agreement', 'helpfulness'] as const;

/** What lies behind one health signal, as titled sections the UI renders generically. */
export async function healthDrill(query: Query, signal: string, since: string): Promise<DrillSection[]> {
  const params = { since };
  switch (signal) {
    case 'civility':
      return [
        {
          title: 'Most hostile posts and comments',
          kind: 'items',
          rows: await items(query, `x.hostility >= ${HOSTILE}`, 'x.hostility DESC', since),
        },
        {
          title: 'Who writes them',
          hint: 'hostile posts and comments, and their share of everything the person wrote',
          kind: 'people',
          rows: plainRows(
            await query(
              `MATCH (u:User)-[:POSTED|COMMENTED]->(x) WHERE x.createdAt >= timestamp($since) AND x.tone IS NOT NULL
               WITH u, count(x) AS judged, sum(CASE WHEN x.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS hostile
               WHERE hostile > 0
               RETURN u.id AS id, u.name AS name, hostile, judged, 1.0 * hostile / judged AS share
               ORDER BY hostile DESC LIMIT 25`,
              params,
            ),
          ),
        },
      ];
    case 'warmth': {
      const counts = new Map<number, number>();
      for (const label of ['Post', 'Comment']) {
        const rows = await query(
          `MATCH (x:${label}) WHERE x.createdAt >= timestamp($since) AND x.tone IS NOT NULL
           WITH CASE WHEN x.tone >= 1.0 THEN 9 ELSE CAST(floor(x.tone * 10) AS INT64) END AS bin
           RETURN bin, count(*) AS items`,
          params,
        );
        for (const row of rows) counts.set(Number(row.bin), (counts.get(Number(row.bin)) ?? 0) + Number(row.items));
      }
      const bins = Array.from({ length: 10 }, (_, bin) => ({ bin, items: counts.get(bin) ?? 0 }));
      return [
        {
          title: 'Tone of everything written',
          hint: '0 is angry, 50 neutral, 100 enthusiastic',
          kind: 'histogram',
          rows: bins.map((row) => ({ bin: `${Number(row.bin) * 10}-${Number(row.bin) * 10 + 10}`, items: row.items })),
        },
        { title: 'Coldest', kind: 'items', rows: await items(query, 'x.tone IS NOT NULL', 'x.tone ASC', since, 15) },
        { title: 'Warmest', kind: 'items', rows: await items(query, 'x.tone IS NOT NULL', 'x.tone DESC', since, 15) },
      ];
    }
    case 'agreement':
      return [
        {
          title: 'Most contested threads',
          hint: 'posts whose comments disagree most',
          kind: 'threads',
          rows: plainRows(
            await query(
              `MATCH (c:Comment)-[:ON_POST]->(p:Post) WHERE c.createdAt >= timestamp($since) AND c.stance IS NOT NULL
               WITH p, count(c) AS judged, sum(CASE WHEN c.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements
               WHERE disagreements >= 3
               OPTIONAL MATCH (u:User)-[:POSTED]->(p)
               RETURN p.id AS id, coalesce(p.subject, p.body) AS subject, u.name AS author, judged, disagreements,
                      1.0 * disagreements / judged AS share, p.createdAt AS at
               ORDER BY disagreements DESC LIMIT 25`,
              params,
            ),
          ).map((row): Row => ({ ...row, subject: clipText(row.subject, 160) })),
        },
        {
          title: 'Recurring disagreements',
          hint: 'pairs of people who answer each other most, by disagreements',
          kind: 'pairs',
          rows: plainRows(
            await query(
              `MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:REPLY_TO]->(:Comment)<-[:COMMENTED]-(b:User)
               WHERE a.id <> b.id AND c.createdAt >= timestamp($since)
               WITH a, b, count(c) AS replies, sum(CASE WHEN c.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements
               WHERE disagreements >= 2
               RETURN a.id AS fromId, a.name AS from, b.id AS toId, b.name AS to, replies, disagreements
               ORDER BY disagreements DESC LIMIT 25`,
              params,
            ),
          ),
        },
      ];
    case 'helpfulness':
      return [
        {
          title: 'Questions nobody answered helpfully',
          hint: 'where neighbors still need help',
          kind: 'threads',
          rows: plainRows(
            await query(
              `MATCH (p:Post) WHERE p.asksQuestion >= 0.5 AND p.threadFetchedAt IS NOT NULL AND p.createdAt >= timestamp($since)
                 AND NOT EXISTS { MATCH (c:Comment)-[:ON_POST]->(p) WHERE c.helpful >= 0.5 }
               OPTIONAL MATCH (u:User)-[:POSTED]->(p)
               RETURN p.id AS id, coalesce(p.subject, p.body) AS subject, u.name AS author, p.commentCount AS comments,
                      p.createdAt AS at
               ORDER BY p.createdAt DESC LIMIT 40`,
              params,
            ),
          ).map((row): Row => ({ ...row, subject: clipText(row.subject, 160) })),
        },
        {
          title: 'Most helpful neighbors',
          hint: 'comments Jev judged as concrete help',
          kind: 'people',
          rows: plainRows(
            await query(
              `MATCH (u:User)-[:COMMENTED]->(c:Comment) WHERE c.createdAt >= timestamp($since) AND c.helpful IS NOT NULL
               WITH u, count(c) AS judged, sum(CASE WHEN c.helpful >= 0.5 THEN 1 ELSE 0 END) AS helpful
               WHERE helpful > 0
               RETURN u.id AS id, u.name AS name, helpful, judged, 1.0 * helpful / judged AS share
               ORDER BY helpful DESC LIMIT 25`,
              params,
            ),
          ),
        },
      ];
    default:
      throw new ExploreError(404, `Unknown health signal "${signal}"`);
  }
}

// --- businesses ----------------------------------------------------------------------

export const DAY = 86_400_000;

/** Every mentioned business with sentiment counts, net score, and recent momentum. */
export async function businesses(query: Query, options: { since: string; now?: number }): Promise<Row[]> {
  const now = options.now ?? Date.now();
  const rows = await query(
    `MATCH (u:User)-[:POSTED|COMMENTED]->(x)-[m:MENTIONS_BUSINESS]->(b:Business)
     WHERE x.createdAt >= timestamp($since)
     RETURN b.id AS id, b.name AS name, b.category AS category, b.faves AS faves, b.address AS address,
            count(m) AS mentions, count(DISTINCT u) AS people,
            sum(CASE WHEN m.opinion = 'favorable' THEN 1 ELSE 0 END) AS favorable,
            sum(CASE WHEN m.opinion = 'unfavorable' THEN 1 ELSE 0 END) AS unfavorable,
            sum(CASE WHEN m.opinion = 'neutral' THEN 1 ELSE 0 END) AS neutral,
            sum(CASE WHEN x.createdAt >= timestamp($recent) THEN 1 ELSE 0 END) AS last30,
            sum(CASE WHEN x.createdAt >= timestamp($prior) AND x.createdAt < timestamp($recent) THEN 1 ELSE 0 END) AS prior30,
            max(x.createdAt) AS lastMentioned
     ORDER BY people DESC, mentions DESC`,
    {
      since: options.since,
      recent: new Date(now - 30 * DAY).toISOString(),
      prior: new Date(now - 60 * DAY).toISOString(),
    },
  );
  return plainRows(rows).map((row) => {
    const judged = Number(row.favorable) + Number(row.unfavorable) + Number(row.neutral);
    return {
      ...row,
      judged,
      /** -1 (all unfavorable) to 1 (all favorable), over judged mentions. */
      net: judged ? (Number(row.favorable) - Number(row.unfavorable)) / judged : null,
    };
  });
}

/** Headline numbers, category breakdown, weekly trend, standouts, and demand for recommendations. */
export async function businessSummary(query: Query, options: { since: string; now?: number; zone?: string }) {
  const list = await businesses(query, options);
  const sum = (key: string) => list.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const people = await query(
    `MATCH (u:User)-[:POSTED|COMMENTED]->(x)-[:MENTIONS_BUSINESS]->(:Business)
     WHERE x.createdAt >= timestamp($since) RETURN count(DISTINCT u) AS people`,
    { since: options.since },
  );
  const categories = new Map<string, Row>();
  for (const row of list) {
    const name = String(row.category ?? 'Uncategorized');
    const entry = categories.get(name) ?? {
      category: name,
      businesses: 0,
      mentions: 0,
      favorable: 0,
      neutral: 0,
      unfavorable: 0,
    };
    for (const key of ['mentions', 'favorable', 'neutral', 'unfavorable'] as const) {
      entry[key] = Number(entry[key]) + Number(row[key] ?? 0);
    }
    entry.businesses = Number(entry.businesses) + 1;
    categories.set(name, entry);
  }
  const hourly = await query(
    `MATCH (x)-[m:MENTIONS_BUSINESS]->(:Business) WHERE x.createdAt >= timestamp($since)
     RETURN date_trunc('hour', x.createdAt) AS hour, count(m) AS mentions,
            sum(CASE WHEN m.opinion = 'favorable' THEN 1 ELSE 0 END) AS favorable,
            sum(CASE WHEN m.opinion = 'unfavorable' THEN 1 ELSE 0 END) AS unfavorable`,
    { since: options.since },
  );
  // Hourly counts roll up into the viewer's calendar weeks.
  const weeklyTotals = new Map<string, { week: string; mentions: number; favorable: number; unfavorable: number }>();
  for (const row of hourly) {
    const week = weekOf(hourMs(row.hour), options.zone);
    const entry = weeklyTotals.get(week) ?? { week, mentions: 0, favorable: 0, unfavorable: 0 };
    entry.mentions += Number(row.mentions);
    entry.favorable += Number(row.favorable);
    entry.unfavorable += Number(row.unfavorable);
    weeklyTotals.set(week, entry);
  }
  const weekly = [...weeklyTotals.values()].sort((a, b) => a.week.localeCompare(b.week));
  const judgedEnough = list.filter((row) => Number(row.judged) >= 3);
  const share = (row: Row, key: string) => Number(row[key]) / Number(row.judged);
  return {
    kpis: {
      businesses: list.length,
      mentions: sum('mentions'),
      people: Number(people[0]?.people ?? 0),
      favorable: sum('favorable'),
      neutral: sum('neutral'),
      unfavorable: sum('unfavorable'),
      judged: sum('judged'),
    },
    /** Businesses get a category once sync has read their profile (most mentioned first). */
    categories: [...categories.values()]
      .filter((row) => row.category !== 'Uncategorized')
      .sort((a, b) => Number(b.mentions) - Number(a.mentions)),
    uncategorized: Number(categories.get('Uncategorized')?.businesses ?? 0),
    weekly,
    loved: [...judgedEnough]
      .filter((row) => share(row, 'favorable') >= 0.6)
      .sort((a, b) => share(b, 'favorable') - share(a, 'favorable') || Number(b.favorable) - Number(a.favorable))
      .slice(0, 12),
    attention: [...judgedEnough]
      .filter((row) => share(row, 'unfavorable') >= 0.3)
      .sort(
        (a, b) => Number(b.unfavorable) - Number(a.unfavorable) || share(b, 'unfavorable') - share(a, 'unfavorable'),
      )
      .slice(0, 12),
    rising: [...list]
      .filter((row) => Number(row.last30) >= 2 && Number(row.last30) > Number(row.prior30))
      .sort((a, b) => Number(b.last30) - Number(b.prior30) - (Number(a.last30) - Number(a.prior30)))
      .slice(0, 12),
    demand: await recommendationDemand(query, options.since),
  };
}

/** Requests for a local business or service, and whether anyone named one in reply. */
export async function recommendationDemand(query: Query, since: string) {
  const rows = plainRows(
    await query(
      `MATCH (p:Post)-[a:ABOUT]->(:Theme {name: $theme})
       WHERE a.p >= ${THEME_P} AND p.asksQuestion >= 0.5 AND p.createdAt >= timestamp($since)
       OPTIONAL MATCH (u:User)-[:POSTED]->(p)
       OPTIONAL MATCH (c:Comment)-[:ON_POST]->(p)
       OPTIONAL MATCH (c)-[:MENTIONS_BUSINESS]->(b:Business)
       RETURN p.id AS id, coalesce(p.subject, p.body) AS subject, u.name AS author, p.createdAt AS at,
              p.commentCount AS comments, count(DISTINCT b) AS businessesSuggested,
              p.threadFetchedAt IS NOT NULL AS threadLoaded
       ORDER BY at DESC LIMIT 300`,
      { since, theme: RECOMMENDATION_THEME },
    ),
  ).map((row): Row => ({ ...row, subject: clipText(row.subject, 160) }));
  const loaded = rows.filter((row) => row.threadLoaded);
  return {
    requests: rows.length,
    /** Requests whose replies (as loaded) named at least one business. */
    answered: loaded.filter((row) => Number(row.businessesSuggested) > 0).length,
    loaded: loaded.length,
    unanswered: loaded.filter((row) => Number(row.businessesSuggested) === 0).slice(0, 25),
    recent: rows.slice(0, 25),
  };
}

/** One business: its numbers, opinion trend, every mention, peers in its category, and its own posts. */
export async function businessDetail(
  query: Query,
  id: string,
  options: { since: string; now?: number; zone?: string },
) {
  const [business] = await query('MATCH (b:Business {id: $id}) RETURN b', { id });
  if (!business) throw new ExploreError(404, `Business ${id} is not in the graph`);
  const props = Object.fromEntries(
    Object.entries(business.b as Row)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, value]) => [key, iso(value)]),
  );
  const all = await businesses(query, options);
  const self = all.find((row) => row.id === id) ?? null;
  const category = props.category ?? null;
  // Without a category there is nothing to compare against (uncategorized is not a category).
  const peers = (category ? all.filter((row) => row.category === category) : []).map((row, index) => ({
    ...row,
    rank: index + 1,
    self: row.id === id,
  }));
  const mentions = plainRows(
    [
      ...(await query(
        `MATCH (u:User)-[:COMMENTED]->(x:Comment)-[m:MENTIONS_BUSINESS]->(:Business {id: $id})
         WHERE x.createdAt >= timestamp($since)
         OPTIONAL MATCH (x)-[:ON_POST]->(p:Post)
         RETURN x.id AS id, 'Comment' AS kind, x.body AS text, x.createdAt AS at, u.id AS authorId, u.name AS author,
                m.opinion AS opinion, m.opinionConfidence AS confidence, x.reactions AS reactions, p.id AS postId,
                coalesce(p.subject, '') AS post`,
        { id, since: options.since },
      )),
      ...(await query(
        `MATCH (u:User)-[:POSTED]->(x:Post)-[m:MENTIONS_BUSINESS]->(:Business {id: $id})
         WHERE x.createdAt >= timestamp($since)
         RETURN x.id AS id, 'Post' AS kind, x.body AS text, x.createdAt AS at, u.id AS authorId, u.name AS author,
                m.opinion AS opinion, m.opinionConfidence AS confidence, x.reactions AS reactions, x.id AS postId,
                coalesce(x.subject, '') AS post`,
        { id, since: options.since },
      )),
    ].sort((a, b) => String(iso(b.at)).localeCompare(String(iso(a.at)))),
  ).map((row): Row => ({ ...row, text: clipText(row.text, 500) }));
  const weekly = new Map<string, Row>();
  for (const row of mentions) {
    const week = weekOf(Date.parse(String(row.at)), options.zone);
    const entry = weekly.get(week) ?? { week, favorable: 0, neutral: 0, unfavorable: 0, unjudged: 0 };
    const key = typeof row.opinion === 'string' ? row.opinion : 'unjudged';
    entry[key] = Number(entry[key] ?? 0) + 1;
    weekly.set(week, entry);
  }
  const ownPosts = plainRows(
    await query(
      `MATCH (u:User)-[:IS_PAGE]->(:Business {id: $id}), (u)-[:POSTED]->(p:Post)
       WHERE p.createdAt >= timestamp($since)
       RETURN p.id AS id, coalesce(p.subject, p.body) AS subject, p.createdAt AS at, p.reactions AS reactions,
              p.commentCount AS comments, p.tone AS tone
       ORDER BY at DESC LIMIT 25`,
      { id, since: options.since },
    ),
  ).map((row): Row => ({ ...row, subject: clipText(row.subject, 160) }));
  return {
    business: props,
    metrics: self,
    weekly: [...weekly.values()].sort((a, b) => String(a.week).localeCompare(String(b.week))),
    mentions,
    peers,
    ownPosts,
  };
}

// --- topic screens (crime and safety, schools and education, ...) --------------------

/**
 * A topic screen: posts Jev judged to be about any of `themes`, broken down
 * into kinds by keyword. Kinds are a quick, transparent first cut (plain word
 * matching on the post text), not a model judgment; a post can be several kinds.
 */
export interface TopicSpec {
  title: string;
  themes: string[];
  kinds: Record<string, string[]>;
  /**
   * Posts left out of the topic: those about any of these themes or matching
   * these keyword kinds, unless they also match one of the `keepIf` kinds (a
   * missing-person alert that mentions the sheriff is still a missing person).
   */
  exclude?: { reason: string; themes: string[]; kinds: Record<string, string[]>; keepIf: string[] };
}

export const TOPICS: Record<string, TopicSpec> = {
  safety: {
    title: 'Crime and safety',
    themes: ['crime_safety'],
    kinds: {
      'Theft and break-ins': [
        'theft*',
        'thief',
        'thieves',
        'stolen',
        'steal*',
        'break-in*',
        'broke into',
        'burglar*',
        'robbery',
        'robbed',
        'robber*',
        'shoplift*',
        'package theft',
        'porch pirate*',
      ],
      Vehicles: [
        'catalytic',
        'stolen car*',
        'stolen truck*',
        'license plate*',
        'hit and run',
        'car was',
        'cars were',
        'truck was',
      ],
      'Scams and fraud': ['scam*', 'fraud*', 'phishing', 'impersonat*', 'gift card*', 'fake'],
      'Suspicious activity': [
        'suspicious',
        'prowler',
        'prowling',
        'knocking on doors',
        'trespass*',
        'lurking',
        'casing',
        'strange man',
        'strange woman',
        'checking mail*',
        'mailbox',
        'slow-moving',
        'slow moving',
      ],
      'Violence and threats': [
        'assault*',
        'gun',
        'gunshot*',
        'gunfire',
        'shots fired',
        'shooting',
        'shooter',
        'weapon',
        'threat*',
        'fight',
        'attack*',
        'stabb*',
        'domestic violence',
        'abuse*',
      ],
      Drugs: ['drug', 'meth', 'fentanyl', 'needle', 'overdos*'],
      Fire: ['fire', 'arson*', 'burning'],
      'Police and sheriff activity': [
        'sheriff*',
        'police',
        'deputy',
        'deputies',
        'officer',
        '911',
        'arrest*',
        'patrol*',
      ],
      'Dangerous driving': [
        'crash*',
        'accident',
        'collision',
        'racing',
        'speeding',
        'reckless*',
        'dirt bike',
        'drunk driv*',
        'high speed',
      ],
      'Wildlife encounters': ['bear', 'cougar', 'mountain lion', 'coyote', 'wolf', 'wolves'],
    },
    exclude: {
      reason: 'lost or found pets and items, missing persons, and online or phone safety tips',
      keepIf: ['Theft and break-ins', 'Scams and fraud', 'Suspicious activity', 'Violence and threats', 'Drugs'],
      themes: ['lost_found_pet', 'lost_found_item'],
      kinds: {
        'Lost and found': ['lost', 'loose', 'found', 'kitty', 'cat', 'dog', 'pet', 'be on the lookout'],
        'Missing persons': ['missing', 'search and rescue', 'silver alert', 'home safe', 'found safe', 'have you seen'],
        'Online and phone safety': [
          'usb',
          'wi-fi',
          'wifi',
          'email*',
          'hack*',
          'password*',
          'spam*',
          'remotely',
          'computer*',
          'phone call',
          'online',
        ],
      },
    },
  },
  schools: {
    title: 'Schools and education',
    themes: ['schools_youth'],
    kinds: {
      'School board and funding': [
        'school board',
        'levy',
        'levies',
        'bond',
        'budget*',
        'superintendent',
        'district',
        'funding',
      ],
      'Getting to school': ['bus', 'drop-off', 'drop off', 'pickup', 'pick up', 'crosswalk', 'school zone'],
      'Sports and activities': [
        'game',
        'team',
        'sport*',
        'football',
        'soccer',
        'basketball',
        'baseball',
        'band',
        'theater',
        'theatre',
        'club',
        'tournament',
        'robotics',
        'gymnast*',
      ],
      'Safety at school': ['lockdown', 'threat*', 'bully', 'bullying', 'resource officer'],
      'Childcare and early learning': [
        'daycare',
        'day care',
        'nursery',
        'preschool',
        'childcare',
        'child care',
        'nanny',
        'babysit*',
        'early learning',
        'early education',
        'pre-k',
        'after school',
      ],
      'Foster care and youth programs': ['foster*', 'youth', 'teen*', 'coalition', 'mentor*', 'scout*'],
      'Back to school': ['back to school', 'school supplies', 'first day of school', 'school year'],
      'College and adult learning': ['college', 'university', 'class', 'course', 'scholarship*', 'tutor*', 'library'],
      'Events and achievements': [
        'graduat*',
        'award*',
        'honor*',
        'celebrat*',
        'congratulat*',
        'fundrais*',
        'student of',
        'trunk or treat',
        'halloween',
      ],
    },
  },
};

/** Below this confidence, Jev's local placement is not used to pick a neighborhood. */
export const MIN_PLACE_CONFIDENCE = 0.5;

/** Where a topic post's situation is, as shown on topic screens. */
export const PLACE_BUCKETS = [
  { key: 'neighborhood', name: 'In a known neighborhood' },
  { key: 'elsewhere', name: 'Elsewhere locally, place not identified' },
  { key: 'outside', name: 'Outside the area' },
  { key: 'general', name: 'General advice or news, no specific place' },
  { key: 'unclear', name: 'Place unclear' },
  { key: 'unjudged', name: 'Not judged yet' },
] as const;

/**
 * Attribute a post to the place it is about. Jev's place judgment decides the
 * kind of place; a neighborhood named in the text decides which one when the
 * incident is elsewhere locally. Only "own neighborhood" falls back to the
 * poster's home neighborhood.
 */
export function placeOf(
  post: Row,
  named: Row[],
): { placeBucket: string; placeHoodId: string | null; placeName: string | null } {
  const home = post.hoodId ? String(post.hoodId) : null;
  // A doubtful local judgment must not land on anyone's neighborhood, least of all the poster's own.
  const local = post.placeScope === 'own_neighborhood' || post.placeScope === 'elsewhere_local';
  if (local && typeof post.placeConfidence === 'number' && post.placeConfidence < MIN_PLACE_CONFIDENCE) {
    return { placeBucket: 'unclear', placeHoodId: null, placeName: null };
  }
  switch (post.placeScope) {
    case 'own_neighborhood':
      return home
        ? { placeBucket: 'neighborhood', placeHoodId: home, placeName: String(post.neighborhood ?? '') }
        : { placeBucket: 'elsewhere', placeHoodId: null, placeName: null };
    case 'elsewhere_local': {
      const others = named.filter((hood) => String(hood.id) !== home);
      return others.length === 1
        ? { placeBucket: 'neighborhood', placeHoodId: String(others[0].id), placeName: String(others[0].name) }
        : { placeBucket: 'elsewhere', placeHoodId: null, placeName: null };
    }
    case 'outside_area':
      return { placeBucket: 'outside', placeHoodId: null, placeName: null };
    case 'general':
      return { placeBucket: 'general', placeHoodId: null, placeName: null };
    default:
      return { placeBucket: 'unjudged', placeHoodId: null, placeName: null };
  }
}

/** Every theme some topic screen covers; sync places their posts (see PLACE_QUESTIONS). */
export const TOPIC_THEMES = [...new Set(Object.values(TOPICS).flatMap((spec) => spec.themes))];

/** Nextdoor's "<name> just joined <neighborhood>." announcements, which say nothing about any topic. */
export function isJoinAnnouncement(text: string): boolean {
  return /^[^.!?\n]{1,80} just joined [^.!?\n]{1,80}\.?$/.test(text.trim());
}

/**
 * A keyword as a pattern. Plain keywords match whole words (with a plural s or
 * es), so "gun" does not match "gunsmith" and "cat" does not match "catalytic";
 * a trailing * makes a stem ("scam*" matches "scammer").
 */
const keywordPatterns = new Map<string, RegExp>();
function keywordPattern(keyword: string): RegExp {
  let pattern = keywordPatterns.get(keyword);
  if (!pattern) {
    const stem = keyword.endsWith('*');
    const word = (stem ? keyword.slice(0, -1) : keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`(^|[^a-z0-9])${word}${stem ? '' : '(s|es)?(?![a-z0-9])'}`);
    keywordPatterns.set(keyword, pattern);
  }
  return pattern;
}

/** Kinds whose keywords appear in the text (case-insensitive). */
export function kindsOf(text: string, kinds: Record<string, string[]>): string[] {
  const lower = text.toLowerCase();
  return Object.entries(kinds)
    .filter(([, words]) => words.some((word) => keywordPattern(word).test(lower)))
    .map(([kind]) => kind);
}

export async function topicReport(query: Query, key: string, options: { since: string; now?: number; zone?: string }) {
  const spec = TOPICS[key];
  if (!spec) throw new ExploreError(404, `Unknown topic "${key}"`);
  const now = options.now ?? Date.now();
  const params = { since: options.since, themes: spec.themes };
  const rows = await query(
    `MATCH (u:User)-[:POSTED]->(p:Post)
     WHERE p.removedAt IS NULL AND p.createdAt >= timestamp($since)
       AND EXISTS { MATCH (p)-[a:ABOUT]->(t:Theme) WHERE a.p >= ${THEME_P} AND list_contains($themes, t.name) }
     OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
     RETURN p.id AS id, coalesce(p.subject, '') AS subject, p.body AS body, p.createdAt AS at, u.id AS authorId,
            u.name AS author, u.kind AS authorKind, n.id AS hoodId, n.name AS neighborhood,
            coalesce(p.reactions, 0) AS reactions, coalesce(p.commentCount, 0) AS comments, p.tone AS tone,
            p.hostility AS hostility, p.urgency AS urgency, p.accuses AS accuses, p.placeScope AS placeScope, p.placeScopeConfidence AS placeConfidence,
            EXISTS { MATCH (p)-[x:ABOUT]->(e:Theme) WHERE x.p >= ${THEME_P} AND list_contains($excludeThemes, e.name) }
              AS excludedTheme
     ORDER BY p.createdAt DESC`,
    { ...params, excludeThemes: spec.exclude?.themes ?? [] },
  );
  // A post with two FROM_HOOD rows appears once.
  const candidates = [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter((row) => !isJoinAnnouncement(String(row.body ?? row.subject ?? '')))
    .map((row): Row => {
      const text = `${String(row.subject ?? '')} ${String(row.body ?? '')}`;
      const kinds = kindsOf(text, spec.kinds);
      // Off-topic for this screen unless the post is also about one of the kinds that keep it.
      const off =
        Boolean(spec.exclude) &&
        !kinds.some((kind) => spec.exclude?.keepIf.includes(kind)) &&
        (row.excludedTheme === true || kindsOf(text, spec.exclude?.kinds ?? {}).length > 0);
      return { ...plainRows([row])[0], body: clipText(row.body, 300), kinds, off };
    });
  const known = await query(
    'MATCH (n:Neighborhood) WHERE size(n.name) >= 4 RETURN n.id AS id, n.name AS name, n.neighbors AS members',
  );
  const matchers = known.map((hood) => ({
    hood,
    pattern: new RegExp(
      `(^|[^a-z0-9])${String(hood.name)
        .toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`,
    ),
  }));
  const posts = candidates
    .filter((row) => !row.off)
    .map(({ off: _off, excludedTheme: _theme, ...row }): Row => {
      const text = `${String(row.subject ?? '')} ${String(row.body ?? '')}`.toLowerCase();
      const named = matchers.filter((m) => m.pattern.test(text)).map((m) => m.hood);
      return { ...row, ...placeOf(row, named) };
    });
  const excluded = candidates.length - posts.length;
  const all = await query(
    `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.createdAt >= timestamp($since)
     OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
     RETURN date_trunc('hour', p.createdAt) AS hour, n.id AS hoodId, n.name AS neighborhood, n.neighbors AS members,
            count(DISTINCT p) AS posts`,
    { since: options.since },
  );

  const at = (row: Row) => Date.parse(String(row.at));
  const last30 = posts.filter((row) => at(row) >= now - 30 * DAY).length;
  const prior30 = posts.filter((row) => at(row) >= now - 60 * DAY && at(row) < now - 30 * DAY).length;
  const allPosts = all.reduce((total, row) => total + Number(row.posts), 0);
  const judged = posts.filter((row) => typeof row.tone === 'number');

  const weeks = new Map<string, { week: string; posts: number; all: number }>();
  for (const row of all) {
    const week = weekOf(hourMs(row.hour), options.zone);
    const entry = weeks.get(week) ?? { week, posts: 0, all: 0 };
    entry.all += Number(row.posts);
    weeks.set(week, entry);
  }
  for (const row of posts) {
    const week = weekOf(at(row), options.zone);
    const entry = weeks.get(week) ?? { week, posts: 0, all: 0 };
    entry.posts += 1;
    weeks.set(week, entry);
  }

  const hoods = new Map<string, Row>();
  for (const row of all) {
    if (!row.hoodId) continue;
    const id = String(row.hoodId);
    const entry = hoods.get(id) ?? {
      id,
      name: row.neighborhood,
      members: row.members,
      all: 0,
      posts: 0,
      toneSum: 0,
      judged: 0,
    };
    entry.all = Number(entry.all) + Number(row.posts);
    hoods.set(id, entry);
  }
  for (const row of posts) {
    if (!row.hoodId) continue;
    const entry = hoods.get(String(row.hoodId));
    if (!entry) continue;
    entry.posts = Number(entry.posts) + 1;
    if (typeof row.tone === 'number') {
      entry.toneSum = Number(entry.toneSum) + row.tone;
      entry.judged = Number(entry.judged) + 1;
    }
  }

  // Where things happened, as opposed to where the people posting about them live.
  const incidentHoods = new Map<string, Row>();
  for (const row of posts) {
    if (row.placeBucket !== 'neighborhood' || !row.placeHoodId) continue;
    const id = String(row.placeHoodId);
    const members = known.find((hood) => hood.id === id)?.members ?? null;
    const entry = incidentHoods.get(id) ?? { id, name: row.placeName, members, posts: 0, toneSum: 0, judged: 0 };
    entry.posts = Number(entry.posts) + 1;
    if (typeof row.tone === 'number') {
      entry.toneSum = Number(entry.toneSum) + row.tone;
      entry.judged = Number(entry.judged) + 1;
    }
    incidentHoods.set(id, entry);
  }
  const buckets = new Map<string, number>(PLACE_BUCKETS.map((bucket) => [bucket.key, 0]));
  for (const row of posts) buckets.set(String(row.placeBucket), (buckets.get(String(row.placeBucket)) ?? 0) + 1);

  const kindCounts = Object.keys(spec.kinds).map((kind) => ({
    kind,
    posts: posts.filter((row) => (row.kinds as string[]).includes(kind)).length,
  }));
  const sourceOf = (kind: unknown) =>
    kind === 'CITY_AGENCY' ? 'Agencies' : kind === 'ENTITY_PAGES' ? 'Businesses and pages' : 'Neighbors';
  const sources = new Map<string, number>();
  const accounts = new Map<string, Row>();
  for (const row of posts) {
    const source = sourceOf(row.authorKind);
    sources.set(source, (sources.get(source) ?? 0) + 1);
    const entry = accounts.get(String(row.authorId)) ?? { id: row.authorId, name: row.author, source, posts: 0 };
    entry.posts = Number(entry.posts) + 1;
    accounts.set(String(row.authorId), entry);
  }

  return {
    key,
    title: spec.title,
    themes: spec.themes,
    kinds: Object.keys(spec.kinds),
    kpis: {
      posts: posts.length,
      share: allPosts ? posts.length / allPosts : null,
      last30,
      prior30,
      urgent: posts.filter((row) => Number(row.urgency ?? 0) >= 2).length,
      fromAgencies: posts.filter((row) => row.authorKind === 'CITY_AGENCY').length,
      tone: judged.length ? judged.reduce((total, row) => total + Number(row.tone), 0) / judged.length : null,
      comments: posts.reduce((total, row) => total + Number(row.comments), 0),
      excluded,
      /** Posts about a specific incident in the local area (in a known neighborhood or not). */
      local: (buckets.get('neighborhood') ?? 0) + (buckets.get('elsewhere') ?? 0),
    },
    excludedReason: spec.exclude?.reason ?? null,
    weekly: [...weeks.values()]
      .sort((a, b) => a.week.localeCompare(b.week))
      .map((row) => ({ ...row, share: row.all ? row.posts / row.all : 0 })),
    kindCounts: [
      ...kindCounts,
      { kind: 'Other', posts: posts.filter((row) => (row.kinds as string[]).length === 0).length },
    ],
    neighborhoods: [...hoods.values()]
      .filter((row) => Number(row.posts) > 0)
      .map((row) => ({
        id: row.id,
        name: row.name,
        members: row.members,
        posts: row.posts,
        allPosts: row.all,
        share: Number(row.all) ? Number(row.posts) / Number(row.all) : null,
        perThousand: row.members ? (1000 * Number(row.posts)) / Number(row.members) : null,
        tone: Number(row.judged) ? Number(row.toneSum) / Number(row.judged) : null,
      }))
      .sort((a, b) => Number(b.posts) - Number(a.posts)),
    placeBuckets: PLACE_BUCKETS.map((bucket) => ({ ...bucket, posts: buckets.get(bucket.key) ?? 0 })),
    /** Neighborhoods by where incidents happened. */
    incidentNeighborhoods: [...incidentHoods.values()]
      .map(
        (row): Row => ({
          id: row.id,
          name: row.name,
          members: row.members,
          posts: row.posts,
          perThousand: row.members ? (1000 * Number(row.posts)) / Number(row.members) : null,
          tone: Number(row.judged) ? Number(row.toneSum) / Number(row.judged) : null,
        }),
      )
      .sort((a, b) => Number(b.posts) - Number(a.posts)),
    sources: [...sources.entries()].map(([source, count]) => ({ source, posts: count })),
    accounts: [...accounts.values()].sort((a, b) => Number(b.posts) - Number(a.posts)).slice(0, 15),
    mostDiscussed: [...posts].sort((a, b) => Number(b.comments) - Number(a.comments)).slice(0, 10),
    posts,
  };
}

// --- new neighbors ----------------------------------------------------------------------

/** Longest series the fill helpers produce, whatever the data says (about 100 years of weeks). */
const MAX_POINTS = 5300;

/** Every week from the first one with data through the current week, zeros included, so time axes stay true. */
export function fillWeeks(counts: Map<string, number>, now: number, zone = UTC): Array<[string, number]> {
  const first = [...counts.keys()].filter((week) => !Number.isNaN(Date.parse(`${week}T00:00:00Z`))).sort()[0];
  if (!first) return [];
  const last = weekOf(now, zone);
  const out: Array<[string, number]> = [];
  // Weeks are calendar dates, so step through them as dates: no instant is right in every zone.
  for (let at = Date.parse(`${first}T00:00:00Z`); out.length < MAX_POINTS; at += 7 * DAY) {
    const week = new Date(at).toISOString().slice(0, 10);
    if (week > last) break;
    out.push([week, counts.get(week) ?? 0]);
  }
  return out;
}

/** Plausible move-in years; profiles are Nextdoor data and can hold anything. */
export const FIRST_YEAR = 1950;

/** Every year between the first and last with data, zeros included, ignoring years outside FIRST_YEAR..this year. */
export function fillYears(rows: Row[], now = Date.now()): Row[] {
  const last = new Date(now).getUTCFullYear();
  const counts = new Map(
    rows
      .map((row) => [Number(row.year), Number(row.residents)] as const)
      .filter(([year]) => Number.isInteger(year) && year >= FIRST_YEAR && year <= last),
  );
  if (counts.size === 0) return [];
  const years = [...counts.keys()];
  const out: Row[] = [];
  for (let year = Math.min(...years); year <= Math.max(...years); year += 1) {
    out.push({ year, residents: counts.get(year) ?? 0 });
  }
  return out;
}

/** Pull the name and neighborhood out of "<name> just joined <neighborhood>." */
export function parseJoin(text: string): { name: string; neighborhood: string } | null {
  const match = text.trim().match(/^([^.!?\n]{1,80}) just joined ([^.!?\n]{1,80})\.?$/);
  return match ? { name: match[1].trim(), neighborhood: match[2].trim() } : null;
}

/**
 * People joining Nextdoor nearby, from the "just joined" announcements in the
 * feeds ndoor has read, plus the year residents say they moved in (from the
 * profiles sync has read). A join is someone joining the online community; it
 * often, but not always, means someone moved in.
 */
export async function newcomers(query: Query, options: { since: string; now?: number; zone?: string }) {
  const now = options.now ?? Date.now();
  const rows = await query(
    `MATCH (u:User)-[:POSTED]->(p:Post)
     WHERE p.createdAt >= timestamp($since) AND p.body CONTAINS ' just joined '
     OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
     RETURN p.id AS id, p.body AS body, p.createdAt AS at, u.id AS userId, n.id AS hoodId, n.name AS hoodName,
            n.neighbors AS members
     ORDER BY p.createdAt DESC`,
    { since: options.since },
  );
  const joins = plainRows([...new Map(rows.map((row) => [row.id, row])).values()])
    .map((row) => ({ row, parsed: parseJoin(String(row.body ?? '')) }))
    .filter(({ parsed }) => parsed !== null)
    .map(({ row, parsed }) => ({
      id: row.id,
      at: row.at,
      userId: row.userId,
      name: parsed!.name,
      hoodId: row.hoodId ?? null,
      neighborhood: (row.hoodName as string | null) ?? parsed!.neighborhood,
      members: row.members ?? null,
    }));
  const at = (row: { at: unknown }) => Date.parse(String(row.at));
  const weeks = new Map<string, number>();
  for (const row of joins) {
    const week = weekOf(at(row), options.zone);
    weeks.set(week, (weeks.get(week) ?? 0) + 1);
  }
  const hoods = new Map<string, Row>();
  for (const row of joins) {
    const key = String(row.neighborhood);
    const entry = hoods.get(key) ?? {
      id: row.hoodId,
      name: row.neighborhood,
      members: row.members,
      joins: 0,
      latest: row.at,
    };
    entry.joins = Number(entry.joins) + 1;
    hoods.set(key, entry);
  }
  const years = await query(
    `MATCH (u:User) WHERE u.residentSince >= $first AND u.residentSince <= $last
     RETURN u.residentSince AS year, count(u) AS residents ORDER BY year`,
    { first: FIRST_YEAR, last: new Date(now).getUTCFullYear() },
  );
  return {
    kpis: {
      joins: joins.length,
      last30: joins.filter((row) => at(row) >= now - 30 * DAY).length,
      prior30: joins.filter((row) => at(row) >= now - 60 * DAY && at(row) < now - 30 * DAY).length,
      neighborhoods: hoods.size,
      residentsWithYear: years.reduce((total, row) => total + Number(row.residents), 0),
    },
    weekly: fillWeeks(weeks, now, options.zone).map(([week, count]) => ({ week, joins: count })),
    neighborhoods: [...hoods.values()]
      .map(
        (row): Row => ({
          ...row,
          perThousand: row.members ? (1000 * Number(row.joins)) / Number(row.members) : null,
        }),
      )
      .sort((a, b) => Number(b.joins) - Number(a.joins)),
    residentSince: fillYears(years, now),
    recent: joins.slice(0, 100),
  };
}

// --- mood over time -------------------------------------------------------------------------

/**
 * Weekly mood for the dashboard: post volume, mean tone (0 to 100, 50 neutral), and the share of hostile
 * posts and comments, newest week first. Weeks are the viewer's calendar weeks, so a Sunday-evening post
 * never lands in a bar dated tomorrow.
 */
export async function mood(query: Query, options: { since: string; weeks: number; zone?: string }): Promise<Row[]> {
  const zone = options.zone ?? UTC;
  const hostile = `sum(CASE WHEN x.hostility >= ${HOSTILE} THEN 1 ELSE 0 END)`;
  const posts = await query(
    `MATCH (x:Post) WHERE x.tone IS NOT NULL AND x.createdAt >= timestamp($since)
     RETURN date_trunc('hour', x.createdAt) AS hour, count(x) AS n, sum(x.tone) AS tone, ${hostile} AS hostile`,
    { since: options.since },
  );
  const comments = await query(
    `MATCH (x:Comment) WHERE x.tone IS NOT NULL
     RETURN date_trunc('hour', x.createdAt) AS hour, count(x) AS n, ${hostile} AS hostile`,
  );
  const weeks = new Map<
    string,
    { posts: number; tone: number; hostilePosts: number; comments: number; hostileComments: number }
  >();
  for (const row of posts) {
    const week = weekOf(hourMs(row.hour), zone);
    const entry = weeks.get(week) ?? { posts: 0, tone: 0, hostilePosts: 0, comments: 0, hostileComments: 0 };
    entry.posts += Number(row.n);
    entry.tone += Number(row.tone);
    entry.hostilePosts += Number(row.hostile);
    weeks.set(week, entry);
  }
  for (const row of comments) {
    const entry = weeks.get(weekOf(hourMs(row.hour), zone));
    if (!entry) continue;
    entry.comments += Number(row.n);
    entry.hostileComments += Number(row.hostile);
  }
  return [...weeks]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, options.weeks)
    .map(([week, entry]) => ({
      week,
      posts: entry.posts,
      postTone: Math.round((entry.tone / entry.posts) * 100),
      hostilePostPct: Math.round((100 * entry.hostilePosts) / entry.posts),
      comments: entry.comments,
      hostileCommentPct: Math.round((100 * entry.hostileComments) / Math.max(entry.comments, 1)),
    }));
}
