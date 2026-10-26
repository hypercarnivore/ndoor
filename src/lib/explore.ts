/**
 * Read-only views of the graph for the UI (`ndoor ui`): search, one node with
 * its links, a post's thread, and the community network.
 *
 * Labels and relationship names reach Cypher only after being checked against
 * the schema tables (they cannot be parameters); every value is a parameter.
 */

import { NODE_TABLES, REL_TABLES, type Row } from './graph.js';

export type Query = (cypher: string, params?: Record<string, unknown>) => Promise<Row[]>;

/** Primary key property of each browsable node table (Sync is bookkeeping, not content). */
export const NODE_KEYS: Record<string, string> = {
  User: 'id',
  Post: 'id',
  Comment: 'id',
  Neighborhood: 'id',
  Business: 'id',
  Agency: 'id',
  InterestGroup: 'id',
  Topic: 'name',
  Theme: 'name',
};

export interface NodeRef {
  label: string;
  key: string;
  title: string;
  subtitle: string | null;
}

export interface LinkedNode extends NodeRef {
  /** Relationship properties, such as a theme probability or reaction kind. */
  edge: Record<string, unknown>;
}

export interface LinkGroup {
  rel: string;
  direction: 'out' | 'in';
  label: string;
  total: number;
  nodes: LinkedNode[];
}

export interface NodeDetail {
  ref: NodeRef;
  properties: Record<string, unknown>;
  links: LinkGroup[];
}

const columns = (label: string) => new Set(NODE_TABLES[label].split(',').map((part) => part.trim().split(/\s+/)[0]));

/** Relationship endpoints from REL_TABLES, e.g. MENTIONS: Post→User and Comment→User. */
export const REL_ENDPOINTS: Array<{ rel: string; from: string; to: string }> = Object.entries(REL_TABLES).flatMap(
  ([rel, spec]) => [...spec.matchAll(/FROM (\w+) TO (\w+)/g)].map(([, from, to]) => ({ rel, from, to })),
);

/** Relationships whose edges are judgments: show only confident ones, strongest first. */
const EDGE_RULES: Record<string, { where: string; order: string }> = {
  ABOUT: { where: 'r.p >= 0.5', order: 'r.p DESC' },
};

function assertLabel(label: string): string {
  if (!(label in NODE_KEYS)) throw new ExploreError(400, `Unknown node type "${label}"`);
  return label;
}

export class ExploreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A timestamp as an ISO instant; the UI shows its day in the viewer's time zone. */
function instant(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/** Display title and subtitle for a node, from its properties. */
export function describe(label: string, node: Row): NodeRef {
  const key = String(node[NODE_KEYS[label]] ?? '');
  const ref = (title: unknown, subtitle: unknown = null): NodeRef => ({
    label,
    key,
    title: clip(title, 120) || key,
    subtitle: subtitle === null || subtitle === undefined || subtitle === '' ? null : String(subtitle),
  });
  switch (label) {
    case 'User':
      return ref(node.name, node.kind === 'NEIGHBOR' ? null : node.kind);
    case 'Post':
      return ref(node.subject || node.body, instant(node.createdAt));
    case 'Comment':
      return ref(node.body, instant(node.createdAt));
    case 'Neighborhood':
      return ref(node.name, node.city);
    case 'Business':
      return ref(node.name, node.category);
    case 'Theme':
      return ref(node.name, node.source === 'discovered' ? 'discovered' : 'built-in');
    default:
      return ref(node.name);
  }
}

/** Node properties without LadybugDB internals. */
function properties(node: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([name]) => !name.startsWith('_')));
}

function orderFor(label: string): string {
  const has = columns(label);
  if (has.has('createdAt')) return 'm.createdAt DESC';
  if (has.has('lastSeen')) return 'm.lastSeen DESC';
  return `m.${NODE_KEYS[label]}`;
}

/** One page of a node's links along one relationship and direction. */
export async function links(
  query: Query,
  label: string,
  key: string,
  rel: string,
  direction: 'out' | 'in',
  other: string,
  options: { limit: number; offset?: number },
): Promise<LinkGroup> {
  assertLabel(label);
  const endpoint = REL_ENDPOINTS.find(
    (e) =>
      e.rel === rel && (direction === 'out' ? e.from === label && e.to === other : e.to === label && e.from === other),
  );
  if (!endpoint || !(other in NODE_KEYS)) throw new ExploreError(400, `No ${rel} link between ${label} and ${other}`);
  const pattern = direction === 'out' ? `(n)-[r:${rel}]->(m:${other})` : `(n)<-[r:${rel}]-(m:${other})`;
  const rule = EDGE_RULES[rel];
  const where = rule ? `WHERE ${rule.where}` : '';
  const match = `MATCH (n:${label} {${NODE_KEYS[label]}: $key}) MATCH ${pattern} ${where}`;
  const [count] = await query(`${match} RETURN count(m) AS total`, { key });
  const rows = await query(
    `${match} RETURN m, r ORDER BY ${rule?.order ?? orderFor(other)} SKIP $offset LIMIT $limit`,
    { key, offset: options.offset ?? 0, limit: options.limit },
  );
  return {
    rel,
    direction,
    label: other,
    total: Number(count?.total ?? 0),
    nodes: rows.map((row) => ({
      ...describe(other, row.m as Row),
      edge: properties(row.r as Row),
    })),
  };
}

/** A node, its properties, and the first page of every kind of link it has. */
export async function nodeDetail(query: Query, label: string, key: string, limit = 12): Promise<NodeDetail> {
  assertLabel(label);
  const [row] = await query(`MATCH (n:${label} {${NODE_KEYS[label]}: $key}) RETURN n`, { key });
  if (!row) throw new ExploreError(404, `${label} ${key} is not in the graph`);
  const node = row.n as Row;
  const groups: LinkGroup[] = [];
  for (const endpoint of REL_ENDPOINTS) {
    for (const direction of ['out', 'in'] as const) {
      const self = direction === 'out' ? endpoint.from : endpoint.to;
      const other = direction === 'out' ? endpoint.to : endpoint.from;
      if (self !== label || !(other in NODE_KEYS)) continue;
      const group = await links(query, label, key, endpoint.rel, direction, other, { limit });
      if (group.total > 0) groups.push(group);
    }
  }
  return { ref: describe(label, node), properties: properties(node), links: groups };
}

// --- search --------------------------------------------------------------------

const SEARCH_FIELDS: Record<string, string[]> = {
  User: ['name'],
  Neighborhood: ['name', 'city'],
  Business: ['name', 'category'],
  Theme: ['name', 'description'],
  Topic: ['name'],
  InterestGroup: ['name'],
  Agency: ['name'],
  Post: ['subject', 'body'],
  Comment: ['body'],
};

export interface SearchGroup {
  label: string;
  nodes: NodeRef[];
}

/** Case-insensitive substring search across node types; people and places first, then content. */
export async function search(query: Query, text: string, limit = 8): Promise<SearchGroup[]> {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return [];
  const groups: SearchGroup[] = [];
  for (const [label, fields] of Object.entries(SEARCH_FIELDS)) {
    const where = fields.map((field) => `lower(coalesce(m.${field}, '')) CONTAINS $q`).join(' OR ');
    const order = columns(label).has('reactions') ? 'coalesce(m.reactions, 0) DESC' : orderFor(label);
    const rows = await query(`MATCH (m:${label}) WHERE ${where} RETURN m ORDER BY ${order} LIMIT $limit`, {
      q,
      limit,
    });
    if (rows.length) groups.push({ label, nodes: rows.map((row) => describe(label, row.m as Row)) });
  }
  return groups;
}

// --- threads ---------------------------------------------------------------------

export interface ThreadComment {
  id: string;
  body: string;
  createdAt: string | null;
  author: { id: string; name: string } | null;
  replyTo: string | null;
  reactions: number;
  stance: string | null;
  tone: number | null;
  hostility: number | null;
  removed: boolean;
}

export interface Thread {
  post: Record<string, unknown>;
  author: { id: string; name: string } | null;
  comments: ThreadComment[];
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
const num = (value: unknown) => (typeof value === 'number' ? value : null);

/** A post and every comment the graph holds for it, oldest first, with reply targets. */
export async function thread(query: Query, postId: string): Promise<Thread> {
  const [row] = await query(
    'MATCH (p:Post {id: $id}) OPTIONAL MATCH (u:User)-[:POSTED]->(p) RETURN p, u.id AS uid, u.name AS uname',
    { id: postId },
  );
  if (!row) throw new ExploreError(404, `Post ${postId} is not in the graph`);
  const comments = await query(
    `MATCH (c:Comment)-[:ON_POST]->(:Post {id: $id})
     OPTIONAL MATCH (a:User)-[:COMMENTED]->(c)
     OPTIONAL MATCH (c)-[:REPLY_TO]->(t:Comment)
     RETURN c, a.id AS aid, a.name AS aname, t.id AS replyTo ORDER BY c.createdAt`,
    { id: postId },
  );
  return {
    post: properties(row.p as Row),
    author: row.uid ? { id: String(row.uid), name: String(row.uname) } : null,
    comments: comments.map((entry) => {
      const c = entry.c as Row;
      return {
        id: String(c.id),
        body: typeof c.body === 'string' ? c.body : '',
        createdAt: iso(c.createdAt),
        author: entry.aid ? { id: String(entry.aid), name: String(entry.aname) } : null,
        replyTo: entry.replyTo ? String(entry.replyTo) : null,
        reactions: num(c.reactions) ?? 0,
        stance: typeof c.stance === 'string' ? c.stance : null,
        tone: num(c.tone),
        hostility: num(c.hostility),
        removed: Boolean(c.removedAt) || c.isDeleted === true,
      };
    }),
  };
}

// --- community network -----------------------------------------------------------

export interface NetworkNode {
  id: string;
  label: 'User' | 'Business';
  name: string;
  group: string | null;
  posts: number;
  comments: number;
}

export interface NetworkLink {
  source: string;
  target: string;
  kind: 'reply' | 'comment' | 'recommends';
  weight: number;
  disagreements: number;
  tone: number | null;
}

export interface Network {
  nodes: NetworkNode[];
  links: NetworkLink[];
}

/**
 * Who talks to whom: replies between people (a comment answering another's
 * comment), comments on someone's post, and optionally recommendations of a
 * business. Keeps the `limit` heaviest links at or above `minWeight`.
 */
export async function network(
  query: Query,
  options: { since: string; minWeight: number; limit: number; businesses?: boolean },
): Promise<Network> {
  const params = { since: options.since, min: options.minWeight };
  const replies = await query(
    `MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:REPLY_TO]->(:Comment)<-[:COMMENTED]-(b:User)
     WHERE a.id <> b.id AND c.createdAt >= timestamp($since)
     WITH a.id AS source, b.id AS target, count(c) AS weight,
          sum(CASE WHEN c.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements, avg(c.tone) AS tone
     WHERE weight >= $min
     RETURN source, target, weight, disagreements, tone`,
    params,
  );
  const onPosts = await query(
    `MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:ON_POST]->(:Post)<-[:POSTED]-(b:User)
     WHERE a.id <> b.id AND c.createdAt >= timestamp($since) AND NOT EXISTS { MATCH (c)-[:REPLY_TO]->(:Comment) }
     WITH a.id AS source, b.id AS target, count(c) AS weight,
          sum(CASE WHEN c.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements, avg(c.tone) AS tone
     WHERE weight >= $min
     RETURN source, target, weight, disagreements, tone`,
    params,
  );
  const recommends = options.businesses
    ? await query(
        `MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:MENTIONS_BUSINESS]->(b:Business)
         WHERE c.createdAt >= timestamp($since)
         WITH a.id AS source, b.id AS target, count(c) AS weight, avg(c.tone) AS tone
         WHERE weight >= 1
         RETURN source, target, weight, 0 AS disagreements, tone`,
        params,
      )
    : [];
  const toLinks = (rows: Row[], kind: NetworkLink['kind']): NetworkLink[] =>
    rows.map((row) => ({
      source: String(row.source),
      target: String(row.target),
      kind,
      weight: Number(row.weight),
      disagreements: Number(row.disagreements ?? 0),
      tone: num(row.tone),
    }));
  const all = [...toLinks(replies, 'reply'), ...toLinks(onPosts, 'comment'), ...toLinks(recommends, 'recommends')]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, options.limit);

  const businessIds = new Set(all.filter((link) => link.kind === 'recommends').map((link) => link.target));
  const userIds = new Set(all.flatMap((link) => [link.source, link.target]).filter((id) => !businessIds.has(id)));
  const users = await query(
    `MATCH (u:User) WHERE list_contains($ids, u.id)
     OPTIONAL MATCH (u)-[:LIVES_IN]->(n:Neighborhood)
     RETURN u.id AS id, u.name AS name, n.name AS hood,
            COUNT { MATCH (u)-[:POSTED]->(:Post) } AS posts,
            COUNT { MATCH (u)-[:COMMENTED]->(:Comment) } AS comments`,
    { ids: [...userIds] },
  );
  const businesses = businessIds.size
    ? await query(
        `MATCH (b:Business) WHERE list_contains($ids, b.id)
         RETURN b.id AS id, b.name AS name, b.category AS category`,
        { ids: [...businessIds] },
      )
    : [];
  const nodes: NetworkNode[] = [
    ...users.map((row) => ({
      id: String(row.id),
      label: 'User' as const,
      name: String(row.name ?? row.id),
      group: row.hood ? String(row.hood) : null,
      posts: Number(row.posts ?? 0),
      comments: Number(row.comments ?? 0),
    })),
    ...businesses.map((row) => ({
      id: String(row.id),
      label: 'Business' as const,
      name: String(row.name ?? row.id),
      group: row.category ? String(row.category) : null,
      posts: 0,
      comments: 0,
    })),
  ];
  // A user may have more than one LIVES_IN row; keep the first.
  const unique = [...new Map(nodes.map((node) => [node.id, node])).values()];
  const present = new Set(unique.map((node) => node.id));
  return { nodes: unique, links: all.filter((link) => present.has(link.source) && present.has(link.target)) };
}

// --- overview --------------------------------------------------------------------

export interface Overview {
  counts: Record<string, number>;
  lastSync: string | null;
}

export async function overview(query: Query): Promise<Overview> {
  const counts: Record<string, number> = {};
  for (const label of Object.keys(NODE_KEYS)) {
    const [row] = await query(`MATCH (n:${label}) RETURN count(n) AS n`);
    counts[label] = Number(row?.n ?? 0);
  }
  const [sync] = await query('MATCH (s:Sync) RETURN s.finishedAt AS at ORDER BY s.finishedAt DESC LIMIT 1');
  return { counts, lastSync: iso(sync?.at) };
}

// --- sentiment ---------------------------------------------------------------------

/** Tone (0..1, 0.5 neutral) at or above which content counts as positive, and below which negative. */
export const TONE = { positive: 0.6, negative: 0.4 } as const;
/** Hostility level (0..3) from which content counts as hostile, as in reports. */
const HOSTILE = 1.5;
/** Fewer judged items than this and there is no verdict. */
const MIN_ITEMS = 3;

export interface ToneMix {
  items: number;
  /** Mean tone, 0..1 (0.5 neutral); null without judged items. */
  tone: number | null;
  positive: number;
  neutral: number;
  negative: number;
  hostile: number;
}

const toneMixCypher = (alias: string) => `count(${alias}) AS items, avg(${alias}.tone) AS tone,
  sum(CASE WHEN ${alias}.tone >= ${TONE.positive} THEN 1 ELSE 0 END) AS positive,
  sum(CASE WHEN ${alias}.tone < ${TONE.negative} THEN 1 ELSE 0 END) AS negative,
  sum(CASE WHEN ${alias}.hostility >= ${HOSTILE} THEN 1 ELSE 0 END) AS hostile`;

/** Combine tone mixes from separate queries, weighting mean tone by item count. */
function mergeMix(rows: Array<Row | undefined>): ToneMix {
  const mix: ToneMix = { items: 0, tone: null, positive: 0, neutral: 0, negative: 0, hostile: 0 };
  let toneSum = 0;
  for (const row of rows) {
    const items = Number(row?.items ?? 0);
    if (!row || items === 0) continue;
    mix.items += items;
    toneSum += Number(row.tone ?? 0) * items;
    mix.positive += Number(row.positive ?? 0);
    mix.negative += Number(row.negative ?? 0);
    mix.hostile += Number(row.hostile ?? 0);
  }
  mix.neutral = mix.items - mix.positive - mix.negative;
  mix.tone = mix.items ? toneSum / mix.items : null;
  return mix;
}

export interface PersonSentiment {
  kind: 'person';
  verdict: 'positive' | 'neutral' | 'negative' | null;
  /** Their own posts and comments. */
  own: ToneMix;
  /** How their comments respond to others: agrees, disagrees, informs, jokes, off_topic. */
  stances: Record<string, number>;
  /** Comments others wrote in reply to them or on their posts. */
  received: ToneMix & { disagreements: number };
  /** Mean tone of every judged post and comment, for comparison. */
  communityTone: number | null;
}

export interface BusinessSentiment {
  kind: 'business';
  verdict: 'liked' | 'mixed' | 'criticized' | null;
  mentions: number;
  people: number;
  /** Mentions that recommend it or speak of it warmly. */
  favorable: number;
  /** Mentions with a negative tone that do not recommend it. */
  unfavorable: number;
  recommendations: number;
  tone: number | null;
  /** Mentions with a Jev opinion judgment; the rest are classified by tone alone. */
  judged: number;
}

async function communityTone(query: Query): Promise<number | null> {
  const rows = await Promise.all([
    query('MATCH (p:Post) WHERE p.tone IS NOT NULL RETURN count(p) AS items, avg(p.tone) AS tone'),
    query('MATCH (c:Comment) WHERE c.tone IS NOT NULL RETURN count(c) AS items, avg(c.tone) AS tone'),
  ]);
  return mergeMix(rows.map((result) => result[0])).tone;
}

export function personVerdict(mix: ToneMix): PersonSentiment['verdict'] {
  if (mix.items < MIN_ITEMS || mix.tone === null) return null;
  if (mix.tone >= 0.58) return 'positive';
  if (mix.tone <= 0.42) return 'negative';
  return 'neutral';
}

/** Overall tone of a person's own writing, and of what others say back to them. */
export async function personSentiment(query: Query, userId: string): Promise<PersonSentiment> {
  const params = { id: userId };
  const own = mergeMix([
    (
      await query(
        `MATCH (:User {id: $id})-[:POSTED]->(x:Post) WHERE x.tone IS NOT NULL RETURN ${toneMixCypher('x')}`,
        params,
      )
    )[0],
    (
      await query(
        `MATCH (:User {id: $id})-[:COMMENTED]->(x:Comment) WHERE x.tone IS NOT NULL RETURN ${toneMixCypher('x')}`,
        params,
      )
    )[0],
  ]);
  const stanceRows = await query(
    `MATCH (:User {id: $id})-[:COMMENTED]->(c:Comment) WHERE c.stance IS NOT NULL
     RETURN c.stance AS stance, count(c) AS n`,
    params,
  );
  const replies = (
    await query(
      `MATCH (:User {id: $id})-[:COMMENTED]->(:Comment)<-[:REPLY_TO]-(x:Comment)<-[:COMMENTED]-(o:User)
       WHERE o.id <> $id AND x.tone IS NOT NULL
       RETURN ${toneMixCypher('x')}, sum(CASE WHEN x.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements`,
      params,
    )
  )[0];
  const onPosts = (
    await query(
      `MATCH (:User {id: $id})-[:POSTED]->(:Post)<-[:ON_POST]-(x:Comment)<-[:COMMENTED]-(o:User)
       WHERE o.id <> $id AND x.tone IS NOT NULL AND NOT EXISTS { MATCH (x)-[:REPLY_TO]->(:Comment) }
       RETURN ${toneMixCypher('x')}, sum(CASE WHEN x.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements`,
      params,
    )
  )[0];
  return {
    kind: 'person',
    verdict: personVerdict(own),
    own,
    stances: Object.fromEntries(stanceRows.map((row) => [String(row.stance), Number(row.n)])),
    received: {
      ...mergeMix([replies, onPosts]),
      disagreements: Number(replies?.disagreements ?? 0) + Number(onPosts?.disagreements ?? 0),
    },
    communityTone: await communityTone(query),
  };
}

export function businessVerdict(
  counts: Pick<BusinessSentiment, 'mentions' | 'favorable' | 'unfavorable'>,
): BusinessSentiment['verdict'] {
  if (counts.mentions < MIN_ITEMS) return null;
  if (counts.favorable / counts.mentions >= 0.65) return 'liked';
  if (counts.unfavorable / counts.mentions >= 0.35) return 'criticized';
  return 'mixed';
}

/** How neighbors speak of a business when they @mention it. */
export async function businessSentiment(query: Query, businessId: string): Promise<BusinessSentiment> {
  const comments = await query(
    `MATCH (:Business {id: $id})<-[m:MENTIONS_BUSINESS]-(x:Comment)<-[:COMMENTED]-(u:User)
     WHERE x.tone IS NOT NULL OR m.opinion IS NOT NULL
     RETURN x.tone AS tone, x.recommendsBusiness AS rec, m.opinion AS opinion, u.id AS who`,
    { id: businessId },
  );
  const posts = await query(
    `MATCH (:Business {id: $id})<-[m:MENTIONS_BUSINESS]-(x:Post)<-[:POSTED]-(u:User)
     WHERE x.tone IS NOT NULL OR m.opinion IS NOT NULL
     RETURN x.tone AS tone, null AS rec, m.opinion AS opinion, u.id AS who`,
    { id: businessId },
  );
  const result: BusinessSentiment = {
    kind: 'business',
    verdict: null,
    mentions: 0,
    people: 0,
    favorable: 0,
    unfavorable: 0,
    recommendations: 0,
    tone: null,
    judged: 0,
  };
  const people = new Set<string>();
  let toneSum = 0;
  let toned = 0;
  for (const row of [...comments, ...posts]) {
    const tone = typeof row.tone === 'number' ? row.tone : null;
    const recommends = typeof row.rec === 'number' && row.rec >= 0.5;
    result.mentions += 1;
    people.add(String(row.who));
    if (tone !== null) {
      toneSum += tone;
      toned += 1;
    }
    if (recommends) result.recommendations += 1;
    // Prefer Jev's opinion of this business; a comment's overall tone can be about something else entirely.
    const opinion =
      typeof row.opinion === 'string'
        ? row.opinion
        : recommends || (tone !== null && tone >= TONE.positive)
          ? 'favorable'
          : tone !== null && tone < TONE.negative
            ? 'unfavorable'
            : 'neutral';
    if (typeof row.opinion === 'string') result.judged += 1;
    if (opinion === 'favorable') result.favorable += 1;
    else if (opinion === 'unfavorable') result.unfavorable += 1;
  }
  result.people = people.size;
  result.tone = toned ? toneSum / toned : null;
  result.verdict = businessVerdict(result);
  return result;
}

// --- community health --------------------------------------------------------------

/**
 * Community health on a 1 to 10 scale, from four signals. Each maps a raw rate
 * onto 0..1 between a "worst" and a "best" anchor; the score is
 * 1 + 9 x the weighted mean. Anchors and weights are policy, kept here as data.
 */
export const HEALTH_SIGNALS = {
  civility: {
    weight: 0.35,
    worst: 0.25,
    best: 0,
    describe: 'Share of posts and comments Jev judged clearly hostile (insults, mockery, threats)',
  },
  warmth: {
    weight: 0.25,
    worst: 0.35,
    best: 0.65,
    describe: 'Mean emotional tone of posts and comments (0.5 is neutral)',
  },
  agreement: {
    weight: 0.15,
    worst: 0.5,
    best: 0,
    describe: 'Share of comments that disagree with or challenge what they answer',
  },
  helpfulness: {
    weight: 0.25,
    worst: 0.5,
    best: 1,
    describe: 'Share of questions and requests for help that got at least one helpful answer',
  },
} as const;

export type HealthSignal = keyof typeof HEALTH_SIGNALS;

export const HEALTH_BANDS = [
  { min: 8, label: 'healthy' },
  { min: 6, label: 'mostly healthy, with some friction' },
  { min: 4, label: 'strained' },
  { min: 0, label: 'toxic' },
] as const;

export interface Health {
  score: number | null;
  label: string | null;
  signals: Record<HealthSignal, { raw: number | null; value: number | null; weight: number; describe: string }>;
  basis: { posts: number; comments: number; questions: number };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Score raw rates (null when unmeasured; its weight is then shared by the others). */
export function scoreHealth(raw: Record<HealthSignal, number | null>): Pick<Health, 'score' | 'label' | 'signals'> {
  let weighted = 0;
  let weights = 0;
  const signals = {} as Health['signals'];
  for (const [name, spec] of Object.entries(HEALTH_SIGNALS) as Array<
    [HealthSignal, (typeof HEALTH_SIGNALS)[HealthSignal]]
  >) {
    const value = raw[name] === null ? null : clamp01((raw[name]! - spec.worst) / (spec.best - spec.worst));
    signals[name] = { raw: raw[name], value, weight: spec.weight, describe: spec.describe };
    if (value !== null) {
      weighted += value * spec.weight;
      weights += spec.weight;
    }
  }
  if (weights === 0) return { score: null, label: null, signals };
  const score = Math.round((1 + (9 * weighted) / weights) * 10) / 10;
  return { score, label: HEALTH_BANDS.find((band) => score >= band.min)!.label, signals };
}

export async function health(query: Query, since: string): Promise<Health> {
  const params = { since };
  const [posts] = await query(
    `MATCH (x:Post) WHERE x.tone IS NOT NULL AND x.createdAt >= timestamp($since) RETURN ${toneMixCypher('x')}`,
    params,
  );
  const [comments] = await query(
    `MATCH (x:Comment) WHERE x.tone IS NOT NULL AND x.createdAt >= timestamp($since)
     RETURN ${toneMixCypher('x')}, sum(CASE WHEN x.stance = 'disagrees' THEN 1 ELSE 0 END) AS disagreements`,
    params,
  );
  const [questions] = await query(
    `MATCH (p:Post) WHERE p.asksQuestion >= 0.5 AND p.threadFetchedAt IS NOT NULL AND p.createdAt >= timestamp($since)
     WITH p, COUNT { MATCH (c:Comment)-[:ON_POST]->(p) WHERE c.helpful >= 0.5 } AS helpful
     RETURN count(p) AS asked, sum(CASE WHEN helpful > 0 THEN 1 ELSE 0 END) AS answered`,
    params,
  );
  const mix = mergeMix([posts, comments]);
  const commentCount = Number(comments?.items ?? 0);
  const asked = Number(questions?.asked ?? 0);
  const scored = scoreHealth({
    civility: mix.items ? mix.hostile / mix.items : null,
    warmth: mix.tone,
    agreement: commentCount ? Number(comments?.disagreements ?? 0) / commentCount : null,
    helpfulness: asked ? Number(questions?.answered ?? 0) / asked : null,
  });
  return { ...scored, basis: { posts: Number(posts?.items ?? 0), comments: commentCount, questions: asked } };
}
