import { describe, expect, it } from 'vitest';
import { formatFeedAnalysis, formatThreadAnalysis, levelName, normalized, summarize } from '../src/lib/insights.js';
import type { Judgments } from '../src/lib/jev.js';
import { mapCommentPage, mapPost, resolveReplyTargets } from '../src/lib/model.js';
import { author, comment, pagedCommentsResponse, post } from './fixtures/payloads.js';

function judgments(subjectId: string, overrides: Partial<Judgments> = {}): Judgments {
  return {
    subjectId,
    kind: 'post',
    model: 'jev-1.13.0',
    questionSet: 'post-v1',
    nouls: { 'theme.crime_safety': 0.9, 'theme.roads_traffic': 0.6, helpful: 0.8, recommends_business: 0.7 },
    choices: {
      primary_theme: { label: 'crime_safety', confidence: 0.9, probabilities: {} },
      intent: { label: 'alert', confidence: 0.9, probabilities: {} },
      stance: { label: 'disagrees', confidence: 0.8, probabilities: {} },
    },
    scores: {
      tone: { value: 1, levels: 5, confidence: 0.7 },
      hostility: { value: 2, levels: 4, confidence: 0.7 },
      urgency: { value: 2.6, levels: 4, confidence: 0.7 },
    },
    inputTokens: 10,
    ...overrides,
  };
}

describe('insights', () => {
  it('names levels and normalizes scores', () => {
    const j = judgments('p');
    expect([levelName(j, 'tone'), levelName(j, 'hostility'), levelName(j, 'urgency')]).toEqual([
      'upset',
      'clear',
      'now',
    ]);
    expect(levelName({ ...j, scores: {} }, 'tone')).toBe('?');
    expect(normalized(j, 'tone')).toBe(0.25);
    expect(normalized(j, 'missing')).toBe(0);
  });

  it('summarizes themes, intents, tone, and hostility', () => {
    const calm = judgments('b', {
      scores: { tone: { value: 3, levels: 5, confidence: 1 }, hostility: { value: 0, levels: 4, confidence: 1 } },
    });
    expect(summarize([judgments('a'), calm])).toEqual({
      posts: 2,
      themes: { crime_safety: 2, roads_traffic: 2 },
      intents: { alert: 2 },
      meanTone: 0.5,
      hostileShare: 0.5,
      inputTokens: 20,
    });
    expect(summarize([]).posts).toBe(0);
  });

  it('renders a feed analysis', () => {
    const p = mapPost(post('A', { subject: 'Break-in on Elm' }))!;
    const text = formatFeedAnalysis([p, mapPost(post('B'))!], [judgments(p.id)]);
    expect(text).toContain('Analyzed 1 posts');
    expect(text).toContain('crime_safety (+roads_traffic) · alert · tone upset · hostility clear · urgency now');
    expect(text).not.toContain('Subject B');
  });

  it('renders a thread with stances, targets, flags, and deleted comments', () => {
    const p = mapPost(
      post('T', {
        comments: [
          comment(1, 'top', { author: author('Ann', 1), replies: [comment(2, 'reply', { parent: 1, minutesAgo: 0 })] }),
          comment(3, '', { deleted: true }),
        ],
      }),
    )!;
    resolveReplyTargets(p.comments);
    const text = formatThreadAnalysis(p, judgments(p.id), [judgments('comment_1'), judgments('comment_2')]);
    expect(text).toContain('stances: disagrees 2');
    expect(text).toContain('Ann disagrees → post · tone upset · HOSTILE helpful recommends');
    expect(text).toContain('Commenter 2 disagrees → Ann');
    expect(text).toContain('Commenter 3: [deleted]');
    expect(mapCommentPage(pagedCommentsResponse([], null)).comments).toEqual([]);
  });
});
