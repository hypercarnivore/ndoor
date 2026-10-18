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
    hash: '365d3b6e58f5cb85eca2a785ac43f6b913dbe668775cf886257a5605cdbfcfba',
    description: 'Logged-in user and home neighborhood',
  },
  PersonalizedFeed: {
    hash: 'f5e81a1a1e358146b413c369d66607597cfe1e34a481c84522cdd60622f4d014',
    description: 'Main news feed (posts and promos), paged',
  },
  FeedItem: {
    hash: '530dddcbd2daf1a51bb03edf6b256d537fca63c4793be553075c9af35a980135',
    description: 'One post with its first page of comments',
  },
  PagedComments: {
    hash: 'e60999832355b867ef70edbca6a1974064845cbba11a3f0b1e908adc9c0a2a52',
    description: 'Next page of comments or replies for a cursor',
  },
  searchPost: {
    hash: '36384d0b7938f3f7e31ef011bcdd84bd23b700edca822d80220c2359e9ebcab3',
    description: 'Post search results',
  },
  NotificationFeed: {
    hash: '13c5c59f5ed259962adec2a628f4fd07979e556396355aafda34bac54c87c19e',
    description: 'Notification center items, paged',
  },
  feedActivity: {
    hash: '1494dc93ecf76d93e502a1ae9304868e404a9341d08a97dd92f9f51157f86986',
    description: "A user's own posts with full content, paged",
  },
  allActivities: {
    hash: '564376c7e56899cf4c8794f2b3368a57afa223a7f54f51d64f8efa18d5fa8cf0',
    description: "A user's activity log (posts, replies, reactions) with lifetime counts",
  },
  userProfile: {
    hash: '67689a065d8e27e11775a5bd5e70a00e5df8a530c9379c6c64e0045743ed8bfb',
    description: "A neighbor's profile: home neighborhood, resident-since year, badges",
  },
  NeighborhoodProfile: {
    hash: 'c448ec3ff62c166b1b1d3816332bef3bd56ed9388443d1af319c4c9c98b0ac73',
    description: 'Neighborhood details and neighbor count, by slug',
  },
  ContentFromHoodFeed: {
    hash: 'b4667a99113c0e314d4077f779299af7c232d5ca152e2417a2ef7145a5adbe97',
    description: "A neighborhood's public post feed, paged",
  },
  agencyFeed: {
    hash: '72a7ae93018a34c8de35fad5f3e3be22a8a24c4f9b40959afdbfcc0583a94e34',
    description: 'Posts from a public agency (police, county, city), paged',
  },
  ThemeFeed: {
    hash: '4f4179ab9fea971161d0efebd80610f9eb8af144e1ed0adfb8c04cf0fea5b336',
    description: 'Themed feed such as top local news, paged',
  },
  groupsWithPromosFeed: {
    hash: '111151ebfbed686f1f1b9e8fed1c496cad668dca3fbed76e086af055f4e34cfb',
    description: "A group's post feed, paged",
  },
  UserGroupsSections: {
    hash: '8b6a2c10a77450ef76c59b9f55ce197a9a94d1b35d037eba62d383327ef10502',
    description: 'Groups you belong to',
  },
  entityPage: {
    hash: 'eb26e3256ad4a1c92e5830df93db4ee6ee46dc2372be39f8333a6d6eb041a5d5',
    description: 'A business or organization page',
  },
  EntityPageInteractionsFeedQuery: {
    hash: 'a6b34558328ad74c2abfaf59d0c2fd3ed66862ae3ebf2cb6a469f4b892e4244a',
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
