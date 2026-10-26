#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { Command, Option } from 'commander';
import JSON5 from 'json5';
import kleur from 'kleur';
import { FEED_SORTS, type FeedSort, NextdoorApi } from './lib/api.js';
import { archiveUser } from './lib/archive.js';
import { compareModels } from './lib/compare.js';
import { isLoggedIn, type ResolveOptions, resolveCredentials } from './lib/cookies.js';
import {
  classifyPosts,
  formatDigest,
  formatNotifications,
  formatPost,
  formatSearch,
  safeText,
  truncate,
} from './lib/digest.js';
import {
  assignDiscoveredThemes,
  claudeCliProposer,
  discoverThemes,
  readDiscoveredThemes,
  writeDiscoveredThemes,
} from './lib/discover.js';
import { health } from './lib/explore.js';
import { extractPostId } from './lib/extract-post-id.js';
import { assertReadQuery, GraphStore } from './lib/graph.js';
import { formatFeedAnalysis, formatThreadAnalysis } from './lib/insights.js';
import { DEFAULT_MODEL, isJevUnavailable, JevAnalyzer } from './lib/jev.js';
import { FileCache } from './lib/jev-cache.js';
import { createMcpServer } from './lib/mcp.js';
import { NextdoorClient, type NextdoorClientOptions } from './lib/nextdoor-client.js';
import { isOpenRouterModel, OpenRouterDecisions, type OpenRouterOptions } from './lib/openrouter.js';
import {
  DEFAULT_OPERATIONS,
  harvestHashesFromHar,
  isOperationName,
  overridesPath,
  readOverrides,
  resolveHashes,
  writeOverrides,
} from './lib/operations.js';
import { formatTable, REPORTS, reportNames } from './lib/reports.js';
import {
  analyzeGraph,
  commentSubjects,
  judgePosts,
  postSubjects,
  SYNC_PRESETS,
  type SyncLimits,
  syncGraph,
} from './lib/sync.js';
import { createUiServer, sharedReader } from './lib/ui-server.js';
import { checkWatches, EXAMPLE_WATCHES, readWatches, readWatchState, writeWatchState } from './lib/watch.js';

type NdoorConfig = {
  browser?: string;
  profile?: string;
  cookieFile?: string;
  noBrowser?: boolean;
  topics?: string[];
  highlightArea?: string;
};

type GlobalOptions = {
  cookie?: string;
  csrf?: string;
  browser?: string;
  profile?: string;
  cookieFile?: string;
  browserExtract?: boolean;
  json?: boolean;
};

type JsonCommandOptions = {
  json?: boolean;
};

type FeedCommandOptions = JsonCommandOptions & {
  count: number;
  sort: FeedSort;
  questions?: boolean;
  highlight?: string;
};

type CountCommandOptions = JsonCommandOptions & {
  count: number;
};

type ReadCommandOptions = JsonCommandOptions & {
  comments?: boolean;
};

const program = new Command();
const isTty = process.stdout.isTTY;
const color = {
  banner: (text: string) => (isTty ? kleur.bold().green(text) : text),
  dim: (text: string) => (isTty ? kleur.gray(text) : text),
  error: (text: string) => (isTty ? kleur.red(text) : text),
  ok: (text: string) => (isTty ? kleur.green(text) : text),
  warning: (text: string) => (isTty ? kleur.yellow(text) : text),
};

function readConfigFile(path: string): Partial<NdoorConfig> {
  if (!existsSync(path)) return {};

  try {
    return (JSON5.parse(readFileSync(path, 'utf8')) as Partial<NdoorConfig>) ?? {};
  } catch (error) {
    console.error(
      color.warning(`warning: failed to parse config at ${path}: ${error instanceof Error ? error.message : error}`),
    );
    return {};
  }
}

function loadConfig(): NdoorConfig {
  return {
    ...readConfigFile(join(homedir(), '.config', 'ndoor', 'config.json5')),
    ...readConfigFile(join(process.cwd(), '.ndoorrc.json5')),
  };
}

function jsonEnabled(commandOptions: JsonCommandOptions = {}): boolean {
  return Boolean(commandOptions.json ?? program.opts<GlobalOptions>().json);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseCount(value: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('count must be a positive integer');
  }
  return count;
}

function credentialOptions(config: NdoorConfig): ResolveOptions {
  const opts = program.opts<GlobalOptions>();
  return {
    cookie: opts.cookie,
    csrf: opts.csrf,
    browser: opts.browser ?? config.browser,
    profile: opts.profile ?? config.profile,
    cookieFile: opts.cookieFile ?? config.cookieFile,
    noBrowser: opts.browserExtract === false || config.noBrowser === true,
  };
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(color.warning(`warning: ${warning}`));
  }
}

function buildApi(clientOptions: NextdoorClientOptions = {}): NextdoorApi {
  const { cookies, warnings } = resolveCredentials(credentialOptions(config));
  printWarnings(warnings);
  if (!isLoggedIn(cookies.jar)) {
    throw new Error(
      'No logged-in Nextdoor session found. Log in to nextdoor.com in your browser, then run `ndoor check`.',
    );
  }
  const onThrottle = (operation: string, waitMs: number) =>
    console.error(color.warning(`throttled on ${operation}; waiting ${Math.round(waitMs / 1000)}s`));
  return new NextdoorApi(new NextdoorClient(cookies, { onThrottle, ...clientOptions }));
}

const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/** The decision model: NDOOR_DECISION_MODEL, else the user .env, else Jev. */
function decisionModel(): string {
  return process.env.NDOOR_DECISION_MODEL ?? readUserEnv('NDOOR_DECISION_MODEL') ?? DEFAULT_MODEL;
}

/** An API key from the environment, else from the user-owned ~/.config/ndoor/.env. */
function apiKey(name: string, model: string): string {
  const key = process.env[name] ?? readUserEnv(name);
  if (!key) {
    throw new Error(`${name} is not set (needed for ${model}). Export it or add it to ~/.config/ndoor/.env.`);
  }
  return key;
}

/**
 * The analyzer for the configured decision model. Bare model ids (jev-1.13.0)
 * go to TypeSafe; vendor/model ids (microsoft/microsoft-decision-1) go through
 * OpenRouter with zero data retention required. Keys come from the
 * environment or the user-owned ~/.config/ndoor/.env, where only the named
 * variables are read, and the endpoints are pinned: a .env in some untrusted
 * working directory must never be able to redirect requests (and keys) elsewhere.
 */
function buildAnalyzer(
  model = decisionModel(),
  options: { fresh?: boolean; onUsage?: OpenRouterOptions['onUsage'] } = {},
): JevAnalyzer {
  const client = isOpenRouterModel(model)
    ? new OpenRouterDecisions({ apiKey: apiKey('OPENROUTER_API_KEY', model), onUsage: options.onUsage })
    : new TypeSafeClient({ apiKey: apiKey('TYPESAFE_API_KEY', model), baseURL: TYPESAFE_BASE_URL });
  process.umask(0o077);
  // Fresh answers bypass the cache entirely, so a comparison can measure real requests.
  return new JevAnalyzer(client, { model, cache: options.fresh ? undefined : FileCache.open(JEV_CACHE_PATH) });
}

/** Every Jev answer ever received, so no question is paid for twice (see jev-cache.ts). */
const JEV_CACHE_PATH = join(homedir(), '.local', 'share', 'ndoor', 'jev-cache.jsonl');

/** Explains a Jev stop: what was kept and how to resume. */
const jevStopped = (reason: string) =>
  `${reason}. Everything judged before that is saved and cached; once Jev is available again, ` +
  'rerun the same command (`ndoor judge` covers all pending work) and it continues where it stopped.';

const jevUsage = (analyzer: JevAnalyzer) => `${analyzer.usage.asked} asked, ${analyzer.usage.cached} from cache`;

function readUserEnv(name: string): string | undefined {
  const path = join(homedir(), '.config', 'ndoor', '.env');
  if (!existsSync(path)) return undefined;
  return parseEnv(readFileSync(path, 'utf8'))[name];
}

/** Wrap an async command action with uniform JSON/text error reporting. */
function run<A extends unknown[]>(action: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      const options = args.find((arg): arg is JsonCommandOptions & object => typeof arg === 'object' && arg !== null);
      emitError(error, options);
    }
  };
}

function emitError(error: unknown, commandOptions: JsonCommandOptions = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonEnabled(commandOptions)) {
    writeJson({ ok: false, error: message });
  } else {
    console.error(color.error(safeText(message)));
  }
  process.exitCode = 1;
}

const VERSION = '0.2.0';
const config = loadConfig();

program.addHelpText('beforeAll', () => `${color.banner('ndoor')} ${color.dim('- ad-free, read-only Nextdoor CLI')}\n`);

program
  .name('ndoor')
  .description('Read Nextdoor from the command line using your browser session')
  .version(VERSION)
  .option('--cookie <header>', 'Raw nextdoor.com Cookie header')
  .option('--csrf <token>', 'CSRF token override')
  .option('--browser <name>', 'Browser name for cookie extraction', config.browser)
  .option('--profile <name>', 'Browser profile name for cookie extraction', config.profile)
  .option('--cookie-file <path>', 'Cached cookie JSON file', config.cookieFile)
  .option('--no-browser-extract', 'Disable browser auto-extraction')
  .option('--json', 'Output machine-readable JSON where supported');

program
  .command('check')
  .description('Show which credential source ndoor will use')
  .option('--json', 'Output as JSON')
  .action((commandOptions: JsonCommandOptions) => {
    const { cookies, warnings } = resolveCredentials(credentialOptions(config));
    const status = {
      ok: isLoggedIn(cookies.jar),
      source: cookies.source,
      cookieCount: Object.keys(cookies.jar).length,
      hasSessionCookie: Boolean(cookies.jar.ndbr_at),
      hasCsrfToken: Boolean(cookies.csrfToken),
      warnings,
    };

    if (jsonEnabled(commandOptions)) {
      writeJson(status);
      return;
    }

    printWarnings(warnings);
    console.log(`${color.ok('source:')} ${cookies.source ?? 'none'}`);
    console.log(`${color.ok('logged in:')} ${status.ok ? 'yes' : 'no'}`);
    console.log(`${color.ok('cookies:')} ${status.cookieCount}`);
    console.log(`${color.ok('csrf token:')} ${status.hasCsrfToken ? 'yes' : 'no'}`);

    if (!status.ok) {
      process.exitCode = 1;
    }
  });

program
  .command('whoami')
  .description('Show the logged-in Nextdoor account')
  .option('--json', 'Output as JSON')
  .action(
    run(async (commandOptions: JsonCommandOptions) => {
      const me = await buildApi().me();
      if (jsonEnabled(commandOptions)) return writeJson(me);
      const hood = me.neighborhood;
      console.log(
        safeText(`${me.name}${hood ? ` - ${hood.name}, ${hood.city ?? '?'} ${hood.state ?? ''}`.trimEnd() : ''}`),
      );
    }),
  );

program
  .command('feed')
  .description('Show your news feed with ads removed')
  .option('-n, --count <count>', 'Number of posts to fetch', parseCount, 20)
  .addOption(new Option('--sort <order>', 'Feed ordering').choices(FEED_SORTS).default('FOR_YOU'))
  .option('--questions', 'Group posts asking for help')
  .option('--highlight <area>', 'Highlight posts from a specific area')
  .option('--json', 'Output as JSON')
  .action(
    run(async (commandOptions: FeedCommandOptions) => {
      const result = await buildApi().feed({ count: commandOptions.count, sort: commandOptions.sort });
      const digestConfig = { ...config, highlightArea: commandOptions.highlight ?? config.highlightArea ?? null };
      const posts = classifyPosts(result.posts, digestConfig);

      if (jsonEnabled(commandOptions)) {
        return writeJson({ posts, adsDropped: result.adsDropped, skipped: result.skipped });
      }
      console.log(
        formatDigest(posts, digestConfig, { questions: commandOptions.questions, adsDropped: result.adsDropped }),
      );
    }),
  );

program
  .command('read')
  .description('Read one post with its full comment thread')
  .argument('<post-id-or-url>', 'Post share id (from nextdoor.com/p/<id>) or URL')
  .option('--no-comments', 'Skip loading comments beyond the first page')
  .option('--json', 'Output as JSON')
  .action(
    run(async (postIdOrUrl: string, commandOptions: ReadCommandOptions) => {
      const post = await buildApi().post(extractPostId(postIdOrUrl), { allComments: commandOptions.comments });
      if (jsonEnabled(commandOptions)) return writeJson(post);
      console.log(formatPost(post));
    }),
  );

program
  .command('notifications')
  .description('Show your notification center')
  .option('-n, --count <count>', 'Number of notifications to fetch', parseCount, 20)
  .option('--json', 'Output as JSON')
  .action(
    run(async (commandOptions: CountCommandOptions) => {
      const notifications = await buildApi().notifications({ count: commandOptions.count });
      if (jsonEnabled(commandOptions)) return writeJson({ notifications });
      console.log(formatNotifications(notifications));
    }),
  );

program
  .command('search')
  .description('Search Nextdoor posts')
  .argument('<query>', 'Search query')
  .option('-n, --count <count>', 'Number of results to fetch', parseCount, 20)
  .option('--json', 'Output as JSON')
  .action(
    run(async (query: string, commandOptions: CountCommandOptions) => {
      const page = await buildApi().search(query, { count: commandOptions.count });
      if (jsonEnabled(commandOptions)) return writeJson(page);
      console.log(formatSearch(page.hits));
    }),
  );

program
  .command('analyze')
  .description('Judge themes, intent, tone, and hostility with Jev: the feed, or one thread with comment stances')
  .argument('[post-id-or-url]', 'Analyze this post and its whole comment thread instead of the feed')
  .option('-n, --count <count>', 'Number of feed posts to analyze', parseCount, 20)
  .option('--json', 'Output raw judgments as JSON')
  .action(
    run(async (postIdOrUrl: string | undefined, commandOptions: CountCommandOptions) => {
      const api = buildApi();
      const analyzer = buildAnalyzer();
      if (postIdOrUrl) {
        const post = await api.post(extractPostId(postIdOrUrl));
        const [postJudgments, comments] = await Promise.all([
          analyzer.analyzePost(post),
          analyzer.analyzeComments(post),
        ]);
        if (jsonEnabled(commandOptions)) return writeJson({ post, judgments: postJudgments, comments });
        return console.log(formatThreadAnalysis(post, postJudgments, comments));
      }
      const { posts } = await api.feed({ count: commandOptions.count });
      const judgments = await analyzer.analyzePosts(posts);
      if (jsonEnabled(commandOptions)) return writeJson({ posts, judgments });
      console.log(formatFeedAnalysis(posts, judgments));
    }),
  );

program
  .command('export')
  .description('Export every post and comment you have written, with context, as JSONL plus a Markdown voice corpus')
  .option('-o, --out <dir>', 'Output directory', join(homedir(), '.local', 'share', 'ndoor', 'archive'))
  .option('--json', 'Print the run summary as JSON')
  .action(
    run(async (commandOptions: JsonCommandOptions & { out: string }) => {
      const api = buildApi({ throttleRetries: 8 });
      const me = await api.me();
      if (!me.userId || !me.secureUserId) throw new Error('Could not determine your Nextdoor user id.');
      const result = await archiveUser(
        {
          activityPages: (id, options) => api.activityPages(id, options),
          userPosts: (id) => api.userPosts(id),
          post: (id, options) => api.post(id, options),
        },
        {
          outDir: commandOptions.out,
          userId: me.userId,
          secureUserId: me.secureUserId,
          log: (line) => console.error(color.dim(line)),
        },
      );
      if (jsonEnabled(commandOptions)) return writeJson({ outDir: commandOptions.out, ...result });
      console.log(
        `${result.posts} posts and ${result.comments} comments in ${commandOptions.out}` +
          `${result.failures ? ` (${result.failures} threads failed, see failures.jsonl)` : ''}`,
      );
      console.log(`voice corpus: ${join(commandOptions.out, 'voice.md')}`);
      if (!result.activitiesComplete) {
        console.log(
          color.warning(
            'activity log incomplete (Nextdoor throttling); run `ndoor export` again later to pick up the rest.',
          ),
        );
      }
    }),
  );

const DEFAULT_GRAPH = join(homedir(), '.local', 'share', 'ndoor', 'graph.lbug');
const THEMES_PATH = join(homedir(), '.config', 'ndoor', 'themes.json5');
type GraphCommandOptions = JsonCommandOptions & { db: string };

async function withGraph<T>(
  path: string,
  work: (store: GraphStore) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  // The graph holds neighbors' content: every file LadybugDB creates (db, WAL) stays owner-only.
  process.umask(0o077);
  const store = await GraphStore.open(path, options);
  try {
    return await work(store);
  } finally {
    await store.close();
  }
}

function parseSince(value: string): string {
  const relative = value.match(/^(\d+)([dwmy])$/);
  if (relative) {
    const days = Number(relative[1]) * { d: 1, w: 7, m: 30, y: 365 }[relative[2] as 'd' | 'w' | 'm' | 'y'];
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid --since "${value}"; use e.g. 30d, 12w, 1y, or 2026-01-01.`);
  return date.toISOString();
}

program
  .command('sync')
  .description('Harvest feeds, threads, profiles, neighborhoods, groups, and businesses into the local graph')
  .addOption(new Option('--preset <name>', 'How much to read').choices(Object.keys(SYNC_PRESETS)).default('standard'))
  .option('--max-requests <n>', 'Cap on Nextdoor requests for this run', parseCount)
  .option('--threads <n>', 'Max threads to load', parseCount)
  .option(
    '--recent <days>',
    'Load unread threads only for posts made in the last N days (default from the preset: 7, 14, or any age)',
    parseCount,
  )
  .option('--profiles <n>', 'Max neighbor profiles to look up', parseCount)
  .option(
    '--histories <n>',
    'Neighbors whose post histories to read (default from the preset: 0, 10, or 100); unread ones come first',
    parseCount,
  )
  .option('--open-groups', 'Also read open groups nearby that you have not joined (skipped by default)')
  .option('--analyze', 'Then judge new posts and comments with Jev')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Print the run summary as JSON')
  .action(
    run(
      async (
        commandOptions: GraphCommandOptions & {
          preset: keyof typeof SYNC_PRESETS;
          openGroups?: boolean;
          maxRequests?: number;
          threads?: number;
          recent?: number;
          profiles?: number;
          histories?: number;
          analyze?: boolean;
        },
      ) => {
        const limits: SyncLimits = {
          ...SYNC_PRESETS[commandOptions.preset],
          ...(commandOptions.maxRequests ? { maxRequests: commandOptions.maxRequests } : {}),
          ...(commandOptions.threads ? { threads: commandOptions.threads } : {}),
          ...(commandOptions.recent ? { newThreadDays: commandOptions.recent } : {}),
          ...(commandOptions.profiles ? { profiles: commandOptions.profiles } : {}),
          ...(commandOptions.histories ? { authorHistories: commandOptions.histories } : {}),
          ...(commandOptions.openGroups ? { openGroups: true } : {}),
        };
        const analyzer = commandOptions.analyze ? buildAnalyzer() : null;
        // Short backoff: a throttled operation is skipped for the rest of the run anyway.
        const api = buildApi({ throttleRetries: 3 });
        const log = (line: string) => console.error(color.dim(safeText(line)));
        const result = await withGraph(commandOptions.db, async (store) => {
          // Judge new posts before threads load so question posts are first in line for thread slots.
          const early = { posts: 0, inputTokens: 0, stoppedBy: null as string | null };
          const sync = await syncGraph(api, store, {
            limits,
            log,
            ...(analyzer && {
              beforeThreads: async () => {
                const judged = await judgePosts(store, analyzer, 5000, log);
                early.posts += judged.posts;
                early.inputTokens += judged.inputTokens;
                early.stoppedBy = judged.stoppedBy;
              },
            }),
          });
          const analysis = analyzer
            ? await analyzeGraph(store, analyzer, {
                posts: 5000,
                comments: 20000,
                discovered: readDiscoveredThemes(THEMES_PATH),
                log,
              })
            : null;
          if (analysis) {
            analysis.posts += early.posts;
            analysis.inputTokens += early.inputTokens;
            analysis.stoppedBy ??= early.stoppedBy;
          }
          return { sync, analysis, graph: await store.counts() };
        });
        if (jsonEnabled(commandOptions)) return writeJson({ db: commandOptions.db, ...result });
        const { sync, analysis, graph } = result;
        console.log(
          `${sync.newPosts} new posts and ${sync.newComments} new comments · ` +
            `read ${sync.posts} posts from ${sync.feeds} feeds (${sync.feedsCaughtUp} caught up early, ` +
            `${sync.feedsSkipped} not due, ` +
            `${sync.adsDropped} ads dropped), ${sync.threads} threads, ${sync.profiles} profiles, ` +
            `${sync.reactions} of your reactions · ${sync.requests} requests`,
        );
        if (sync.commentsRemoved || sync.postsRemoved) {
          console.log(`removed since last seen: ${sync.postsRemoved} posts, ${sync.commentsRemoved} comments`);
        }
        if (analysis) {
          console.log(
            `Jev: ${analysis.posts} posts, ${analysis.comments} comments, ${analysis.opinions} business mentions, ${analysis.placed} topic posts placed, ${analysis.political} political posts, ` +
              `${analysis.discovered} posts against discovered themes ` +
              `(${analysis.inputTokens} input tokens; ${jevUsage(analyzer!)})`,
          );
          if (analysis.stoppedBy) console.log(color.warning(jevStopped(analysis.stoppedBy)));
        }
        console.log(
          color.dim(
            `graph: ${Object.entries(graph)
              .filter(([name]) => name !== 'Sync')
              .map(([name, n]) => `${n} ${name}`)
              .join(', ')}`,
          ),
        );
        if (sync.stoppedBy)
          console.log(color.warning(`stopped early (${sync.stoppedBy}); run sync again to continue.`));
        if (sync.throttled.length) {
          console.log(
            color.warning(`Nextdoor throttled ${sync.throttled.join(', ')}; that work resumes on the next sync.`),
          );
        }
        if (sync.failures) console.log(color.warning(`${sync.failures} requests failed`));
      },
    ),
  );

program
  .command('report')
  .description('Built-in graph reports (run without a name to list them)')
  .argument('[name]', `One of: ${reportNames().join(', ')}`)
  .option('-n, --limit <n>', 'Rows to show', parseCount, 25)
  .option('--since <when>', 'Only content since then: 30d, 12w, 1y, or a date', '1y')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output rows as JSON')
  .action(
    run(async (name: string | undefined, commandOptions: GraphCommandOptions & { limit: number; since: string }) => {
      if (!name) {
        const rows = Object.entries(REPORTS).map(([report, spec]) => ({ report, description: spec.description }));
        if (jsonEnabled(commandOptions)) return writeJson(rows);
        for (const row of rows) console.log(`${color.ok(row.report.padEnd(14))} ${row.description}`);
        return;
      }
      const report = REPORTS[name];
      if (!report) throw new Error(`Unknown report "${name}". Available: ${reportNames().join(', ')}`);
      const rows = await withGraph(
        commandOptions.db,
        (store) => store.run(report.cypher, { limit: commandOptions.limit, since: parseSince(commandOptions.since) }),
        { readOnly: true },
      );
      if (jsonEnabled(commandOptions)) return writeJson(rows);
      console.log(color.dim(report.description));
      console.log(formatTable(rows));
    }),
  );

program
  .command('query')
  .description('Run read-only Cypher against the local graph (see README for the schema)')
  .argument('<cypher>', 'Cypher query')
  .option('--params <json>', 'Query parameters as JSON', '{}')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output rows as JSON')
  .action(
    run(async (cypher: string, commandOptions: GraphCommandOptions & { params: string }) => {
      const params = JSON.parse(commandOptions.params) as Record<string, unknown>;
      assertReadQuery(cypher);
      const rows = await withGraph(
        commandOptions.db,
        (store) => store.run(cypher, Object.keys(params).length ? params : undefined),
        { readOnly: true },
      );
      if (jsonEnabled(commandOptions)) return writeJson(rows);
      console.log(formatTable(rows));
    }),
  );

program
  .command('judge')
  .description('Run pending Jev judgments over the cached graph only (no Nextdoor requests)')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output the summary as JSON')
  .action(
    run(async (commandOptions: GraphCommandOptions) => {
      const analyzer = buildAnalyzer();
      const log = (line: string) => console.error(color.dim(safeText(line)));
      const stats = await withGraph(commandOptions.db, (store) =>
        analyzeGraph(store, analyzer, {
          posts: 20000,
          comments: 50000,
          discovered: readDiscoveredThemes(THEMES_PATH),
          log,
        }),
      );
      if (jsonEnabled(commandOptions)) return writeJson(stats);
      console.log(
        `Jev: ${stats.posts} posts, ${stats.comments} comments, ${stats.opinions} business mentions, ${stats.placed} topic posts placed, ${stats.political} political posts, ` +
          `${stats.discovered} posts against discovered themes (${stats.inputTokens} input tokens; ${jevUsage(analyzer)})`,
      );
      if (stats.stoppedBy) {
        console.log(color.warning(jevStopped(stats.stoppedBy)));
        process.exitCode = 1;
      }
    }),
  );

program
  .command('compare-models')
  .description('Compare two decision models on the same recent posts and comments (read-only, no Nextdoor requests)')
  .option('--baseline <model>', 'Model to compare against', DEFAULT_MODEL)
  .option('--candidate <model>', 'Model to evaluate', 'microsoft/microsoft-decision-1')
  .option('--posts <n>', 'Newest posts to judge', '100')
  .option('--comments <n>', 'Newest comments to judge', '100')
  .option('--fresh', 'Ask both models again instead of using cached answers (measures speed and cost)')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output as JSON')
  .action(
    run(
      async (
        commandOptions: GraphCommandOptions & {
          baseline: string;
          candidate: string;
          posts: string;
          comments: string;
          fresh?: boolean;
        },
      ) => {
        const subjects = await withGraph(
          commandOptions.db,
          async (store) => [
            ...postSubjects(await store.postsNeedingJudgments(null, parseCount(commandOptions.posts))),
            ...commentSubjects(await store.commentsNeedingJudgments(null, parseCount(commandOptions.comments))),
          ],
          { readOnly: true },
        );
        const side = (model: string) => {
          let cost: number | null = null;
          const analyzer = buildAnalyzer(model, {
            fresh: commandOptions.fresh,
            onUsage: (usage) => {
              if (usage.cost !== null) cost = (cost ?? 0) + usage.cost;
            },
          });
          return { analyzer, cost: () => cost };
        };
        console.error(color.dim(`judging ${subjects.length} items with each model…`));
        const result = await compareModels(side(commandOptions.baseline), side(commandOptions.candidate), subjects);
        if (jsonEnabled(commandOptions)) return writeJson(result);
        const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
        console.log(`${result.items} items, overall agreement ${pct(result.overall).trim()}\n`);
        for (const r of [result.baseline, result.candidate]) {
          const latency = r.latency ? `p50 ${r.latency.p50} ms, p90 ${r.latency.p90} ms` : 'all from cache';
          const cost = r.cost === null ? '' : `, $${r.cost.toFixed(4)}`;
          console.log(
            `${r.model}: ${r.asked} asked, ${r.cached} cached, ${r.inputTokens} input tokens${cost}; ${latency}; ${(r.wallMs / 1000).toFixed(1)}s`,
          );
        }
        console.log(`\n${'question'.padEnd(32)} ${'type'.padEnd(6)} ${'n'.padStart(4)} agree  diff`);
        for (const q of result.questions) {
          console.log(
            `${q.question.padEnd(32)} ${q.type.padEnd(6)} ${String(q.n).padStart(4)} ${pct(q.agreement)}  ${q.meanDiff.toFixed(2)}`,
          );
        }
        console.log(
          color.dim(
            '\nagree: same decision (Noul on the same side of 0.5, same Choice label, same nearest Score level). ' +
              'diff: mean distance, 0 identical to 1 opposite.',
          ),
        );
      },
    ),
  );

program
  .command('health')
  .description('Community health on a 1 to 10 scale, with the signals behind it (from the graph)')
  .option('--since <when>', 'Only content since then: 30d, 12w, 1y, or a date', '1y')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output as JSON')
  .action(
    run(async (commandOptions: GraphCommandOptions & { since: string }) => {
      const result = await withGraph(
        commandOptions.db,
        (store) => health((c, p) => store.run(c, p), parseSince(commandOptions.since)),
        {
          readOnly: true,
        },
      );
      if (jsonEnabled(commandOptions)) return writeJson(result);
      if (result.score === null) return console.log('Not enough judged content yet. Run `ndoor sync --analyze`.');
      console.log(`${color.ok(`${result.score.toFixed(1)} / 10`)}  ${result.label}`);
      for (const [name, signal] of Object.entries(result.signals)) {
        const raw =
          signal.raw === null ? 'n/a' : name === 'warmth' ? signal.raw.toFixed(2) : `${Math.round(signal.raw * 100)}%`;
        const value = signal.value === null ? '  -' : `${Math.round(signal.value * 10)}/10`;
        console.log(`  ${name.padEnd(12)} ${value.padStart(5)}  ${raw.padStart(5)}  ${color.dim(signal.describe)}`);
      }
      console.log(
        color.dim(
          `from ${result.basis.posts} posts, ${result.basis.comments} comments, ${result.basis.questions} questions (weights: civility 35%, warmth 25%, helpfulness 25%, agreement 15%)`,
        ),
      );
    }),
  );

const WATCHES_PATH = join(homedir(), '.config', 'ndoor', 'watches.json5');
const discoveredIds = () => readDiscoveredThemes(THEMES_PATH).map((theme) => theme.id);
const WATCH_STATE_PATH = join(homedir(), '.local', 'share', 'ndoor', 'watch-state.json');

/**
 * macOS notification. Text goes in as argv, never into the script source, so
 * neighbors' text cannot inject AppleScript.
 */
function notify(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  execFile(
    'osascript',
    [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
      title,
      body,
    ],
    () => {},
  );
}

const watch = program
  .command('watch')
  .description('Standing alerts over the graph (rules in ~/.config/ndoor/watches.json5)');

watch
  .command('init')
  .description('Write an example watches file to edit')
  .action(
    run(async () => {
      if (existsSync(WATCHES_PATH)) throw new Error(`${WATCHES_PATH} already exists.`);
      mkdirSync(dirname(WATCHES_PATH), { recursive: true, mode: 0o700 });
      writeFileSync(WATCHES_PATH, EXAMPLE_WATCHES, { mode: 0o600 });
      console.log(`wrote ${WATCHES_PATH}; edit it, then run \`ndoor watch check\` after a sync.`);
    }),
  );

watch
  .command('list')
  .description('Show the configured watches')
  .option('--json', 'Output as JSON')
  .action(
    run(async (commandOptions: JsonCommandOptions) => {
      const watches = readWatches(WATCHES_PATH, discoveredIds());
      if (jsonEnabled(commandOptions)) return writeJson({ path: WATCHES_PATH, watches });
      if (watches.length === 0) return console.log(`No watches. Run \`ndoor watch init\` to create ${WATCHES_PATH}.`);
      for (const rule of watches) {
        const { name, ...conditions } = rule;
        console.log(`${color.ok(name)}  ${color.dim(JSON.stringify(conditions))}`);
      }
    }),
  );

watch
  .command('check')
  .description('Report graph content new since the last check that matches a watch (run after `ndoor sync`)')
  .option('--notify', 'Also show a macOS notification per matching watch')
  .option('--since <when>', 'How far back the first check of a watch looks', '1d')
  .option('--peek', 'Do not advance the last-checked times')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output hits as JSON')
  .action(
    run(async (commandOptions: GraphCommandOptions & { notify?: boolean; since: string; peek?: boolean }) => {
      const watches = readWatches(WATCHES_PATH, discoveredIds());
      if (watches.length === 0)
        throw new Error(`No watches configured. Run \`ndoor watch init\` to create ${WATCHES_PATH}.`);
      const result = await withGraph(
        commandOptions.db,
        async (store) =>
          checkWatches(watches, (cypher, params) => store.run(cypher, params), {
            state: readWatchState(WATCH_STATE_PATH),
            now: new Date().toISOString(),
            meId: await store.meId(),
            firstRunSince: parseSince(commandOptions.since),
          }),
        { readOnly: true },
      );
      if (!commandOptions.peek) writeWatchState(WATCH_STATE_PATH, result.state);
      if (commandOptions.notify) {
        for (const hit of result.hits) {
          const first = hit.rows[0];
          notify(
            `ndoor: ${hit.watch} (${hit.rows.length})`,
            safeText(`${first.author ?? ''}: ${first.post ?? ''} ${first.text ?? ''}`).slice(0, 200),
          );
        }
      }
      if (jsonEnabled(commandOptions)) return writeJson(result.hits);
      if (result.hits.length === 0) return console.log(color.dim('nothing new'));
      for (const hit of result.hits) {
        console.log(color.ok(`${hit.watch} (${hit.rows.length})`));
        for (const row of hit.rows) {
          const where = row.neighborhood ? ` (${row.neighborhood})` : '';
          console.log(safeText(`  ${row.author}${where}: ${truncate(String(row.post || row.text || ''), 100)}`));
          console.log(color.dim(`  ${row.url}`));
        }
      }
    }),
  );

const themes = program
  .command('themes')
  .description('Discover community themes beyond the built-in ones (uses only the local graph, never Nextdoor)');

themes
  .command('discover')
  .description('Sample cached posts and have Claude propose new themes into ~/.config/ndoor/themes.json5')
  .option('--sample <n>', 'Posts the proposer reads', parseCount, 300)
  .option('--max <n>', 'Most new themes to propose', parseCount, 12)
  .option('--since <when>', 'Sample posts since then: 30d, 12w, 1y, or a date', '1y')
  .option('--model <name>', 'Claude model for proposing', 'sonnet')
  .option('--replace', 'Start the theme file over instead of adding to it')
  .option('--dry-run', 'Show proposals without writing the file')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output proposals as JSON')
  .action(
    run(
      async (
        commandOptions: GraphCommandOptions & {
          sample: number;
          max: number;
          since: string;
          model: string;
          replace?: boolean;
          dryRun?: boolean;
        },
      ) => {
        const current = commandOptions.replace ? [] : readDiscoveredThemes(THEMES_PATH);
        console.error(
          color.dim(`asking Claude (${commandOptions.model}) to read ${commandOptions.sample} cached posts...`),
        );
        const result = await withGraph(
          commandOptions.db,
          (store) =>
            discoverThemes(store, claudeCliProposer({ model: commandOptions.model }), {
              since: parseSince(commandOptions.since),
              sample: commandOptions.sample,
              max: commandOptions.max,
              current,
            }),
          { readOnly: true },
        );
        if (!commandOptions.dryRun) writeDiscoveredThemes(THEMES_PATH, [...current, ...result.proposed]);
        if (jsonEnabled(commandOptions))
          return writeJson({ path: THEMES_PATH, written: !commandOptions.dryRun, ...result });
        console.log(color.dim(`read ${result.sampled} posts; proposed ${result.proposed.length} themes`));
        for (const theme of result.proposed) console.log(`${color.ok(theme.id)}  ${safeText(theme.description)}`);
        for (const reason of result.rejected) console.log(color.warning(`skipped ${safeText(reason)}`));
        if (!commandOptions.dryRun) {
          console.log(`\nwrote ${THEMES_PATH}. Review and edit it, then run \`ndoor themes assign\`.`);
        }
      },
    ),
  );

themes
  .command('list')
  .description('Show discovered themes and how many posts Jev assigned to each')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output as JSON')
  .action(
    run(async (commandOptions: GraphCommandOptions) => {
      const discovered = readDiscoveredThemes(THEMES_PATH);
      const counts = existsSync(commandOptions.db)
        ? await withGraph(
            commandOptions.db,
            (store) =>
              store.run(
                `MATCH (p:Post)-[a:ABOUT]->(t:Theme) WHERE t.source = 'discovered' AND a.p >= 0.5
                 RETURN t.name AS theme, count(p) AS posts`,
              ),
            { readOnly: true },
          )
        : [];
      const posts = new Map(counts.map((row) => [String(row.theme), Number(row.posts)]));
      const rows = discovered.map((theme) => ({ ...theme, posts: posts.get(theme.id) ?? null }));
      if (jsonEnabled(commandOptions)) return writeJson({ path: THEMES_PATH, themes: rows });
      if (rows.length === 0) return console.log(`No discovered themes. Run \`ndoor themes discover\`.`);
      for (const row of rows) {
        const count = row.posts === null ? 'not assigned' : `${row.posts} posts`;
        console.log(`${color.ok(row.id)} ${color.dim(`(${count})`)}  ${safeText(row.description)}`);
      }
    }),
  );

themes
  .command('assign')
  .description('Judge cached posts against the discovered themes with Jev (only posts not yet judged against this set)')
  .option('--limit <n>', 'Most posts to judge this run', parseCount, 10000)
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .option('--json', 'Output the summary as JSON')
  .action(
    run(async (commandOptions: GraphCommandOptions & { limit: number }) => {
      const discovered = readDiscoveredThemes(THEMES_PATH);
      const analyzer = buildAnalyzer();
      const log = (line: string) => console.error(color.dim(safeText(line)));
      let saved = 0;
      const stats = await withGraph(commandOptions.db, (store) =>
        assignDiscoveredThemes(store, analyzer, discovered, {
          limit: commandOptions.limit,
          log,
          onProgress: (progress) => {
            saved = progress.posts;
          },
        }),
      ).catch((error) => {
        if (!isJevUnavailable(error)) throw error;
        throw new Error(
          `${jevStopped(error instanceof Error ? error.message : String(error))} (${saved} posts saved this run)`,
        );
      });
      if (jsonEnabled(commandOptions)) return writeJson({ themes: discovered.length, ...stats });
      console.log(
        `judged ${stats.posts} posts against ${discovered.length} themes (${stats.inputTokens} input tokens; ${jevUsage(analyzer)})`,
      );
      console.log(color.dim('see `ndoor themes list` or `ndoor report themes`'));
    }),
  );

program
  .command('mcp')
  .description('Serve ndoor to agents over MCP (stdio): live reads plus graph reports and queries')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .action(async (commandOptions: { db: string }) => {
    let api: NextdoorApi | null = null;
    const server = createMcpServer({
      version: VERSION,
      api: () => {
        api ??= buildApi();
        return api;
      },
      query: (cypher, params) => withGraph(commandOptions.db, (store) => store.run(cypher, params), { readOnly: true }),
    });
    await server.connect(new StdioServerTransport());
  });

/**
 * Open a URL that carries a secret without putting it in process arguments,
 * which other users on the machine can list: `open` gets a private file that
 * redirects to it, and the file is deleted shortly after.
 */
function openPrivately(url: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'ndoor-ui-'));
  const file = join(dir, 'open.html');
  const attr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  writeFileSync(file, `<!doctype html><meta http-equiv="refresh" content="0;url=${attr}">`, { mode: 0o600 });
  const remove = () => rmSync(dir, { recursive: true, force: true });
  // Removed once the browser has read it, and on every exit path (Ctrl-C included) before that.
  process.once('exit', remove);
  execFile('open', [file], () => {});
  setTimeout(remove, 15_000).unref();
}

/**
 * Token for `make dev`, where the API restarts on every source change: kept
 * in an owner-only file so the open page stays signed in across restarts. The
 * regular `ndoor ui` makes a fresh token per run.
 */
function devToken(): string {
  const path = join(homedir(), '.local', 'share', 'ndoor', 'ui-dev-token');
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved.length >= 32) return saved;
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

/** The built frontend: next to dist/index.js, or under dist/ when running from source. */
function webDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return (
    [join(here, 'web'), join(here, '..', 'dist', 'web')].find((dir) => existsSync(join(dir, 'index.html'))) ?? null
  );
}

program
  .command('ui')
  .description('Explore the graph in your browser (local only; reads the graph, never Nextdoor)')
  .option('--port <n>', 'Port on 127.0.0.1 (0 picks a free one)', '4791')
  .option('--api-only', 'Serve only the API (for frontend development with `make dev`)')
  .option('--open', 'Open the browser')
  .option('--db <path>', 'Graph database file', DEFAULT_GRAPH)
  .action(
    run(async (commandOptions: { port: string; apiOnly?: boolean; open?: boolean; db: string }) => {
      if (!existsSync(commandOptions.db))
        throw new Error(`No graph at ${commandOptions.db} yet. Run \`ndoor sync\` first.`);
      process.umask(0o077);
      const staticDir = commandOptions.apiOnly ? null : webDir();
      if (!commandOptions.apiOnly && !staticDir) throw new Error('Frontend not built. Run `make ui-build` first.');
      const reader = sharedReader(commandOptions.db);
      const token = commandOptions.apiOnly ? devToken() : randomBytes(24).toString('base64url');
      const server = createUiServer({ query: reader.query, staticDir, token });
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(Number.parseInt(commandOptions.port, 10) || 0, '127.0.0.1', resolveListen);
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : commandOptions.port;
      // In API-only mode the page comes from the Vite dev server, which proxies /api here.
      const url = `http://127.0.0.1:${commandOptions.apiOnly ? 5173 : port}/?token=${token}`;
      if (commandOptions.apiOnly) console.log(color.dim(`API on 127.0.0.1:${port}`));
      console.log(`ndoor ui at ${color.ok(url)} ${color.dim('(Ctrl-C to stop)')}`);
      if (commandOptions.open && process.platform === 'darwin') openPrivately(url);
      const stop = async () => {
        server.close();
        await reader.close();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }),
  );

program
  .command('raw')
  .description('Run a registered read operation with explicit variables and print the raw response')
  .argument('<operation>', `One of: ${Object.keys(DEFAULT_OPERATIONS).join(', ')}`)
  .option('--vars <json>', 'Operation variables as JSON', '{}')
  .action(
    run(async (operation: string, commandOptions: { vars: string }) => {
      if (!isOperationName(operation)) throw new Error(`Unknown operation "${operation}". See \`ndoor ops list\`.`);
      const variables = JSON.parse(commandOptions.vars) as Record<string, unknown>;
      writeJson(await buildApi().raw(operation, variables));
    }),
  );

const ops = program.command('ops').description('Inspect or refresh the persisted GraphQL operation hashes');

ops
  .command('list')
  .description('Show each operation and the hash in use')
  .option('--json', 'Output as JSON')
  .action((commandOptions: JsonCommandOptions) => {
    const overrides = readOverrides();
    const hashes = resolveHashes(overrides);
    const rows = Object.entries(DEFAULT_OPERATIONS).map(([name, spec]) => ({
      name,
      hash: hashes[name as keyof typeof hashes],
      source: overrides[name] ? 'override' : 'default',
      description: spec.description,
    }));
    if (jsonEnabled(commandOptions)) return writeJson({ overridesPath: overridesPath(), operations: rows });
    const width = Math.max(...rows.map((row) => row.name.length));
    for (const row of rows) {
      console.log(
        `${row.name.padEnd(width)} ${row.hash.slice(0, 12)}  ${color.dim(`${row.source}  ${row.description}`)}`,
      );
    }
  });

ops
  .command('harvest')
  .description('Update operation hashes from a HAR capture of nextdoor.com')
  .argument('<har-file>', 'HAR file recorded while browsing nextdoor.com')
  .option('--json', 'Output as JSON')
  .action(
    run(async (harFile: string, commandOptions: JsonCommandOptions) => {
      const found = harvestHashesFromHar(JSON.parse(readFileSync(harFile, 'utf8')));
      const current = resolveHashes();
      const overrides = readOverrides();
      const updated: string[] = [];
      for (const [name, hash] of Object.entries(found)) {
        if (!isOperationName(name) || current[name] === hash) continue;
        overrides[name] = hash;
        updated.push(name);
      }
      if (updated.length > 0) writeOverrides(overrides);

      const known = Object.keys(found).filter(isOperationName);
      const missing = Object.keys(DEFAULT_OPERATIONS).filter((name) => !(name in found));
      if (jsonEnabled(commandOptions)) return writeJson({ updated, seen: known, missing });
      console.log(updated.length > 0 ? `updated: ${updated.join(', ')}` : 'all captured hashes already current');
      if (missing.length > 0) console.log(color.dim(`not in capture: ${missing.join(', ')}`));
    }),
  );

await program.parseAsync(process.argv);
