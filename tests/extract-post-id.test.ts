import { describe, expect, it } from 'vitest';
import { extractPostId } from '../src/lib/extract-post-id.js';

describe('extractPostId', () => {
  it('returns a bare id unchanged', () => {
    expect(extractPostId('123456789')).toBe('123456789');
    expect(extractPostId('abc123def')).toBe('abc123def');
  });

  it('extracts from a /p/ short URL', () => {
    expect(extractPostId('https://nextdoor.com/p/abc123def456')).toBe('abc123def456');
  });

  it('extracts from a /post/ URL', () => {
    expect(extractPostId('https://nextdoor.com/post/987654321/')).toBe('987654321');
  });

  it('extracts from a ?post= query parameter', () => {
    expect(extractPostId('https://nextdoor.com/news_feed/?post=555&foo=bar')).toBe('555');
  });

  it('trims surrounding whitespace', () => {
    expect(extractPostId('  123  ')).toBe('123');
  });
});
