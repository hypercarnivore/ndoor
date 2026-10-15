/**
 * Builds a demo graph from the invented community in demo/data, so the README
 * screenshots show a place that does not exist.
 *
 *   tsx demo/build.ts check [files...]   validate roster and threads, change nothing
 *   tsx demo/build.ts build [--out path]  write the graph (default demo/out/graph.lbug)
 *
 * The data goes through the same GraphStore writes `ndoor sync` and
 * `ndoor judge` use, so every screen reads it exactly as it reads real data.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphStore } from '../src/lib/graph.js';
import { PLACE_QUESTION_SET, QUESTION_SET_VERSION } from '../src/lib/jev.js';
import type { Author, BusinessRef, Comment, Neighborhood, Post, UserProfile } from '../src/lib/model.js';
import { CITY, Roster, STATE, type Thread, Threads } from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const DAY = 86_400_000;

export function loadRoster(): Roster {
  return Roster.parse(JSON.parse(readFileSync(join(DATA, 'roster.json'), 'utf8')));
}

export function threadFiles(): string[] {
  return readdirSync(DATA)
    .filter((name) => /^threads-.*\.json$/.test(name))
    .sort()
    .map((name) => join(DATA, name));
}

export function loadThreads(files: string[]): Thread[] {
  return files.flatMap((file) => {
    try {
      return Threads.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
    }
  });
}

/** Cross-references and timing the schemas cannot express. Returns every problem found. */
export function problems(roster: Roster, threads: Thread[]): string[] {
  const out: string[] = [];
  const people = new Map(roster.people.map((person) => [person.key, person]));
  const hoods = new Set(roster.neighborhoods.map((hood) => hood.key));
  const businesses = new Set(roster.businesses.map((business) => business.key));
  const groups = new Set(roster.groups.map((group) => group.key));
  const ids = new Set<string>();
  for (const person of roster.people) {
    if (!hoods.has(person.hood)) out.push(`person ${person.key}: unknown neighborhood ${person.hood}`);
  }
  for (const thread of threads) {
    const at = `thread ${thread.id}`;
    if (ids.has(thread.id)) out.push(`${at}: duplicate id`);
    ids.add(thread.id);
    if (!hoods.has(thread.hood)) out.push(`${at}: unknown neighborhood ${thread.hood}`);
    if (thread.group && !groups.has(thread.group)) out.push(`${at}: unknown group ${thread.group}`);
    const check = (who: string, daysAgo: number, label: string) => {
      const person = people.get(who);
      if (!person) return out.push(`${at}: unknown person ${who} (${label})`);
      if (daysAgo > person.joinedDaysAgo) {
        out.push(
          `${at}: ${who} acts ${Math.round(daysAgo)} days ago but joined ${person.joinedDaysAgo} days ago (${label})`,
        );
      }
    };
    check(thread.author, thread.daysAgo, 'author');
    if (people.get(thread.author) && people.get(thread.author)!.hood !== thread.hood) {
      out.push(`${at}: hood ${thread.hood} is not ${thread.author}'s neighborhood ${people.get(thread.author)!.hood}`);
    }
    for (const mention of thread.businessMentions) {
      if (!businesses.has(mention.business)) out.push(`${at}: unknown business ${mention.business}`);
    }
    thread.comments.forEach((comment, index) => {
      const label = `comment ${index}`;
      check(comment.author, thread.daysAgo - comment.minutesAfter / 1440, label);
      if (comment.replyTo !== null) {
        const target = thread.comments[comment.replyTo];
        if (comment.replyTo >= index) out.push(`${at}: ${label} replies to a later comment`);
        else if (target && comment.minutesAfter <= target.minutesAfter) out.push(`${at}: ${label} predates its parent`);
      }
      for (const mention of comment.businessMentions) {
        if (!businesses.has(mention.business)) out.push(`${at}: ${label} unknown business ${mention.business}`);
      }
    });
  }
  return out;
}

/** Small deterministic generator, so the same data always builds the same graph. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export async function buildGraph(out: string): Promise<{ posts: number; comments: number; people: number }> {
  const roster = loadRoster();
  const threads = loadThreads(threadFiles());
  const found = problems(roster, threads);
  if (found.length) throw new Error(`The demo data has ${found.length} problem(s):\n${found.join('\n')}`);

  const random = seeded(20261015);
  const today = Date.now();
  const iso = (daysAgo: number) => new Date(today - daysAgo * DAY).toISOString();
  const people = new Map(roster.people.map((person) => [person.key, person]));
  const businessRefs = new Map<string, BusinessRef>(
    roster.businesses.map((b) => [b.key, { id: `entity_${b.key}`, name: b.name, slug: slug(b.name) }]),
  );
  const hoodRef = (key: string): Neighborhood => {
    const hood = roster.neighborhoods.find((n) => n.key === key)!;
    return {
      id: `neighborhood_${key}`,
      name: `Nextdoor ${hood.name}`,
      slug: slug(hood.name),
      city: CITY,
      state: STATE,
    };
  };
  const authorOf = (key: string): Author => {
    const person = people.get(key)!;
    return {
      id: `user_${key}`,
      secureId: `secureUser_${key}`,
      name: person.name,
      type: 'NEIGHBOR',
      profileUrl: `/profile/${key}/`,
      neighborhood: hoodRef(person.hood),
      agency: null,
      pageSlug: null,
    };
  };
  const reactionsOf = (total: number) => {
    const thanks = Math.round(total * 0.15 * random());
    const loves = Math.round(total * 0.2 * random());
    return { total, byType: { like2: total - thanks - loves, thank: thanks, love: loves } };
  };

  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  const store = await GraphStore.open(out);

  for (const hood of roster.neighborhoods) {
    await store.upsertNeighborhoodProfile({ ...hoodRef(hood.key), neighbors: hood.neighbors }, iso(1));
  }
  for (const b of roster.businesses) {
    await store.upsertBusiness(
      {
        id: `entity_${b.key}`,
        slug: slug(b.name),
        name: b.name,
        category: b.category,
        address: b.address,
        faves: b.faves,
        followers: b.followers,
      },
      iso(1),
    );
  }
  for (const group of roster.groups) {
    await store.upsertGroups(
      [{ id: `group_${group.key}`, name: group.name, members: group.members, isMember: true }],
      null,
      iso(1),
    );
  }

  // Oldest first, so firstSeen follows the calendar.
  const ordered = [...threads].sort((a, b) => b.daysAgo - a.daysAgo);
  const expected = { posts: 0, comments: 0 };
  const earliest = new Map<string, number>();
  const seen = (key: string, daysAgo: number) => earliest.set(key, Math.max(earliest.get(key) ?? 0, daysAgo));

  for (const thread of ordered) {
    const postId = `post_${thread.id}`;
    const shareId = `demo-${thread.id}`;
    const comments: Comment[] = [];
    const rootOf = new Map<number, number>();
    thread.comments.forEach((c, index) => {
      rootOf.set(index, c.replyTo === null ? index : rootOf.get(c.replyTo)!);
    });
    const built = thread.comments.map((c, index): Comment => {
      const target = c.replyTo === null ? null : thread.comments[c.replyTo];
      return {
        id: `comment_${thread.id}_${index}`,
        parentId: c.replyTo === null ? null : `comment_${thread.id}_${rootOf.get(index)}`,
        replyToId: c.replyTo === null ? null : `comment_${thread.id}_${c.replyTo}`,
        mentions: target ? [`user_${target.author}`] : [],
        businessMentions: c.businessMentions.map((m) => businessRefs.get(m.business)!),
        author: authorOf(c.author),
        body: c.body,
        createdAt: iso(thread.daysAgo - c.minutesAfter / 1440),
        reactions: reactionsOf(c.reactions),
        isDeleted: c.removed,
        replies: [],
        replyCount: 0,
        repliesCursor: null,
      };
    });
    built.forEach((c, index) => {
      if (c.parentId === null) comments.push(c);
      else built[rootOf.get(index)!].replies.push(c);
      seen(thread.comments[index].author, thread.daysAgo - thread.comments[index].minutesAfter / 1440);
    });
    for (const c of comments) c.replyCount = c.replies.length;
    seen(thread.author, thread.daysAgo);

    const post: Post = {
      id: postId,
      shareId,
      url: `https://nextdoor.com/p/${shareId}`,
      subject: thread.subject,
      body: thread.body,
      createdAt: iso(thread.daysAgo),
      author: authorOf(thread.author),
      topics: [],
      visibility: 'NEIGHBORHOOD',
      reactions: reactionsOf(thread.reactions),
      commentCount: thread.comments.length,
      media: [],
      label: null,
      repostOf: null,
      postType: 'USER',
      hashtags: [],
      mentions: [],
      businessMentions: thread.businessMentions.map((m) => businessRefs.get(m.business)!),
      isForSale: thread.isForSale,
      isEdited: false,
      comments,
      commentsCursor: null,
    };
    const when = iso(thread.daysAgo - 0.01);
    await store.ingestPost(post, when, thread.group ? { groupId: `group_${thread.group}` } : {});
    await store.run('MATCH (p:Post {id: $id}) SET p.threadFetchedAt = timestamp($at)', { id: postId, at: when });
    expected.posts += 1;
    expected.comments += thread.comments.length;

    await store.saveJudgments({
      subjectId: postId,
      kind: 'post',
      version: QUESTION_SET_VERSION,
      properties: {
        primaryTheme: thread.theme,
        primaryThemeConfidence: 0.9,
        intent: thread.intent,
        tone: thread.tone,
        hostility: thread.hostility,
        urgency: thread.urgency,
        asksQuestion: thread.asksQuestion,
        accuses: thread.accuses,
      },
      themes: { ...thread.otherThemes, [thread.theme]: 0.9 },
    });
    await store.savePlace(postId, thread.place, 0.85, PLACE_QUESTION_SET);
    for (const m of thread.businessMentions) {
      await store.saveOpinion('Post', postId, `entity_${m.business}`, m.opinion, 0.85);
    }
    for (const [index, c] of thread.comments.entries()) {
      const id = `comment_${thread.id}_${index}`;
      await store.saveJudgments({
        subjectId: id,
        kind: 'comment',
        version: QUESTION_SET_VERSION,
        properties: {
          stance: c.stance,
          tone: c.tone,
          hostility: c.hostility,
          helpful: c.helpful,
          recommendsBusiness: c.businessMentions.some((m) => m.opinion === 'favorable') ? 0.9 : 0.04,
        },
      });
      for (const m of c.businessMentions)
        await store.saveOpinion('Comment', id, `entity_${m.business}`, m.opinion, 0.85);
    }
    if (thread.removed)
      await store.markPostRemoved(postId, 'Removed by moderators', iso(Math.max(0, thread.daysAgo - 1)));
  }

  // Profiles, with each person's first appearance no later than their first activity.
  for (const person of roster.people) {
    const profile: UserProfile = {
      id: `user_${person.key}`,
      secureId: `secureUser_${person.key}`,
      name: person.name,
      neighborhood: hoodRef(person.hood),
      residentSince: person.residentSince,
      pronouns: null,
      biography: '',
      profileType: 'NEIGHBORHOOD_USER',
      badges: person.badges,
      helpfulScore: null,
      ownedBusinesses: [],
    };
    const first = Math.max(person.joinedDaysAgo, earliest.get(person.key) ?? 0);
    await store.upsertUserProfile(profile, iso(Math.max(0, first - 0.01)));
    await store.run('MATCH (u:User {id: $id}) SET u.firstSeen = timestamp($first)', {
      id: profile.id,
      first: iso(first),
    });
  }

  await store.recordSync('demo-sync', iso(0.02), iso(0.01), { demo: true });
  await store.close();
  return { ...expected, people: roster.people.length };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'check') {
    const roster = loadRoster();
    const files = rest.length ? rest.map((file) => resolve(file)) : threadFiles();
    const threads = loadThreads(files);
    const found = problems(roster, threads);
    if (found.length) {
      console.error(found.join('\n'));
      process.exit(1);
    }
    console.log(`ok: ${threads.length} threads, ${threads.reduce((n, t) => n + t.comments.length, 0)} comments`);
  } else if (command === 'build') {
    const flag = rest.indexOf('--out');
    const out = resolve(flag >= 0 ? rest[flag + 1] : join(HERE, 'out', 'graph.lbug'));
    const result = await buildGraph(out);
    console.log(`built ${out}: ${result.people} people, ${result.posts} posts, ${result.comments} comments`);
  } else {
    console.error('usage: tsx demo/build.ts check [files...] | build [--out path]');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
