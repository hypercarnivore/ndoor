import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  COMMENT_QUESTIONS,
  commentState,
  DEFAULT_MODEL,
  JevAnalyzer,
  POST_QUESTIONS,
  postState,
  QUESTION_SET_VERSION,
  type SystemOneClient,
  THEMES,
  themesOf,
  toJudgments,
} from '../src/lib/jev.js';
import { mapCommentPage, mapPost, resolveReplyTargets } from '../src/lib/model.js';
import { author, comment, pagedCommentsResponse, post, repostOf } from './fixtures/payloads.js';

/** Unit-level fake that answers every question with a fixed shape and records requests. */
function fakeClient(answer: (id: string, q: Questions[string]) => unknown = () => undefined) {
  const requests: { state: unknown; questions: Questions; model?: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client: SystemOneClient = {
    async systemOne(request) {
      requests.push(request);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(request.questions)) {
        answers[id] =
          answer(id, q) ??
          (q.type === 'noul'
            ? { type: 'noul', noul: 0.1 }
            : q.type === 'choice'
              ? {
                  type: 'choice',
                  choice: Object.keys(q.criteria)[0],
                  confidence: 0.9,
                  probabilities: { [Object.keys(q.criteria)[0]]: 1 },
                }
              : {
                  type: 'score',
                  score: 1,
                  confidence: 0.8,
                  legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
                  probabilities: {},
                });
      }
      return {
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 100, output_tokens: 5 },
      } as SystemOneResult<Questions>;
    },
  };
  return { client, requests, maxInFlight: () => maxInFlight };
}

describe('question tables', () => {
  it('asks one theme Noul per theme plus the primary Choice with a no-match option', () => {
    for (const theme of Object.keys(THEMES)) expect(POST_QUESTIONS[`theme.${theme}`]?.type).toBe('noul');
    const primary = POST_QUESTIONS.primary_theme;
    expect(primary.type === 'choice' && Object.keys(primary.criteria)).toContain('other');
    expect(COMMENT_QUESTIONS.stance.type).toBe('choice');
  });

  it('references only state paths that exist', () => {
    const p = mapPost(post('S'))!;
    const c = mapCommentPage(pagedCommentsResponse([comment(1, 'x')], null)).comments[0];
    const check = (questions: Questions, state: Record<string, unknown>) => {
      for (const q of Object.values(questions)) {
        for (const path of String(q.instructions).match(/`([^`]+)`/g) ?? []) {
          expect(Object.keys(state)).toContain(path.slice(1, -1).split('.')[0]);
        }
      }
    };
    check(POST_QUESTIONS, postState(p));
    check(COMMENT_QUESTIONS, commentState(p, c, null));
  });
});

describe('state builders', () => {
  it('keeps posts lean and includes reposted text', () => {
    const raw = post('S', { subject: 'Same', body: 'Same' }) as Record<string, unknown>;
    raw.repostInfo = { item: repostOf('O', 'Earned.', 'Taxes fund roads.') };
    expect(postState(mapPost(raw)!)).toEqual({
      post: { subject: 'Same', body: '', reposted_post: 'Earned.\nTaxes fund roads.' },
    });
  });

  it('targets the parent comment or the post, and clips long text', () => {
    const p = mapPost(post('S', { subject: 'Topic', body: 'Details' }))!;
    const [parent, reply] = [comment(1, 'parent text'), comment(2, 'x'.repeat(5000))].map(
      (edge) => mapCommentPage(pagedCommentsResponse([edge], null)).comments[0],
    );
    expect(commentState(p, parent, null).target).toEqual({ kind: 'original post', text: 'Topic\nDetails' });
    const state = commentState(p, reply, parent);
    expect(state.target).toEqual({ kind: 'comment', text: 'parent text' });
    expect(state.comment.length).toBe(4001);
  });
});

describe('judgments', () => {
  it('normalizes every answer type and records provenance', () => {
    const j = toJudgments('post_1', 'post', {
      model: 'jev-1.13.0',
      usage: { input_tokens: 42, output_tokens: 1 },
      answers: {
        'theme.lost_found_pet': { type: 'noul', noul: 0.9 },
        'theme.crime_safety': { type: 'noul', noul: 0.6 },
        'theme.roads_traffic': { type: 'noul', noul: 0.2 },
        intent: { type: 'choice', choice: 'alert', confidence: 0.7, probabilities: { alert: 0.8, inform: 0.2 } },
        tone: { type: 'score', score: 1.4, confidence: 0.6, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: {} },
      },
    } as unknown as SystemOneResult<Questions>);
    expect(j).toMatchObject({
      subjectId: 'post_1',
      questionSet: `post-${QUESTION_SET_VERSION}`,
      inputTokens: 42,
      nouls: { 'theme.lost_found_pet': 0.9 },
      choices: { intent: { label: 'alert', confidence: 0.7 } },
      scores: { tone: { value: 1.4, levels: 3 } },
    });
    expect(themesOf(j)).toEqual(['lost_found_pet', 'crime_safety']);
    expect(themesOf(j, 0.7)).toEqual(['lost_found_pet']);
  });
});

describe('JevAnalyzer', () => {
  it('analyzes posts with bounded concurrency and the pinned model', async () => {
    const fake = fakeClient();
    const analyzer = new JevAnalyzer(fake.client, { concurrency: 2 });
    const posts = ['A', 'B', 'C', 'D', 'E'].map((id) => mapPost(post(id))!);
    const out = await analyzer.analyzePosts(posts);
    expect(out.map((j) => j.subjectId)).toEqual(posts.map((p) => p.id));
    expect(fake.maxInFlight()).toBeLessThanOrEqual(2);
    expect(fake.requests[0].model).toBe(DEFAULT_MODEL);
  });

  it('judges each live comment against its resolved target', async () => {
    const fake = fakeClient();
    const ann = author('Ann', 1);
    const raw = post('T', {
      comments: [
        comment(10, 'top', {
          author: ann,
          minutesAgo: 60,
          replies: [
            comment(11, 'first reply', { parent: 10, minutesAgo: 50 }),
            comment(12, 'answering 11', { parent: 10, mentions: [1011], minutesAgo: 40 }),
          ],
        }),
        comment(13, '', { deleted: true }),
      ],
    });
    const p = mapPost(raw)!;
    resolveReplyTargets(p.comments);
    const out = await new JevAnalyzer(fake.client).analyzeComments(p);
    expect(out.map((j) => j.subjectId)).toEqual(['comment_10', 'comment_11', 'comment_12']);
    const targets = fake.requests.map((r) => (r.state as { target: { text: string } }).target.text);
    expect(targets).toEqual(['Subject T\nBody T', 'top', 'first reply']);
  });
});
