/**
 * Persistent cache of Jev answers, shared by every feature that asks Jev
 * anything (analyze, sync --analyze, judge, themes assign), so no question is
 * ever paid for twice.
 *
 * The key is a hash of the model, the exact questions, and the exact state:
 * rewording a question or changing the input text misses the cache on its own,
 * with no version bookkeeping. Entries are appended to a JSONL file the moment
 * each answer arrives, so an interrupted run (Ctrl-C, out of credits, a crash)
 * keeps everything it already received. The file holds hashes and numeric
 * judgments only, never the judged text.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Anything JSON-serializable that the cache stores per key. */
export type Cached = Record<string, unknown>;

export interface AnswerCache {
  get(key: string): Cached | undefined;
  set(key: string, value: Cached): void;
}

/** Stable JSON: object keys sorted, so equal content always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function cacheKey(parts: { model: string; questions: unknown; state: unknown }): string {
  return createHash('sha256').update(canonical(parts)).digest('hex');
}

/** In-memory cache, for tests and one-off runs. */
export class MemoryCache implements AnswerCache {
  readonly entries = new Map<string, Cached>();
  get(key: string) {
    return this.entries.get(key);
  }
  set(key: string, value: Cached) {
    this.entries.set(key, value);
  }
}

/** Append-only JSONL file cache. Later lines win; malformed lines (a torn last write) are skipped. */
export class FileCache implements AnswerCache {
  private readonly entries = new Map<string, Cached>();

  private constructor(private readonly path: string) {}

  static open(path: string): FileCache {
    const cache = new FileCache(path);
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const { k, v } = JSON.parse(line) as { k: string; v: Cached };
          if (typeof k === 'string' && v && typeof v === 'object') cache.entries.set(k, v);
        } catch {
          // A line cut short by an interrupted write: that answer is simply asked again.
        }
      }
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    return cache;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string) {
    return this.entries.get(key);
  }

  set(key: string, value: Cached) {
    this.entries.set(key, value);
    const fresh = !existsSync(this.path);
    appendFileSync(this.path, `${JSON.stringify({ k: key, v: value })}\n`, { mode: 0o600 });
    if (fresh) chmodSync(this.path, 0o600);
  }
}
