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
    hash: 'b3e32cd7ade5d36c7dd74f2121ca5ed71df280b879bb4b711a627a510aca1e2a',
    description: 'Logged-in user and home neighborhood',
  },
  PersonalizedFeed: {
    hash: '22a4d6d17e9880dfc7ee64aa8fe6b7293ac48977d6ec3405628cd71502f3e7f1',
    description: 'Main news feed (posts and promos), paged',
  },
  FeedItem: {
    hash: '69db05fd456d4c11d44d5ca1874c97a94a5eeb415c4c240c8aac8aa29eee309d',
    description: 'One post with its first page of comments',
  },
  PagedComments: {
    hash: '78513e4b1379cf1bb8fe6686cd1fe916eda4e0a3140dd89f96ed0b50d9024e0e',
    description: 'Next page of comments or replies for a cursor',
  },
  searchPost: {
    hash: 'a4adacf8dc21beb46d7e79ac050be2204d2aa70a4f303ef4f9572d7e520be311',
    description: 'Post search results',
  },
  NotificationFeed: {
    hash: 'd4333b719dc3e5647acf01a14c786c27ac6ca4cceba17282ce33896a72c3a166',
    description: 'Notification center items, paged',
  },
  feedActivity: {
    hash: 'a431012c8544a160f531b2e6c5e15b15056b9a183342b4529166753ca16fa793',
    description: "A user's own posts with full content, paged",
  },
  allActivities: {
    hash: '564376c7e56899cf4c8794f2b3368a57afa223a7f54f51d64f8efa18d5fa8cf0',
    description: "A user's activity log (posts, replies, reactions) with lifetime counts",
  },
  userProfile: {
    hash: '7d30e62632beb08b554eda99c473297a27092eed3a14bf9d0b294fda4b5c00ad',
    description: "A neighbor's profile: home neighborhood, resident-since year, badges",
  },
  NeighborhoodProfile: {
    hash: '95362c506013b7b25925bc5ce3e83601958668f6fb5b2f0a65a81a52f4c44ee9',
    description: 'Neighborhood details and neighbor count, by slug',
  },
  ContentFromHoodFeed: {
    hash: '23249671f12f86b3dc9bfed21bbceb9c92e0a664617b3d9e69558849228cc307',
    description: "A neighborhood's public post feed, paged",
  },
  agencyFeed: {
    hash: '72a7ae93018a34c8de35fad5f3e3be22a8a24c4f9b40959afdbfcc0583a94e34',
    description: 'Posts from a public agency (police, county, city), paged',
  },
  ThemeFeed: {
    hash: 'f652be27d46cf97e8c788132dc7f6392ed40c4ee8e0fe4922ad2bdf0d1c2b435',
    description: 'Themed feed such as top local news, paged',
  },
  groupsWithPromosFeed: {
    hash: '2823fe45d3143ac74be885782d42a3d8c7cc61b7f7bc8ff9361780dd054b7d61',
    description: "A group's post feed, paged",
  },
  UserGroupsSections: {
    hash: '8b6a2c10a77450ef76c59b9f55ce197a9a94d1b35d037eba62d383327ef10502',
    description: 'Groups you belong to',
  },
  entityPage: {
    hash: 'f39c44f22b07ea02c77d502f18c54700524d441526996742ceb0ccf0f5ce6617',
    description: 'A business or organization page',
  },
  EntityPageInteractionsFeedQuery: {
    hash: '21024374b8021bb97a1da382ebffedb59df1642954c5e0bb0a81e3bdcb4e3694',
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
