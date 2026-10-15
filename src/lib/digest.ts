/**
 * Classification and plain-text rendering of mapped Nextdoor data.
 *
 * Ads are already gone by the time posts get here (see model.ts), so this
 * module only decides what is important, what is a question, and what is in
 * the reader's own area, then formats it for a terminal or a pipe.
 */

import type { Comment, Notification, Post, SearchHit } from './model.js';

export interface DigestConfig {
  topics?: string[];
  highlightArea?: string | null;
}

export interface ClassifiedPost extends Post {
  isImportant: boolean;
  isQuestion: boolean;
  inHighlightArea: boolean;
}

export interface FormatDigestOptions {
  questions?: boolean;
  adsDropped?: number;
}

export const DEFAULT_TOPICS = [
  'police',
  'fire',
  'theft',
  'break-in',
  'burglary',
  'stolen',
  'suspicious',
  'missing',
  'accident',
  'evacuation',
  'outage',
  'power out',
  'road closed',
  'flooding',
  'earthquake',
  'wildfire',
  'emergency',
  'alert',
  'warning',
  'town hall',
  'city council',
  'meeting',
  'vote',
  'election',
  'ordinance',
  'zoning',
  'construction',
  'road work',
  'water main',
  'lost dog',
  'lost cat',
  'found dog',
  'found cat',
  'missing pet',
  'recommend',
  'recommendation',
  'looking for',
];

const QUESTION_STARTS = [
  'can anyone',
  'does anyone',
  'has anyone',
  'is there',
  'where can',
  'who do',
  'what is',
  'how do',
  'looking for',
  'need help',
  'advice',
  'suggestions',
  'recommend',
  'any idea',
  'anyone know',
];

function postText(post: Post): string {
  return [post.subject, post.body].filter(Boolean).join('\n');
}

export function isImportant(text: string, topics: string[]): boolean {
  const lower = text.toLowerCase();
  return topics.some((topic) => lower.includes(topic.toLowerCase()));
}

export function isQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  const lower = text.toLowerCase();
  return QUESTION_STARTS.some((start) => lower.includes(start));
}

export function matchesArea(post: Post, area: string | null | undefined): boolean {
  if (!area) return true;
  const needle = area.toLowerCase();
  const neighborhood = post.author.neighborhood?.name.toLowerCase() ?? '';
  return neighborhood.includes(needle) || postText(post).toLowerCase().includes(needle);
}

export function getEffectiveTopics(config: DigestConfig): string[] {
  return config.topics && config.topics.length > 0 ? config.topics : DEFAULT_TOPICS;
}

export function classifyPosts(posts: Post[], config: DigestConfig): ClassifiedPost[] {
  const topics = getEffectiveTopics(config);
  return posts.map((post) => {
    const text = postText(post);
    return {
      ...post,
      isImportant: isImportant(text, topics),
      isQuestion: isQuestion(text),
      inHighlightArea: Boolean(config.highlightArea && matchesArea(post, config.highlightArea)),
    };
  });
}

// --- rendering ---------------------------------------------------------------

/**
 * Remove C0/C1 control characters (keeping newline and tab) from text bound
 * for a terminal. Post and comment bodies are written by other people; raw
 * ESC/CSI/OSC sequences in them could rewrite the screen, set the window title,
 * or plant clickable hyperlinks. Every text formatter returns through this.
 */
export function safeText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

export function truncate(value: string, maxLength: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '?';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return '?';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

function postHeader(post: Post, now?: number): string {
  const where = post.author.neighborhood?.name ?? '?';
  const kind = post.author.type === 'NEIGHBOR' ? '' : ` [${post.author.type.toLowerCase().replace(/_/g, ' ')}]`;
  return `${post.author.name || '?'}${kind} (${where}) - ${relativeTime(post.createdAt, now)}`;
}

function postStats(post: Post): string {
  return `${post.reactions.total} reactions · ${post.commentCount} comments · ${post.url}`;
}

function appendPosts(lines: string[], posts: ClassifiedPost[], maxTextLength: number, now?: number): void {
  posts.forEach((post, index) => {
    const prefix = post.isImportant ? '[!] ' : post.isQuestion ? '[?] ' : '';
    lines.push(`  ${prefix}${index + 1}. ${postHeader(post, now)}`);
    lines.push(`     ${truncate(postText(post), maxTextLength)}`);
    lines.push(`     ${postStats(post)}`);
    lines.push('');
  });
}

export function formatDigest(
  posts: ClassifiedPost[],
  config: DigestConfig,
  options: FormatDigestOptions = {},
  now?: number,
): string {
  const area = config.highlightArea ?? null;
  const yourArea = area ? posts.filter((post) => post.inHighlightArea) : [];
  const other = area ? posts.filter((post) => !post.inHighlightArea) : posts;

  const important = other.filter((post) => post.isImportant);
  const questions = other.filter((post) => post.isQuestion && !post.isImportant);
  const regular = other.filter((post) => !post.isImportant && !(options.questions && post.isQuestion));

  const lines = ['Nextdoor Digest'];
  const ads = options.adsDropped ?? 0;
  lines.push(`Posts: ${posts.length}${ads > 0 ? `, ${ads} ads dropped` : ''}`);
  lines.push('='.repeat(60));

  const section = (title: string, items: ClassifiedPost[], max: number) => {
    if (items.length === 0) return;
    if (lines.at(-1) !== '') lines.push('');
    lines.push(title, '-'.repeat(40));
    appendPosts(lines, items, max, now);
  };

  if (area) {
    const sorted = [
      ...yourArea.filter((p) => p.isImportant),
      ...yourArea.filter((p) => p.isQuestion && !p.isImportant),
      ...yourArea.filter((p) => !p.isImportant && !p.isQuestion),
    ];
    section(`YOUR AREA (${area.toUpperCase()}):`, sorted, 300);
  }
  section(area ? 'IMPORTANT (other areas):' : 'IMPORTANT:', important, 300);
  if (options.questions) section('QUESTIONS (neighbors need help):', questions, 300);
  section('OTHER POSTS:', regular, 200);

  if (posts.length === 0) lines.push('', 'Nothing in your feed right now.');
  return safeText(lines.join('\n').trimEnd());
}

function appendComments(lines: string[], comments: Comment[], depth: number, now?: number): void {
  const indent = '  '.repeat(depth + 1);
  for (const comment of comments) {
    const reactions = comment.reactions.total > 0 ? ` · ${comment.reactions.total} reactions` : '';
    const where = comment.author.neighborhood?.name ? ` (${comment.author.neighborhood.name})` : '';
    lines.push(`${indent}${comment.author.name || '?'}${where} - ${relativeTime(comment.createdAt, now)}${reactions}`);
    lines.push(`${indent}  ${comment.isDeleted ? '[deleted]' : comment.body.replace(/\s+/g, ' ').trim()}`);
    appendComments(lines, comment.replies, depth + 1, now);
  }
}

export function formatPost(post: Post, now?: number): string {
  const lines = [postHeader(post, now)];
  if (post.subject) lines.push('', post.subject);
  if (post.body && post.body !== post.subject) lines.push('', post.body);
  if (post.media.length > 0) lines.push('', ...post.media.map((url) => `[media] ${url}`));
  lines.push('', postStats(post));
  if (post.topics.length > 0) lines.push(`topics: ${post.topics.join(', ')}`);
  if (post.comments.length > 0) {
    lines.push('', 'COMMENTS:', '-'.repeat(40));
    appendComments(lines, post.comments, 0, now);
  }
  return safeText(lines.join('\n'));
}

export function formatNotifications(notifications: Notification[], now?: number): string {
  if (notifications.length === 0) return 'No notifications.';
  return safeText(
    notifications
      .map((n) => {
        const unread = n.isRead ? ' ' : '*';
        return `${unread} [${n.type.toLowerCase()}] ${relativeTime(n.createdAt, now)}\n    ${truncate(n.text, 250)}${n.url ? `\n    ${n.url.split('?')[0]}` : ''}`;
      })
      .join('\n\n'),
  );
}

export function formatSearch(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No matching posts found.';
  return safeText(
    hits
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.author || '?'} (${hit.context})\n   ${truncate(hit.body, 300)}\n   ${hit.commentCount} comments · ${hit.url ?? '?'}`,
      )
      .join('\n\n'),
  );
}
