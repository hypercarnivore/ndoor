import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPERATIONS,
  harvestHashesFromHar,
  isOperationName,
  readOverrides,
  resolveHashes,
  writeOverrides,
} from '../src/lib/operations.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function har(entries: unknown[]) {
  return { log: { entries } };
}

describe('harvestHashesFromHar', () => {
  it('reads GET query-string and POST body persisted queries', () => {
    const extensions = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH_A } }));
    const found = harvestHashesFromHar(
      har([
        {
          request: {
            url: `https://nextdoor.com/api/gql/PersonalizedFeed?operationName=PersonalizedFeed&extensions=${extensions}`,
          },
        },
        {
          request: {
            url: 'https://nextdoor.com/api/gql/getMe?',
            postData: {
              text: JSON.stringify({ operationName: 'getMe', extensions: { persistedQuery: { sha256Hash: HASH_B } } }),
            },
          },
        },
        { request: { url: 'https://nextdoor.com/static/app.js' } },
        { request: { url: 'https://nextdoor.com/api/gql/bad?', postData: { text: 'not json' } } },
      ]),
    );
    expect(found).toEqual({ PersonalizedFeed: HASH_A, getMe: HASH_B });
  });

  it('rejects non-HAR input', () => {
    expect(() => harvestHashesFromHar({})).toThrow(/not a HAR/);
  });
});

describe('overrides', () => {
  it('round-trips, ignores invalid hashes, and wins over defaults', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ndoor-')), 'nested', 'operations.json');
    writeOverrides({ getMe: HASH_A }, path);
    expect(readOverrides(path)).toEqual({ getMe: HASH_A });

    writeFileSync(path, JSON.stringify({ getMe: 'short', FeedItem: HASH_B }));
    const overrides = readOverrides(path);
    expect(overrides).toEqual({ FeedItem: HASH_B });
    const hashes = resolveHashes(overrides);
    expect(hashes.FeedItem).toBe(HASH_B);
    expect(hashes.getMe).toBe(DEFAULT_OPERATIONS.getMe.hash);
  });

  it('returns {} for missing or corrupt files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndoor-'));
    expect(readOverrides(join(dir, 'missing.json'))).toEqual({});
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(readOverrides(join(dir, 'bad.json'))).toEqual({});
  });

  it('knows its operation names', () => {
    expect(isOperationName('searchPost')).toBe(true);
    expect(isOperationName('toString')).toBe(false);
  });
});
