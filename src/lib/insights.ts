/**
 * Turn Jev judgments into readable labels, aggregates, and terminal output.
 *
 * Policy (thresholds, label names) lives here; inference lives in jev.ts.
 */

import { safeText, truncate } from './digest.js';
import { type Judgments, THEMES, type Theme, themesOf } from './jev.js';
import type { Comment, Post } from './model.js';

/** Words for each Score level, index-aligned with the rubrics in jev.ts. */
export const LEVEL_NAMES = {
  tone: ['angry', 'upset', 'neutral', 'warm', 'joyful'],
  hostility: ['none', 'mild', 'clear', 'severe'],
  urgency: ['none', 'days', 'today', 'now'],
} as const;

/** Hostility at or above this expected level counts as a hostile item. */
export const HOSTILE_AT = 1.5;
/** A theme Noul at or above this counts the theme as present. */
export const THEME_AT = 0.5;

export function levelName(judgments: Judgments, scoreId: keyof typeof LEVEL_NAMES): string {
  const judgment = judgments.scores[scoreId];
  if (!judgment) return '?';
  const names = LEVEL_NAMES[scoreId];
  return names[Math.min(names.length - 1, Math.max(0, Math.round(judgment.value)))];
}

/** Map a Score to [0, 1] so dimensions with different level counts can be compared and averaged. */
export function normalized(judgments: Judgments, scoreId: string): number {
  const judgment = judgments.scores[scoreId];
  return judgment ? judgment.value / (judgment.levels - 1) : 0;
}

export interface FeedSummary {
  posts: number;
  themes: Record<string, number>;
  intents: Record<string, number>;
  /** Mean tone on [0, 1]: 0 angry, 0.5 neutral, 1 joyful. */
  meanTone: number;
  hostileShare: number;
  inputTokens: number;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function summarize(all: Judgments[]): FeedSummary {
  const summary: FeedSummary = {
    posts: all.length,
    themes: {},
    intents: {},
    meanTone: 0,
    hostileShare: 0,
    inputTokens: 0,
  };
  if (all.length === 0) return summary;
  let hostile = 0;
  for (const judgments of all) {
    for (const theme of themesOf(judgments, THEME_AT)) bump(summary.themes, theme);
    bump(summary.intents, judgments.choices.intent?.label ?? '?');
    summary.meanTone += normalized(judgments, 'tone');
    if ((judgments.scores.hostility?.value ?? 0) >= HOSTILE_AT) hostile += 1;
    summary.inputTokens += judgments.inputTokens;
  }
  summary.meanTone /= all.length;
  summary.hostileShare = hostile / all.length;
  return summary;
}

function ranked(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${n}`)
    .join(', ');
}

function themeLine(judgments: Judgments): string {
  const primary = judgments.choices.primary_theme;
  const others = themesOf(judgments, THEME_AT).filter((theme) => theme !== primary?.label);
  const head = primary ? `${primary.label}${primary.confidence < 0.5 ? '?' : ''}` : '?';
  return others.length > 0 ? `${head} (+${others.join(', ')})` : head;
}

export function formatFeedAnalysis(posts: Post[], judgments: Judgments[]): string {
  const byId = new Map(judgments.map((j) => [j.subjectId, j]));
  const summary = summarize(judgments);
  const lines = [
    `Analyzed ${summary.posts} posts with Jev (${summary.inputTokens} input tokens)`,
    `themes: ${ranked(summary.themes) || 'none'}`,
    `intents: ${ranked(summary.intents)}`,
    `mean tone: ${(summary.meanTone * 100).toFixed(0)}/100 (50 = neutral) · hostile posts: ${(summary.hostileShare * 100).toFixed(0)}%`,
    '='.repeat(60),
  ];
  posts.forEach((post, index) => {
    const j = byId.get(post.id);
    if (!j) return;
    lines.push(`${index + 1}. ${truncate(post.subject || post.body, 110)}`);
    lines.push(
      `   ${themeLine(j)} · ${j.choices.intent?.label ?? '?'} · tone ${levelName(j, 'tone')} · hostility ${levelName(j, 'hostility')} · urgency ${levelName(j, 'urgency')}`,
    );
    lines.push(`   ${post.author.name} (${post.author.neighborhood?.name ?? '?'}) · ${post.url}`);
  });
  return safeText(lines.join('\n'));
}

function flatten(comments: Comment[]): Comment[] {
  return comments.flatMap((comment) => [comment, ...flatten(comment.replies)]);
}

export function formatThreadAnalysis(post: Post, postJudgments: Judgments, comments: Judgments[]): string {
  const all = flatten(post.comments);
  const byId = new Map(all.map((c) => [c.id, c]));
  const judged = new Map(comments.map((j) => [j.subjectId, j]));
  const lines = [
    truncate(post.subject || post.body, 140),
    `${themeLine(postJudgments)} · ${postJudgments.choices.intent?.label ?? '?'} · tone ${levelName(postJudgments, 'tone')} · hostility ${levelName(postJudgments, 'hostility')}`,
    '',
  ];

  const stances: Record<string, number> = {};
  for (const comment of all) {
    const j = judged.get(comment.id);
    const indent = comment.parentId ? '    ' : '  ';
    if (!j) {
      lines.push(`${indent}${comment.author.name}: [deleted]`);
      continue;
    }
    const stance = j.choices.stance?.label ?? '?';
    bump(stances, stance);
    const target = comment.replyToId ? (byId.get(comment.replyToId)?.author.name ?? '?') : 'post';
    const flags = [
      (j.scores.hostility?.value ?? 0) >= HOSTILE_AT ? 'HOSTILE' : '',
      (j.nouls.helpful ?? 0) >= 0.5 ? 'helpful' : '',
      (j.nouls.recommends_business ?? 0) >= 0.5 ? 'recommends' : '',
    ].filter(Boolean);
    lines.push(
      `${indent}${comment.author.name} ${stance} → ${target} · tone ${levelName(j, 'tone')}${flags.length ? ` · ${flags.join(' ')}` : ''}`,
    );
    lines.push(`${indent}  ${truncate(comment.body, 160)}`);
  }
  lines.splice(2, 0, `comments: ${all.length} · stances: ${ranked(stances) || 'none'}`);
  return safeText(lines.join('\n'));
}

export const THEME_NAMES = Object.keys(THEMES) as Theme[];
