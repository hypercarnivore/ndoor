/**
 * Registry of the Nextdoor GraphQL operations ndoor uses.
 *
 * The web app sends Apollo persisted queries: an operation name plus the
 * sha256 hash of a query document the server already knows. Introspection is
 * disabled, so these hashes (captured from real browser traffic) are the
 * contract. When Nextdoor ships a new frontend the hashes can rotate; the
 * gateway then answers `PersistedQueryNotFound` and `ndoor ops harvest <har>`
 * refreshes them into ~/.config/ndoor/operations.json, which overrides the
 * defaults below.
 *
 * Every operation here is a read. Mutations are deliberately absent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface OperationSpec {
  /** Persisted-query sha256 hash. */
  hash: string;
  /** What the operation returns, for `ndoor ops list`. */
  description: string;
}

export const DEFAULT_OPERATIONS = {
  getMe: {
    hash: '4bb37a4ca47b74249edd6fcf90c7af0abb5ec776be348d70b1ea27518d5f79a7',
    description: 'Logged-in user and home neighborhood',
  },
  PersonalizedFeed: {
    hash: '0def50999e1bd1803061608fe6221dc7adebbb671320f21b6d3d3bc06d40ba21',
    description: 'Main news feed (posts and promos), paged',
  },
  FeedItem: {
    hash: '2eabc57a9a8d35eeddc5c83e72d53ce3fdd9ef97cf09935296653f64b8647d5a',
    description: 'One post with its first page of comments',
  },
  PagedComments: {
    hash: '75eda363cab1d69371c6a8e0bd23a5f48c4141736b4a12cef913a68ef0135588',
    description: 'Next page of comments or replies for a cursor',
  },
  searchPost: {
    hash: '62c216718f39edb9473b9dd5059fadb676217b81331507b3104d1dfc03ed8a43',
    description: 'Post search results',
  },
  NotificationFeed: {
    hash: '345a8a2f4d6e77a7cbfde9d9e074b3bb1e21a67aa13f843bcf385ad8abe6bbe6',
    description: 'Notification center items, paged',
  },
  feedActivity: {
    hash: 'c473b9db3f2ca82829cbfd2b02cf84fb0986ce430fae3f188ed46a7ff6fa58fa',
    description: "A user's own posts with full content, paged",
  },
  allActivities: {
    hash: '564376c7e56899cf4c8794f2b3368a57afa223a7f54f51d64f8efa18d5fa8cf0',
    description: "A user's activity log (posts, replies, reactions) with lifetime counts",
  },
  userProfile: {
    hash: '9b2a0a685212e602243a110947bf29fe373acdec09d5501203d25f4061a52e3b',
    description: "A neighbor's profile: home neighborhood, resident-since year, badges",
  },
  NeighborhoodProfile: {
    hash: '3060e6a5799addd08ad9f6e849671f14b4d8a07d85e99370973ae4d1d11bf754',
    description: 'Neighborhood details and neighbor count, by slug',
  },
  ContentFromHoodFeed: {
    hash: '3c2b2d365e3bcd1ca8ac21881dde09b3e3f9da5b6ebcffff6b1a73b7447f2519',
    description: "A neighborhood's public post feed, paged",
  },
  agencyFeed: {
    hash: '72a7ae93018a34c8de35fad5f3e3be22a8a24c4f9b40959afdbfcc0583a94e34',
    description: 'Posts from a public agency (police, county, city), paged',
  },
  ThemeFeed: {
    hash: '41fcfc0e60b55bb91c2cc3144f1e52540befea82f91bcc1240ba6ae06f2b5506',
    description: 'Themed feed such as top local news, paged',
  },
  groupsWithPromosFeed: {
    hash: '6e78d152e41cc2a07c7e10a1d9dce2c9f4e9a90e1a0cdfd75e8c0819a679b1a4',
    description: "A group's post feed, paged",
  },
  UserGroupsSections: {
    hash: '8b6a2c10a77450ef76c59b9f55ce197a9a94d1b35d037eba62d383327ef10502',
    description: 'Groups you belong to',
  },
  entityPage: {
    hash: '267947f66c93ab32cebe11b6647448608dc748965b076a566295a6c2cefbedeb',
    description: 'A business or organization page',
  },
  EntityPageInteractionsFeedQuery: {
    hash: '7a16f4ef7dd7d47eea0cb259391a2c354b3a9f9ad3f14718d9fe67c6a593db6e',
    description: 'Posts and comments that recommend or mention a business, paged',
  },
} satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof DEFAULT_OPERATIONS;

export function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(DEFAULT_OPERATIONS, name);
}

export function overridesPath(): string {
  return join(homedir(), '.config', 'ndoor', 'operations.json');
}

/** Read hash overrides (`{ "<operationName>": "<sha256>" }`). Missing or invalid files yield {}. */
export function readOverrides(path = overridesPath()): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && /^[0-9a-f]{64}$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function writeOverrides(overrides: Record<string, string>, path = overridesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`);
}

/** Effective hash per operation: overrides win over the built-in defaults. */
export function resolveHashes(overrides: Record<string, string> = readOverrides()): Record<OperationName, string> {
  const hashes = {} as Record<OperationName, string>;
  for (const [name, spec] of Object.entries(DEFAULT_OPERATIONS) as [OperationName, OperationSpec][]) {
    hashes[name] = overrides[name] ?? spec.hash;
  }
  return hashes;
}

/**
 * Pull `operationName -> sha256Hash` pairs out of a HAR capture. Both GET
 * (query-string) and POST (JSON body) persisted queries are recognized. Later
 * entries win, so the newest hash in a capture is kept.
 */
export function harvestHashesFromHar(har: unknown): Record<string, string> {
  const entries = (har as { log?: { entries?: unknown[] } })?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('not a HAR file: missing log.entries');

  const found: Record<string, string> = {};
  for (const entry of entries) {
    const request = (entry as { request?: { url?: string; postData?: { text?: string } } }).request;
    if (!request?.url?.includes('/api/gql/')) continue;

    const hit = hashFromUrl(request.url) ?? hashFromBody(request.postData?.text);
    if (hit) found[hit.operationName] = hit.hash;
  }
  return found;
}

function hashFromUrl(url: string): { operationName: string; hash: string } | null {
  try {
    const parsed = new URL(url);
    const extensions = parsed.searchParams.get('extensions');
    if (!extensions) return null;
    const hash = JSON.parse(extensions)?.persistedQuery?.sha256Hash;
    const operationName = parsed.searchParams.get('operationName') ?? parsed.pathname.split('/').pop();
    return typeof hash === 'string' && operationName ? { operationName, hash } : null;
  } catch {
    return null;
  }
}

function hashFromBody(text: string | undefined): { operationName: string; hash: string } | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    const hash = body?.extensions?.persistedQuery?.sha256Hash;
    return typeof hash === 'string' && typeof body.operationName === 'string'
      ? { operationName: body.operationName, hash }
      : null;
  } catch {
    return null;
  }
}
