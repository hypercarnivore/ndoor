/**
 * Built-in graph reports: named Cypher queries over the GraphStore.
 *
 * Reports are data. Each one is a query plus a description, all taking
 * `$limit` (and `$since`, an ISO timestamp, where time matters). `ndoor query`
 * runs arbitrary Cypher for anything not covered here.
 */

import { safeText } from './digest.js';
import type { Row } from './graph.js';

export interface Report {
  description: string;
  cypher: string;
}

/** Hostility at or above this level counts as hostile (matches insights.ts). */
const HOSTILE = 1.5;
/** Theme probability that counts a post as being about a theme. */
const THEME_P = 0.5;

const LIVE_POST = 'p.removedAt IS NULL';

export const REPORTS: Record<string, Report> = {
  influencers: {
    description:
      'People whose posts and comments draw the most reactions and replies (ranked by reactions + 3 x replies; ' +
      'historyRead false means their post history is not read yet, so posts is a lower bound)',
    cypher: `
      MATCH (u:User) WHERE u.kind = 'NEIGHBOR'
      OPTIONAL MATCH (u)-[:POSTED]->(p:Post) WHERE p.createdAt >= timestamp($since)
      WITH u, count(p) AS posts, sum(coalesce(p.reactions, 0)) AS postReactions
      OPTIONAL MATCH (u)-[:COMMENTED]->(c:Comment) WHERE c.createdAt >= timestamp($since)
      WITH u, posts, postReactions, count(c) AS comments, sum(coalesce(c.reactions, 0)) AS commentReactions
      OPTIONAL MATCH (u)-[:COMMENTED]->(:Comment)<-[:REPLY_TO]-(r:Comment)<-[:COMMENTED]-(other:User)
        WHERE other.id <> u.id AND r.createdAt >= timestamp($since)
      WITH u, posts, postReactions, comments, commentReactions, count(r) AS repliesReceived,
           count(DISTINCT other) AS distinctRepliers
      WHERE posts + comments > 0
      OPTIONAL MATCH (u)-[:LIVES_IN]->(n:Neighborhood)
      RETURN u.name AS name, n.name AS neighborhood, posts, comments,
             postReactions + commentReactions AS reactions, repliesReceived, distinctRepliers,
             u.historyFetchedAt IS NOT NULL AS historyRead
      ORDER BY reactions + 3 * repliesReceived DESC LIMIT $limit`,
  },
  topics: {
    description: "Nextdoor's own post topics by volume and average reactions",
    cypher: `
      MATCH (p:Post)-[:TAGGED]->(t:Topic) WHERE p.createdAt >= timestamp($since)
      RETURN t.name AS topic, count(p) AS posts, round(avg(coalesce(p.reactions, 0)), 1) AS avgReactions,
             sum(coalesce(p.commentCount, 0)) AS comments
      ORDER BY posts DESC LIMIT $limit`,
  },
  themes: {
    description: 'Jev community themes (built-in and discovered) by volume, engagement, tone, and hostility',
    cypher: `
      MATCH (p:Post)-[a:ABOUT]->(t:Theme) WHERE a.p >= ${THEME_P} AND p.createdAt >= timestamp($since)
      RETURN t.name AS theme, coalesce(t.source, 'built-in') AS source, count(p) AS posts, round(avg(coalesce(p.reactions, 0)), 1) AS avgReactions,
             round(avg(p.tone) * 100, 0) AS tone,
             round(100.0 * sum(CASE WHEN p.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) / count(p), 0) AS hostilePct
      ORDER BY posts DESC LIMIT $limit`,
  },
  sentiment: {
    description: 'Weekly mood: post volume, mean tone (50 = neutral), and share of hostile posts and comments',
    cypher: `
      MATCH (p:Post) WHERE p.tone IS NOT NULL AND p.createdAt >= timestamp($since)
      WITH date_trunc('week', p.createdAt) AS week, count(p) AS posts, avg(p.tone) AS tone,
           sum(CASE WHEN p.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS hostilePosts
      OPTIONAL MATCH (c:Comment) WHERE c.tone IS NOT NULL AND date_trunc('week', c.createdAt) = week
      RETURN week, posts, round(tone * 100, 0) AS postTone, round(100.0 * hostilePosts / posts, 0) AS hostilePostPct,
             count(c) AS comments,
             round(100.0 * sum(CASE WHEN c.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) / CASE WHEN count(c) = 0 THEN 1 ELSE count(c) END, 0) AS hostileCommentPct
      ORDER BY week DESC LIMIT $limit`,
  },
  neighborhoods: {
    description: 'Neighborhoods by activity, with mood and their most common theme',
    cypher: `
      MATCH (p:Post)-[:FROM_HOOD]->(n:Neighborhood) WHERE p.createdAt >= timestamp($since)
      OPTIONAL MATCH (u:User)-[:POSTED]->(p)
      WITH n, count(DISTINCT p) AS posts, count(DISTINCT u) AS authors, avg(p.tone) AS tone,
           sum(CASE WHEN p.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS hostile,
           sum(coalesce(p.reactions, 0)) AS reactions
      RETURN n.name AS neighborhood, n.city AS city, n.neighbors AS neighbors, posts, authors, reactions,
             round(tone * 100, 0) AS tone, round(100.0 * hostile / posts, 0) AS hostilePct
      ORDER BY posts DESC LIMIT $limit`,
  },
  removed: {
    description: 'Authors whose posts or comments disappeared after ndoor first saw them',
    cypher: `
      MATCH (u:User)
      OPTIONAL MATCH (u)-[:POSTED]->(p:Post) WHERE p.removedAt >= timestamp($since)
      WITH u, count(p) AS removedPosts, max(p.removedAt) AS lastPost
      OPTIONAL MATCH (u)-[:COMMENTED]->(c:Comment) WHERE c.removedAt >= timestamp($since)
      WITH u, removedPosts, count(c) AS removedComments, lastPost, max(c.removedAt) AS lastComment
      WHERE removedPosts + removedComments > 0
      OPTIONAL MATCH (u)-[:POSTED|COMMENTED]->(item) WHERE item.createdAt >= timestamp($since)
      WITH u, removedPosts, removedComments, count(item) AS total,
           CASE WHEN lastPost IS NULL OR lastComment > lastPost THEN lastComment ELSE lastPost END AS lastRemoval
      RETURN u.name AS name, removedPosts + removedComments AS removed, removedPosts, removedComments, total,
             round(100.0 * (removedPosts + removedComments) / CASE WHEN total = 0 THEN 1 ELSE total END, 0) AS removedPct,
             lastRemoval
      ORDER BY removed DESC LIMIT $limit`,
  },
  'removed-items': {
    description: 'The posts and comments that disappeared, newest first, with their last known text',
    cypher: `
      MATCH (u:User)-[:POSTED|COMMENTED]->(x) WHERE x.removedAt IS NOT NULL AND x.removedAt >= timestamp($since)
      RETURN x.removedAt AS removedAt, label(x) AS kind, u.name AS author,
             coalesce(x.subject, '') + ' ' + coalesce(x.body, '') AS text, x.removedReason AS reason
      ORDER BY removedAt DESC LIMIT $limit`,
  },
  businesses: {
    description:
      'Businesses neighbors @mention most: distinct people, and how many mentions Jev judged favorable or unfavorable ' +
      'toward that business (judged counts the mentions `ndoor judge` has covered)',
    cypher: `
      MATCH (u:User)-[:POSTED|COMMENTED]->(x)-[m:MENTIONS_BUSINESS]->(b:Business)
      WHERE x.createdAt >= timestamp($since)
      RETURN b.name AS business, b.category AS category, count(x) AS mentions, count(DISTINCT u) AS people,
             sum(CASE WHEN m.opinion = 'favorable' THEN 1 ELSE 0 END) AS favorable,
             sum(CASE WHEN m.opinion = 'unfavorable' THEN 1 ELSE 0 END) AS unfavorable,
             sum(CASE WHEN m.opinion IS NULL THEN 0 ELSE 1 END) AS judged, b.faves AS faves
      ORDER BY people DESC, mentions DESC LIMIT $limit`,
  },
  conversations: {
    description: 'Who replies to whom most often',
    cypher: `
      MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:REPLY_TO]->(:Comment)<-[:COMMENTED]-(b:User)
      WHERE a.id <> b.id AND c.createdAt >= timestamp($since)
      RETURN a.name AS from, b.name AS to, count(c) AS replies,
             round(avg(c.tone) * 100, 0) AS tone,
             sum(CASE WHEN c.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements
      ORDER BY replies DESC LIMIT $limit`,
  },
  hostile: {
    description: 'The most hostile posts and comments Jev found',
    cypher: `
      MATCH (u:User)-[:POSTED|COMMENTED]->(x) WHERE x.hostility >= ${HOSTILE} AND x.createdAt >= timestamp($since)
      RETURN x.createdAt AS at, label(x) AS kind, u.name AS author, round(x.hostility, 2) AS hostility,
             coalesce(x.subject, '') + ' ' + coalesce(x.body, '') AS text
      ORDER BY hostility DESC LIMIT $limit`,
  },
  'top-posts': {
    description: 'Most reacted-to posts',
    cypher: `
      MATCH (u:User)-[:POSTED]->(p:Post)
      WHERE ${LIVE_POST} AND p.reactions IS NOT NULL AND p.createdAt >= timestamp($since)
      RETURN p.createdAt AS at, u.name AS author, p.reactions AS reactions, p.commentCount AS comments,
             coalesce(p.subject, p.body) AS post, p.url AS url
      ORDER BY reactions DESC LIMIT $limit`,
  },
  coverage: {
    description: 'What the graph holds: node counts, judged share, and sync history',
    cypher: `
      MATCH (s:Sync) RETURN s.startedAt AS startedAt, s.finishedAt AS finishedAt, s.stats AS stats
      ORDER BY startedAt DESC LIMIT $limit`,
  },
};

export function reportNames(): string[] {
  return Object.keys(REPORTS);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.join(', ');
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

/** Render rows as an aligned text table. */
export function formatTable(rows: Row[]): string {
  if (rows.length === 0) return '(no rows)';
  const columns = Object.keys(rows[0]);
  const cells = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = columns.map((column, index) => Math.max(column.length, ...cells.map((r) => r[index].length)));
  const line = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return safeText([line(columns), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n'));
}
