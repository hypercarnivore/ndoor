import { describe, expect, it } from 'vitest';
import {
  classifyPosts,
  DEFAULT_TOPICS,
  formatDigest,
  formatNotifications,
  formatPost,
  formatSearch,
  getEffectiveTopics,
  isQuestion,
  relativeTime,
  safeText,
  truncate,
} from '../src/lib/digest.js';
import { mapCommentPage, mapPost, type Post } from '../src/lib/model.js';
import { author, comment, neighborhood, pagedCommentsResponse, post, T0 } from './fixtures/payloads.js';

function mapped(shareId: string, subject: string, hood = 'Maple Grove', authorType = 'NEIGHBOR'): Post {
  return mapPost(post(shareId, { subject, body: '', author: author('Sam', 1, neighborhood(1, hood), authorType) }))!;
}

describe('classification', () => {
  it('flags important posts, questions, and highlight area', () => {
    const [lost, question, other] = classifyPosts(
      [
        mapped('A', 'Lost dog near the park', 'Oak Hollow'),
        mapped('B', 'Anyone know a plumber?'),
        mapped('C', 'Sunset'),
      ],
      { highlightArea: 'maple' },
    );
    expect(lost).toMatchObject({ isImportant: true, inHighlightArea: false });
    expect(question).toMatchObject({ isQuestion: true, inHighlightArea: true });
    expect(other).toMatchObject({ isImportant: false, isQuestion: false });
  });

  it('uses configured topics when present', () => {
    expect(getEffectiveTopics({ topics: ['ai'] })).toEqual(['ai']);
    expect(getEffectiveTopics({})).toBe(DEFAULT_TOPICS);
    expect(isQuestion('Looking for advice')).toBe(true);
  });
});

describe('text helpers', () => {
  it('truncates and flattens whitespace', () => {
    expect(truncate('a\n  b', 10)).toBe('a b');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('formats relative times', () => {
    const iso = (ms: number) => new Date(T0 - ms).toISOString();
    expect(relativeTime(null)).toBe('?');
    expect(relativeTime('garbage', T0)).toBe('?');
    expect(relativeTime(iso(10_000), T0)).toBe('just now');
    expect(relativeTime(iso(5 * 60_000), T0)).toBe('5m ago');
    expect(relativeTime(iso(3 * 3_600_000), T0)).toBe('3h ago');
    expect(relativeTime(iso(2 * 86_400_000), T0)).toBe('2d ago');
    expect(relativeTime('2026-01-02T00:00:00Z', T0)).toBe('2026-01-02');
  });
});

describe('formatDigest', () => {
  const posts = classifyPosts(
    [
      mapped('A', 'Power outage on Main', 'Oak Hollow'),
      mapped('B', 'Who do you use for gutters?'),
      mapped('C', 'Nice sunset', 'Oak Hollow', 'CITY_AGENCY'),
    ],
    { highlightArea: 'Maple Grove' },
  );

  it('groups by area and importance and reports dropped ads', () => {
    const text = formatDigest(posts, { highlightArea: 'Maple Grove' }, { adsDropped: 4 }, T0);
    expect(text).toContain('Posts: 3, 4 ads dropped');
    expect(text).toContain('YOUR AREA (MAPLE GROVE):\n');
    expect(text).toContain('IMPORTANT (other areas):');
    expect(text).toContain('[city agency]');
    expect(text).not.toContain('\n\n\n');
  });

  it('separates questions when asked', () => {
    const text = formatDigest(classifyPosts([mapped('B', 'Who do you use?')], {}), {}, { questions: true }, T0);
    expect(text).toContain('QUESTIONS (neighbors need help):');
    expect(text).not.toContain('OTHER POSTS:');
  });

  it('says so when empty', () => {
    expect(formatDigest([], {})).toContain('Nothing in your feed');
  });
});

describe('formatPost', () => {
  it('renders the post with an indented comment tree', () => {
    const p = mapPost(post('P', { subject: 'Hello', body: 'World' }))!;
    p.comments = mapCommentPage(
      pagedCommentsResponse(
        [comment(1, 'top', { replies: [comment(2, 'nested')] }), comment(3, 'x', { deleted: true })],
        null,
      ),
    ).comments;
    const text = formatPost(p, T0);
    expect(text).toContain('Hello\n\nWorld');
    expect(text).toContain('[media] https://photos.example/P.png');
    expect(text).toContain('topics: General');
    expect(text).toMatch(/\n {2}Commenter 1 \(Oak Hollow\)/);
    expect(text).toMatch(/\n {4}Commenter 2/);
    expect(text).toContain('[deleted]');
  });
});

describe('formatNotifications and formatSearch', () => {
  it('marks unread notifications and strips URL tracking', () => {
    const text = formatNotifications(
      [
        {
          id: 'n',
          type: 'THANK',
          category: null,
          text: 'hi',
          createdAt: null,
          url: 'https://x/p/1?a=b',
          actors: [],
          isRead: false,
        },
      ],
      T0,
    );
    expect(text).toBe('* [thank] ?\n    hi\n    https://x/p/1');
    expect(formatNotifications([])).toBe('No notifications.');
  });

  it('lists search hits', () => {
    expect(formatSearch([])).toBe('No matching posts found.');
    expect(
      formatSearch([
        { shareId: 'S', url: 'u', author: 'A', context: 'Oak Hollow · 1 Oct', body: 'b', commentCount: 2 },
      ]),
    ).toBe('1. A (Oak Hollow · 1 Oct)\n   b\n   2 comments · u');
  });
});

describe('safeText', () => {
  const hostile = 'ok\u001b]0;pwned\u0007 \u001b[2J\u009b31m\r\u0000done\n\tnext';

  it('strips C0/C1 controls but keeps newline and tab', () => {
    expect(safeText(hostile)).toBe('ok]0;pwned [2J31mdone\n\tnext');
  });

  it('is applied by every formatter', () => {
    const p = mapPost(post('E', { subject: hostile, body: '' }))!;
    p.comments = mapCommentPage(pagedCommentsResponse([comment(1, hostile)], null)).comments;
    const outputs = [
      formatDigest(classifyPosts([p], {}), {}),
      formatPost(p),
      formatNotifications([
        { id: 'n', type: 'POST', category: null, text: hostile, createdAt: null, url: null, actors: [], isRead: true },
      ]),
      formatSearch([{ shareId: 'S', url: 'u', author: hostile, context: '', body: hostile, commentCount: 0 }]),
    ];
    for (const output of outputs) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of control characters
      expect(output).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    }
  });
});
