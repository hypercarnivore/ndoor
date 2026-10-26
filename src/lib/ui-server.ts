/**
 * `ndoor ui`: a local web app over the graph. Serves the built frontend
 * (dist/web) and a small read-only JSON API. It never calls Nextdoor.
 *
 * The graph holds neighbors' personal content, so the server listens on
 * 127.0.0.1 only, answers only requests addressed to that host and port
 * (blocking DNS rebinding), sends no CORS headers, and serves a strict CSP.
 * The graph is opened read-only per burst of requests and closed when idle,
 * so a `ndoor sync` can still take the write lock.
 */

import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import * as analytics from './analytics.js';
import {
  businessSentiment,
  ExploreError,
  health,
  links,
  network,
  nodeDetail,
  overview,
  personSentiment,
  type Query,
  search,
  thread,
} from './explore.js';
import { GraphStore, NODE_TABLES, REL_TABLES } from './graph.js';
import { POLITICS_GATE_P, POLITICS_GATE_THEMES, POLITICS_QUESTION_SET } from './jev.js';
import { parseSources, politicsReport } from './politics.js';
import { REPORTS } from './reports.js';
import { resolveTimezone } from './timezone.js';
import { RANKS, SCENARIOS, whatIf } from './whatif.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * One read-only connection shared by all requests, opened on demand, used one
 * query at a time, and closed after `idleMs` without queries.
 */
export function sharedReader(path: string, idleMs = 3000): { query: Query; close: () => Promise<void> } {
  let store: Promise<GraphStore> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const closeNow = async () => {
    const open = store;
    store = null;
    if (open) await (await open).close();
  };
  const query: Query = (cypher, params) => {
    const result = queue.then(async () => {
      if (timer) clearTimeout(timer);
      store ??= GraphStore.open(path, { readOnly: true });
      const opening = store;
      try {
        const db = await opening.catch((error) => {
          store = null;
          throw error;
        });
        return await db.run(cypher, params);
      } finally {
        timer = setTimeout(() => {
          queue = queue.then(closeNow, closeNow);
        }, idleMs);
        timer.unref();
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  return {
    query,
    close: async () => {
      if (timer) clearTimeout(timer);
      await queue;
      await closeNow();
    },
  };
}

export interface UiServerOptions {
  query: Query;
  /** Built frontend directory; null serves the API only (for `vite` dev). */
  staticDir: string | null;
  /**
   * Secret for this run. The page reads it from the `?token=` link `ndoor ui`
   * prints, keeps it in localStorage (scoped to this exact origin, port
   * included, unlike cookies), and sends it as `x-ndoor-token` on every API
   * call. Other local processes and users can reach 127.0.0.1 too; without the
   * token they get nothing.
   */
  token: string;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const int = (value: string | null, fallback: number, max: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const sinceOf = (url: URL) => daysAgo(int(url.searchParams.get('days'), 365, 36500));
const param = (url: URL, name: string) => (url.searchParams.get(name) ?? '').slice(0, 200);
const limitOf = (url: URL, fallback: number) => int(url.searchParams.get('limit'), fallback, 2000);

/** `zone` is the viewer's IANA time zone: calendar buckets (days, weeks, months) follow it. */
type Route = (params: string[], url: URL, query: Query, zone: string) => Promise<unknown>;

/** API routes: [method-less path pattern, handler]. Path segments arrive URL-decoded. */
const ROUTES: Array<[RegExp, Route]> = [
  [/^\/api\/overview$/, (_, __, query) => overview(query)],
  [/^\/api\/search$/, (_, url, query) => search(query, (url.searchParams.get('q') ?? '').slice(0, 200), 8)],
  [
    /^\/api\/node\/([^/]+)\/([^/]+)$/,
    ([label, key], url, query) => nodeDetail(query, label, key, int(url.searchParams.get('limit'), 12, 100)),
  ],
  [
    /^\/api\/links\/([^/]+)\/([^/]+)\/([^/]+)\/(in|out)\/([^/]+)$/,
    ([label, key, rel, direction, other], url, query) =>
      links(query, label, key, rel, direction as 'in' | 'out', other, {
        limit: int(url.searchParams.get('limit'), 25, 200),
        offset: Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0,
      }),
  ],
  [/^\/api\/thread\/([^/]+)$/, ([postId], _, query) => thread(query, postId)],
  [
    /^\/api\/sentiment\/(User|Business)\/([^/]+)$/,
    ([label, key], _, query) => (label === 'User' ? personSentiment(query, key) : businessSentiment(query, key)),
  ],
  [/^\/api\/health$/, (_, url, query) => health(query, daysAgo(int(url.searchParams.get('days'), 365, 36500)))],
  [/^\/api\/health\/([a-z]+)$/, ([signal], url, query) => analytics.healthDrill(query, signal, sinceOf(url))],
  [/^\/api\/whatif$/, async () => ({ scenarios: SCENARIOS, ranks: RANKS })],
  [
    /^\/api\/whatif\/([a-z]+)$/,
    ([scenario], url, query) =>
      whatIf(query, scenario, {
        since: sinceOf(url),
        n: Number.parseInt(url.searchParams.get('n') ?? '', 10),
        rank: param(url, 'rank'),
        share: Number.parseFloat(url.searchParams.get('share') ?? ''),
        cascade: url.searchParams.get('cascade') === '1',
        keys: (url.searchParams.get('keys') ?? '').split(',').filter(Boolean),
      }),
  ],
  [
    /^\/api\/people$/,
    (_, url, query) =>
      analytics.people(query, {
        since: sinceOf(url),
        sort: param(url, 'sort'),
        q: param(url, 'q'),
        limit: limitOf(url, 300),
      }),
  ],
  [
    /^\/api\/posts$/,
    (_, url, query) =>
      analytics.posts(query, {
        since: sinceOf(url),
        sort: param(url, 'sort'),
        q: param(url, 'q'),
        theme: param(url, 'theme'),
        hood: param(url, 'hood'),
        limit: limitOf(url, 200),
      }),
  ],
  [
    /^\/api\/comments$/,
    (_, url, query) =>
      analytics.comments(query, {
        since: sinceOf(url),
        sort: param(url, 'sort'),
        q: param(url, 'q'),
        stance: param(url, 'stance'),
        limit: limitOf(url, 200),
      }),
  ],
  [/^\/api\/neighborhoods$/, (_, url, query) => analytics.neighborhoods(query, sinceOf(url))],
  [/^\/api\/themes$/, (_, url, query, zone) => analytics.themes(query, sinceOf(url), zone)],
  [
    /^\/api\/mood$/,
    (_, url, query, zone) => analytics.mood(query, { since: sinceOf(url), weeks: limitOf(url, 52), zone }),
  ],
  [/^\/api\/groups$/, (_, url, query) => analytics.groups(query, sinceOf(url))],
  [/^\/api\/businesses$/, (_, url, query) => analytics.businesses(query, { since: sinceOf(url) })],
  [
    /^\/api\/businesses\/summary$/,
    (_, url, query, zone) => analytics.businessSummary(query, { since: sinceOf(url), zone }),
  ],
  [
    /^\/api\/business\/([^/]+)$/,
    ([id], url, query, zone) => analytics.businessDetail(query, id, { since: sinceOf(url), zone }),
  ],
  [
    /^\/api\/topic\/([a-z]+)$/,
    ([key], url, query, zone) => analytics.topicReport(query, key, { since: sinceOf(url), zone }),
  ],
  [
    /^\/api\/politics$/,
    (_, url, query, zone) =>
      politicsReport(
        query,
        { themes: POLITICS_GATE_THEMES, minP: POLITICS_GATE_P, set: POLITICS_QUESTION_SET },
        { since: sinceOf(url), sources: parseSources(url.searchParams.get('sources')), zone },
      ),
  ],
  [/^\/api\/newcomers$/, (_, url, query, zone) => analytics.newcomers(query, { since: sinceOf(url), zone })],
  [
    /^\/api\/network$/,
    (_, url, query) =>
      network(query, {
        since: daysAgo(int(url.searchParams.get('days'), 365, 36500)),
        minWeight: int(url.searchParams.get('min'), 1, 100),
        limit: int(url.searchParams.get('limit'), 3000, 20000),
        businesses: url.searchParams.get('businesses') === '1',
      }),
  ],
  [
    /^\/api\/reports$/,
    async () => Object.entries(REPORTS).map(([name, report]) => ({ name, description: report.description })),
  ],
  [
    /^\/api\/report\/([^/]+)$/,
    async ([name], url, query) => {
      const report = REPORTS[name];
      if (!report) throw new ExploreError(404, `Unknown report "${name}"`);
      return query(report.cypher, {
        limit: int(url.searchParams.get('limit'), 25, 500),
        since: daysAgo(int(url.searchParams.get('days'), 365, 36500)),
      });
    },
  ],
  [/^\/api\/schema$/, async () => ({ nodes: NODE_TABLES, relationships: REL_TABLES })],
];

/** decodeURIComponent throws on malformed escapes; a bad URL must never take the server down. */
function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function sameSecret(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  const base = resolve(root);
  const decoded = decode(pathname);
  if (decoded === null) {
    res.writeHead(400, SECURITY_HEADERS).end();
    return;
  }
  let file = resolve(join(base, normalize(decoded)));
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  // Client-side routes fall back to the app shell.
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
  if (!existsSync(file)) {
    res
      .writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      .end('Frontend not built: run `make ui-build`.');
    return;
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(readFileSync(file));
}

export function createUiServer(options: UiServerOptions): Server {
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.address();
    const port = 'port' in address ? address.port : 0;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(421, { 'Content-Type': 'text/plain' }).end('Misdirected request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (options.staticDir) serveStatic(res, options.staticDir, url.pathname);
      else sendJson(res, 404, { error: 'API only' });
      return;
    }
    const presented = req.headers['x-ndoor-token'];
    if (!sameSecret(typeof presented === 'string' ? presented : undefined, options.token)) {
      sendJson(res, 401, { error: "Open the link printed by `ndoor ui` (it carries this run's token)." });
      return;
    }
    for (const [pattern, handler] of ROUTES) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      try {
        const params = match.slice(1).map((part) => {
          const value = decode(part);
          if (value === null) throw new ExploreError(400, 'Malformed URL');
          return value;
        });
        const zoneHeader = req.headers['x-ndoor-timezone'];
        const zone = resolveTimezone(typeof zoneHeader === 'string' ? zoneHeader : null);
        sendJson(res, 200, await handler(params, url, options.query, zone));
      } catch (error) {
        const status = error instanceof ExploreError ? error.status : 500;
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}
