/**
 * Watches: standing questions over the graph ("new crime posts in my
 * neighborhood", "someone replied to me"), checked against content first seen
 * since the last check. Rules are data in ~/.config/ndoor/watches.json5; this
 * module turns each rule into one Cypher query and reports matches.
 *
 * Typical schedule: `ndoor sync --preset quick --analyze && ndoor watch check --notify`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';
import type { Row } from './graph.js';
import { THEMES } from './jev.js';

const PostWatch = z
  .object({
    name: z.string().min(1),
    /** Any of these words or phrases in the subject or body (case-insensitive). */
    keywords: z.array(z.string().min(1)).optional(),
    /** Any of these Jev themes, built-in or discovered (requires `sync --analyze`). */
    themes: z.array(z.string().min(1)).optional(),
    /** Posted from any of these neighborhoods (name or slug, case-insensitive). */
    neighborhoods: z.array(z.string().min(1)).optional(),
    /** By any of these authors (display name, case-insensitive). */
    authors: z.array(z.string().min(1)).optional(),
    /** Nextdoor topics. */
    topics: z.array(z.string().min(1)).optional(),
    minUrgency: z.number().min(0).max(3).optional(),
    minHostility: z.number().min(0).max(3).optional(),
    minReactions: z.number().int().min(0).optional(),
    forSale: z.boolean().optional(),
  })
  .strict();

const RepliesWatch = z
  .object({
    name: z.string().min(1),
    /** New comments on your posts or replies to your comments. */
    repliesToMe: z.literal(true),
  })
  .strict();

export const WatchSchema = z.union([RepliesWatch, PostWatch]);
export type Watch = z.infer<typeof WatchSchema>;

const WatchFile = z.object({ watches: z.array(WatchSchema) }).strict();

export const EXAMPLE_WATCHES = `// ndoor watches: each rule matches posts first seen since the last check.
// All conditions in a rule must hold; lists match any of their entries.
{
  watches: [
    { name: "safety near home", themes: ["crime_safety"], neighborhoods: ["Maple Grove"] },
    { name: "urgent", minUrgency: 2 },
    { name: "utilities", keywords: ["power outage", "water main", "boil notice"] },
    { name: "replies to me", repliesToMe: true },
  ],
}
`;

/** Themes a watch may name: the built-in ones plus any discovered ids passed in. */
export function parseWatches(text: string, extraThemes: string[] = []): Watch[] {
  const parsed = WatchFile.safeParse(JSON5.parse(text));
  if (!parsed.success) {
    throw new Error(
      `Invalid watches file: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  const known = new Set([...Object.keys(THEMES), ...extraThemes]);
  for (const watch of parsed.data.watches) {
    const unknown = 'themes' in watch ? watch.themes?.find((theme) => !known.has(theme)) : undefined;
    if (unknown) throw new Error(`Invalid watches file: watch "${watch.name}" names unknown theme "${unknown}"`);
  }
  return parsed.data.watches;
}

export function readWatches(path: string, extraThemes: string[] = []): Watch[] {
  if (!existsSync(path)) return [];
  return parseWatches(readFileSync(path, 'utf8'), extraThemes);
}

/** Last check time per watch name, so each watch reports only what is new to it. */
export function readWatchState(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

export function writeWatchState(path: string, state: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the Cypher for one watch. Only the clauses a rule uses are emitted. */
export function watchQuery(
  watch: Watch,
  context: { since: string; meId: string | null; limit: number },
): { cypher: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { since: context.since, limit: context.limit };
  if ('repliesToMe' in watch) {
    params.me = context.meId ?? '';
    return {
      cypher: `
        MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:ON_POST]->(p:Post)
        WHERE c.firstSeen > timestamp($since) AND c.removedAt IS NULL AND a.id <> $me AND (
          EXISTS { MATCH (:User {id: $me})-[:POSTED]->(p) }
          OR EXISTS { MATCH (c)-[:REPLY_TO]->(:Comment)<-[:COMMENTED]-(:User {id: $me}) }
          OR EXISTS { MATCH (c)-[:MENTIONS]->(:User {id: $me}) }
        )
        RETURN c.id AS id, 'comment' AS kind, c.createdAt AS at, a.name AS author,
               p.subject AS post, c.body AS text, p.url AS url
        ORDER BY at DESC LIMIT $limit`,
      params,
    };
  }

  const where = ['p.firstSeen > timestamp($since)', 'p.removedAt IS NULL'];
  if (watch.keywords?.length) {
    params.pattern = `(${watch.keywords.map((keyword) => escapeRegex(keyword.toLowerCase())).join('|')})`;
    where.push("regexp_matches(lower(coalesce(p.subject, '') + ' ' + coalesce(p.body, '')), $pattern)");
  }
  if (watch.themes?.length) {
    params.themes = watch.themes;
    where.push('EXISTS { MATCH (p)-[a:ABOUT]->(t:Theme) WHERE a.p >= 0.5 AND list_contains($themes, t.name) }');
  }
  if (watch.neighborhoods?.length) {
    params.hoods = watch.neighborhoods.map((hood) => hood.toLowerCase());
    where.push(
      'EXISTS { MATCH (p)-[:FROM_HOOD]->(n:Neighborhood) WHERE list_contains($hoods, lower(n.name)) OR list_contains($hoods, n.slug) }',
    );
  }
  if (watch.authors?.length) {
    params.authors = watch.authors.map((author) => author.toLowerCase());
    where.push('list_contains($authors, lower(u.name))');
  }
  if (watch.topics?.length) {
    params.topics = watch.topics.map((topic) => topic.toLowerCase());
    where.push('EXISTS { MATCH (p)-[:TAGGED]->(t:Topic) WHERE list_contains($topics, lower(t.name)) }');
  }
  if (watch.minUrgency !== undefined) {
    params.minUrgency = watch.minUrgency;
    where.push('p.urgency >= $minUrgency');
  }
  if (watch.minHostility !== undefined) {
    params.minHostility = watch.minHostility;
    where.push('p.hostility >= $minHostility');
  }
  if (watch.minReactions !== undefined) {
    params.minReactions = watch.minReactions;
    where.push('p.reactions >= $minReactions');
  }
  if (watch.forSale !== undefined) {
    params.forSale = watch.forSale;
    where.push('coalesce(p.isForSale, false) = $forSale');
  }
  return {
    cypher: `
      MATCH (u:User)-[:POSTED]->(p:Post)
      WHERE ${where.join('\n        AND ')}
      OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
      RETURN p.id AS id, 'post' AS kind, p.createdAt AS at, u.name AS author, n.name AS neighborhood,
             p.subject AS post, p.body AS text, p.url AS url
      ORDER BY at DESC LIMIT $limit`,
    params,
  };
}

export interface WatchHit {
  watch: string;
  rows: Row[];
}

/** Run every watch against content first seen since its last check; returns hits and the new state. */
export async function checkWatches(
  watches: Watch[],
  run: (cypher: string, params: Record<string, unknown>) => Promise<Row[]>,
  options: { state: Record<string, string>; now: string; meId: string | null; firstRunSince: string; limit?: number },
): Promise<{ hits: WatchHit[]; state: Record<string, string> }> {
  const state = { ...options.state };
  const hits: WatchHit[] = [];
  for (const watch of watches) {
    const since = state[watch.name] ?? options.firstRunSince;
    const { cypher, params } = watchQuery(watch, { since, meId: options.meId, limit: options.limit ?? 50 });
    const rows = await run(cypher, params);
    if (rows.length > 0) hits.push({ watch: watch.name, rows });
    state[watch.name] = options.now;
  }
  return { hits, state };
}
