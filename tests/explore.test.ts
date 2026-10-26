import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessSentiment,
  businessVerdict,
  describe as describeNode,
  ExploreError,
  health,
  links,
  network,
  nodeDetail,
  overview,
  personSentiment,
  personVerdict,
  type Query,
  REL_ENDPOINTS,
  scoreHealth,
  search,
  thread,
} from '../src/lib/explore.js';
import { GraphStore } from '../src/lib/graph.js';
import { createUiServer, sharedReader } from '../src/lib/ui-server.js';
import { buildCommunityGraph, SINCE } from './fixtures/graph.js';

// Integration tests: a real LadybugDB file built from fixture payloads, and a real HTTP server.

const TOKEN = 'test-token-0123456789';

let dbPath: string;

beforeAll(async () => {
  dbPath = await buildCommunityGraph();
});

describe('explore over a real graph', () => {
  let store: GraphStore;
  let query: Query;

  beforeAll(async () => {
    store = await GraphStore.open(dbPath, { readOnly: true });
    query = (cypher, params) => store.run(cypher, params);
  });

  afterAll(async () => {
    await store?.close();
  });

  it('reads relationship endpoints from the schema', () => {
    expect(REL_ENDPOINTS.filter((e) => e.rel === 'MENTIONS')).toEqual([
      { rel: 'MENTIONS', from: 'Post', to: 'User' },
      { rel: 'MENTIONS', from: 'Comment', to: 'User' },
    ]);
  });

  it('titles nodes by type', () => {
    expect(describeNode('User', { id: 'u', name: 'Bea', kind: 'NEIGHBOR' })).toEqual({
      label: 'User',
      key: 'u',
      title: 'Bea',
      subtitle: null,
    });
    expect(describeNode('Theme', { name: 'trolley', source: 'discovered' }).subtitle).toBe('discovered');
    expect(describeNode('Post', { id: 'p', subject: '', body: 'x'.repeat(200) }).title).toHaveLength(120);
    expect(describeNode('Agency', { id: 'a' }).title).toBe('a');
  });

  it('shows a node with every kind of link, confident themes only', async () => {
    const detail = await nodeDetail(query, 'Post', 'post_T1');
    expect(detail.ref.title).toBe('Where to eat by the water?');
    expect(detail.properties).toMatchObject({ id: 'post_T1', tone: 0.7 });
    expect(Object.keys(detail.properties).some((name) => name.startsWith('_'))).toBe(false);
    const groups = Object.fromEntries(detail.links.map((g) => [`${g.rel}:${g.direction}:${g.label}`, g]));
    expect(groups['ON_POST:in:Comment'].total).toBe(3);
    expect(groups['POSTED:in:User'].nodes[0].title).toBe('Alex Neighbor');
    expect(groups['ABOUT:out:Theme'].nodes.map((n) => [n.key, n.edge.p])).toEqual([['services_recommendations', 0.9]]);
  });

  it('pages links and rejects unknown types, relationships, and nodes', async () => {
    const page = await links(query, 'User', 'user_1', 'POSTED', 'out', 'Post', { limit: 2, offset: 0 });
    expect(page.total).toBe(4);
    expect(page.nodes).toHaveLength(2);
    const rest = await links(query, 'User', 'user_1', 'POSTED', 'out', 'Post', { limit: 10, offset: 2 });
    expect(rest.nodes).toHaveLength(2);
    await expect(nodeDetail(query, 'Sync', 'x')).rejects.toMatchObject({ status: 400 });
    await expect(nodeDetail(query, 'User', 'nobody')).rejects.toMatchObject({ status: 404 });
    await expect(links(query, 'User', 'user_1', 'POSTED', 'in', 'Post', { limit: 1 })).rejects.toBeInstanceOf(
      ExploreError,
    );
    await expect(links(query, 'User', 'user_1', 'DROP', 'out', 'Post', { limit: 1 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('searches across types, case-insensitively', async () => {
    const groups = await search(query, 'ACME');
    expect(groups.map((g) => g.label)).toEqual(['Business', 'Comment']);
    expect(groups[0].nodes[0]).toMatchObject({ key: 'entity_9', title: 'Acme' });
    expect(await search(query, 'd')).toEqual([]);
  });

  it('returns a thread with authors, reply targets, and judgments', async () => {
    const result = await thread(query, 'post_T1');
    expect(result.author).toEqual({ id: 'user_1', name: 'Alex Neighbor' });
    const reply = result.comments.find((c) => c.id === 'comment_11')!;
    expect(reply).toMatchObject({ replyTo: 'comment_10', stance: 'disagrees', tone: 0.3, author: { name: 'Cal' } });
    expect(result.comments.map((c) => c.id)).toEqual(['comment_10', 'comment_11', 'comment_12']);
    await expect(thread(query, 'post_missing')).rejects.toMatchObject({ status: 404 });
  });

  it('builds the who-talks-to-whom network, optionally with businesses', async () => {
    const plain = await network(query, { since: SINCE, minWeight: 1, limit: 100 });
    const pairs = plain.links.map((l) => `${l.kind}:${l.source}->${l.target}:${l.disagreements}`).sort();
    expect(pairs).toEqual(['comment:user_2->user_1:0', 'comment:user_4->user_1:0', 'reply:user_3->user_2:1']);
    expect(plain.nodes.find((n) => n.id === 'user_1')).toMatchObject({
      name: 'Alex Neighbor',
      posts: 4,
      group: 'Cedar Park',
    });

    const withBusinesses = await network(query, { since: SINCE, minWeight: 1, limit: 100, businesses: true });
    expect(withBusinesses.links.find((l) => l.kind === 'recommends')).toMatchObject({
      source: 'user_3',
      target: 'entity_9',
    });
    expect(withBusinesses.nodes.find((n) => n.id === 'entity_9')?.label).toBe('Business');

    const heavy = await network(query, { since: SINCE, minWeight: 2, limit: 100 });
    expect(heavy).toEqual({ nodes: [], links: [] });
  });

  it('sums up a person: their writing, their stances, and how others answer them', async () => {
    const alex = await personSentiment(query, 'user_1');
    expect(alex.own).toMatchObject({ items: 1, tone: 0.7, positive: 1 });
    expect(alex.verdict).toBeNull();
    expect(alex.received).toMatchObject({ items: 2, positive: 1, neutral: 1, disagreements: 0 });
    expect(alex.received.tone).toBeCloseTo(0.65);
    const cal = await personSentiment(query, 'user_3');
    expect(cal.stances).toEqual({ disagrees: 1 });
    expect(cal.own).toMatchObject({ items: 1, negative: 1 });
    expect(cal.communityTone).toBeCloseTo((0.7 + 0.3 + 0.8 + 0.5) / 4);
  });

  it('gives verdicts only with enough judged content', () => {
    const mix = (items: number, tone: number) => ({ items, tone, positive: 0, neutral: 0, negative: 0, hostile: 0 });
    expect(personVerdict(mix(5, 0.7))).toBe('positive');
    expect(personVerdict(mix(5, 0.5))).toBe('neutral');
    expect(personVerdict(mix(5, 0.3))).toBe('negative');
    expect(personVerdict(mix(2, 0.9))).toBeNull();
    expect(businessVerdict({ mentions: 10, favorable: 7, unfavorable: 1 })).toBe('liked');
    expect(businessVerdict({ mentions: 10, favorable: 4, unfavorable: 4 })).toBe('criticized');
    expect(businessVerdict({ mentions: 10, favorable: 5, unfavorable: 2 })).toBe('mixed');
    expect(businessVerdict({ mentions: 2, favorable: 2, unfavorable: 0 })).toBeNull();
  });

  it('judges a business by the opinion of each mention, not the comment tone', async () => {
    const acme = await businessSentiment(query, 'entity_9');
    expect(acme).toMatchObject({ mentions: 1, judged: 1, favorable: 1, unfavorable: 0, people: 1, verdict: null });
    expect(await businessSentiment(query, 'entity_none')).toMatchObject({ mentions: 0, tone: null, verdict: null });
  });

  it('scores community health from four signals', async () => {
    const perfect = scoreHealth({ civility: 0, warmth: 0.8, agreement: 0, helpfulness: 1 });
    expect(perfect).toMatchObject({ score: 10, label: 'healthy' });
    expect(scoreHealth({ civility: 0.5, warmth: 0.2, agreement: 0.6, helpfulness: 0.2 })).toMatchObject({
      score: 1,
      label: 'toxic',
    });
    const partial = scoreHealth({ civility: 0, warmth: null, agreement: null, helpfulness: null });
    expect(partial.score).toBe(10);
    expect(partial.signals.warmth.value).toBeNull();
    expect(scoreHealth({ civility: null, warmth: null, agreement: null, helpfulness: null }).score).toBeNull();

    const result = await health(query, SINCE);
    expect(result.basis).toEqual({ posts: 1, comments: 3, questions: 1 });
    expect(result.signals.helpfulness.raw).toBe(1);
    expect(result.signals.agreement.raw).toBeCloseTo(1 / 3);
    expect(result.score).toBeGreaterThan(1);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('summarizes the graph', async () => {
    const result = await overview(query);
    expect(result.counts).toMatchObject({ Post: 4, Comment: 3, Business: 1 });
    expect(result.lastSync).toBeNull();
  });
});

describe('ui server', () => {
  let port: number;
  let close: () => Promise<void>;
  let webDir: string;

  /** Raw request so the Host header and path can be anything. */
  function get(
    path: string,
    options: { host?: string; method?: string; auth?: Record<string, string> | null; zone?: string } = {},
  ) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers: {
            host: options.host ?? `127.0.0.1:${port}`,
            ...(options.zone ? { 'x-ndoor-timezone': options.zone } : {}),
            ...(options.auth === undefined ? { 'x-ndoor-token': TOKEN } : (options.auth ?? {})),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    webDir = mkdtempSync(join(tmpdir(), 'ndoor-web-'));
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>atlas</title>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
    const reader = sharedReader(dbPath, 50);
    const server = createUiServer({ query: reader.query, staticDir: webDir, token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    close = async () => {
      server.close();
      await reader.close();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  it('serves the API as JSON with security headers', async () => {
    const response = await get('/api/node/User/user_1');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.parse(response.body).ref.title).toBe('Alex Neighbor');

    expect(JSON.parse((await get('/api/search?q=acme')).body)[0].label).toBe('Business');
    expect(JSON.parse((await get('/api/thread/post_T1')).body).comments).toHaveLength(3);
    expect(JSON.parse((await get('/api/network?businesses=1')).body).links.length).toBeGreaterThan(0);
    expect(JSON.parse((await get('/api/report/themes?days=36500')).body)[0].theme).toBe('services_recommendations');
    expect(JSON.parse((await get('/api/links/User/user_1/POSTED/out/Post?limit=1&offset=1')).body).nodes).toHaveLength(
      1,
    );
    expect(JSON.parse((await get('/api/reports')).body).length).toBeGreaterThan(5);
    expect(JSON.parse((await get('/api/schema')).body).nodes.User).toContain('name');
    expect(JSON.parse((await get('/api/overview')).body).counts.Post).toBe(4);
    expect(JSON.parse((await get('/api/sentiment/User/user_1')).body).kind).toBe('person');
    expect(JSON.parse((await get('/api/sentiment/Business/entity_9')).body).judged).toBe(1);
    expect((await get('/api/sentiment/Post/post_T1')).status).toBe(404);
    expect(JSON.parse((await get('/api/health?days=36500')).body).basis.posts).toBe(1);
    expect(JSON.parse((await get('/api/people?days=36500&sort=coldest&limit=1')).body)[0].name).toBe('Cal');
    expect(JSON.parse((await get('/api/posts?days=36500&theme=services_recommendations')).body)).toHaveLength(1);
    expect(JSON.parse((await get('/api/comments?days=36500&stance=disagrees')).body).rows).toHaveLength(1);
    expect(JSON.parse((await get('/api/neighborhoods?days=36500')).body).length).toBeGreaterThan(0);
    expect(JSON.parse((await get('/api/themes?days=36500')).body)[0].name).toBe('services_recommendations');
    expect(JSON.parse((await get('/api/groups')).body)).toEqual([]);
    expect(JSON.parse((await get('/api/health/helpfulness?days=36500')).body)).toHaveLength(2);
    expect((await get('/api/health/vibes')).status).toBe(404);
    expect(Object.keys(JSON.parse((await get('/api/whatif')).body).scenarios)).toContain('people');
    expect(JSON.parse((await get('/api/whatif/people?days=36500&n=1&rank=hostile')).body).scenario).toBe('people');
    expect((await get('/api/whatif/vibes')).status).toBe(404);
    expect(JSON.parse((await get('/api/businesses?days=36500')).body)[0].name).toBe('Acme');
    expect(JSON.parse((await get('/api/businesses/summary?days=36500')).body).kpis.mentions).toBe(1);
    expect(JSON.parse((await get('/api/business/entity_9?days=36500')).body).mentions).toHaveLength(1);
    expect(JSON.parse((await get('/api/topic/schools?days=36500')).body).kpis.posts).toBe(0);
    expect((await get('/api/topic/weather')).status).toBe(404);
    expect(JSON.parse((await get('/api/politics?days=36500')).body).kpis).toMatchObject({ posts: 0, pending: 0 });
    expect(JSON.parse((await get('/api/newcomers?days=36500')).body).kpis.joins).toBe(0);
  });

  it('maps errors to statuses', async () => {
    expect((await get('/api/node/Sync/x')).status).toBe(400);
    expect((await get('/api/node/User/nobody')).status).toBe(404);
    expect((await get('/api/report/nope')).status).toBe(404);
    expect((await get('/api/nothing')).status).toBe(404);
    expect((await get('/api/overview', { method: 'POST' })).status).toBe(405);
  });

  it("requires this run's token as a header, never a cookie", async () => {
    expect((await get('/api/overview', { auth: null })).status).toBe(401);
    expect((await get('/api/overview', { auth: { 'x-ndoor-token': 'wrong-token-012345678' } })).status).toBe(401);
    expect((await get('/api/overview', { auth: { cookie: `ndoor_ui=${TOKEN}` } })).status).toBe(401);
    const page = await get(`/explore?token=${TOKEN}`, { auth: null });
    expect(page.status).toBe(200);
    expect(page.headers['set-cookie']).toBeUndefined();
  });

  it('survives malformed URLs', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
    expect((await get('/api/node/User/%E0%A4%A')).status).toBe(400);
    expect((await get('/api/overview')).status).toBe(200);
  });

  it('refuses requests addressed to another host (DNS rebinding)', async () => {
    expect((await get('/api/overview', { host: 'evil.example' })).status).toBe(421);
    expect((await get('/api/overview', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('serves the app, falls back to it for client routes, and never leaves its directory', async () => {
    const asset = await get('/assets/app.js');
    expect(asset.body).toBe('console.log(1)');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await get('/explore/User/x')).body).toContain('atlas');
    for (const path of ['/../package.json', '/..%2f..%2fpackage.json', '/assets/..%2f..%2f..%2fetc%2fpasswd']) {
      const response = await get(path);
      expect(response.body, path).not.toContain('"name"');
      expect(response.body, path).not.toContain('root:');
    }
  });

  it('releases the graph when idle so a sync can write', async () => {
    await get('/api/overview');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const writer = await GraphStore.open(dbPath);
    await writer.close();
    expect((await get('/api/overview')).status).toBe(200);
  });

  it('buckets weeks in the time zone the browser sends', async () => {
    // Sunday 5:46 PM in Los Angeles is already Monday 00:46 UTC: the same post, two different weeks.
    const hour = new Date('2026-10-26T02:00:00Z');
    const server = createUiServer({
      query: async (cypher) =>
        cypher.includes(':Post') ? [{ hour, n: 1, tone: 0.5, hostile: 0 }] : [{ hour, n: 2, hostile: 1 }],
      staticDir: null,
      token: TOKEN,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const original = port;
    port = (server.address() as AddressInfo).port;
    try {
      const weekIn = async (zone?: string) => JSON.parse((await get('/api/mood?days=36500', { zone })).body)[0];
      expect(await weekIn('America/Los_Angeles')).toMatchObject({ week: '2026-10-19', posts: 1, comments: 2 });
      expect(await weekIn('UTC')).toMatchObject({ week: '2026-10-26', hostileCommentPct: 50 });
      // An unknown zone falls back to the machine's own instead of failing the request.
      expect((await get('/api/mood?days=36500', { zone: 'Not/AZone' })).status).toBe(200);
    } finally {
      server.close();
      port = original;
    }
  });

  it('serves only the API when there is no frontend', async () => {
    const server = createUiServer({ query: async () => [], staticDir: null, token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const original = port;
    port = (server.address() as AddressInfo).port;
    try {
      expect((await get('/')).status).toBe(404);
    } finally {
      server.close();
      port = original;
    }
  });
});
