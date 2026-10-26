import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lbug from '@ladybugdb/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertReadQuery, GraphStore } from '../src/lib/graph.js';
import { mapPost, type Post, resolveReplyTargets } from '../src/lib/model.js';
import { author, comment, neighborhood, post, repostOf } from './fixtures/payloads.js';

// Integration tests: a real LadybugDB file, no mocks.

const NOW = '2026-10-11T08:00:00.000Z';
const LATER = '2026-10-12T08:00:00.000Z';
const ACME = { id: 'entity_9', name: 'Acme', slug: 'acme-bakery' };

function thread(comments = defaultComments()): Post {
  const p = mapPost(
    post('T1', {
      author: author('Alex Neighbor', 1, neighborhood(3, 'Cedar Park')),
      comments,
    }),
  )!;
  resolveReplyTargets(p.comments);
  return p;
}

function defaultComments() {
  return [
    comment(10, 'where to eat?', {
      author: author('Bea', 2),
      minutesAgo: 30,
      replies: [
        comment(11, '@Bea try Acme', {
          author: author('Cal', 3),
          parent: 10,
          mentions: [2],
          minutesAgo: 20,
          businesses: [ACME],
        }),
      ],
    }),
    comment(12, 'agreed', { author: author('Dee', 4), minutesAgo: 10 }),
  ];
}

let store: GraphStore;
let dbPath: string;

beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'ndoor-graph-')), 'nested', 'graph.lbug');
  store = await GraphStore.open(dbPath);
});

afterEach(async () => {
  await store?.close();
});

describe('GraphStore', () => {
  it('creates a private database file with the schema', async () => {
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(await store.counts()).toMatchObject({ Post: 0, User: 0 });
  });

  it('ingests a thread as people, posts, comments, replies, mentions, and businesses', async () => {
    await store.ingestPost(thread(), NOW);
    const counts = await store.counts();
    expect(counts).toMatchObject({ Post: 1, Comment: 3, User: 4, Business: 1, Topic: 1, Neighborhood: 2 });

    const reply = await store.run(
      `MATCH (a:User)-[:COMMENTED]->(c:Comment)-[:REPLY_TO]->(t:Comment)<-[:COMMENTED]-(b:User)
       RETURN a.name AS from, b.name AS to, c.body AS body`,
    );
    expect(reply).toEqual([{ from: 'Cal', to: 'Bea', body: '@Bea try Acme' }]);

    const recs = await store.run(
      'MATCH (u:User)-[:COMMENTED]->(c:Comment)-[:MENTIONS_BUSINESS]->(b:Business) RETURN u.name AS who, b.slug AS slug',
    );
    expect(recs).toEqual([{ who: 'Cal', slug: 'acme-bakery' }]);

    const home = await store.run(
      "MATCH (u:User {id: 'user_1'})-[:LIVES_IN]->(n:Neighborhood) RETURN n.name AS hood, n.slug AS slug",
    );
    expect(home).toEqual([{ hood: 'Cedar Park', slug: 'cedarpark' }]);

    const stored = await store.run("MATCH (p:Post {id: 'post_T1'}) RETURN p.reactions AS r, p.createdAt AS at");
    expect(stored[0].r).toBe(5);
    expect(stored[0].at).toBeInstanceOf(Date);
  });

  it('is idempotent and keeps the first-seen time', async () => {
    await store.ingestPost(thread(), NOW);
    await store.ingestPost(thread(), LATER);
    expect(await store.counts()).toMatchObject({ Post: 1, Comment: 3, User: 4 });
    const edges = await store.run('MATCH ()-[r:COMMENTED]->() RETURN count(r) AS n');
    expect(edges[0].n).toBe(3);
    const seen = await store.run("MATCH (p:Post {id: 'post_T1'}) RETURN p.firstSeen AS first, p.lastSeen AS last");
    expect((seen[0].first as Date).toISOString()).toBe(NOW);
    expect((seen[0].last as Date).toISOString()).toBe(LATER);
  });

  it('marks comments that disappear from a reloaded thread as removed', async () => {
    const first = thread();
    await store.ingestPost(first, NOW);
    expect(await store.markThreadFetched(first, NOW)).toBe(0);

    const reloaded = thread([comment(12, 'agreed', { author: author('Dee', 4), minutesAgo: 10 })]);
    await store.ingestPost(reloaded, LATER);
    expect(await store.markThreadFetched(reloaded, LATER)).toBe(2);

    const removed = await store.run(
      'MATCH (u:User)-[:COMMENTED]->(c:Comment) WHERE c.removedAt IS NOT NULL RETURN u.name AS who ORDER BY who',
    );
    expect(removed.map((row) => row.who)).toEqual(['Bea', 'Cal']);
  });

  it('keeps the text of a comment that later comes back deleted', async () => {
    await store.ingestPost(thread(), NOW);
    const deleted = thread([comment(12, '', { author: author('Dee', 4), deleted: true })]);
    await store.ingestPost(deleted, LATER);
    const row = await store.run(
      "MATCH (c:Comment {id: 'comment_12'}) RETURN c.body AS body, c.isDeleted AS d, c.removedAt AS at",
    );
    expect(row[0]).toMatchObject({ body: 'agreed', d: true });
    expect((row[0].at as Date).toISOString()).toBe(LATER);
  });

  it('marks removed posts once and drops them from the thread queue', async () => {
    await store.ingestPost(thread(), NOW);
    expect(
      await store.postsNeedingThreads({
        recheckSince: '2026-01-01T00:00:00Z',
        refetchBefore: NOW,
        now: NOW,
        limit: 10,
      }),
    ).toEqual(['post_T1']);
    await store.markPostRemoved('post_T1', 'not found', NOW);
    await store.markPostRemoved('post_T1', 'second reason', LATER);
    const row = await store.run("MATCH (p:Post {id: 'post_T1'}) RETURN p.removedReason AS reason");
    expect(row[0].reason).toBe('not found');
    expect(
      await store.postsNeedingThreads({
        recheckSince: '2026-01-01T00:00:00Z',
        refetchBefore: LATER,
        now: LATER,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('queues never-loaded threads only for posts made since the cutoff', async () => {
    await store.ingestPost(thread(), NOW);
    const queue = (unreadSince?: string) =>
      store.postsNeedingThreads({
        recheckSince: '2026-01-01T00:00:00Z',
        refetchBefore: NOW,
        now: NOW,
        limit: 10,
        unreadSince,
      });
    // The post was made the day before NOW.
    expect(await queue()).toEqual(['post_T1']);
    expect(await queue('2026-10-10T00:00:00Z')).toEqual(['post_T1']);
    expect(await queue('2026-10-11T00:00:00Z')).toEqual([]);
  });

  it('rechecks a thread after waiting as long as it was old, so rechecks thin out with age', async () => {
    const p = thread();
    await store.ingestPost(p, NOW);
    // The post is 21 hours old at NOW, so its next deletion check is 21 hours later.
    await store.markThreadFetched(p, NOW);
    const recheck = { recheckSince: '2026-01-01T00:00:00Z', refetchBefore: '2000-01-01T00:00:00Z', limit: 10 };
    expect(await store.postsNeedingThreads({ ...recheck, now: NOW })).toEqual([]);
    expect(await store.postsNeedingThreads({ ...recheck, now: '2026-10-12T04:00:00.000Z' })).toEqual([]);
    expect(await store.postsNeedingThreads({ ...recheck, now: LATER })).toEqual(['post_T1']);
    // Loaded again at 45 hours old: the next check waits 45 hours.
    await store.markThreadFetched(p, LATER);
    expect(await store.postsNeedingThreads({ ...recheck, now: '2026-10-13T20:00:00.000Z' })).toEqual([]);
    expect(await store.postsNeedingThreads({ ...recheck, now: '2026-10-14T06:00:00.000Z' })).toEqual(['post_T1']);
    // Past the recheck window, it is never reloaded for deletions again.
    expect(
      await store.postsNeedingThreads({
        ...recheck,
        recheckSince: '2026-10-11T00:00:00Z',
        now: '2026-10-20T00:00:00Z',
      }),
    ).toEqual([]);
  });

  it('stores profiles, moving a user to their real home neighborhood', async () => {
    await store.ingestPost(thread(), NOW);
    expect(await store.usersNeedingProfiles(10)).toContain('secureUser_1');
    await store.upsertUserProfile(
      {
        id: 'user_1',
        secureId: 'secureUser_1',
        name: 'Alex Neighbor',
        neighborhood: {
          id: 'neighborhood_8',
          name: 'Maple Grove',
          slug: 'maplegrove',
          city: 'Springfield',
          state: 'IL',
        },
        residentSince: 2017,
        pronouns: null,
        biography: '',
        profileType: 'NEIGHBORHOOD_USER',
        badges: ['lead'],
        helpfulScore: null,
        ownedBusinesses: [],
      },
      LATER,
    );
    const home = await store.run(
      "MATCH (u:User {id: 'user_1'})-[:LIVES_IN]->(n) RETURN n.name AS hood, u.residentSince AS since, u.badges AS badges",
    );
    expect(home).toEqual([{ hood: 'Maple Grove', since: 2017, badges: ['lead'] }]);
    expect(await store.usersNeedingProfiles(10)).not.toContain('secureUser_1');
  });

  it('stores judgments and themes', async () => {
    await store.ingestPost(thread(), NOW);
    expect((await store.postsNeedingJudgments('v1', 10)).map((row) => row.id)).toEqual(['post_T1']);
    await store.saveJudgments({
      subjectId: 'post_T1',
      kind: 'post',
      version: 'v1',
      properties: { tone: 0.75, primaryTheme: 'services_recommendations', intent: 'ask_recommendation' },
      themes: { services_recommendations: 0.9, crime_safety: 0.02 },
    });
    expect(await store.postsNeedingJudgments('v1', 10)).toEqual([]);
    // Without a version, judged posts and comments come back too (model comparisons sample them).
    expect((await store.postsNeedingJudgments(null, 10)).map((row) => row.id)).toEqual(['post_T1']);
    expect((await store.commentsNeedingJudgments(null, 10)).length).toBe(
      (await store.commentsNeedingJudgments('v1', 10)).length,
    );
    const themes = await store.run('MATCH (:Post)-[a:ABOUT]->(t:Theme) WHERE a.p >= 0.5 RETURN t.name AS theme');
    expect(themes).toEqual([{ theme: 'services_recommendations' }]);

    const pending = await store.commentsNeedingJudgments('v1', 10);
    const reply = pending.find((row) => row.id === 'comment_11');
    expect(reply).toMatchObject({ targetAuthor: 'Bea', targetBody: 'where to eat?', postSubject: 'Subject T1' });
  });

  it('records my reactions from the activity log', async () => {
    await store.ingestPost(thread(), NOW);
    await store.upsertAuthor(
      {
        id: 'user_42',
        secureId: null,
        name: 'Me',
        type: 'NEIGHBOR',
        profileUrl: null,
        neighborhood: null,
        agency: null,
        pageSlug: null,
      },
      NOW,
    );
    const n = await store.ingestReactions(
      'user_42',
      [
        { kind: 'reaction_to_post', postId: 'post_T1', at: NOW, summary: '' },
        { kind: 'comment', postId: 'post_T1', at: NOW, summary: '' },
      ],
      NOW,
    );
    expect(n).toBe(1);
    const rows = await store.run(
      "MATCH (:User {id: 'user_42'})-[r:REACTED]->(p:Post) RETURN p.id AS id, r.kind AS kind",
    );
    expect(rows).toEqual([{ id: 'post_T1', kind: 'reaction_to_post' }]);
  });
});

describe('reports', () => {
  it('every built-in report runs against a populated graph', async () => {
    const { REPORTS } = await import('../src/lib/reports.js');
    await store.ingestPost(thread(), NOW);
    await store.saveJudgments({
      subjectId: 'post_T1',
      kind: 'post',
      version: 'v1',
      properties: { tone: 0.75, hostility: 2 },
      themes: { services_recommendations: 0.9 },
    });
    await store.saveJudgments({
      subjectId: 'comment_11',
      kind: 'comment',
      version: 'v1',
      properties: { stance: 'informs', tone: 0.5, hostility: 0, recommendsBusiness: 0.9 },
    });
    await store.markThreadFetched(thread([]), LATER);
    await store.recordSync('s1', NOW, LATER, { posts: 1 });
    for (const [name, report] of Object.entries(REPORTS)) {
      const rows = await store.run(report.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' }).catch((error) => {
        throw new Error(`report ${name}: ${error.message}`);
      });
      expect(Array.isArray(rows), name).toBe(true);
    }
    const businesses = await store.run(REPORTS.businesses.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(businesses[0]).toMatchObject({ business: 'Acme', people: 1, judged: 0, favorable: 0 });
    await store.saveOpinion('Comment', 'comment_11', 'entity_9', 'unfavorable', 0.9);
    const judged = await store.run(REPORTS.businesses.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(judged[0]).toMatchObject({ judged: 1, favorable: 0, unfavorable: 1 });
    const removed = await store.run(REPORTS.removed.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(removed.map((row) => row.name).sort()).toEqual(['Bea', 'Cal', 'Dee']);
    const themes = await store.run(REPORTS.themes.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(themes[0]).toMatchObject({ theme: 'services_recommendations', posts: 1, hostilePct: 100 });
    const before = await store.run(REPORTS.influencers.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(before.find((row) => row.name === 'Alex Neighbor')).toMatchObject({ posts: 1, historyRead: false });
    await store.markHistoryRead('secureUser_1', LATER);
    const after = await store.run(REPORTS.influencers.cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(after.find((row) => row.name === 'Alex Neighbor')).toMatchObject({ historyRead: true });
  });
});

describe('repost originals', () => {
  it('queues a post known only from a repost, and leaves it out of reaction rankings until loaded', async () => {
    const raw = post('R1', { author: author('Alex Neighbor', 1) }) as Record<string, unknown>;
    raw.repostInfo = { item: repostOf('ORIG', 'Earned.', 'Taxes fund roads.') };
    await store.ingestPost(mapPost(raw)!, NOW);
    await store.markThreadFetched(mapPost(raw)!, NOW);
    const queue = await store.postsNeedingThreads({ recheckSince: LATER, refetchBefore: NOW, now: NOW, limit: 10 });
    expect(queue).toEqual(['post_ORIG']);
    const { REPORTS } = await import('../src/lib/reports.js');
    const top = await store.run(REPORTS['top-posts'].cypher, { limit: 10, since: '2000-01-01T00:00:00Z' });
    expect(top.map((row) => row.post)).not.toContain('Earned.');
    expect(top.every((row) => typeof row.reactions === 'number')).toBe(true);
  });
});

describe('groups and transactions', () => {
  it('links only real memberships and drops stale ones', async () => {
    await store.upsertAuthor(
      {
        id: 'user_42',
        secureId: null,
        name: 'Me',
        type: 'NEIGHBOR',
        profileUrl: null,
        neighborhood: null,
        agency: null,
        pageSlug: null,
      },
      NOW,
    );
    await store.upsertGroups([{ id: 'group_1', name: 'Mine', members: 5, isMember: true }], 'user_42', NOW);
    await store.upsertGroups([{ id: 'group_1', name: 'Mine', members: 5, isMember: false }], 'user_42', LATER);
    expect(await store.run('MATCH ()-[r:MEMBER_OF]->() RETURN count(r) AS n')).toEqual([{ n: 0 }]);
  });

  it('rolls back a failed transaction', async () => {
    await expect(
      store.transaction(async () => {
        await store.ingestPost(thread(), NOW);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await store.counts()).Post).toBe(0);
  });
});

describe('read-only access', () => {
  it('refuses a missing graph and rejects writes', async () => {
    await expect(GraphStore.open(join(tmpdir(), 'ndoor-none', 'missing.lbug'), { readOnly: true })).rejects.toThrow(
      /ndoor sync/,
    );
    await store.ingestPost(thread(), NOW);
    await store.close();
    const reader = await GraphStore.open(dbPath, { readOnly: true });
    try {
      expect((await reader.counts()).Post).toBe(1);
      await expect(reader.run("CREATE (:Topic {name: 'x'})")).rejects.toThrow();
    } finally {
      await reader.close();
    }
    store = await GraphStore.open(dbPath);
  });
});

describe('assertReadQuery', () => {
  const allowed = [
    'MATCH (p:Post) RETURN count(p) AS n',
    'OPTIONAL MATCH (u:User) RETURN u.name;',
    "MATCH (p:Post) WHERE p.body CONTAINS 'water main' RETURN p.id",
    'MATCH (p:Post) WHERE p.body CONTAINS $text RETURN p.id',
    'WITH 1 AS x RETURN x',
    'UNWIND [1, 2] AS x RETURN x',
  ];
  const rejected = [
    "LOAD FROM '/etc/passwd' RETURN *",
    "MATCH (p:Post) RETURN p.id; LOAD FROM '/etc/passwd' RETURN *",
    'INSTALL httpfs',
    'LOAD EXTENSION httpfs',
    "CALL current_setting('home_directory') RETURN *",
    'MATCH (p:Post) CALL show_tables() RETURN *',
    "ATTACH '/tmp/x.lbug' AS other (dbtype lbug)",
    "MATCH (p:Post) SET p.body = 'x'",
    'MATCH (p:Post) DETACH DELETE p',
    "COPY Post FROM '/tmp/x.csv'",
    "MATCH (p:Post) WITH p LOAD FROM 'https://evil.example/' RETURN *",
    // Parser differentials: a quote inside a comment or string must not hide a statement.
    "MATCH (n) RETURN 1 // it's\n; LOAD FROM '/etc/passwd' RETURN *",
    "MATCH (n) RETURN 1 /* ' */ LOAD FROM '/etc/passwd' RETURN *",
    "MATCH (n) WHERE n.x = 'a\\' RETURN 1; LOAD FROM '/etc/passwd' RETURN * //'",
    'MATCH (n) RETURN `x;` ',
    // Conservative by design: forbidden words are refused even in literals and identifiers.
    "MATCH (p:Post) WHERE p.body CONTAINS 'load from' RETURN p.id",
    'MATCH (`set`:User) RETURN `set`.name',
    '// comment first\nMATCH (n) RETURN n',
  ];
  it.each(allowed)('allows %s', (cypher) => expect(() => assertReadQuery(cypher)).not.toThrow());
  it.each(rejected)('rejects %s', (cypher) => expect(() => assertReadQuery(cypher)).toThrow());
});

describe('schema migration', () => {
  // A graph created by an older ndoor: Sync without meId, Theme without its later columns.
  // (Simulating one with ALTER ... DROP instead crashes LadybugDB on the next write to the re-added column.)
  async function legacyGraph(): Promise<string> {
    const path = join(mkdtempSync(join(tmpdir(), 'ndoor-legacy-')), 'graph.lbug');
    const db = new lbug.Database(path, 256 * 1024 * 1024, true, false, 1024 * 1024 * 1024);
    const conn = new lbug.Connection(db);
    await conn.query(
      'CREATE NODE TABLE Sync(id STRING PRIMARY KEY, startedAt TIMESTAMP, finishedAt TIMESTAMP, stats STRING)',
    );
    await conn.query('CREATE NODE TABLE Theme(name STRING PRIMARY KEY)');
    await conn.query("CREATE (:Theme {name: 'crime_safety'})");
    await conn.close();
    await db.close();
    return path;
  }

  it('adds columns declared after a graph was created', async () => {
    const legacy = await GraphStore.open(await legacyGraph());
    try {
      await legacy.recordSync('s1', NOW, LATER, {}, 'user_42');
      expect(await legacy.meId()).toBe('user_42');
    } finally {
      await legacy.close();
    }
  });

  it('adds relationship properties declared later and treats their absence as stale', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ndoor-legacy-rel-')), 'graph.lbug');
    const db = new lbug.Database(path, 256 * 1024 * 1024, true, false, 1024 * 1024 * 1024);
    const conn = new lbug.Connection(db);
    await conn.query('CREATE NODE TABLE Comment(id STRING PRIMARY KEY)');
    await conn.query('CREATE NODE TABLE Post(id STRING PRIMARY KEY)');
    await conn.query('CREATE NODE TABLE Business(id STRING PRIMARY KEY)');
    await conn.query('CREATE REL TABLE MENTIONS_BUSINESS(FROM Post TO Business, FROM Comment TO Business)');
    await conn.query("CREATE (:Comment {id: 'c'}), (:Business {id: 'b'})");
    await conn.query("MATCH (c:Comment {id: 'c'}), (b:Business {id: 'b'}) CREATE (c)-[:MENTIONS_BUSINESS]->(b)");
    await conn.close();
    await db.close();
    const reader = await GraphStore.open(path, { readOnly: true });
    try {
      expect(await reader.run('MATCH ()-[m:MENTIONS_BUSINESS]->() RETURN m.opinion AS opinion')).toEqual([
        { opinion: null },
      ]);
    } finally {
      await reader.close();
    }
  });

  it('migrates a stale graph before a read-only open', async () => {
    const reader = await GraphStore.open(await legacyGraph(), { readOnly: true });
    try {
      expect(await reader.run('MATCH (t:Theme) RETURN t.name AS name, t.source AS source')).toEqual([
        { name: 'crime_safety', source: null },
      ]);
      await expect(reader.run("CREATE (:Theme {name: 'x'})")).rejects.toThrow(/read-only/);
    } finally {
      await reader.close();
    }
  });
});
