/**
 * Semantic enrichment of posts and comments with TypeSafe's Jev model.
 *
 * Code owns the analysis; Jev only answers narrow, typed questions about one
 * post or one comment at a time. Every judgment is kept as a raw probability
 * (Noul), distribution (Choice), or expected level (Score) so thresholds,
 * weights, and aggregations can change later without re-running inference.
 *
 * Question meaning lives in the tables below (data, not logic). Bump
 * QUESTION_SET_VERSION whenever a question's wording or options change, so
 * stored judgments from different wordings are never mixed.
 */

import type { ChoiceQuestion, NoulQuestion, Questions, ScoreQuestion, SystemOneResult } from '@typesafe-ai/sdk';
import { type AnswerCache, cacheKey } from './jev-cache.js';
import type { Comment, Post } from './model.js';

export const QUESTION_SET_VERSION = 'v1';
export const DEFAULT_MODEL = 'jev-1.13.0';

/** Community themes. Asked as independent Nouls (several may apply) and as one primary-theme Choice. */
export const THEMES = {
  crime_safety: 'crime, theft, break-ins, scams, missing persons, suspicious people or vehicles, or personal safety',
  lost_found_pet: 'a lost, found, or loose pet',
  lost_found_item: 'a lost or found personal item that is not a pet',
  wildlife_nature: 'wild animals, birds, plants, or the natural environment',
  local_government: 'local government: city council, county or port decisions, local taxes, levies, or ordinances',
  national_politics:
    'national or international politics: the President, Congress, federal policy, foreign affairs, or national political parties',
  roads_traffic: 'roads, traffic, driving behavior, parking, or road construction',
  utilities_services: 'utilities or public services such as power, water, internet, garbage, or mail',
  housing_development: 'housing, rent, real estate, homelessness, or new building and development projects',
  services_recommendations: 'finding, recommending, or reviewing a local business, contractor, or service provider',
  local_business_news: 'a local business opening, closing, moving, or changing',
  buy_sell_free: 'selling, giving away, or looking to obtain physical items',
  events_community: 'community events, gatherings, volunteering, clubs, churches, or local organizations',
  neighbor_complaints: "complaints about neighbors' behavior such as noise, dogs, trash, fireworks, or speeding",
  health_medical: 'health, medical care, doctors, hospitals, or illness',
  weather_emergency: 'weather, wildfire, smoke, storms, earthquakes, or emergency preparedness',
  schools_youth: 'schools, children, or youth activities',
  photos_appreciation: 'sharing photos, scenery, humor, gratitude, or appreciation without a request or complaint',
} as const;

export type Theme = keyof typeof THEMES;

const POST_INTENTS = {
  ask_help: 'Asks neighbors for help, information, or a recommendation',
  alert: 'Warns neighbors about a risk, incident, or urgent situation',
  inform: 'Shares news, an announcement, or useful information',
  opinion: 'Argues a position or invites debate',
  complaint: 'Complains about a person, business, or situation',
  transaction: 'Offers or seeks an item or paid service (selling, giving away, hiring)',
  social: 'Shares photos, humor, greetings, or appreciation',
};

const COMMENT_STANCES = {
  agrees: 'Agrees with, supports, or thanks the author of `target`',
  disagrees: 'Disagrees with, challenges, or corrects `target`',
  informs: 'Answers, adds information, or makes a suggestion without taking a side',
  jokes: 'Jokes or responds lightheartedly',
  off_topic: 'Does not respond to `target`',
};

const toneLevels = (subject: string) =>
  [
    `${subject} sounds angry, bitter, or contemptuous`,
    `${subject} sounds worried, frustrated, sad, or upset`,
    `${subject} sounds matter-of-fact or emotionally neutral`,
    `${subject} sounds friendly, warm, or appreciative`,
    `${subject} sounds enthusiastic, joyful, or deeply grateful`,
  ] as const;

const HOSTILITY_LEVELS = [
  'No hostility: respectful, or not directed at any person or group',
  'Mild: sarcasm, snark, condescension, or dismissiveness toward someone',
  'Clear: insults, mockery, or name-calling aimed at a person or group',
  'Severe: demeaning, threatening, or dehumanizing language',
] as const;

const URGENCY_LEVELS = [
  'Not time-sensitive',
  'Relevant to neighbors within the next few days',
  'Needs neighbors’ attention today',
  'Immediate: an active emergency or danger happening now',
] as const;

const noul = (instructions: string, yes?: string, no?: string): NoulQuestion => ({
  type: 'noul',
  instructions,
  ...(yes || no ? { criteria: { ...(yes ? { true: yes } : {}), ...(no ? { false: no } : {}) } } : {}),
});
const choice = (instructions: string, criteria: Record<string, string | null>): ChoiceQuestion => ({
  type: 'choice',
  instructions,
  criteria,
});
const score = (instructions: string, criteria: readonly [string, string, ...string[]]): ScoreQuestion => ({
  type: 'score',
  instructions,
  criteria,
});

/** One Noul per theme, keyed `theme.<id>`. Discovered themes (discover.ts) use the same wording. */
export function themeQuestions(subject: string, themes: Record<string, string> = THEMES): Questions {
  const questions: Questions = {};
  for (const [id, description] of Object.entries(themes)) {
    questions[`theme.${id}`] = noul(
      `Is ${subject} about ${description}?`,
      'This is the main subject or a major part of the text.',
      'This is absent or only mentioned in passing.',
    );
  }
  return questions;
}

export const POST_QUESTIONS: Questions = {
  ...themeQuestions('`post`'),
  primary_theme: choice('Which theme best describes the main subject of `post`?', { ...THEMES, other: null }),
  intent: choice("What is the author's main purpose in writing `post`?", POST_INTENTS),
  tone: score('What is the emotional tone of the author of `post`?', toneLevels('The author')),
  hostility: score('How hostile is `post` toward other people or groups?', HOSTILITY_LEVELS),
  urgency: score('How time-sensitive is `post` for nearby neighbors?', URGENCY_LEVELS),
  asks_question: noul('Does `post` ask readers a question or request information or help?'),
  accuses_individual: noul(
    'Does `post` accuse a specific, identifiable person, household, or business of wrongdoing?',
    'A particular named or clearly identifiable party is accused.',
    'No accusation, or only a vague or general group is criticized.',
  ),
};

export const COMMENT_QUESTIONS: Questions = {
  stance: choice('How does `comment` respond to `target`?', COMMENT_STANCES),
  tone: score('What is the emotional tone of the author of `comment`?', toneLevels('The commenter')),
  hostility: score('How hostile is `comment` toward other people or groups?', HOSTILITY_LEVELS),
  helpful: noul(
    'Does `comment` give a concrete answer, recommendation, or useful information in response to `target`?',
  ),
  recommends_business: noul('Does `comment` recommend a specific named business, contractor, or service provider?'),
};

/**
 * Where the situation a post describes is, relative to the poster's home
 * neighborhood. Posts carry the author's neighborhood, which is not where an
 * incident happened: a resident sharing news from another town or general
 * advice must not count as an incident in their own neighborhood.
 */
export const PLACE_QUESTION_SET = 'place-v1';
export const PLACE_QUESTIONS: Questions = {
  place: choice('Where is the situation that `post` describes?', {
    own_neighborhood:
      "A specific incident or situation in or right around the author's own neighborhood, `author_neighborhood`",
    elsewhere_local:
      'A specific incident or situation somewhere else nearby: another neighborhood, street, or town in the same local area',
    outside_area: 'Something far away (another region, state, or country) or national news',
    general:
      'General advice, a warning, an opinion, or an announcement that is not about a specific incident in a particular place',
  }),
};

/**
 * Political posts: at what level of government, and which way the author leans.
 * Asked only of posts whose theme judgments touch government or politics (the
 * gate), so most posts never pay for it. `not_political` lets this question
 * overrule a loose gate. Lean is the author's own expressed position, not the
 * topic's: a neutral notice about a council vote is neutral.
 */
export const POLITICS_QUESTION_SET = 'politics-v1';
/** Themes that send a post to the politics question, at or above POLITICS_GATE_P (loose on purpose: the question can say "not political"). */
export const POLITICS_GATE_THEMES = ['local_government', 'national_politics'];
export const POLITICS_GATE_P = 0.3;
export const POLITICS_QUESTIONS: Questions = {
  level: choice('At what level of government is the political subject of `post`?', {
    local:
      'Local government: city, county, school board, port district, local officials, elections, or ballot measures',
    state:
      'State government: the governor, state legislature, state agencies, state elections, or state ballot measures',
    national:
      'National or international politics: the President, Congress, federal policy, foreign affairs, or national parties and figures',
    not_political:
      'Not political: no government, policy, election, official, or party is at issue, or it is only mentioned in passing',
  }),
  lean: choice("Which political direction does the author's own position in `post` lean?", {
    left: 'Expresses or promotes a left-leaning, progressive, or Democratic-aligned position, or criticizes the right',
    right:
      'Expresses or promotes a right-leaning, conservative, or Republican-aligned position, or criticizes the left',
    neutral: 'No discernible partisan position: reports facts, announces, asks a question, or weighs both sides evenly',
  }),
};

/** A post's political lean as -1 (left) .. +1 (right): P(right) - P(left), so uncertain posts sit near the middle. */
export function leanScore(probabilities: Record<string, number>): number {
  return (probabilities.right ?? 0) - (probabilities.left ?? 0);
}

/** What a post or comment that @mentions a business says about it; asked once per mention. */
export const OPINION_QUESTION_SET = 'opinion-v1';
export const OPINION_QUESTIONS: Questions = {
  opinion: choice('What does the author of `text` express about the business described in `business`?', {
    favorable: 'Recommends it, praises it, or describes a good experience with it',
    unfavorable: 'Warns against it, criticizes it, or describes a bad experience with it',
    neutral:
      'No clear opinion of this business: mentions it as a place, asks about it, states a fact, or is mainly about something else',
  }),
};

// --- state builders ----------------------------------------------------------

const MAX_POST_CHARS = 4000;
const MAX_CONTEXT_CHARS = 600;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Only the text the questions need; author identity and metrics stay out to
 * avoid distraction and bias. A repost carries the quoted post, since the
 * reposter's words ("great perspective") are often meaningless without it.
 */
/** The text a post judgment needs; a mapped Post satisfies it, and so does a graph row. */
export interface PostText {
  subject: string;
  body: string;
  repostOf: { subject: string; body: string } | null;
}

export function postState(post: PostText) {
  const body = post.body === post.subject ? '' : post.body;
  return {
    post: {
      subject: clip(post.subject, 500),
      body: clip(body, MAX_POST_CHARS),
      ...(post.repostOf
        ? {
            reposted_post: clip(
              [post.repostOf.subject, post.repostOf.body].filter(Boolean).join('\n'),
              MAX_CONTEXT_CHARS,
            ),
          }
        : {}),
    },
  };
}

function postText(post: PostText): string {
  return [post.subject, post.body === post.subject ? '' : post.body].filter(Boolean).join('\n');
}

/**
 * A comment is judged against its direct target: the comment it answers
 * (resolved from @mentions) or else the post. The post subject stays as light
 * thread context.
 */
export function commentState(post: PostText, comment: Pick<Comment, 'body'>, target: Pick<Comment, 'body'> | null) {
  return {
    thread_topic: clip(post.subject || postText(post), 300),
    target: target
      ? { kind: 'comment', text: clip(target.body, MAX_CONTEXT_CHARS) }
      : { kind: 'original post', text: clip(postText(post), MAX_CONTEXT_CHARS) },
    comment: clip(comment.body, MAX_POST_CHARS),
  };
}

// --- judgments ---------------------------------------------------------------

export interface ChoiceJudgment {
  label: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreJudgment {
  /** Expected level (probability-weighted), may fall between levels. */
  value: number;
  /** Number of levels, so value can be normalized as value / (levels - 1). */
  levels: number;
  confidence: number;
}

/** Raw, reusable answers to one question set about one piece of content. */
export interface Judgments {
  subjectId: string;
  kind: 'post' | 'comment';
  model: string;
  questionSet: string;
  nouls: Record<string, number>;
  choices: Record<string, ChoiceJudgment>;
  scores: Record<string, ScoreJudgment>;
  inputTokens: number;
}

/** Stored with every judgment, so changing questions marks old judgments stale. */
export function questionSetId(kind: Judgments['kind']): string {
  return `${kind}-${QUESTION_SET_VERSION}`;
}

export function toJudgments(subjectId: string, kind: Judgments['kind'], result: SystemOneResult<Questions>): Judgments {
  const judgments: Judgments = {
    subjectId,
    kind,
    model: result.model,
    questionSet: questionSetId(kind),
    nouls: {},
    choices: {},
    scores: {},
    inputTokens: result.usage.input_tokens,
  };
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'noul') judgments.nouls[id] = answer.noul;
    else if (answer.type === 'choice') {
      judgments.choices[id] = {
        label: answer.choice,
        confidence: answer.confidence,
        probabilities: { ...answer.probabilities },
      };
    } else {
      judgments.scores[id] = {
        value: answer.score,
        levels: Object.keys(answer.legend).length,
        confidence: answer.confidence,
      };
    }
  }
  return judgments;
}

/** Themes whose Noul clears the threshold, strongest first. */
export function themesOf(judgments: Judgments, threshold = 0.5): Theme[] {
  return (Object.keys(THEMES) as Theme[])
    .filter((theme) => (judgments.nouls[`theme.${theme}`] ?? 0) >= threshold)
    .sort((a, b) => judgments.nouls[`theme.${b}`] - judgments.nouls[`theme.${a}`]);
}

// --- analyzer ----------------------------------------------------------------

/** The slice of TypeSafeClient the analyzer needs (keeps it testable without the network). */
export interface SystemOneClient {
  systemOne(request: { state: unknown; questions: Questions; model?: string }): PromiseLike<SystemOneResult<Questions>>;
}

export interface AnalyzerOptions {
  model?: string;
  /** Concurrent requests in flight (Jev allows 80 rps; default 8). */
  concurrency?: number;
  /** Answers already paid for; consulted before every request and filled as answers arrive. */
  cache?: AnswerCache;
}

/** Run `fn` over items with bounded concurrency. After the first failure no new item starts. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Errors that will not go away by retrying this run: no credits, a bad or
 * revoked key, or a forbidden account. Callers stop asking Jev and keep what
 * they have; the answers already received are cached and saved.
 */
export function isJevUnavailable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status === 401 || status === 402 || status === 403) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(401|402|403)\b|credits?|quota|insufficient|unauthori[sz]ed|invalid api key/i.test(message);
}

function flattenComments(comments: Comment[]): Comment[] {
  return comments.flatMap((comment) => [comment, ...flattenComments(comment.replies)]);
}

export interface JudgmentSubject {
  id: string;
  kind: Judgments['kind'];
  state: unknown;
  /** Ask these instead of the kind's standard questions, recorded under `questionSet`. */
  questions?: Questions;
  questionSet?: string;
}

export class JevAnalyzer {
  readonly model: string;
  private readonly concurrency: number;
  private readonly cache: AnswerCache | null;
  /** Requests sent to Jev and answers served from the cache, since construction. */
  readonly usage = { asked: 0, cached: 0 };

  constructor(
    private readonly client: SystemOneClient,
    options: AnalyzerOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.concurrency = options.concurrency ?? 8;
    this.cache = options.cache ?? null;
  }

  async analyzePost(post: Post): Promise<Judgments> {
    return this.judge({ id: post.id, kind: 'post', state: postState(post) });
  }

  /** Judge a prepared state (from postState or commentState) with the matching question set. */
  async judge(subject: JudgmentSubject): Promise<Judgments> {
    const questions = subject.questions ?? (subject.kind === 'post' ? POST_QUESTIONS : COMMENT_QUESTIONS);
    const questionSet = subject.questionSet ?? questionSetId(subject.kind);
    const key = this.cache ? cacheKey({ model: this.model, questions, state: subject.state }) : null;
    const hit = key ? this.cache!.get(key) : undefined;
    if (hit) {
      this.usage.cached += 1;
      const { model, nouls, choices, scores } = hit as Pick<Judgments, 'model' | 'nouls' | 'choices' | 'scores'>;
      return { subjectId: subject.id, kind: subject.kind, questionSet, model, nouls, choices, scores, inputTokens: 0 };
    }
    const result = await this.client.systemOne({ state: subject.state, questions, model: this.model });
    this.usage.asked += 1;
    const judgments = { ...toJudgments(subject.id, subject.kind, result), questionSet };
    if (key) {
      const { model, nouls, choices, scores } = judgments;
      this.cache!.set(key, { model, nouls, choices, scores });
    }
    return judgments;
  }

  /**
   * Judge in batches and hand each finished batch to `save`, so results land
   * in storage as they arrive instead of all at the end.
   */
  async judgeInBatches(
    subjects: JudgmentSubject[],
    save: (batch: Judgments[]) => Promise<void>,
    options: { size?: number; progress?: (done: number, total: number) => void } = {},
  ): Promise<void> {
    const size = options.size ?? 200;
    for (let start = 0; start < subjects.length; start += size) {
      await save(await this.judgeAll(subjects.slice(start, start + size)));
      options.progress?.(Math.min(start + size, subjects.length), subjects.length);
    }
  }

  judgeAll(subjects: JudgmentSubject[]): Promise<Judgments[]> {
    return mapPool(subjects, this.concurrency, (subject) => this.judge(subject));
  }

  analyzePosts(posts: Post[]): Promise<Judgments[]> {
    return mapPool(posts, this.concurrency, (post) => this.analyzePost(post));
  }

  /** Judge every non-deleted comment in a post's thread against its direct target. */
  analyzeComments(post: Post): Promise<Judgments[]> {
    const all = flattenComments(post.comments);
    const byId = new Map(all.map((comment) => [comment.id, comment]));
    const live = all.filter((comment) => !comment.isDeleted && comment.body.trim());
    return mapPool(live, this.concurrency, async (comment) => {
      const target = comment.replyToId ? (byId.get(comment.replyToId) ?? null) : null;
      return this.judge({ id: comment.id, kind: 'comment', state: commentState(post, comment, target) });
    });
  }
}

/** State for an opinion judgment: the business, the text that mentions it, and light thread context. */
export function opinionState(
  business: { name: string; category: string | null },
  text: string,
  context: { topic: string | null; answering: string | null },
) {
  return {
    business: { name: business.name, ...(business.category ? { category: business.category } : {}) },
    text: clip(text, MAX_POST_CHARS),
    ...(context.topic ? { thread_topic: clip(context.topic, 300) } : {}),
    ...(context.answering ? { answering: clip(context.answering, MAX_CONTEXT_CHARS) } : {}),
  };
}

/** State for a politics judgment: just the post's words. */
export function politicsState(post: { subject: string; body: string }) {
  const body = post.body === post.subject ? '' : post.body;
  return { post: { subject: clip(post.subject, 500), body: clip(body, MAX_POST_CHARS) } };
}

/** State for a place judgment: the post and the author's home neighborhood. */
export function placeState(
  post: { subject: string; body: string },
  home: { name: string | null; city: string | null },
) {
  const body = post.body === post.subject ? '' : post.body;
  return {
    post: { subject: clip(post.subject, 500), body: clip(body, MAX_POST_CHARS) },
    author_neighborhood: home.name ?? 'unknown',
    ...(home.city ? { area: home.city } : {}),
  };
}
