/**
 * Export everything a user wrote on Nextdoor: their posts and their comments,
 * each comment with the text it was answering. Meant as a personal voice
 * corpus (JSONL for tooling, Markdown for reading or prompting).
 *
 * The export is resumable: records are appended as they arrive and the set of
 * finished threads is checkpointed, so a throttled or interrupted run picks up
 * where it stopped. It is also incremental: once everything is archived, a
 * rerun reads only the newest posts and activity, stops at the first stretch it
 * already has, and fetches just the threads with new comments by the user.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity, ActivityPage, Comment, Post, Reactions } from './model.js';

export interface ArchivedComment {
  id: string;
  url: string;
  at: string | null;
  body: string;
  reactions: Reactions;
  /** The post the comment lives on. */
  post: { id: string; shareId: string; url: string; author: string; subject: string; body: string };
  isOwnPost: boolean;
  /** What this comment answers: another comment, or null when it answers the post itself. */
  inReplyTo: { author: string; body: string } | null;
}

export interface ArchiveSource {
  activityPages(secureUserId: string, options: { before?: string | null }): AsyncGenerator<ActivityPage>;
  userPosts(secureUserId: string): AsyncGenerator<Post>;
  /** With `allComments: false`, only the comments that load with the post (a fallback when paging fails). */
  post(postId: string, options?: { allComments?: boolean }): Promise<Post>;
}

export interface ArchiveOptions {
  outDir: string;
  userId: string;
  secureUserId: string;
  /** Called with progress lines (stderr in the CLI). */
  log?: (line: string) => void;
}

export interface ArchiveResult {
  posts: number;
  comments: number;
  threadsFetched: number;
  failures: number;
  counts: ActivityPage['counts'];
  /** False when the activity log could not be fully read; rerunning resumes it. */
  activitiesComplete: boolean;
  activityError: string | null;
}

const CONTEXT_CHARS = 1500;
/** Own posts already archived, in a row, after which the profile feed has nothing newer to give. */
const KNOWN_POSTS_RUN = 10;

const activityKey = (activity: Activity) => `${activity.kind}|${activity.postId}|${activity.at ?? ''}`;

function clip(text: string, max = CONTEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function flatten(comments: Comment[]): Comment[] {
  return comments.flatMap((comment) => [comment, ...flatten(comment.replies)]);
}

/** The user's own comments in a fully loaded thread, each with its context. */
export function commentsBy(post: Post, userId: string): ArchivedComment[] {
  const all = flatten(post.comments);
  const byId = new Map(all.map((comment) => [comment.id, comment]));
  return all
    .filter((comment) => comment.author.id === userId && !comment.isDeleted && comment.body.trim() !== '')
    .map((comment) => {
      const target = comment.replyToId ? byId.get(comment.replyToId) : undefined;
      return {
        id: comment.id,
        url: `${post.url}/c/${comment.id.replace(/^comment_/, '')}`,
        at: comment.createdAt,
        body: comment.body,
        reactions: comment.reactions,
        post: {
          id: post.id,
          shareId: post.shareId,
          url: post.url,
          author: post.author.name,
          subject: post.subject,
          body: clip(post.body === post.subject ? '' : post.body),
        },
        isOwnPost: post.author.id === userId,
        inReplyTo: target ? { author: target.author.name, body: clip(target.body) } : null,
      };
    });
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function postForArchive(post: Post): Omit<Post, 'comments' | 'commentsCursor'> {
  const { comments: _comments, commentsCursor: _cursor, ...rest } = post;
  return rest;
}

export async function archiveUser(source: ArchiveSource, options: ArchiveOptions): Promise<ArchiveResult> {
  const { outDir, userId, secureUserId } = options;
  const log = options.log ?? (() => {});
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = (name: string) => join(outDir, name);
  const append = (name: string, record: unknown) =>
    appendFileSync(file(name), `${JSON.stringify(record)}\n`, { mode: 0o600 });

  const statePath = file('state.json');
  type State = {
    threadsDone: string[];
    activityCursor: string | null;
    activitiesComplete: boolean;
    counts: ActivityPage['counts'];
  };
  const state: State = {
    threadsDone: [],
    activityCursor: null,
    activitiesComplete: false,
    counts: null,
    ...(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}),
  };
  // Threads that failed last time are retried rather than treated as finished.
  const previousFailures = readJsonl<{ postId: string }>(file('failures.jsonl'));
  const threadsDone = new Set(state.threadsDone);
  for (const { postId } of previousFailures) threadsDone.delete(postId);
  const checkpoint = () =>
    writeFileSync(statePath, JSON.stringify({ ...state, threadsDone: [...threadsDone] }), { mode: 0o600 });

  // 1. Own posts with full content.
  log('reading your posts…');
  const posts = new Map(readJsonl<Post>(file('posts.jsonl')).map((post) => [post.id, post]));
  // Newest first, so a run of posts already archived means the rest are archived too.
  // The run is several posts long because pinned posts can sit at the top out of order.
  let knownRun = 0;
  for await (const post of source.userPosts(secureUserId)) {
    if (post.author.id !== userId) continue;
    if (posts.has(post.id)) {
      if (++knownRun >= KNOWN_POSTS_RUN) break;
      continue;
    }
    knownRun = 0;
    posts.set(post.id, post);
    append('posts.jsonl', postForArchive(post));
  }
  // 2. Activity log: tells us every post the user wrote on or commented on.
  //    Appended page by page and checkpointed, so a throttled run resumes at the same timestamp.
  const activities = readJsonl<Activity>(file('activities.jsonl'));
  let activityError: string | null = null;
  if (state.activitiesComplete) {
    // Later runs: read from the newest end and stop at the first page with nothing new.
    // A new comment on a thread archived earlier sends that thread back for another read.
    const known = new Set(activities.map(activityKey));
    let fresh = 0;
    try {
      for await (const page of source.activityPages(secureUserId, { before: null })) {
        if (page.counts) state.counts = page.counts;
        const added = page.activities.filter((activity) => !known.has(activityKey(activity)));
        for (const activity of added) {
          known.add(activityKey(activity));
          append('activities.jsonl', activity);
          activities.push(activity);
          if (activity.kind === 'comment') threadsDone.delete(activity.postId);
        }
        fresh += added.length;
        if (added.length === 0) break;
      }
      checkpoint();
      if (fresh) log(`  ${fresh} new activities since the last export`);
    } catch (error) {
      activityError = error instanceof Error ? error.message : String(error);
      log(`  could not check for new activity (${activityError}); rerun later`);
    }
  } else {
    log(activities.length ? `resuming activity log at ${activities.length} activities…` : 'reading activity log…');
    try {
      for await (const page of source.activityPages(secureUserId, { before: state.activityCursor })) {
        state.counts ??= page.counts;
        for (const activity of page.activities) append('activities.jsonl', activity);
        activities.push(...page.activities);
        state.activityCursor = page.nextBefore;
        checkpoint();
        const oldest = page.activities.at(-1)?.at?.slice(0, 10);
        if (oldest) log(`  ${activities.length} activities, back to ${oldest}`);
      }
      state.activitiesComplete = true;
      checkpoint();
    } catch (error) {
      // Typically throttling. Everything reachable without the log still gets archived; rerun to resume.
      activityError = error instanceof Error ? error.message : String(error);
      log(`  activity log paused (${activityError}); continuing with what is available, rerun later to resume`);
    }
  }
  const counts = state.counts;
  log(
    `  ${activities.length} activities${counts ? ` (Nextdoor reports ${counts.posts} posts, ${counts.comments} comments)` : ''}`,
  );

  // Posts in the activity log that the profile feed did not return (older or filtered) are fetched one by one.
  const missingPosts = [...new Set(activities.filter((a) => a.kind === 'post').map((a) => a.postId))].filter(
    (id) => !posts.has(id) && !threadsDone.has(id),
  );
  log(`  ${posts.size} posts${missingPosts.length ? `, ${missingPosts.length} more to fetch individually` : ''}`);

  // 3. Threads: every post commented on, plus own posts that have comments, plus missing own posts.
  const threadIds = [
    ...new Set([
      ...activities.filter((a) => a.kind === 'comment').map((a) => a.postId),
      ...[...posts.values()].filter((post) => post.commentCount > 0).map((post) => post.id),
      ...missingPosts,
    ]),
  ].filter((id) => !threadsDone.has(id));

  const commentIds = new Set(readJsonl<ArchivedComment>(file('comments.jsonl')).map((c) => c.id));
  const failures: { postId: string; error: string; partial?: boolean }[] = [];
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  log(`reading ${threadIds.length} threads for your comments…`);
  for (const [index, postId] of threadIds.entries()) {
    let thread: Post | null = null;
    try {
      thread = await source.post(postId);
      threadsDone.add(postId);
    } catch (error) {
      // Comment paging sometimes errors on old threads; the first page usually still loads with the post.
      try {
        thread = await source.post(postId, { allComments: false });
        failures.push({ postId, error: message(error), partial: true });
      } catch (fallbackError) {
        failures.push({ postId, error: message(fallbackError) });
      }
    }
    if (thread) {
      if (thread.author.id === userId && !posts.has(thread.id)) {
        posts.set(thread.id, thread);
        append('posts.jsonl', postForArchive(thread));
      }
      for (const comment of commentsBy(thread, userId)) {
        if (commentIds.has(comment.id)) continue;
        commentIds.add(comment.id);
        append('comments.jsonl', comment);
      }
    }
    if ((index + 1) % 10 === 0 || index === threadIds.length - 1) {
      checkpoint();
      log(`  ${index + 1}/${threadIds.length} threads · ${commentIds.size} comments`);
    }
  }
  writeFileSync(file('failures.jsonl'), failures.map((f) => `${JSON.stringify(f)}\n`).join(''), { mode: 0o600 });
  checkpoint();

  writeFileSync(
    file('voice.md'),
    renderVoiceCorpus([...posts.values()], readJsonl<ArchivedComment>(file('comments.jsonl'))),
    {
      mode: 0o600,
    },
  );
  return {
    posts: posts.size,
    comments: commentIds.size,
    threadsFetched: threadIds.length,
    failures: failures.length,
    counts,
    activitiesComplete: state.activitiesComplete,
    activityError,
  };
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Chronological Markdown of everything the user wrote, each comment with the text it answered. */
export function renderVoiceCorpus(
  posts: Pick<Post, 'createdAt' | 'url' | 'subject' | 'body'>[],
  comments: ArchivedComment[],
): string {
  type Entry = { at: string; text: string };
  const entries: Entry[] = [
    ...posts.map((post) => ({
      at: post.createdAt ?? '',
      text: [
        `## ${post.createdAt?.slice(0, 10) ?? '?'} · post · ${post.url}`,
        '',
        [post.subject, post.body === post.subject ? '' : post.body].filter(Boolean).join('\n\n'),
      ].join('\n'),
    })),
    ...comments.map((comment) => {
      const context = comment.inReplyTo
        ? `Replying to ${comment.inReplyTo.author}:\n\n${quote(comment.inReplyTo.body)}`
        : `On ${comment.isOwnPost ? 'my own' : `${comment.post.author}'s`} post "${comment.post.subject}":\n\n${quote(
            [comment.post.subject === comment.post.body ? '' : comment.post.body].filter(Boolean).join('') ||
              comment.post.subject,
          )}`;
      return {
        at: comment.at ?? '',
        text: [`## ${comment.at?.slice(0, 10) ?? '?'} · comment · ${comment.url}`, '', context, '', comment.body].join(
          '\n',
        ),
      };
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return `# My Nextdoor writing\n\n${entries.length} entries, oldest first. Quoted text (>) is context written by others.\n\n${entries
    .map((entry) => entry.text)
    .join('\n\n---\n\n')}\n`;
}
