/** Visual identity of each node type, shared by every view. */
export const LABELS: Record<string, { color: string; name: string; plural: string; glyph: string }> = {
  User: { color: '#60a5fa', name: 'Person', plural: 'People', glyph: 'P' },
  Post: { color: '#f59e0b', name: 'Post', plural: 'Posts', glyph: 'Po' },
  Comment: { color: '#a78bfa', name: 'Comment', plural: 'Comments', glyph: 'C' },
  Neighborhood: { color: '#34d399', name: 'Neighborhood', plural: 'Neighborhoods', glyph: 'N' },
  Business: { color: '#f472b6', name: 'Business', plural: 'Businesses', glyph: 'B' },
  Theme: { color: '#22d3ee', name: 'Theme', plural: 'Themes', glyph: 'Th' },
  Topic: { color: '#94a3b8', name: 'Topic', plural: 'Topics', glyph: 'To' },
  Agency: { color: '#f87171', name: 'Agency', plural: 'Agencies', glyph: 'A' },
  InterestGroup: { color: '#a3e635', name: 'Group', plural: 'Groups', glyph: 'G' },
};

export const labelColor = (label: string) => LABELS[label]?.color ?? '#94a3b8';

/** Relationship names as readers say them, by direction. */
export const REL_NAMES: Record<string, { out: string; in: string }> = {
  POSTED: { out: 'posted', in: 'posted by' },
  COMMENTED: { out: 'commented', in: 'written by' },
  ON_POST: { out: 'on post', in: 'comments' },
  REPLY_TO: { out: 'replies to', in: 'replies' },
  MENTIONS: { out: 'mentions', in: 'mentioned in' },
  MENTIONS_BUSINESS: { out: 'mentions business', in: 'mentioned in' },
  TAGGED: { out: 'topic', in: 'posts' },
  REPOSTS: { out: 'reposts', in: 'reposted by' },
  FROM_HOOD: { out: 'from', in: 'posts from here' },
  LIVES_IN: { out: 'lives in', in: 'residents' },
  IN_GROUP: { out: 'in group', in: 'posts' },
  MEMBER_OF: { out: 'member of', in: 'members' },
  SPEAKS_FOR: { out: 'speaks for', in: 'staff' },
  IS_PAGE: { out: 'page of', in: 'page' },
  REACTED: { out: 'you reacted to', in: 'your reaction' },
  ABOUT: { out: 'about', in: 'posts' },
};

export const relName = (rel: string, direction: 'in' | 'out') => REL_NAMES[rel]?.[direction] ?? rel.toLowerCase();

/** Categorical palette for neighborhoods and other groupings. */
export const PALETTE = [
  '#60a5fa',
  '#34d399',
  '#f59e0b',
  '#f472b6',
  '#a78bfa',
  '#22d3ee',
  '#f87171',
  '#a3e635',
  '#fb923c',
  '#e879f9',
  '#2dd4bf',
  '#facc15',
];

/** Tone 0..1 (0.5 neutral) as a red-to-green color. */
export function toneColor(tone: number | null | undefined): string {
  if (tone === null || tone === undefined) return '#64748b';
  const hue = Math.round(Math.max(0, Math.min(1, tone)) * 130);
  return `hsl(${hue} 70% 55%)`;
}

export const STANCE_COLORS: Record<string, string> = {
  agrees: '#34d399',
  disagrees: '#f87171',
  informs: '#60a5fa',
  jokes: '#facc15',
  off_topic: '#94a3b8',
};
