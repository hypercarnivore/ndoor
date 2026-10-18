/**
 * What-if scenarios for community health: "how much would the score change if
 * these people, threads, or topics were not here?"
 *
 * The cached graph is read once into a compact corpus. A scenario names what to
 * leave out; the health formula (scoreHealth, the same one behind the
 * dashboard) is then recomputed over what remains, so the "before" score
 * always equals the dashboard's. The result is arithmetic on judged content,
 * not a prediction: people and threads do not vanish cleanly in real life.
 */

import { ExploreError, HEALTH_SIGNALS, type HealthSignal, type Query, scoreHealth } from './explore.js';
import type { Row } from './graph.js';

const HOSTILE = 1.5;
/** Fewest judged items before a person's hostile share is ranked. */
const MIN_ITEMS = 5;
/** Most people tried one by one when ranking by individual impact. */
const IMPACT_CANDIDATES = 300;
const MAX_CURVE = 50;
const MAX_N = 200;
/** Neighborhoods with fewer judged items than this are not listed (their scores are noise). */
const MIN_PLACE_ITEMS = 5;
const MAX_PLACES = 60;
const LIST_LIMIT = 25;

// --- scenario catalog (data the UI renders its controls from) -------------------------

export const RANKS = {
  hostile: 'Most hostile posts and comments',
  hostileShare: `Highest share of hostile writing (${MIN_ITEMS}+ items)`,
  negativity: 'Most negative tone',
  impact: 'Biggest effect on the score',
  helpful: 'Most helpful answers (shows what losing them costs)',
} as const;
export type Rank = keyof typeof RANKS;

export const SCENARIOS = {
  people: {
    title: 'Remove people',
    question: 'How much better would things be without the worst offenders?',
    controls: ['n', 'rank', 'cascade'],
  },
  threads: {
    title: 'Remove the worst threads',
    question: 'How much better would things be without the nastiest threads?',
    controls: ['n'],
  },
  hostility: {
    title: 'Remove hostile writing',
    question: 'How much better would things be if hostile posts and comments were never written?',
    controls: ['share', 'cascade'],
  },
  answers: {
    title: 'Answer open questions',
    question: 'How much better would things be if unanswered questions got a good answer?',
    controls: ['share'],
  },
  themes: {
    title: 'Remove a topic',
    question: 'Which topics drag the score down? Tick topics to take them out together.',
    controls: ['keys'],
  },
  places: {
    title: 'Remove a neighborhood',
    question: 'Which neighborhoods drag the score down? Tick neighborhoods to take them out together.',
    controls: ['keys'],
  },
} as const;
export type Scenario = keyof typeof SCENARIOS;

export interface WhatIfOptions {
  since: string;
  n?: number;
  rank?: string;
  share?: number;
  cascade?: boolean;
  /** Topics or neighborhoods to take out together (table scenarios). */
  keys?: string[];
}

export interface View {
  /** The dashboard's score, rounded to a tenth. */
  score: number | null;
  /** Unrounded, so small effects still show (deltas and ranking use this). */
  exact: number | null;
  label: string | null;
  signals: Record<HealthSignal, { raw: number | null; value: number | null }>;
}

export interface WhatIfResult {
  scenario: Scenario;
  title: string;
  question: string;
  before: View;
  after: View;
  /** after - before, in score points; null when either is unmeasured. */
  delta: number | null;
  removed: { people: number; posts: number; comments: number /** of all judged posts and comments */; share: number };
  /** Score after removing the top 0..N of the ranking, for scenarios that rank things. */
  curve: Array<{ n: number; score: number | null }> | null;
  /** What was taken out (people, threads, questions), most affected first. */
  subjects: Row[] | null;
  /** One row per candidate for the table scenarios (topics, neighborhoods). */
  table: Row[] | null;
  caveats: string[];
}

// --- corpus --------------------------------------------------------------------------

interface CPost {
  id: string;
  author: string | null;
  tone: number | null;
  hostility: number | null;
  question: boolean;
  theme: string | null;
  hood: string | null;
  at: number;
  inWindow: boolean;
}

interface CComment {
  id: string;
  post: string | null;
  author: string | null;
  parent: string | null;
  tone: number | null;
  hostility: number | null;
  disagrees: boolean;
  helpful: boolean;
  inWindow: boolean;
}

export interface Corpus {
  posts: CPost[];
  comments: CComment[];
  hoodNames: Map<string, string>;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Read every post and comment once, keeping only what the health formula and the scenarios need. */
export async function loadCorpus(query: Query, since: string): Promise<Corpus> {
  const params = { since };
  const postRows = await query(
    `MATCH (p:Post)
     OPTIONAL MATCH (u:User)-[:POSTED]->(p)
     OPTIONAL MATCH (p)-[:FROM_HOOD]->(n:Neighborhood)
     RETURN p.id AS id, u.id AS author, p.tone AS tone, p.hostility AS hostility, p.asksQuestion AS asks,
            p.threadFetchedAt IS NOT NULL AS fetched, p.primaryTheme AS theme, n.id AS hood, n.name AS hoodName,
            p.createdAt AS at, coalesce(p.createdAt >= timestamp($since), false) AS inWindow`,
    params,
  );
  const commentRows = await query(
    `MATCH (c:Comment)
     OPTIONAL MATCH (c)-[:ON_POST]->(p:Post)
     OPTIONAL MATCH (u:User)-[:COMMENTED]->(c)
     OPTIONAL MATCH (c)-[:REPLY_TO]->(parent:Comment)
     RETURN c.id AS id, p.id AS post, u.id AS author, parent.id AS parent, c.tone AS tone,
            c.hostility AS hostility, c.stance AS stance, c.helpful AS helpful,
            coalesce(c.createdAt >= timestamp($since), false) AS inWindow`,
    params,
  );
  const posts = new Map<string, CPost>();
  const hoodNames = new Map<string, string>();
  for (const row of postRows) {
    const id = String(row.id);
    if (posts.has(id)) continue;
    const hood = str(row.hood);
    if (hood && str(row.hoodName)) hoodNames.set(hood, String(row.hoodName));
    posts.set(id, {
      id,
      author: str(row.author),
      tone: num(row.tone),
      hostility: num(row.hostility),
      question: (num(row.asks) ?? 0) >= 0.5 && row.fetched === true,
      theme: str(row.theme),
      hood,
      at: row.at instanceof Date ? row.at.getTime() : 0,
      inWindow: row.inWindow === true,
    });
  }
  const comments = new Map<string, CComment>();
  for (const row of commentRows) {
    const id = String(row.id);
    if (comments.has(id)) continue;
    comments.set(id, {
      id,
      post: str(row.post),
      author: str(row.author),
      parent: str(row.parent),
      tone: num(row.tone),
      hostility: num(row.hostility),
      disagrees: row.stance === 'disagrees',
      helpful: (num(row.helpful) ?? 0) >= 0.5,
      inWindow: row.inWindow === true,
    });
  }
  return { posts: [...posts.values()], comments: [...comments.values()], hoodNames };
}

// --- removal and scoring -------------------------------------------------------------

/** What a scenario leaves out. */
interface Removal {
  people?: ReadonlySet<string>;
  posts?: ReadonlySet<string>;
  comments?: ReadonlySet<string>;
  /** Questions treated as having received a helpful answer. */
  answered?: ReadonlySet<string>;
  /**
   * Also remove what grew from removed writing: comments under a removed post and replies to a removed
   * comment, whoever wrote them (default false: only the removed writing itself).
   */
  cascade?: boolean;
}

/** The health formula without its final rounding. */
function exactScore(signals: ReturnType<typeof scoreHealth>['signals']): number | null {
  let weighted = 0;
  let weights = 0;
  for (const name of Object.keys(HEALTH_SIGNALS) as HealthSignal[]) {
    const value = signals[name].value;
    if (value === null) continue;
    weighted += value * HEALTH_SIGNALS[name].weight;
    weights += HEALTH_SIGNALS[name].weight;
  }
  return weights ? 1 + (9 * weighted) / weights : null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const hostile = (item: { hostility: number | null }) => (item.hostility ?? 0) >= HOSTILE;

/** Indexed view of a corpus, so many scenarios can be scored without re-reading anything. */
export class Engine {
  private readonly commentAt = new Map<string, number>();
  private readonly postIds = new Map<string, number>();
  private readonly threadComments = new Map<string, number[]>();
  /** Posts that are questions and have a helpful comment (for the baseline answered set). */
  readonly baseline: View;

  constructor(readonly corpus: Corpus) {
    corpus.posts.forEach((post, i) => {
      this.postIds.set(post.id, i);
    });
    corpus.comments.forEach((comment, i) => {
      this.commentAt.set(comment.id, i);
      if (comment.post) {
        const list = this.threadComments.get(comment.post) ?? [];
        list.push(i);
        this.threadComments.set(comment.post, list);
      }
    });
    this.baseline = this.evaluate({}).view;
  }

  /** Which posts and comments a removal takes out. */
  private gone(removal: Removal): { posts: Uint8Array; comments: Uint8Array } {
    const { posts, comments } = this.corpus;
    const cascade = removal.cascade ?? false;
    const postGone = new Uint8Array(posts.length);
    posts.forEach((post, i) => {
      postGone[i] = (post.author && removal.people?.has(post.author)) || removal.posts?.has(post.id) ? 1 : 0;
    });
    // 0 unknown, 1 kept, 2 gone, 3 being resolved (guards against reply cycles)
    const state = new Uint8Array(comments.length);
    const resolve = (i: number): boolean => {
      if (state[i] === 2) return true;
      if (state[i] === 1 || state[i] === 3) return false;
      state[i] = 3;
      const comment = comments[i];
      const postIndex = comment.post === null ? undefined : this.postIds.get(comment.post);
      const parentIndex = comment.parent === null ? undefined : this.commentAt.get(comment.parent);
      const out =
        (comment.author !== null && removal.people?.has(comment.author) === true) ||
        removal.comments?.has(comment.id) === true ||
        (cascade && postIndex !== undefined && postGone[postIndex] === 1) ||
        (cascade && parentIndex !== undefined && resolve(parentIndex));
      state[i] = out ? 2 : 1;
      return out;
    };
    const commentGone = new Uint8Array(comments.length);
    for (let i = 0; i < comments.length; i++) commentGone[i] = resolve(i) ? 1 : 0;
    return { posts: postGone, comments: commentGone };
  }

  /** Health over what remains, with counts of what was removed. */
  evaluate(removal: Removal): {
    view: View;
    removed: { people: number; posts: number; comments: number; share: number };
  } {
    const { posts, comments } = this.corpus;
    const gone = this.gone(removal);
    let items = 0;
    let toneSum = 0;
    let hostileCount = 0;
    let judgedComments = 0;
    let disagreements = 0;
    let judgedGone = 0;
    let judgedAll = 0;
    let removedPosts = 0;
    let removedComments = 0;
    const authors = new Set<string>();

    posts.forEach((post, i) => {
      const judged = post.inWindow && post.tone !== null;
      if (judged) judgedAll += 1;
      if (gone.posts[i]) {
        removedPosts += 1;
        if (post.author && removal.people?.has(post.author)) authors.add(post.author);
        if (judged) judgedGone += 1;
        return;
      }
      if (!judged) return;
      items += 1;
      toneSum += post.tone!;
      if (hostile(post)) hostileCount += 1;
    });
    const helpedPosts = new Set<string>();
    comments.forEach((comment, i) => {
      const judged = comment.inWindow && comment.tone !== null;
      if (judged) judgedAll += 1;
      if (gone.comments[i]) {
        removedComments += 1;
        if (comment.author && removal.people?.has(comment.author)) authors.add(comment.author);
        if (judged) judgedGone += 1;
        return;
      }
      if (comment.helpful && comment.post) helpedPosts.add(comment.post);
      if (!judged) return;
      items += 1;
      toneSum += comment.tone!;
      judgedComments += 1;
      if (hostile(comment)) hostileCount += 1;
      if (comment.disagrees) disagreements += 1;
    });
    let asked = 0;
    let answered = 0;
    posts.forEach((post, i) => {
      if (!post.inWindow || !post.question || gone.posts[i]) return;
      asked += 1;
      if (helpedPosts.has(post.id) || removal.answered?.has(post.id)) answered += 1;
    });
    const scored = scoreHealth({
      civility: items ? hostileCount / items : null,
      warmth: items ? toneSum / items : null,
      agreement: judgedComments ? disagreements / judgedComments : null,
      helpfulness: asked ? answered / asked : null,
    });
    return {
      view: {
        score: scored.score,
        exact: exactScore(scored.signals),
        label: scored.label,
        signals: Object.fromEntries(
          Object.entries(scored.signals).map(([name, s]) => [name, { raw: s.raw, value: s.value }]),
        ) as View['signals'],
      },
      removed: {
        people: authors.size,
        posts: removedPosts,
        comments: removedComments,
        share: judgedAll ? judgedGone / judgedAll : 0,
      },
    };
  }

  /** Per-person tallies over judged writing in the window. */
  authorStats(): Map<string, { items: number; hostile: number; negativity: number; helpful: number }> {
    const stats = new Map<string, { items: number; hostile: number; negativity: number; helpful: number }>();
    const of = (id: string) => {
      const entry = stats.get(id) ?? { items: 0, hostile: 0, negativity: 0, helpful: 0 };
      stats.set(id, entry);
      return entry;
    };
    for (const item of [...this.corpus.posts, ...this.corpus.comments]) {
      if (!item.author || !item.inWindow || item.tone === null) continue;
      const entry = of(item.author);
      entry.items += 1;
      if (hostile(item)) entry.hostile += 1;
      entry.negativity += Math.max(0, 0.5 - item.tone);
      if ('helpful' in item && item.helpful) entry.helpful += 1;
    }
    return stats;
  }

  /** People ordered by a ranking, worst (or most helpful) first. Only people the ranking applies to appear. */
  rankPeople(rank: Rank, cascade: boolean): string[] {
    const stats = this.authorStats();
    const entries = [...stats.entries()];
    const byCount = (key: 'hostile' | 'negativity' | 'helpful') =>
      entries
        .filter(([, s]) => s[key] > 0)
        .sort((a, b) => b[1][key] - a[1][key] || b[1].items - a[1].items || a[0].localeCompare(b[0]))
        .map(([id]) => id);
    if (rank === 'hostileShare') {
      return entries
        .filter(([, s]) => s.hostile > 0 && s.items >= MIN_ITEMS)
        .sort((a, b) => b[1].hostile / b[1].items - a[1].hostile / a[1].items || b[1].items - a[1].items)
        .map(([id]) => id);
    }
    if (rank === 'impact') {
      const before = this.baseline.exact;
      if (before === null) return [];
      const candidates = [...new Set([...byCount('hostile'), ...byCount('negativity')])].slice(0, IMPACT_CANDIDATES);
      return candidates
        .map((id) => ({ id, score: this.evaluate({ people: new Set([id]), cascade }).view.exact ?? before }))
        .filter((entry) => entry.score > before)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .map((entry) => entry.id);
    }
    return byCount(rank);
  }
}

// --- scenarios -------------------------------------------------------------------------

const GENERAL_CAVEAT =
  'This is arithmetic on the posts and comments we have scored, not a prediction. A real community would adapt.';

function intParam(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.min(Math.floor(value!), max) : fallback;
}

function fraction(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 1;
}

function finish(
  engine: Engine,
  scenario: Scenario,
  removal: Removal,
  extra: Partial<Pick<WhatIfResult, 'curve' | 'subjects' | 'table'>> = {},
  notes: string[] = [],
): WhatIfResult {
  const { view: after, removed } = engine.evaluate(removal);
  const before = engine.baseline;
  const caveats = [GENERAL_CAVEAT, ...notes];
  if (removed.share > 0.25) {
    caveats.push(
      `This removes ${Math.round(removed.share * 100)}% of everything scored, so the result describes a much smaller community.`,
    );
  }
  if (before.score === null) caveats.push('There is not enough scored content yet to measure community health.');
  return {
    scenario,
    title: SCENARIOS[scenario].title,
    question: SCENARIOS[scenario].question,
    before,
    after,
    delta: before.exact !== null && after.exact !== null ? round2(after.exact - before.exact) : null,
    removed,
    curve: null,
    subjects: null,
    table: null,
    ...extra,
    caveats,
  };
}

/** Names for the people in a ranking. */
async function names(query: Query, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await query('MATCH (u:User) WHERE list_contains($ids, u.id) RETURN u.id AS id, u.name AS name', { ids });
  return new Map(rows.map((row) => [String(row.id), String(row.name ?? row.id)]));
}

async function peopleScenario(engine: Engine, query: Query, options: WhatIfOptions): Promise<WhatIfResult> {
  const rank = (options.rank && options.rank in RANKS ? options.rank : 'hostile') as Rank;
  const cascade = options.cascade ?? false;
  const ranked = engine.rankPeople(rank, cascade);
  const n = Math.min(intParam(options.n, 10, MAX_N), ranked.length);
  const curve = [{ n: 0, score: engine.baseline.exact }];
  for (let k = 1; k <= Math.min(MAX_CURVE, ranked.length); k++) {
    curve.push({ n: k, score: engine.evaluate({ people: new Set(ranked.slice(0, k)), cascade }).view.exact });
  }
  const chosen = ranked.slice(0, n);
  const stats = engine.authorStats();
  const named = await names(query, chosen);
  const subjects = chosen.slice(0, LIST_LIMIT * 2).map((id, i) => {
    const s = stats.get(id)!;
    const solo = engine.evaluate({ people: new Set([id]), cascade }).view.exact;
    return {
      rank: i + 1,
      id,
      name: named.get(id) ?? id,
      items: s.items,
      hostile: s.hostile,
      hostileShare: s.items ? s.hostile / s.items : null,
      helpful: s.helpful,
      alone: solo !== null && engine.baseline.exact !== null ? round2(solo - engine.baseline.exact) : null,
    };
  });
  const notes = [`Ranked by: ${RANKS[rank].toLowerCase()}.`];
  if (ranked.length < intParam(options.n, 10, MAX_N)) {
    notes.push(`Only ${ranked.length} people qualify, so that is how many were removed.`);
  }
  if (!cascade) notes.push("Only their own posts and comments go. Other people's replies stay.");
  if (!ranked.length) notes.push('Nobody qualifies in this period.');
  if (rank === 'impact') {
    notes.push(
      `Effect is tested one person at a time among the ${IMPACT_CANDIDATES} most hostile or negative writers. Removing several at once adds up differently.`,
    );
  }
  return finish(engine, 'people', { people: new Set(chosen), cascade }, { curve, subjects }, notes);
}

/** Judged hostile writing per thread (the post and its comments), worst first. */
function toxicThreads(engine: Engine): Array<{ post: CPost; hostile: number; items: number }> {
  const { posts, comments } = engine.corpus;
  const tally = new Map<string, { hostile: number; items: number }>();
  const add = (id: string | null, item: { inWindow: boolean; tone: number | null; hostility: number | null }) => {
    if (!id || !item.inWindow || item.tone === null) return;
    const entry = tally.get(id) ?? { hostile: 0, items: 0 };
    entry.items += 1;
    if (hostile(item)) entry.hostile += 1;
    tally.set(id, entry);
  };
  for (const post of posts) add(post.id, post);
  for (const comment of comments) add(comment.post, comment);
  const byId = new Map(posts.map((post) => [post.id, post]));
  return [...tally.entries()]
    .filter(([id, t]) => t.hostile > 0 && byId.has(id))
    .map(([id, t]) => ({ post: byId.get(id)!, ...t }))
    .sort((a, b) => b.hostile - a.hostile || b.items - a.items || a.post.id.localeCompare(b.post.id));
}

async function threadsScenario(engine: Engine, query: Query, options: WhatIfOptions): Promise<WhatIfResult> {
  const ranked = toxicThreads(engine);
  const n = Math.min(intParam(options.n, 5, MAX_N), ranked.length);
  const curve = [{ n: 0, score: engine.baseline.exact }];
  for (let k = 1; k <= Math.min(MAX_CURVE, ranked.length); k++) {
    curve.push({
      n: k,
      score: engine.evaluate({ posts: new Set(ranked.slice(0, k).map((t) => t.post.id)), cascade: true }).view.exact,
    });
  }
  const chosen = ranked.slice(0, n);
  const rows = await query('MATCH (p:Post) WHERE list_contains($ids, p.id) RETURN p.id AS id, p.subject AS subject', {
    ids: chosen.map((t) => t.post.id),
  });
  const subjectOf = new Map(rows.map((row) => [String(row.id), String(row.subject ?? '')]));
  const named = await names(
    query,
    chosen.map((t) => t.post.author).filter((id): id is string => id !== null),
  );
  const subjects = chosen.slice(0, LIST_LIMIT * 2).map((t, i) => ({
    rank: i + 1,
    id: t.post.id,
    subject: subjectOf.get(t.post.id) ?? '',
    author: t.post.author ? (named.get(t.post.author) ?? t.post.author) : null,
    hostile: t.hostile,
    items: t.items,
  }));
  return finish(
    engine,
    'threads',
    { posts: new Set(chosen.map((t) => t.post.id)), cascade: true },
    { curve, subjects },
    ['A thread is a post and all its comments.'],
  );
}

function hostilityScenario(engine: Engine, options: WhatIfOptions): WhatIfResult {
  const share = fraction(options.share);
  const items = [
    ...engine.corpus.posts.map((item) => ({ kind: 'post' as const, item })),
    ...engine.corpus.comments.map((item) => ({ kind: 'comment' as const, item })),
  ]
    .filter(({ item }) => item.inWindow && item.tone !== null && hostile(item))
    .sort((a, b) => (b.item.hostility ?? 0) - (a.item.hostility ?? 0) || a.item.id.localeCompare(b.item.id));
  const chosen = items.slice(0, Math.round(items.length * share));
  const notes = [`${items.length} hostile posts and comments in this period; ${chosen.length} removed, worst first.`];
  if (chosen.some(({ kind }) => kind === 'post')) {
    notes.push('Comments under a removed post stay unless "Also remove replies" is ticked.');
  }
  return finish(
    engine,
    'hostility',
    {
      posts: new Set(chosen.filter(({ kind }) => kind === 'post').map(({ item }) => item.id)),
      comments: new Set(chosen.filter(({ kind }) => kind === 'comment').map(({ item }) => item.id)),
      cascade: options.cascade ?? false,
    },
    {},
    notes,
  );
}

async function answersScenario(engine: Engine, query: Query, options: WhatIfOptions): Promise<WhatIfResult> {
  const share = fraction(options.share);
  const helped = new Set(engine.corpus.comments.filter((c) => c.helpful && c.post).map((c) => c.post!));
  const open = engine.corpus.posts
    .filter((post) => post.inWindow && post.question && !helped.has(post.id))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const chosen = open.slice(0, Math.round(open.length * share));
  const rows = await query(
    'MATCH (p:Post) WHERE list_contains($ids, p.id) RETURN p.id AS id, p.subject AS subject, p.commentCount AS comments',
    { ids: open.slice(0, LIST_LIMIT).map((post) => post.id) },
  );
  const info = new Map(rows.map((row) => [String(row.id), row]));
  const named = await names(
    query,
    open.slice(0, LIST_LIMIT).flatMap((post) => (post.author ? [post.author] : [])),
  );
  const subjects = open.slice(0, LIST_LIMIT).map((post, i) => ({
    rank: i + 1,
    id: post.id,
    subject: String(info.get(post.id)?.subject ?? ''),
    author: post.author ? (named.get(post.author) ?? post.author) : null,
    comments: Number(info.get(post.id)?.comments ?? 0),
    at: post.at ? new Date(post.at).toISOString() : null,
  }));
  return finish(engine, 'answers', { answered: new Set(chosen.map((post) => post.id)) }, { subjects }, [
    `${open.length} questions in the period have no helpful answer; ${chosen.length} are treated as answered, newest first.`,
    'Only the helpfulness signal can move in this scenario.',
  ]);
}

/** One row per theme or neighborhood: what the score would be without its threads. */
function tableScenario(engine: Engine, scenario: 'themes' | 'places', picked: string[] = []): WhatIfResult {
  const { posts } = engine.corpus;
  const keyOf = (post: CPost) => (scenario === 'themes' ? post.theme : post.hood);
  const groups = new Map<string, Set<string>>();
  const judged = new Map<string, number>();
  for (const post of posts) {
    const key = keyOf(post);
    if (!key) continue;
    const set = groups.get(key) ?? new Set<string>();
    set.add(post.id);
    groups.set(key, set);
    if (post.inWindow && post.tone !== null) judged.set(key, (judged.get(key) ?? 0) + 1);
  }
  const before = engine.baseline.exact;
  let rows = [...groups.entries()]
    .filter(([key]) => (judged.get(key) ?? 0) >= (scenario === 'themes' ? 1 : MIN_PLACE_ITEMS))
    .map(([key, ids]) => {
      const { view, removed } = engine.evaluate({ posts: ids, cascade: true });
      return {
        key,
        name: scenario === 'themes' ? key : (engine.corpus.hoodNames.get(key) ?? key),
        posts: judged.get(key) ?? 0,
        comments: removed.comments,
        share: removed.share,
        score: view.score,
        delta: view.exact !== null && before !== null ? round2(view.exact - before) : null,
      };
    })
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || b.posts - a.posts);
  if (scenario === 'places') rows = rows.slice(0, MAX_PLACES);
  const chosen = new Set<string>();
  for (const key of picked) for (const id of groups.get(key) ?? []) chosen.add(id);
  return finish(engine, scenario, { posts: chosen, cascade: true }, { table: rows }, [
    scenario === 'themes'
      ? 'The Without and Change columns show each topic removed on its own, with all its threads.'
      : `The Without and Change columns show each neighborhood removed on its own, with all its threads. Neighborhoods with fewer than ${MIN_PLACE_ITEMS} scored posts are not listed.`,
  ]);
}

export function isScenario(name: string): name is Scenario {
  return Object.hasOwn(SCENARIOS, name);
}

/** Run one what-if scenario over the cached graph. */
export async function whatIf(query: Query, scenario: string, options: WhatIfOptions): Promise<WhatIfResult> {
  if (!isScenario(scenario)) throw new ExploreError(404, `Unknown what-if scenario "${scenario}"`);
  const engine = new Engine(await loadCorpus(query, options.since));
  switch (scenario) {
    case 'people':
      return peopleScenario(engine, query, options);
    case 'threads':
      return threadsScenario(engine, query, options);
    case 'hostility':
      return hostilityScenario(engine, options);
    case 'answers':
      return answersScenario(engine, query, options);
    case 'themes':
    case 'places':
      return tableScenario(engine, scenario, options.keys);
  }
}
