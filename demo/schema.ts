/**
 * The shape of the invented community behind the README screenshots.
 *
 * Everything here is fiction: Tallgrass Ridge, Illinois does not exist, and no
 * name, business, or story matches a real one. The data lives in
 * demo/data/*.json and is validated against these schemas by `make demo-graph`.
 */

import { z } from 'zod';
import { THEMES } from '../src/lib/jev.js';

export const CITY = 'Tallgrass Ridge';
export const STATE = 'IL';

const themeIds = Object.keys(THEMES) as [keyof typeof THEMES, ...(keyof typeof THEMES)[]];
export const ThemeId = z.enum(themeIds);

const key = z.string().regex(/^[a-z0-9_]+$/, 'lowercase letters, digits, and underscores only');
const level = z.number().min(0).max(3);
const unit = z.number().min(0).max(1);
const opinion = z.enum(['favorable', 'unfavorable', 'neutral']);

export const Neighborhood = z.object({
  key,
  name: z.string(),
  /** How many neighbors Nextdoor would report for it. */
  neighbors: z.number().int().min(150).max(2500),
});

export const Person = z.object({
  key,
  /** First name and last initial or a full invented name, like "Marguerite Oyelaran". */
  name: z.string(),
  hood: key,
  residentSince: z.number().int().min(1985).max(2026),
  /** How many days before today this person first appears in the data (0 = a brand-new neighbor). */
  joinedDaysAgo: z.number().int().min(0).max(700),
  /** Nextdoor badges: lead, foundingMember, ... Mostly empty. */
  badges: z.array(z.string()).default([]),
  /** A few words on how they write, for whoever authors their text ("terse retired machinist"). */
  voice: z.string(),
});

export const Business = z.object({
  key,
  name: z.string(),
  /** Nextdoor-style category, e.g. "Bakery", "Plumber", "Pizza restaurant". */
  category: z.string(),
  /** Street address inside Tallgrass Ridge, IL, with an invented street. */
  address: z.string(),
  faves: z.number().int().min(0).max(400),
  followers: z.number().int().min(0).max(900),
});

export const Group = z.object({ key, name: z.string(), members: z.number().int().min(20).max(1200) });

export const Roster = z.object({
  neighborhoods: z.array(Neighborhood).length(8),
  people: z.array(Person).min(60),
  businesses: z.array(Business).min(14),
  groups: z.array(Group).min(3),
});

const BusinessMention = z.object({ business: key, opinion });

export const Comment = z.object({
  author: key,
  /** Index of an earlier comment in this thread that this one answers, or null for a top-level comment. */
  replyTo: z.number().int().min(0).nullable(),
  /** Minutes after the post. Replies come after the comment they answer. */
  minutesAfter: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 6),
  body: z.string(),
  stance: z.enum(['agrees', 'disagrees', 'informs', 'jokes', 'off_topic']),
  /** 0 angry ... 0.5 neutral ... 1 delighted. */
  tone: unit,
  hostility: level,
  /** Probability the comment gives a concrete answer or useful information. */
  helpful: unit,
  reactions: z.number().int().min(0).max(40),
  businessMentions: z.array(BusinessMention).default([]),
  /** True for the rare comment the moderators removed. */
  removed: z.boolean().default(false),
});

export const Thread = z.object({
  /** Unique across all files, e.g. "crime-07". */
  id: z.string().regex(/^[a-z]+-\d{2,3}$/),
  theme: ThemeId,
  /** Other themes that apply, with probabilities. The primary theme is added automatically at 0.9. */
  otherThemes: z.partialRecord(ThemeId, unit).default({}),
  hood: key,
  author: key,
  /** Days before today, 0 to 180. Spread across the range; recent days are busier. */
  daysAgo: z.number().min(0).max(180),
  subject: z.string(),
  body: z.string(),
  intent: z.enum(['ask_help', 'alert', 'inform', 'opinion', 'complaint', 'transaction', 'social']),
  tone: unit,
  hostility: level,
  urgency: level,
  asksQuestion: unit,
  accuses: unit,
  place: z.enum(['own_neighborhood', 'elsewhere_local', 'outside_area', 'general']),
  reactions: z.number().int().min(0).max(200),
  isForSale: z.boolean().default(false),
  businessMentions: z.array(BusinessMention).default([]),
  group: key.optional(),
  /** True for the rare post the moderators removed. */
  removed: z.boolean().default(false),
  comments: z.array(Comment).max(14),
});

export const Threads = z.array(Thread);

export type Roster = z.infer<typeof Roster>;
export type Thread = z.infer<typeof Thread>;
