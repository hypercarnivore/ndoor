/**
 * Graph store for everything ndoor observes, backed by LadybugDB (embedded,
 * Cypher). The schema is data (NODE_TABLES / REL_TABLES); ingestion is
 * idempotent MERGEs, so syncing the same content twice changes only the
 * observation timestamps.
 *
 * Every node records when it was first and last seen. Deletions are inferred:
 * when a thread is reloaded in full, comments that vanished get `removedAt`,
 * and posts Nextdoor no longer serves are marked removed with the reason.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import lbug from '@ladybugdb/core';
import type {
  Activity,
  Author,
  Business,
  BusinessRef,
  Comment,
  Group,
  Neighborhood,
  Post,
  UserProfile,
} from './model.js';

const OBSERVED = 'firstSeen TIMESTAMP, lastSeen TIMESTAMP';

/** Node tables. Jev judgments live as properties on Post and Comment (see saveJudgments). */
export const NODE_TABLES: Record<string, string> = {
  User: `id STRING PRIMARY KEY, secureId STRING, name STRING, kind STRING, profileUrl STRING,
    residentSince INT64, pronouns STRING, biography STRING, badges STRING[], profileType STRING,
    profileFetchedAt TIMESTAMP, historyFetchedAt TIMESTAMP, ${OBSERVED}`,
  Neighborhood: `id STRING PRIMARY KEY, name STRING, slug STRING, city STRING, state STRING,
    neighbors INT64, profileFetchedAt TIMESTAMP, ${OBSERVED}`,
  Post: `id STRING PRIMARY KEY, shareId STRING, url STRING, subject STRING, body STRING,
    createdAt TIMESTAMP, postType STRING, visibility STRING, label STRING, isForSale BOOLEAN,
    isEdited BOOLEAN, hashtags STRING[], media STRING[], reactions INT64, reactionsByType STRING,
    commentCount INT64, threadFetchedAt TIMESTAMP, removedAt TIMESTAMP, removedReason STRING,
    jevVersion STRING, primaryTheme STRING, primaryThemeConfidence DOUBLE, intent STRING,
    tone DOUBLE, hostility DOUBLE, urgency DOUBLE, asksQuestion DOUBLE, accuses DOUBLE, themeSet STRING,
    placeScope STRING, placeScopeConfidence DOUBLE, placeSet STRING, nextThreadCheck TIMESTAMP, ${OBSERVED}`,
  Comment: `id STRING PRIMARY KEY, body STRING, createdAt TIMESTAMP, reactions INT64,
    reactionsByType STRING, isDeleted BOOLEAN, removedAt TIMESTAMP,
    jevVersion STRING, stance STRING, tone DOUBLE, hostility DOUBLE, helpful DOUBLE,
    recommendsBusiness DOUBLE, ${OBSERVED}`,
  Topic: `name STRING PRIMARY KEY, ${OBSERVED}`,
  /** source is null for Jev's built-in themes and 'discovered' for themes from `ndoor themes discover`. */
  Theme: 'name STRING PRIMARY KEY, source STRING, description STRING',
  Business: `id STRING PRIMARY KEY, slug STRING, name STRING, category STRING, address STRING,
    faves INT64, followers INT64, profileFetchedAt TIMESTAMP, ${OBSERVED}`,
  Agency: `id STRING PRIMARY KEY, name STRING, ${OBSERVED}`,
  InterestGroup: `id STRING PRIMARY KEY, name STRING, members INT64, ${OBSERVED}`,
  /** When each pull (a feed, your account, your activity) last ran and next falls due; see sync.ts. */
  Schedule: 'key STRING PRIMARY KEY, lastRunAt TIMESTAMP, nextRunAt TIMESTAMP, quiet INT64, payload STRING',
  Sync: 'id STRING PRIMARY KEY, startedAt TIMESTAMP, finishedAt TIMESTAMP, stats STRING, meId STRING',
};

export const REL_TABLES: Record<string, string> = {
  POSTED: 'FROM User TO Post',
  COMMENTED: 'FROM User TO Comment',
  ON_POST: 'FROM Comment TO Post',
  /** The comment a reply actually answers (resolved from @mentions). */
  REPLY_TO: 'FROM Comment TO Comment',
  MENTIONS: 'FROM Post TO User, FROM Comment TO User',
  /** opinion: Jev's judgment of what the mention says about the business (favorable, unfavorable, neutral). */
  MENTIONS_BUSINESS: 'FROM Post TO Business, FROM Comment TO Business, opinion STRING, opinionConfidence DOUBLE',
  TAGGED: 'FROM Post TO Topic',
  REPOSTS: 'FROM Post TO Post',
  /** The neighborhood the author posted from. */
  FROM_HOOD: 'FROM Post TO Neighborhood',
  LIVES_IN: 'FROM User TO Neighborhood',
  IN_GROUP: 'FROM Post TO InterestGroup',
  MEMBER_OF: 'FROM User TO InterestGroup',
  SPEAKS_FOR: 'FROM User TO Agency',
  /** A business or publisher page posting as itself. */
  IS_PAGE: 'FROM User TO Business',
  REACTED: 'FROM User TO Post, kind STRING, at TIMESTAMP',
  ABOUT: 'FROM Post TO Theme, p DOUBLE',
};

export type Row = Record<string, unknown>;

/** Judgments as saveJudgments stores them; built from jev.ts Judgments by the caller. */
export interface StoredJudgments {
  subjectId: string;
  kind: 'post' | 'comment';
  version: string;
  properties: Record<string, string | number | null>;
  /** Post themes with their probabilities. */
  themes?: Record<string, number>;
}

function flatten(comments: Comment[]): Comment[] {
  return comments.flatMap((comment) => [comment, ...flatten(comment.replies)]);
}

const MB = 1024 * 1024;

type QueryResult = InstanceType<typeof lbug.QueryResult>;

/** Multi-statement queries return one result per statement; callers want the last. */
async function lastResult(result: QueryResult | QueryResult[]): Promise<Row[]> {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  return last ? ((await last.getAll()) as Row[]).map((row) => plain(row) as Row) : [];
}

/** Wide integer aggregates arrive as BigInt; counts here always fit in a double. */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  }
  return value;
}

const TS = (param: string) => `CASE WHEN $${param} IS NULL THEN NULL ELSE timestamp($${param}) END`;

/**
 * Gate for Cypher that did not come from ndoor itself (`ndoor query`, MCP
 * graph_query). A read-only database still lets Cypher read local files
 * (LOAD FROM), install and load extensions from the network (INSTALL, LOAD
 * EXTENSION), call table functions, and chain statements. Content in the graph
 * is written by strangers, so an agent steered by it must not reach any of
 * that: only a single MATCH/WITH/UNWIND/RETURN query passes, and no forbidden
 * word may appear anywhere in it.
 */
const FORBIDDEN = new Set([
  'LOAD',
  'COPY',
  'INSTALL',
  'EXTENSION',
  'ATTACH',
  'DETACH',
  'USE',
  'EXPORT',
  'IMPORT',
  'CALL',
  'CREATE',
  'MERGE',
  'SET',
  'DELETE',
  'REMOVE',
  'DROP',
  'ALTER',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'CHECKPOINT',
  'PROJECT',
  'GRAPH',
  'DATABASE',
]);
const ALLOWED_START = new Set(['MATCH', 'OPTIONAL', 'WITH', 'UNWIND', 'RETURN']);

export function assertReadQuery(cypher: string): void {
  // The raw text is checked as is. Blanking strings or comments first would need a
  // lexer identical to LadybugDB's, and any difference becomes a bypass (a quote in
  // a comment can make an attacker's statement look like a string). Checking
  // everything is conservative by design: literal values belong in params.
  const text = cypher.trim().replace(/;\s*$/, '');
  if (text.includes(';')) throw new Error('Only a single query is allowed.');
  const words = text.match(/[A-Za-z_]+/g) ?? [];
  if (!ALLOWED_START.has(words[0]?.toUpperCase() ?? '')) {
    throw new Error('Only read queries are allowed (start with MATCH, OPTIONAL MATCH, WITH, UNWIND, or RETURN).');
  }
  const bad = words.find((word) => FORBIDDEN.has(word.toUpperCase()));
  if (bad) {
    throw new Error(
      `"${bad}" is not allowed in graph queries, even inside strings or comments; pass literal text as a parameter.`,
    );
  }
}

export class GraphStore {
  private readonly statements = new Map<string, unknown>();

  private constructor(
    private readonly db: InstanceType<typeof lbug.Database>,
    private readonly conn: InstanceType<typeof lbug.Connection>,
  ) {}

  /**
   * Open (creating if needed) the database file and ensure the schema exists.
   * Read-only opens never write, except once to migrate a graph whose schema
   * predates this version (otherwise new queries would fail on old graphs).
   */
  static async open(path: string, options: { readOnly?: boolean } = {}): Promise<GraphStore> {
    if (options.readOnly && !existsSync(path)) {
      throw new Error(`No graph at ${path} yet. Run \`ndoor sync\` first.`);
    }
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    let store = GraphStore.connect(path, options.readOnly ?? false);
    if (!options.readOnly) {
      await store.migrate();
      if (path !== ':memory:' && existsSync(path)) chmodSync(path, 0o600);
      return store;
    }
    // A graph from an older ndoor: migrate once with a writable open, then reopen read-only. LadybugDB
    // sometimes fails to checkpoint that migration on the first close, which leaves the next read-only
    // open seeing the old schema (the change is not lost; another writable open/close flushes it), so
    // verify and repeat a few times.
    for (let attempt = 0; attempt < 3 && (await store.isStale()); attempt += 1) {
      await store.close();
      const writer = await GraphStore.open(path);
      await writer.run('CHECKPOINT').catch(() => {});
      await writer.close();
      store = GraphStore.connect(path, true);
    }
    return store;
  }

  private static connect(path: string, readOnly: boolean): GraphStore {
    // Defaults reserve terabytes of address space; a personal graph needs far less.
    const db = new lbug.Database(path, 2048 * MB, true, readOnly, 64 * 1024 * MB);
    return new GraphStore(db, new lbug.Connection(db));
  }

  private static columns(spec: string): string[] {
    return spec.split(',').map((part) => part.trim().replace(/\s+/g, ' '));
  }

  /** Create missing tables, then add columns declared after a graph was created. */
  private async migrate(): Promise<void> {
    for (const [name, columns] of Object.entries(NODE_TABLES)) {
      await this.run(`CREATE NODE TABLE IF NOT EXISTS ${name}(${columns.replace(/\s+/g, ' ')})`);
    }
    for (const [name, spec] of Object.entries(REL_TABLES)) {
      await this.run(`CREATE REL TABLE IF NOT EXISTS ${name}(${spec})`);
    }
    for (const [name, columns] of Object.entries(NODE_TABLES)) {
      for (const column of GraphStore.columns(columns)) {
        if (!column.includes('PRIMARY KEY')) await this.run(`ALTER TABLE ${name} ADD IF NOT EXISTS ${column}`);
      }
    }
    for (const [name, spec] of Object.entries(REL_TABLES)) {
      for (const column of GraphStore.relProperties(spec)) {
        await this.run(`ALTER TABLE ${name} ADD IF NOT EXISTS ${column}`);
      }
    }
  }

  /** Property columns of a relationship spec (everything after its FROM ... TO ... pairs). */
  private static relProperties(spec: string): string[] {
    return GraphStore.columns(spec).filter((part) => !part.startsWith('FROM '));
  }

  /** True when a table or column this version declares is missing. */
  private async isStale(): Promise<boolean> {
    for (const [name, columns] of Object.entries(NODE_TABLES)) {
      const present = new Set(
        (await this.run(`CALL table_info('${name}') RETURN name`).catch(() => [])).map((row) => String(row.name)),
      );
      if (GraphStore.columns(columns).some((column) => !present.has(column.split(' ')[0]))) return true;
    }
    for (const [name, spec] of Object.entries(REL_TABLES)) {
      const wanted = GraphStore.relProperties(spec);
      if (wanted.length === 0) continue;
      const present = new Set(
        (await this.run(`CALL table_info('${name}') RETURN name`).catch(() => [])).map((row) => String(row.name)),
      );
      if (wanted.some((column) => !present.has(column.split(' ')[0]))) return true;
    }
    return false;
  }

  /** Run Cypher. With params it goes through a cached prepared statement. */
  async run(cypher: string, params?: Record<string, unknown>): Promise<Row[]> {
    if (!params) {
      return lastResult(await this.conn.query(cypher));
    }
    let statement = this.statements.get(cypher);
    if (!statement) {
      statement = await this.conn.prepare(cypher);
      this.statements.set(cypher, statement);
    }
    return lastResult(await this.conn.execute(statement as never, params as never));
  }

  /** Run writes as one transaction: one commit instead of one per statement (several times faster). */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.run('BEGIN TRANSACTION');
    try {
      const result = await work();
      await this.run('COMMIT');
      return result;
    } catch (error) {
      // A failed statement can end the transaction on its own; keep the original error either way.
      await this.run('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
  }

  // --- nodes -------------------------------------------------------------------

  async upsertNeighborhood(hood: Neighborhood, now: string): Promise<void> {
    await this.run(
      `MERGE (n:Neighborhood {id: $id}) ON CREATE SET n.firstSeen = timestamp($now)
       SET n.lastSeen = timestamp($now), n.name = $name, n.city = $city, n.state = $state,
           n.slug = coalesce($slug, n.slug)`,
      { id: hood.id, now, name: hood.name, city: hood.city, state: hood.state, slug: hood.slug },
    );
  }

  async upsertAuthor(author: Author, now: string): Promise<string | null> {
    if (!author.id) return null;
    await this.run(
      `MERGE (u:User {id: $id}) ON CREATE SET u.firstSeen = timestamp($now)
       SET u.lastSeen = timestamp($now), u.name = $name, u.kind = $kind,
           u.profileUrl = coalesce($profileUrl, u.profileUrl), u.secureId = coalesce($secureId, u.secureId)`,
      {
        id: author.id,
        now,
        name: author.name,
        kind: author.type,
        profileUrl: author.profileUrl,
        secureId: author.secureId,
      },
    );
    if (author.neighborhood) {
      await this.upsertNeighborhood(author.neighborhood, now);
      if (author.type === 'NEIGHBOR') {
        // The neighborhood an author posts from stands in for home until their profile is fetched.
        await this.run(
          `MATCH (u:User {id: $user}), (n:Neighborhood {id: $hood})
           WHERE u.profileFetchedAt IS NULL AND NOT EXISTS { MATCH (u)-[:LIVES_IN]->(:Neighborhood) }
           MERGE (u)-[:LIVES_IN]->(n)`,
          { user: author.id, hood: author.neighborhood.id },
        );
      }
    }
    if (author.agency) {
      await this.run(
        `MERGE (a:Agency {id: $agency}) ON CREATE SET a.firstSeen = timestamp($now)
         SET a.lastSeen = timestamp($now), a.name = $name
         WITH a MATCH (u:User {id: $user}) MERGE (u)-[:SPEAKS_FOR]->(a)`,
        { agency: author.agency.id, name: author.agency.name, now, user: author.id },
      );
    }
    if (author.pageSlug) {
      await this.upsertBusinessRef({ id: author.id, name: author.name, slug: author.pageSlug }, now);
      await this.run('MATCH (u:User {id: $id}), (b:Business {id: $id}) MERGE (u)-[:IS_PAGE]->(b)', { id: author.id });
    }
    return author.id;
  }

  private async upsertBusinessRef(ref: BusinessRef, now: string): Promise<void> {
    await this.run(
      `MERGE (b:Business {id: $id}) ON CREATE SET b.firstSeen = timestamp($now), b.name = $name
       SET b.lastSeen = timestamp($now), b.slug = coalesce($slug, b.slug)`,
      { id: ref.id, name: ref.name, slug: ref.slug, now },
    );
  }

  async upsertBusiness(business: Business, now: string): Promise<void> {
    await this.upsertBusinessRef(business, now);
    await this.run(
      `MATCH (b:Business {id: $id}) SET b.name = $name, b.category = $category, b.address = $address,
         b.faves = $faves, b.followers = $followers, b.profileFetchedAt = timestamp($now)`,
      { ...business, now },
    );
  }

  async upsertUserProfile(profile: UserProfile, now: string): Promise<void> {
    await this.run(
      `MERGE (u:User {id: $id}) ON CREATE SET u.firstSeen = timestamp($now), u.lastSeen = timestamp($now)
       SET u.secureId = coalesce($secureId, u.secureId), u.name = $name, u.residentSince = $residentSince,
           u.pronouns = $pronouns, u.biography = $biography, u.badges = $badges, u.profileType = $profileType,
           u.profileFetchedAt = timestamp($now)`,
      {
        id: profile.id,
        now,
        secureId: profile.secureId,
        name: profile.name,
        residentSince: profile.residentSince,
        pronouns: profile.pronouns,
        biography: profile.biography,
        badges: profile.badges,
        profileType: profile.profileType,
      },
    );
    if (profile.neighborhood) {
      await this.upsertNeighborhood(profile.neighborhood, now);
      await this.run(`MATCH (u:User {id: $user})-[r:LIVES_IN]->(n:Neighborhood) WHERE n.id <> $hood DELETE r`, {
        user: profile.id,
        hood: profile.neighborhood.id,
      });
      await this.run('MATCH (u:User {id: $user}), (n:Neighborhood {id: $hood}) MERGE (u)-[:LIVES_IN]->(n)', {
        user: profile.id,
        hood: profile.neighborhood.id,
      });
    }
  }

  async upsertNeighborhoodProfile(hood: Neighborhood & { neighbors: number | null }, now: string): Promise<void> {
    await this.upsertNeighborhood(hood, now);
    await this.run(
      'MATCH (n:Neighborhood {id: $id}) SET n.neighbors = $neighbors, n.profileFetchedAt = timestamp($now)',
      { id: hood.id, neighbors: hood.neighbors, now },
    );
  }

  async upsertGroups(groups: Group[], memberId: string | null, now: string): Promise<void> {
    for (const group of groups) {
      await this.run(
        `MERGE (g:InterestGroup {id: $id}) ON CREATE SET g.firstSeen = timestamp($now)
         SET g.lastSeen = timestamp($now), g.name = $name, g.members = $members`,
        { id: group.id, name: group.name, members: group.members, now },
      );
      if (!memberId) continue;
      const params = { user: memberId, groupId: group.id };
      await this.run(
        group.isMember
          ? 'MATCH (u:User {id: $user}), (g:InterestGroup {id: $groupId}) MERGE (u)-[:MEMBER_OF]->(g)'
          : 'MATCH (u:User {id: $user})-[r:MEMBER_OF]->(g:InterestGroup {id: $groupId}) DELETE r',
        params,
      );
    }
  }

  // --- posts and threads -------------------------------------------------------

  /**
   * Upsert a post with everything attached to it: author, neighborhood, topics,
   * mentions, repost, group, and any comments it carries.
   */
  async ingestPost(post: Post, now: string, context: { groupId?: string } = {}): Promise<void> {
    const authorId = await this.upsertAuthor(post.author, now);
    await this.run(
      `MERGE (p:Post {id: $id}) ON CREATE SET p.firstSeen = timestamp($now)
       SET p.lastSeen = timestamp($now), p.shareId = $shareId, p.url = $url, p.subject = $subject, p.body = $body,
           p.createdAt = ${TS('createdAt')}, p.postType = $postType, p.visibility = $visibility,
           p.label = coalesce($label, p.label), p.isForSale = $isForSale, p.isEdited = $isEdited,
           p.hashtags = $hashtags, p.media = $media, p.reactions = $reactions,
           p.reactionsByType = $reactionsByType, p.commentCount = $commentCount`,
      {
        id: post.id,
        now,
        shareId: post.shareId,
        url: post.url,
        subject: post.subject,
        body: post.body,
        createdAt: post.createdAt,
        postType: post.postType,
        visibility: post.visibility,
        label: post.label,
        isForSale: post.isForSale,
        isEdited: post.isEdited,
        hashtags: post.hashtags,
        media: post.media,
        reactions: post.reactions.total,
        reactionsByType: JSON.stringify(post.reactions.byType),
        commentCount: post.commentCount,
      },
    );
    if (authorId) {
      await this.run('MATCH (u:User {id: $user}), (p:Post {id: $post}) MERGE (u)-[:POSTED]->(p)', {
        user: authorId,
        post: post.id,
      });
    }
    if (post.author.neighborhood) {
      await this.run('MATCH (p:Post {id: $post}), (n:Neighborhood {id: $hood}) MERGE (p)-[:FROM_HOOD]->(n)', {
        post: post.id,
        hood: post.author.neighborhood.id,
      });
    }
    for (const topic of post.topics) {
      await this.run(
        `MERGE (t:Topic {name: $name}) ON CREATE SET t.firstSeen = timestamp($now) SET t.lastSeen = timestamp($now)
         WITH t MATCH (p:Post {id: $post}) MERGE (p)-[:TAGGED]->(t)`,
        { name: topic, now, post: post.id },
      );
    }
    await this.linkMentions('Post', post.id, post.mentions, post.businessMentions, now);
    if (post.repostOf) {
      const original = post.repostOf;
      await this.upsertAuthor(original.author, now);
      await this.run(
        `MERGE (o:Post {id: $id}) ON CREATE SET o.firstSeen = timestamp($now), o.lastSeen = timestamp($now),
           o.shareId = $shareId, o.url = $url, o.subject = $subject, o.body = $body, o.createdAt = ${TS('createdAt')}
         WITH o MATCH (p:Post {id: $post}) MERGE (p)-[:REPOSTS]->(o)`,
        {
          id: original.id,
          now,
          shareId: original.shareId,
          url: `https://nextdoor.com/p/${original.shareId}`,
          subject: original.subject,
          body: original.body,
          createdAt: original.createdAt,
          post: post.id,
        },
      );
      if (original.author.id) {
        await this.run('MATCH (u:User {id: $user}), (p:Post {id: $post}) MERGE (u)-[:POSTED]->(p)', {
          user: original.author.id,
          post: original.id,
        });
      }
    }
    if (context.groupId) {
      await this.run(
        `MERGE (g:InterestGroup {id: $groupId}) ON CREATE SET g.firstSeen = timestamp($now) SET g.lastSeen = timestamp($now)
         WITH g MATCH (p:Post {id: $post}) MERGE (p)-[:IN_GROUP]->(g)`,
        { groupId: context.groupId, now, post: post.id },
      );
    }
    for (const comment of flatten(post.comments)) await this.ingestComment(post.id, comment, now);
  }

  private async ingestComment(postId: string, comment: Comment, now: string): Promise<void> {
    const authorId = await this.upsertAuthor(comment.author, now);
    await this.run(
      `MERGE (c:Comment {id: $id}) ON CREATE SET c.firstSeen = timestamp($now)
       SET c.lastSeen = timestamp($now), c.body = CASE WHEN $isDeleted AND c.body IS NOT NULL THEN c.body ELSE $body END,
           c.createdAt = ${TS('createdAt')}, c.reactions = $reactions, c.reactionsByType = $reactionsByType,
           c.isDeleted = $isDeleted,
           c.removedAt = CASE WHEN $isDeleted AND c.removedAt IS NULL THEN timestamp($now) ELSE c.removedAt END
       WITH c MATCH (p:Post {id: $post}) MERGE (c)-[:ON_POST]->(p)`,
      {
        id: comment.id,
        now,
        body: comment.body,
        createdAt: comment.createdAt,
        reactions: comment.reactions.total,
        reactionsByType: JSON.stringify(comment.reactions.byType),
        isDeleted: comment.isDeleted,
        post: postId,
      },
    );
    if (authorId) {
      await this.run('MATCH (u:User {id: $user}), (c:Comment {id: $comment}) MERGE (u)-[:COMMENTED]->(c)', {
        user: authorId,
        comment: comment.id,
      });
    }
    if (comment.replyToId) {
      await this.run(
        `MERGE (t:Comment {id: $target})
         WITH t MATCH (c:Comment {id: $comment}) MERGE (c)-[:REPLY_TO]->(t)`,
        { target: comment.replyToId, comment: comment.id },
      );
    }
    await this.linkMentions('Comment', comment.id, comment.mentions, comment.businessMentions, now);
  }

  private async linkMentions(
    label: 'Post' | 'Comment',
    id: string,
    users: string[],
    businesses: BusinessRef[],
    now: string,
  ): Promise<void> {
    for (const user of new Set(users)) {
      await this.run(
        `MERGE (u:User {id: $user}) ON CREATE SET u.firstSeen = timestamp($now), u.lastSeen = timestamp($now)
         WITH u MATCH (s:${label} {id: $id}) MERGE (s)-[:MENTIONS]->(u)`,
        { user, now, id },
      );
    }
    for (const business of businesses) {
      await this.upsertBusinessRef(business, now);
      await this.run(`MATCH (s:${label} {id: $id}), (b:Business {id: $business}) MERGE (s)-[:MENTIONS_BUSINESS]->(b)`, {
        id,
        business: business.id,
      });
    }
  }

  /**
   * Record a full reload of a thread. Comments stored for this post that are
   * missing from the reload were removed since the last time they were seen.
   */
  /**
   * Record a full thread load and mark comments that vanished. The next
   * deletion check waits as long as the thread was old when loaded (at least
   * `minHours`), so rechecks thin out as a thread ages instead of repeating.
   */
  async markThreadFetched(post: Post, now: string, minHours = 12): Promise<number> {
    const present = flatten(post.comments).map((comment) => comment.id);
    const removed = await this.run(
      `MATCH (c:Comment)-[:ON_POST]->(p:Post {id: $post})
       WHERE c.removedAt IS NULL AND NOT list_contains($present, c.id)
       SET c.removedAt = timestamp($now)
       RETURN count(c) AS n`,
      { post: post.id, present, now },
    );
    const at = Date.parse(now);
    const created = post.createdAt ? Date.parse(post.createdAt) : at;
    const wait = Math.max(minHours * 3_600_000, at - (Number.isNaN(created) ? at : created));
    await this.run(
      'MATCH (p:Post {id: $post}) SET p.threadFetchedAt = timestamp($now), p.nextThreadCheck = timestamp($next)',
      { post: post.id, now, next: new Date(at + wait).toISOString() },
    );
    return Number(removed[0]?.n ?? 0);
  }

  async markPostRemoved(postId: string, reason: string, now: string): Promise<void> {
    await this.run(
      `MATCH (p:Post {id: $post}) WHERE p.removedAt IS NULL
       SET p.removedAt = timestamp($now), p.removedReason = $reason, p.threadFetchedAt = timestamp($now)`,
      { post: postId, reason, now },
    );
  }

  /** The logged-in user's own reactions, from the activity log. */
  /** Store your reactions; returns how many were not already in the graph. */
  async ingestReactions(userId: string, activities: Activity[], now: string): Promise<number> {
    let count = 0;
    for (const activity of activities) {
      if (!activity.kind.startsWith('reaction')) continue;
      const [existing] = await this.run(
        'MATCH (:User {id: $user})-[r:REACTED {kind: $kind}]->(:Post {id: $post}) RETURN count(r) AS n',
        { user: userId, kind: activity.kind, post: activity.postId },
      );
      if (Number(existing?.n ?? 0) > 0) continue;
      await this.run(
        `MERGE (p:Post {id: $post}) ON CREATE SET p.firstSeen = timestamp($now), p.lastSeen = timestamp($now)
         WITH p MATCH (u:User {id: $user}) MERGE (u)-[r:REACTED {kind: $kind}]->(p) SET r.at = ${TS('at')}`,
        { post: activity.postId, now, user: userId, kind: activity.kind, at: activity.at },
      );
      count += 1;
    }
    return count;
  }

  async saveJudgments(judgments: StoredJudgments): Promise<void> {
    const label = judgments.kind === 'post' ? 'Post' : 'Comment';
    const assignments = Object.keys(judgments.properties)
      .map((key) => `s.${key} = $${key}`)
      .join(', ');
    await this.run(`MATCH (s:${label} {id: $id}) SET s.jevVersion = $version${assignments ? `, ${assignments}` : ''}`, {
      id: judgments.subjectId,
      version: judgments.version,
      ...judgments.properties,
    });
    for (const [theme, p] of Object.entries(judgments.themes ?? {})) {
      await this.run(
        `MERGE (t:Theme {name: $theme}) WITH t MATCH (s:Post {id: $id})
         MERGE (s)-[a:ABOUT]->(t) SET a.p = $p`,
        { theme, id: judgments.subjectId, p },
      );
    }
  }

  async recordSync(
    id: string,
    startedAt: string,
    finishedAt: string,
    stats: unknown,
    meId: string | null = null,
  ): Promise<void> {
    await this.run(
      `MERGE (s:Sync {id: $id}) SET s.startedAt = timestamp($startedAt), s.finishedAt = timestamp($finishedAt),
         s.stats = $stats, s.meId = $meId`,
      { id, startedAt, finishedAt, stats: JSON.stringify(stats), meId },
    );
  }

  /** The logged-in user as of the latest sync, so offline commands know who "me" is. */
  async meId(): Promise<string | null> {
    const rows = await this.run(
      'MATCH (s:Sync) WHERE s.meId IS NOT NULL RETURN s.meId AS id ORDER BY s.startedAt DESC LIMIT 1',
    );
    return rows[0] ? String(rows[0].id) : null;
  }

  // --- work queues for sync ----------------------------------------------------

  /**
   * Posts whose threads should be (re)loaded: known only by id (from the activity
   * log) or by a repost's summary (no counts yet), never loaded, grown since, or
   * recent enough to watch for deletions. Questions come first among unloaded
   * posts: their answers drive helpfulness and recommendation demand.
   */
  async postsNeedingThreads(options: {
    recheckSince: string;
    /** Fallback for threads loaded before rechecks were scheduled (no nextThreadCheck). */
    refetchBefore: string;
    now: string;
    limit: number;
  }): Promise<string[]> {
    const rows = await this.run(
      `MATCH (p:Post) WHERE p.removedAt IS NULL AND (
         (p.threadFetchedAt IS NULL AND (p.commentCount > 0 OR p.commentCount IS NULL OR p.shareId IS NULL))
         OR (p.threadFetchedAt IS NOT NULL AND p.createdAt >= timestamp($recheckSince) AND (
               p.nextThreadCheck <= timestamp($now)
               OR (p.nextThreadCheck IS NULL AND p.threadFetchedAt < timestamp($refetchBefore))))
         OR (p.threadFetchedAt IS NOT NULL AND p.lastSeen > p.threadFetchedAt
             AND p.commentCount > COUNT { MATCH (c:Comment)-[:ON_POST]->(p) WHERE c.removedAt IS NULL })
       )
       RETURN p.id AS id
       ORDER BY p.threadFetchedAt IS NULL DESC, coalesce(p.asksQuestion, 0) >= 0.5 DESC, p.commentCount DESC
       LIMIT $limit`,
      options,
    );
    return rows.map((row) => String(row.id));
  }

  // --- schedules (see sync.ts) -----------------------------------------------------

  async schedule(key: string): Promise<{ nextRunAt: Date | null; quiet: number; payload: string | null } | null> {
    const [row] = await this.run(
      'MATCH (s:Schedule {key: $key}) RETURN s.nextRunAt AS next, s.quiet AS quiet, s.payload AS payload',
      { key },
    );
    if (!row) return null;
    return {
      nextRunAt: row.next instanceof Date ? row.next : null,
      quiet: Number(row.quiet ?? 0),
      payload: typeof row.payload === 'string' ? row.payload : null,
    };
  }

  async recordRun(key: string, run: { now: string; next: string; quiet: number; payload?: string | null }) {
    await this.run(
      `MERGE (s:Schedule {key: $key})
       SET s.lastRunAt = timestamp($now), s.nextRunAt = timestamp($next), s.quiet = $quiet,
           s.payload = coalesce($payload, s.payload)`,
      { key, now: run.now, next: run.next, quiet: run.quiet, payload: run.payload ?? null },
    );
  }

  /** Groups already in the graph, members first, for runs that do not refresh the group list. */
  async knownGroups(memberId: string | null): Promise<Group[]> {
    const rows = await this.run(
      `MATCH (g:InterestGroup)
       OPTIONAL MATCH (:User {id: $member})-[m:MEMBER_OF]->(g)
       RETURN g.id AS id, g.name AS name, g.members AS members, count(m) > 0 AS isMember
       ORDER BY isMember DESC, members DESC`,
      { member: memberId ?? '' },
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? row.id),
      members: row.members === null || row.members === undefined ? null : Number(row.members),
      isMember: row.isMember === true,
    }));
  }

  /**
   * Record a profile lookup that returned nothing (private, gone) or failed for
   * good, so it is not asked again every run. Throttled lookups are not recorded.
   */
  async markLookedUp(kind: 'User' | 'Neighborhood' | 'Business', key: string, now: string): Promise<void> {
    const field = kind === 'User' ? 'secureId' : 'slug';
    await this.run(`MATCH (n:${kind}) WHERE n.${field} = $key SET n.profileFetchedAt = timestamp($now)`, { key, now });
  }

  async usersNeedingProfiles(limit: number): Promise<string[]> {
    const rows = await this.run(
      `MATCH (u:User) WHERE u.profileFetchedAt IS NULL AND u.secureId IS NOT NULL AND u.kind = 'NEIGHBOR'
       OPTIONAL MATCH (u)-[:POSTED|COMMENTED]->(x)
       RETURN u.secureId AS id, count(x) AS activity ORDER BY activity DESC LIMIT $limit`,
      { limit },
    );
    return rows.map((row) => String(row.id));
  }

  async neighborhoodsNeedingProfiles(limit: number): Promise<string[]> {
    const rows = await this.run(
      `MATCH (n:Neighborhood) WHERE n.profileFetchedAt IS NULL AND n.slug IS NOT NULL
       OPTIONAL MATCH (p:Post)-[:FROM_HOOD]->(n)
       RETURN n.slug AS slug, count(p) AS posts ORDER BY posts DESC LIMIT $limit`,
      { limit },
    );
    return rows.map((row) => String(row.slug));
  }

  async businessesNeedingProfiles(limit: number): Promise<string[]> {
    const rows = await this.run(
      `MATCH (b:Business) WHERE b.profileFetchedAt IS NULL AND b.slug IS NOT NULL
       OPTIONAL MATCH (s)-[:MENTIONS_BUSINESS]->(b)
       RETURN b.slug AS slug, count(s) AS mentions ORDER BY mentions DESC LIMIT $limit`,
      { limit },
    );
    return rows.map((row) => String(row.slug));
  }

  /** Most active neighborhoods by posts seen, for neighborhood feeds. */
  async topNeighborhoods(limit: number): Promise<string[]> {
    const rows = await this.run(
      `MATCH (p:Post)-[:FROM_HOOD]->(n:Neighborhood) WHERE n.slug IS NOT NULL
       RETURN n.slug AS slug, count(p) AS posts ORDER BY posts DESC LIMIT $limit`,
      { limit },
    );
    return rows.map((row) => String(row.slug));
  }

  async agencies(limit: number): Promise<string[]> {
    const rows = await this.run(
      `MATCH (a:Agency) OPTIONAL MATCH (:User)-[:SPEAKS_FOR]->(a)
       RETURN a.id AS id, count(*) AS staff ORDER BY staff DESC LIMIT $limit`,
      { limit },
    );
    return rows.map((row) => String(row.id));
  }

  async topMentionedBusinesses(limit: number): Promise<string[]> {
    const rows = await this.run(
      `MATCH (s)-[:MENTIONS_BUSINESS]->(b:Business) WHERE b.slug IS NOT NULL
       RETURN b.slug AS slug, count(s) AS mentions ORDER BY mentions DESC LIMIT $limit`,
      { limit },
    );
    return rows.map((row) => String(row.slug));
  }

  /**
   * Neighbors whose post histories to read next: never-read ones first (most
   * active first), then the longest since their last read, so successive syncs
   * work down the whole list instead of rereading the same people.
   */
  async authorsNeedingHistories(limit: number, staleBefore: string): Promise<string[]> {
    const rows = await this.run(
      `MATCH (u:User)-[:POSTED|COMMENTED]->(x)
       WHERE u.kind = 'NEIGHBOR' AND u.secureId IS NOT NULL
         AND (u.historyFetchedAt IS NULL OR u.historyFetchedAt < timestamp($staleBefore))
       WITH u, count(x) AS activity
       RETURN u.secureId AS id
       ORDER BY u.historyFetchedAt IS NULL DESC, u.historyFetchedAt, activity DESC LIMIT $limit`,
      { limit, staleBefore },
    );
    return rows.map((row) => String(row.id));
  }

  async markHistoryRead(secureId: string, now: string): Promise<void> {
    await this.run('MATCH (u:User {secureId: $secureId}) SET u.historyFetchedAt = timestamp($now)', { secureId, now });
  }

  async groups(): Promise<string[]> {
    return (await this.run('MATCH (g:InterestGroup) RETURN g.id AS id')).map((row) => String(row.id));
  }

  /**
   * Posts without judgments for this question-set version, newest first, with what the decision
   * model needs to judge them. A null version returns the newest posts whether judged or not.
   */
  async postsNeedingJudgments(version: string | null, limit: number): Promise<Row[]> {
    const pending = version === null ? '' : 'AND (p.jevVersion IS NULL OR p.jevVersion <> $version)';
    return this.run(
      `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.body IS NOT NULL ${pending}
       OPTIONAL MATCH (p)-[:REPOSTS]->(o:Post)
       RETURN p.id AS id, p.subject AS subject, p.body AS body, p.hashtags AS hashtags,
              o.subject AS repostSubject, o.body AS repostBody
       ORDER BY p.createdAt DESC LIMIT $limit`,
      version === null ? { limit } : { version, limit },
    );
  }

  /** Comments without judgments for this question-set version; a null version returns the newest ones. */
  async commentsNeedingJudgments(version: string | null, limit: number): Promise<Row[]> {
    const pending = version === null ? '' : 'AND (c.jevVersion IS NULL OR c.jevVersion <> $version)';
    return this.run(
      `MATCH (c:Comment)-[:ON_POST]->(p:Post) WHERE c.removedAt IS NULL AND c.body IS NOT NULL AND c.body <> ''
         ${pending}
       OPTIONAL MATCH (c)-[:REPLY_TO]->(t:Comment)
       OPTIONAL MATCH (a:User)-[:COMMENTED]->(c)
       OPTIONAL MATCH (ta:User)-[:COMMENTED]->(t)
       RETURN c.id AS id, c.body AS body, a.name AS author, p.id AS postId, p.subject AS postSubject,
              p.body AS postBody, t.body AS targetBody, ta.name AS targetAuthor
       ORDER BY c.createdAt DESC LIMIT $limit`,
      version === null ? { limit } : { version, limit },
    );
  }

  // --- opinions of businesses ------------------------------------------------------

  /** Business mentions without an opinion judgment, with the text and context Jev needs. */
  async mentionsNeedingOpinions(limit: number): Promise<Row[]> {
    const comments = await this.run(
      `MATCH (x:Comment)-[m:MENTIONS_BUSINESS]->(b:Business) WHERE m.opinion IS NULL AND x.body IS NOT NULL AND x.body <> ''
       OPTIONAL MATCH (x)-[:ON_POST]->(p:Post)
       OPTIONAL MATCH (x)-[:REPLY_TO]->(t:Comment)
       RETURN 'Comment' AS kind, x.id AS id, b.id AS business, b.name AS name, b.category AS category,
              x.body AS text, p.subject AS topic, t.body AS answering
       ORDER BY x.createdAt DESC LIMIT $limit`,
      { limit },
    );
    const posts = await this.run(
      `MATCH (x:Post)-[m:MENTIONS_BUSINESS]->(b:Business) WHERE m.opinion IS NULL AND x.body IS NOT NULL
       RETURN 'Post' AS kind, x.id AS id, b.id AS business, b.name AS name, b.category AS category,
              x.body AS text, x.subject AS topic, null AS answering
       ORDER BY x.createdAt DESC LIMIT $limit`,
      { limit },
    );
    return [...comments, ...posts].slice(0, limit);
  }

  /** Posts about any of `themes` not yet judged for where their situation is (place question set `set`). */
  async postsNeedingPlace(themes: string[], set: string, limit: number): Promise<Row[]> {
    return this.run(
      `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.body IS NOT NULL AND (p.placeSet IS NULL OR p.placeSet <> $set)
         AND EXISTS { MATCH (p)-[a:ABOUT]->(t:Theme) WHERE a.p >= 0.5 AND list_contains($themes, t.name) }
       OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
       RETURN p.id AS id, p.subject AS subject, p.body AS body, n.name AS hood, n.city AS city
       ORDER BY p.createdAt DESC LIMIT $limit`,
      { themes, set, limit },
    );
  }

  /** Which of these posts were already in the graph before `since` (so not new to this run). */
  async postsKnownBefore(ids: string[], since: string): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.run(
      'MATCH (p:Post) WHERE list_contains($ids, p.id) AND p.firstSeen < timestamp($since) RETURN p.id AS id',
      { ids, since },
    );
    return new Set(rows.map((row) => String(row.id)));
  }

  /** Posts and comments first seen at or after `since`. */
  async newSince(since: string): Promise<{ posts: number; comments: number }> {
    const [posts] = await this.run('MATCH (p:Post) WHERE p.firstSeen >= timestamp($since) RETURN count(p) AS n', {
      since,
    });
    const [comments] = await this.run('MATCH (c:Comment) WHERE c.firstSeen >= timestamp($since) RETURN count(c) AS n', {
      since,
    });
    return { posts: Number(posts?.n ?? 0), comments: Number(comments?.n ?? 0) };
  }

  async savePlace(postId: string, scope: string, confidence: number, set: string): Promise<void> {
    await this.run(
      'MATCH (p:Post {id: $id}) SET p.placeScope = $scope, p.placeScopeConfidence = $confidence, p.placeSet = $set',
      { id: postId, scope, confidence, set },
    );
  }

  async saveOpinion(
    kind: 'Post' | 'Comment',
    id: string,
    businessId: string,
    opinion: string,
    confidence: number,
  ): Promise<void> {
    await this.run(
      `MATCH (x:${kind === 'Post' ? 'Post' : 'Comment'} {id: $id})-[m:MENTIONS_BUSINESS]->(:Business {id: $business})
       SET m.opinion = $opinion, m.opinionConfidence = $confidence`,
      { id, business: businessId, opinion, confidence },
    );
  }

  // --- discovered themes (discover.ts) -----------------------------------------

  /** Posts with text for theme discovery, with how well the built-in themes fit them (null: not judged). */
  async discoveryCandidates(since: string, limit: number): Promise<Row[]> {
    return this.run(
      `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.body IS NOT NULL AND p.createdAt >= timestamp($since)
       OPTIONAL MATCH (p)-[a:ABOUT]->(t:Theme) WHERE t.source IS NULL
       WITH p, max(a.p) AS fit
       RETURN p.id AS id, p.subject AS subject, p.body AS body, fit, p.primaryTheme AS primaryTheme,
              coalesce(p.reactions, 0) + coalesce(p.commentCount, 0) AS engagement
       ORDER BY engagement DESC LIMIT $limit`,
      { since, limit },
    );
  }

  /** Make the graph's discovered themes match `themes`; themes dropped from the set lose their edges. */
  async setDiscoveredThemes(themes: Record<string, string>): Promise<void> {
    await this.run(
      `MATCH (t:Theme) WHERE t.source = 'discovered' AND NOT list_contains($names, t.name) DETACH DELETE t`,
      { names: Object.keys(themes) },
    );
    for (const [name, description] of Object.entries(themes)) {
      await this.run(`MERGE (t:Theme {name: $name}) SET t.source = 'discovered', t.description = $description`, {
        name,
        description,
      });
    }
  }

  /** Posts not yet judged against discovered theme set `setId`. */
  async postsNeedingThemeSet(setId: string, limit: number): Promise<Row[]> {
    return this.run(
      `MATCH (p:Post) WHERE p.removedAt IS NULL AND p.body IS NOT NULL AND (p.themeSet IS NULL OR p.themeSet <> $setId)
       OPTIONAL MATCH (p)-[:REPOSTS]->(o:Post)
       RETURN p.id AS id, p.subject AS subject, p.body AS body, o.subject AS repostSubject, o.body AS repostBody
       ORDER BY p.createdAt DESC LIMIT $limit`,
      { setId, limit },
    );
  }

  async saveThemeSet(postId: string, setId: string, probabilities: Record<string, number>): Promise<void> {
    await this.run('MATCH (p:Post {id: $id}) SET p.themeSet = $setId', { id: postId, setId });
    for (const [theme, p] of Object.entries(probabilities)) {
      await this.run(`MATCH (t:Theme {name: $theme}), (s:Post {id: $id}) MERGE (s)-[a:ABOUT]->(t) SET a.p = $p`, {
        theme,
        id: postId,
        p,
      });
    }
  }

  async counts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const name of Object.keys(NODE_TABLES)) {
      const rows = await this.run(`MATCH (n:${name}) RETURN count(n) AS n`);
      counts[name] = Number(rows[0]?.n ?? 0);
    }
    return counts;
  }
}
