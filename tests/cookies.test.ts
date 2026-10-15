import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCookieHeader,
  decodeDecrypted,
  extractFromFile,
  isLoggedIn,
  parseCookieHeader,
  resolveCredentials,
} from '../src/lib/cookies.js';

describe('buildCookieHeader', () => {
  it('joins a jar into a Cookie header string', () => {
    expect(buildCookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2');
  });

  it('returns an empty string for an empty jar', () => {
    expect(buildCookieHeader({})).toBe('');
  });
});

describe('parseCookieHeader', () => {
  it('parses a Cookie header into a jar', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('keeps "=" characters inside values', () => {
    expect(parseCookieHeader('token=ey.abc=; x=1')).toEqual({ token: 'ey.abc=', x: '1' });
  });

  it('ignores malformed segments', () => {
    expect(parseCookieHeader('a=1; garbage; b=2')).toEqual({ a: '1', b: '2' });
  });
});

describe('isLoggedIn', () => {
  it('requires both the session cookie and a csrftoken', () => {
    expect(isLoggedIn({ ndbr_at: 'x', csrftoken: 'y' })).toBe(true);
    expect(isLoggedIn({ ndbr_at: 'x' })).toBe(false);
    expect(isLoggedIn({ csrftoken: 'y' })).toBe(false);
    expect(isLoggedIn({})).toBe(false);
  });
});

describe('decodeDecrypted', () => {
  it('strips the 32-byte SHA256 domain-hash prefix that modern Chromium prepends', () => {
    const prefix = createHash('sha256').update('nextdoor.com').digest(); // 32 binary bytes
    const value = 'GA1.1.123456789.1700000000';
    const buf = Buffer.concat([prefix, Buffer.from(value, 'utf8')]);
    expect(decodeDecrypted(buf)).toBe(value);
  });

  it('returns short printable values unchanged (no prefix)', () => {
    const buf = Buffer.from('plainvalue', 'utf8');
    expect(decodeDecrypted(buf)).toBe('plainvalue');
  });
});

describe('extractFromFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ndoor-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a flat cookie JSON file and surfaces csrftoken', () => {
    const path = join(dir, 'cookies.json');
    writeFileSync(path, JSON.stringify({ ndbr_at: 'token', csrftoken: 'csrf123', other: 'v' }));
    const { cookies, warnings } = extractFromFile(path);
    expect(cookies.jar.ndbr_at).toBe('token');
    expect(cookies.csrfToken).toBe('csrf123');
    expect(warnings).toEqual([]);
  });

  it('warns when the file is missing', () => {
    const { cookies, warnings } = extractFromFile(join(dir, 'nope.json'));
    expect(cookies.jar).toEqual({});
    expect(warnings[0]).toMatch(/No cached cookie file/);
  });
});

describe('resolveCredentials', () => {
  it('uses an explicit cookie string and derives csrftoken from it', () => {
    const { cookies } = resolveCredentials({ cookie: 'ndbr_at=a; csrftoken=b' });
    expect(cookies.source).toBe('explicit cookie');
    expect(cookies.csrfToken).toBe('b');
    expect(isLoggedIn(cookies.jar)).toBe(true);
  });

  it('lets an explicit --csrf override the cookie value', () => {
    const { cookies } = resolveCredentials({ cookie: 'ndbr_at=a; csrftoken=b', csrf: 'override' });
    expect(cookies.csrfToken).toBe('override');
  });

  it('falls back to a cached file when browser extraction is disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndoor-test-'));
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify({ ndbr_at: 'a', csrftoken: 'b' }));
    const { cookies } = resolveCredentials({ noBrowser: true, cookieFile: path });
    expect(cookies.source).toBe(`cache ${path}`);
    expect(cookies.csrfToken).toBe('b');
    rmSync(dir, { recursive: true, force: true });
  });
});
