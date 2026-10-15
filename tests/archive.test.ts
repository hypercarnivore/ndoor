import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ArchiveSource, archiveUser, commentsBy, renderVoiceCorpus } from '../src/lib/archive.js';
import { type Activity, mapPost, type Post, resolveReplyTargets } from '../src/lib/model.js';
import { author, comment, post } from './fixtures/payloads.js';

const ME = author('Me Myself', 42);
const meId = 'user_42';

const threadNumbers = new Map<string, number>();

function thread(shareId: string, postAuthor = author('Other', 7)): Post {
  if (!threadNumbers.has(shareId)) threadNumbers.set(shareId, 100 * (threadNumbers.size + 1));
  const n = threadNumbers.get(shareId)!;
  const p = mapPost(
    post(shareId, {
      subject: `About ${shareId}`,
      body: `Body ${shareId}`,
      author: postAuthor,
      comments: [
        comment(n + 1, 'a neighbor asks', {
          author: author('Neighbor', 8),
          minutesAgo: 30,
          replies: [comment(n + 2, 'my answer', { author: ME, parent: n + 1, mentions: [8], minutesAgo: 20 })],
        }),
        comment(n + 3, 'my top-level take', { author: ME, minutesAgo: 10 }),
        comment(n + 4, '', { author: ME, deleted: true }),
      ],
    }),
  )!;
  resolveReplyTargets(p.comments);
  return p;
}

describe('commentsBy', () => {
  it('extracts only my live comments, each with what it answered', () => {
    const mine = commentsBy(thread('T1'), meId);
    expect(mine.map((c) => c.body)).toEqual(['my answer', 'my top-level take']);
    expect(mine[0]).toMatchObject({
      url: expect.stringMatching(/^https:\/\/nextdoor\.com\/p\/T1\/c\/\d+2$/),
      inReplyTo: { author: 'Neighbor', body: 'a neighbor asks' },
      isOwnPost: false,
      post: { author: 'Other', subject: 'About T1', body: 'Body T1' },
    });
    expect(mine[1].inReplyTo).toBeNull();
  });
});

function fakeSource(
  options: { failOn?: string; pagingFailsOn?: string; throttleActivities?: boolean; newer?: Activity[] } = {},
) {
  const calls: string[] = [];
  const activities: Activity[] = [
    ...(options.newer ?? []),
    { kind: 'comment', postId: 'post_T1', at: '2026-01-02T00:00:00.000Z', summary: '' },
    { kind: 'reaction_to_post', postId: 'post_T9', at: null, summary: '' },
    { kind: 'post', postId: 'post_OLD', at: '2012-05-01T00:00:00.000Z', summary: '' },
    { kind: 'comment', postId: 'post_BAD', at: null, summary: '' },
  ];
  const source: ArchiveSource = {
    async *activityPages(_id, { before }) {
      calls.push(`activities:${before ?? 'start'}`);
      if (before === null || before === undefined) {
        if (options.throttleActivities) throw new Error('Nextdoor throttled allActivities');
        const head = activities.length - 2;
        yield {
          activities: activities.slice(0, head),
          nextBefore: 'b1',
          counts: { posts: 2, comments: 3, reactions: 1 },
        };
        calls.push('activities:b1');
      }
      yield { activities: activities.slice(-2), nextBefore: null, counts: null };
    },
    async *userPosts() {
      yield thread('MINE', ME);
      yield thread('T1');
    },
    async post(postId, postOptions) {
      calls.push(postId);
      if (postId === options.failOn) throw new Error('gone');
      if (postId === options.pagingFailsOn && postOptions?.allComments !== false) throw new Error('paging broke');
      if (postId === 'post_OLD') return mapPost(post('OLD', { subject: 'Hello 2012', author: ME }))!;
      const shareId = postId.replace(/^post_/, '');
      return thread(shareId, shareId === 'MINE' ? ME : undefined);
    },
  };
  return { source, calls };
}

describe('archiveUser', () => {
  it('writes posts, comments with context, failures, and a voice corpus', async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'ndoor-archive-')), 'out');
    const { source, calls } = fakeSource({ failOn: 'post_BAD' });
    const lines: string[] = [];
    const result = await archiveUser(source, { outDir, userId: meId, secureUserId: 's', log: (l) => lines.push(l) });

    expect(result).toMatchObject({
      posts: 2,
      comments: 4,
      failures: 1,
      counts: { posts: 2, comments: 3, reactions: 1 },
    });
    // post_BAD is tried twice: full thread, then the first-page fallback.
    expect(calls.filter((c) => c.startsWith('post_')).sort()).toEqual([
      'post_BAD',
      'post_BAD',
      'post_MINE',
      'post_OLD',
      'post_T1',
    ]);
    expect(result.activitiesComplete).toBe(true);
    expect(readFileSync(join(outDir, 'activities.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
    const posts = readFileSync(join(outDir, 'posts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(posts.map((p) => p.shareId).sort()).toEqual(['MINE', 'OLD']);
    expect(posts[0].comments).toBeUndefined();
    expect(readFileSync(join(outDir, 'failures.jsonl'), 'utf8')).toContain('"postId":"post_BAD"');
    expect(statSync(join(outDir, 'comments.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(outDir).mode & 0o777).toBe(0o700);

    const voice = readFileSync(join(outDir, 'voice.md'), 'utf8');
    expect(voice.indexOf('Hello 2012')).toBeLessThan(voice.indexOf('my answer'));
    expect(voice).toContain('Replying to Neighbor:\n\n> a neighbor asks\n\nmy answer');
    expect(voice).toContain('On my own post "About MINE"');
    expect(lines.join('\n')).toContain('Nextdoor reports 2 posts, 3 comments');
  });

  it('resumes without refetching finished threads or duplicating records', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ndoor-archive-'));
    await archiveUser(fakeSource().source, { outDir, userId: meId, secureUserId: 's' });
    const second = fakeSource();
    const result = await archiveUser(second.source, { outDir, userId: meId, secureUserId: 's' });
    // Only the newest activity page is read, and it has nothing new.
    expect(second.calls).toEqual(['activities:start']);
    expect(result.threadsFetched).toBe(0);
    const comments = readFileSync(join(outDir, 'comments.jsonl'), 'utf8').trim().split('\n');
    expect(new Set(comments).size).toBe(comments.length);
    expect(existsSync(join(outDir, 'state.json'))).toBe(true);
  });
});

describe('archiveUser after a finished export', () => {
  it('reads only new activity and refetches just the threads with new comments', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ndoor-archive-'));
    await archiveUser(fakeSource().source, { outDir, userId: meId, secureUserId: 's' });
    const later = fakeSource({
      newer: [{ kind: 'comment', postId: 'post_T1', at: '2026-03-01T00:00:00.000Z', summary: '' }],
    });
    const lines: string[] = [];
    const result = await archiveUser(later.source, {
      outDir,
      userId: meId,
      secureUserId: 's',
      log: (l) => lines.push(l),
    });
    expect(later.calls).toEqual(['activities:start', 'activities:b1', 'post_T1']);
    expect(result.threadsFetched).toBe(1);
    expect(lines.join('\n')).toContain('1 new activities since the last export');
    expect(readFileSync(join(outDir, 'activities.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('stops reading the profile feed after a run of posts it already has', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ndoor-archive-'));
    const own = Array.from({ length: 30 }, (_, i) => thread(`OWN${i}`, ME));
    let read = 0;
    const base = fakeSource().source;
    const source: ArchiveSource = {
      ...base,
      async *userPosts() {
        for (const p of own) {
          read++;
          yield p;
        }
      },
    };
    await archiveUser(source, { outDir, userId: meId, secureUserId: 's' });
    expect(read).toBe(30);
    read = 0;
    own.unshift(thread('NEWEST', ME));
    await archiveUser(source, { outDir, userId: meId, secureUserId: 's' });
    expect(read).toBe(11);
    const shareIds = readFileSync(join(outDir, 'posts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).shareId);
    expect(shareIds).toContain('NEWEST');
  });
});

describe('archiveUser when the activity log is throttled', () => {
  it('archives what it can, then resumes the log on the next run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ndoor-archive-'));
    const first = await archiveUser(fakeSource({ throttleActivities: true }).source, {
      outDir,
      userId: meId,
      secureUserId: 's',
    });
    expect(first).toMatchObject({ activitiesComplete: false, posts: 1, comments: 2 });
    expect(first.activityError).toMatch(/throttled/);

    const retry = fakeSource();
    const second = await archiveUser(retry.source, { outDir, userId: meId, secureUserId: 's' });
    expect(retry.calls[0]).toBe('activities:start');
    expect(second).toMatchObject({ activitiesComplete: true, posts: 2, comments: 6 });
  });
});

describe('archiveUser when comment paging fails', () => {
  it('keeps the first page of comments and retries the thread on the next run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ndoor-archive-'));
    const first = await archiveUser(fakeSource({ pagingFailsOn: 'post_T1' }).source, {
      outDir,
      userId: meId,
      secureUserId: 's',
    });
    expect(first).toMatchObject({ failures: 1, comments: 6 });
    expect(readFileSync(join(outDir, 'failures.jsonl'), 'utf8')).toContain('"partial":true');

    const retry = fakeSource();
    const second = await archiveUser(retry.source, { outDir, userId: meId, secureUserId: 's' });
    expect(retry.calls).toEqual(['activities:start', 'post_T1']);
    expect(second).toMatchObject({ failures: 0, comments: 6 });
    expect(readFileSync(join(outDir, 'failures.jsonl'), 'utf8')).toBe('');
  });
});

describe('renderVoiceCorpus', () => {
  it('handles an empty archive', () => {
    expect(renderVoiceCorpus([], [])).toContain('0 entries');
  });
});
