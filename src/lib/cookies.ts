/**
 * Cookie extraction for Nextdoor authentication.
 *
 * Unlike a token-based API, Nextdoor authenticates with the full browser cookie
 * jar plus a CSRF token echoed in the `X-CSRFToken` header. We therefore read
 * EVERY nextdoor.com cookie from the browser (not just a couple of named ones)
 * and surface the `csrftoken` value separately.
 *
 * Sources, in priority order (see resolveCredentials):
 *   1. CLI flags (--cookie / --csrf)
 *   2. Environment (NDOOR_COOKIE / NDOOR_CSRF)
 *   3. A Chromium-family browser profile (Brave, Chrome, Edge, ...)
 *   4. A Firefox profile
 *   5. A cached cookie JSON file (flat { name: value } map)
 *
 * macOS only for browser decryption (uses the Keychain + sqlite3 CLI, no native
 * deps). Firefox and the cached file work cross-platform.
 */

import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** A resolved Nextdoor session: the full cookie jar plus the CSRF token. */
export interface NextdoorCookies {
  /** All nextdoor.com cookies as name -> value. */
  jar: Record<string, string>;
  /** Value of the `csrftoken` cookie, sent back as the X-CSRFToken header. */
  csrfToken: string | null;
  /** Human-readable description of where the cookies came from. */
  source: string | null;
}

export interface CookieExtractionResult {
  cookies: NextdoorCookies;
  warnings: string[];
}

/** The cookie that proves a logged-in Nextdoor session (browser auth token). */
const SESSION_COOKIE = 'ndbr_at';

/** Chromium-family browsers we know how to read on macOS. */
interface ChromiumBrowser {
  name: string;
  /** Path under ~/Library/Application Support/ */
  dir: string;
  /** macOS Keychain service name holding the AES key. */
  keychain: string;
}

const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { name: 'Chrome Beta', dir: 'Google/Chrome Beta', keychain: 'Chrome Safe Storage' },
  { name: 'Chrome Canary', dir: 'Google/Chrome Canary', keychain: 'Chrome Safe Storage' },
  { name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  { name: 'Arc', dir: 'Arc', keychain: 'Arc Safe Storage' },
  { name: 'Vivaldi', dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage' },
  { name: 'Chromium', dir: 'Chromium', keychain: 'Chromium Safe Storage' },
];

/** Build the `Cookie:` request header from a jar. */
export function buildCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** True if the jar looks like a usable, logged-in Nextdoor session. */
export function isLoggedIn(jar: Record<string, string>): boolean {
  return Boolean(jar[SESSION_COOKIE] && jar.csrftoken);
}

function appSupportDir(): string {
  return join(homedir(), 'Library', 'Application Support');
}

/** True if the buffer contains bytes that never appear in a plain cookie value. */
function looksBinary(buf: Buffer): boolean {
  for (const byte of buf) {
    // Allow tab/newline/CR; flag any other control byte or non-ASCII byte.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte >= 0x7f) return true;
  }
  return false;
}

/**
 * Decode a Chromium v10/v11 cookie buffer that has already been AES-decrypted.
 *
 * Modern Chromium (macOS, ~2024+) prepends a 32-byte SHA256 hash of the host to
 * the plaintext value. That prefix is binary, so we detect it via binary bytes in
 * the first 32 bytes and strip it; older cookies have no prefix.
 */
export function decodeDecrypted(decrypted: Buffer): string {
  if (decrypted.length > 32 && looksBinary(decrypted.subarray(0, 32))) {
    return decrypted.subarray(32).toString('utf8');
  }
  return decrypted.toString('utf8');
}

/** Get and cache the per-browser AES key from the macOS Keychain. */
const keychainKeyCache = new Map<string, string | null>();
function getKeychainKey(service: string): string | null {
  if (keychainKeyCache.has(service)) return keychainKeyCache.get(service) ?? null;
  let key: string | null = null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    key = out.length > 0 ? out : null;
  } catch {
    key = null;
  }
  keychainKeyCache.set(service, key);
  return key;
}

function decryptChromiumValue(encryptedHex: string, keychainKey: string): string | null {
  try {
    const encrypted = Buffer.from(encryptedHex, 'hex');
    if (encrypted.length < 4) return null;

    const version = encrypted.subarray(0, 3).toString('utf8');
    if (version !== 'v10' && version !== 'v11') {
      // Unencrypted (rare on macOS) - return as-is.
      return encrypted.toString('utf8');
    }

    // Standard Chromium-on-macOS derivation: PBKDF2(key, "saltysalt", 1003) -> 16 bytes.
    const derivedKey = pbkdf2Sync(keychainKey, 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv('aes-128-cbc', derivedKey, iv);
    decipher.setAutoPadding(true);

    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return decodeDecrypted(decrypted);
  } catch {
    return null;
  }
}

/** Run a query against a sqlite DB via the sqlite3 CLI, returning raw stdout. */
function sqlite3Query(dbPath: string, query: string): string {
  return execFileSync('sqlite3', ['-separator', '\t', dbPath, query], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Profile directories under a browser dir that contain a Cookies DB. */
function listProfiles(browserRoot: string): string[] {
  if (!existsSync(browserRoot)) return [];

  try {
    const entries = readdirSync(browserRoot, { withFileTypes: true });
    const profiles: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const isProfile = name === 'Default' || name === 'Guest Profile' || /^Profile \d+$/.test(name);
      if (!isProfile) continue;
      if (existsSync(join(browserRoot, name, 'Cookies'))) profiles.push(name);
    }

    return profiles;
  } catch {
    return [];
  }
}

/** Read raw (name, encrypted_hex) rows for nextdoor cookies from a Chromium DB. */
function readChromiumRows(cookiesPath: string): Array<[string, string]> {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'ndoor-'));
    const tempDb = join(tempDir, 'Cookies');
    copyFileSync(cookiesPath, tempDb);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${cookiesPath}${suffix}`)) copyFileSync(`${cookiesPath}${suffix}`, `${tempDb}${suffix}`);
    }
    const out = sqlite3Query(
      tempDb,
      "SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%nextdoor.com%' ORDER BY LENGTH(path) DESC;",
    );
    if (!out) return [];
    return out
      .split('\n')
      .map((line) => line.split('\t') as [string, string])
      .filter(([name, hex]) => name && hex);
  } catch {
    return [];
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * Extract the nextdoor.com cookie jar from a Chromium-family browser profile.
 * If `browser`/`profile` are omitted, scans all known browsers/profiles and
 * picks the one with a logged-in session (preferring the largest jar).
 */
export function extractFromChromium(options: { browser?: string; profile?: string } = {}): CookieExtractionResult {
  const warnings: string[] = [];
  const targets = options.browser
    ? CHROMIUM_BROWSERS.filter((b) => b.name.toLowerCase() === options.browser?.toLowerCase())
    : CHROMIUM_BROWSERS;

  if (options.browser && targets.length === 0) {
    warnings.push(`Unknown browser "${options.browser}". Known: ${CHROMIUM_BROWSERS.map((b) => b.name).join(', ')}.`);
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }

  let best: NextdoorCookies | null = null;

  for (const browser of targets) {
    const root = join(appSupportDir(), browser.dir);
    const profiles = options.profile ? [options.profile] : listProfiles(root);
    for (const profile of profiles) {
      const cookiesPath = join(root, profile, 'Cookies');
      if (!existsSync(cookiesPath)) continue;
      const rows = readChromiumRows(cookiesPath);
      if (rows.length === 0) continue;

      const key = getKeychainKey(browser.keychain);
      if (!key) {
        warnings.push(`Found nextdoor cookies in ${browser.name} but could not read "${browser.keychain}" key.`);
        continue;
      }

      const jar: Record<string, string> = {};
      for (const [name, hex] of rows) {
        const value = decryptChromiumValue(hex, key);
        if (value && !(name in jar)) jar[name] = value;
      }
      if (Object.keys(jar).length === 0) continue;

      const candidate: NextdoorCookies = {
        jar,
        csrfToken: jar.csrftoken ?? null,
        source: `${browser.name} profile "${profile}"`,
      };
      // Prefer a fully logged-in session; among those, the largest jar.
      if (scoreJar(candidate.jar) > (best ? scoreJar(best.jar) : -1)) best = candidate;
    }
  }

  if (!best) {
    warnings.push('No nextdoor.com cookies found in any Chromium-family browser. Log in to nextdoor.com first.');
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }
  if (!isLoggedIn(best.jar)) {
    warnings.push(`Cookies from ${best.source} look incomplete (no active session). Try logging in again.`);
  }
  return { cookies: best, warnings };
}

/** Rank candidate jars: logged-in sessions first, then by size. */
function scoreJar(jar: Record<string, string>): number {
  return (isLoggedIn(jar) ? 1000 : 0) + Object.keys(jar).length;
}

function firefoxProfilesRoot(): string | null {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Firefox', 'Profiles');
  if (process.platform === 'linux') return join(home, '.mozilla', 'firefox');
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'Mozilla', 'Firefox', 'Profiles');
  }
  return null;
}

/** Extract the nextdoor.com cookie jar from Firefox (plaintext, no decryption). */
export function extractFromFirefox(options: { profile?: string } = {}): CookieExtractionResult {
  const warnings: string[] = [];
  const root = firefoxProfilesRoot();
  if (!root || !existsSync(root)) {
    warnings.push('No Firefox profiles directory found.');
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }

  let profileDirs: string[];
  try {
    profileDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }

  if (options.profile) {
    profileDirs = profileDirs.filter((name) => name === options.profile || name.includes(options.profile as string));
  } else {
    const def = profileDirs.find((n) => n.includes('default-release'));
    if (def) profileDirs = [def, ...profileDirs.filter((n) => n !== def)];
  }

  let best: NextdoorCookies | null = null;
  for (const profile of profileDirs) {
    const dbPath = join(root, profile, 'cookies.sqlite');
    if (!existsSync(dbPath)) continue;
    let tempDir: string | null = null;
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'ndoor-ff-'));
      const tempDb = join(tempDir, 'cookies.sqlite');
      copyFileSync(dbPath, tempDb);
      const out = sqlite3Query(tempDb, "SELECT name, value FROM moz_cookies WHERE host LIKE '%nextdoor.com%';");
      if (!out) continue;
      const jar: Record<string, string> = {};
      for (const line of out.split('\n')) {
        const [name, value] = line.split('\t');
        if (name && value && !(name in jar)) jar[name] = value;
      }
      if (Object.keys(jar).length === 0) continue;
      const candidate: NextdoorCookies = {
        jar,
        csrfToken: jar.csrftoken ?? null,
        source: `Firefox profile "${profile}"`,
      };
      if (scoreJar(candidate.jar) > (best ? scoreJar(best.jar) : -1)) best = candidate;
    } catch {
      // skip unreadable profile
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  if (!best) {
    warnings.push('No nextdoor.com cookies found in Firefox.');
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }
  return { cookies: best, warnings };
}

/** Default location of the cached cookie file (compatible with nextdoor-digest). */
export function defaultCookieFilePath(): string {
  return join(homedir(), '.config', 'scrapling', 'nextdoor-cookies.json');
}

/** Read a cached cookie jar from a flat { name: value } JSON file. */
export function extractFromFile(path: string): CookieExtractionResult {
  const warnings: string[] = [];
  if (!existsSync(path)) {
    warnings.push(`No cached cookie file at ${path}.`);
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const jar: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'string') jar[name] = value;
    }
    return {
      cookies: { jar, csrfToken: jar.csrftoken ?? null, source: `cache ${path}` },
      warnings,
    };
  } catch (error) {
    warnings.push(`Failed to parse cookie file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { cookies: { jar: {}, csrfToken: null, source: null }, warnings };
  }
}

/** Parse a raw `Cookie:` header string ("k=v; k=v") into a jar. */
export function parseCookieHeader(header: string): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

export interface ResolveOptions {
  /** Raw Cookie header string (from --cookie or NDOOR_COOKIE). */
  cookie?: string;
  /** CSRF token override (from --csrf or NDOOR_CSRF). */
  csrf?: string;
  /** Restrict browser auto-extract to one browser by name. */
  browser?: string;
  /** Restrict browser auto-extract to one profile. */
  profile?: string;
  /** Path to a cached cookie file. */
  cookieFile?: string;
  /** Disable browser auto-extraction (use env/flags/file only). */
  noBrowser?: boolean;
}

/**
 * Resolve a Nextdoor session from all sources.
 * Precedence: CLI/explicit > env > Chromium browser > Firefox > cached file.
 */
export function resolveCredentials(options: ResolveOptions = {}): CookieExtractionResult {
  const warnings: string[] = [];

  // 1. Explicit cookie header (CLI flag or env).
  const rawCookie = options.cookie ?? process.env.NDOOR_COOKIE;
  if (rawCookie) {
    const jar = parseCookieHeader(rawCookie);
    const csrf = options.csrf ?? process.env.NDOOR_CSRF ?? jar.csrftoken ?? null;
    if (csrf && !jar.csrftoken) jar.csrftoken = csrf;
    return { cookies: { jar, csrfToken: csrf, source: 'explicit cookie' }, warnings };
  }

  // 2. Browser auto-extraction (Chromium first, then Firefox).
  if (!options.noBrowser) {
    const chromium = extractFromChromium({ browser: options.browser, profile: options.profile });
    if (isLoggedIn(chromium.cookies.jar)) {
      if (options.csrf) chromium.cookies.csrfToken = options.csrf;
      return chromium;
    }
    warnings.push(...chromium.warnings);

    const firefox = extractFromFirefox({ profile: options.profile });
    if (isLoggedIn(firefox.cookies.jar)) {
      if (options.csrf) firefox.cookies.csrfToken = options.csrf;
      return firefox;
    }
    warnings.push(...firefox.warnings);
  }

  // 3. Cached cookie file.
  const filePath = options.cookieFile ?? process.env.NDOOR_COOKIE_FILE ?? defaultCookieFilePath();
  const cached = extractFromFile(filePath);
  if (Object.keys(cached.cookies.jar).length > 0) {
    if (options.csrf) cached.cookies.csrfToken = options.csrf;
    cached.warnings = [...warnings, ...cached.warnings];
    return cached;
  }
  warnings.push(...cached.warnings);

  warnings.push('Could not resolve Nextdoor credentials from any source. Log in to nextdoor.com in your browser.');
  return { cookies: { jar: {}, csrfToken: options.csrf ?? null, source: null }, warnings };
}
