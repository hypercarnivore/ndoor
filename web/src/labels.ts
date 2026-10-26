/**
 * Plain-language names for everything the app shows: themes, intents,
 * stances, account kinds, and record fields. People using the app are not
 * expected to know internal ids or field names, so nothing raw reaches the
 * screen without passing through here.
 */

import { day } from './dates';

const THEME_NAMES: Record<string, string> = {
  crime_safety: 'Crime & safety',
  lost_found_pet: 'Lost & found pets',
  lost_found_item: 'Lost & found items',
  wildlife_nature: 'Wildlife & nature',
  local_government: 'Local government',
  national_politics: 'National politics',
  roads_traffic: 'Roads & traffic',
  utilities_services: 'Utilities & public services',
  housing_development: 'Housing & development',
  services_recommendations: 'Services & recommendations',
  local_business_news: 'Local business news',
  buy_sell_free: 'Buy, sell & free',
  events_community: 'Events & community',
  neighbor_complaints: 'Neighbor complaints',
  health_medical: 'Health & medical',
  weather_emergency: 'Weather & emergencies',
  schools_youth: 'Schools & youth',
  photos_appreciation: 'Photos & appreciation',
  other: 'Other',
};

const INTENTS: Record<string, string> = {
  ask_help: 'Asks for help',
  alert: 'Alert',
  inform: 'Shares information',
  opinion: 'Opinion',
  complaint: 'Complaint',
  transaction: 'Buy, sell, or hire',
  social: 'Social',
};

const STANCES: Record<string, string> = {
  agrees: 'Agrees',
  disagrees: 'Disagrees',
  informs: 'Informs',
  jokes: 'Jokes',
  off_topic: 'Off topic',
};

const KINDS: Record<string, string> = {
  NEIGHBOR: 'Neighbor',
  CITY_AGENCY: 'Public agency',
  ENTITY_PAGES: 'Business or organization page',
};

const PLACES: Record<string, string> = {
  own_neighborhood: "In the poster's own neighborhood",
  elsewhere_local: 'Elsewhere nearby',
  outside_area: 'Outside the area',
  general: 'General, no specific place',
};

const OPINIONS: Record<string, string> = { favorable: 'Favorable', unfavorable: 'Unfavorable', neutral: 'Neutral' };

/** "SOME_VALUE" or "some_value" as "Some value". */
export function humanize(value: string): string {
  const words = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Built-in themes by name; discovered themes from their id. */
export const themeLabel = (id: string) => THEME_NAMES[id] ?? humanize(id);
export const intentLabel = (id: string) => INTENTS[id] ?? humanize(id);
export const stanceLabel = (id: string) => STANCES[id] ?? humanize(id);
export const kindLabel = (id: string) => KINDS[id] ?? humanize(id);
export const placeLabel = (id: string) => PLACES[id] ?? humanize(id);
export const opinionLabel = (id: string) => OPINIONS[id] ?? humanize(id);

/** Record fields worth showing, by plain name, in display order. Anything else is internal and hidden. */
export const FIELDS: Record<string, string> = {
  kind: 'Account type',
  residentSince: 'Resident since',
  pronouns: 'Pronouns',
  badges: 'Badges',
  createdAt: 'Posted',
  postType: 'Post type',
  visibility: 'Visible to',
  label: 'Label',
  isForSale: 'For sale',
  isEdited: 'Edited',
  hashtags: 'Hashtags',
  media: 'Photos and media',
  reactions: 'Reactions',
  reactionsByType: 'Reactions by type',
  commentCount: 'Comments',
  isDeleted: 'Deleted by author',
  removedAt: 'Noticed removed',
  removedReason: 'Why it seems removed',
  city: 'City',
  state: 'State',
  neighbors: 'Nextdoor members',
  category: 'Category',
  address: 'Address',
  faves: 'Nextdoor faves',
  followers: 'Followers',
  members: 'Members',
  source: 'Source',
  firstSeen: 'First seen',
  lastSeen: 'Last seen',
};

/** Values of enumerated fields, in plain words. */
export function fieldValue(field: string, value: string): string {
  if (field === 'kind') return kindLabel(value);
  if (field === 'postType') {
    return (
      { USER: 'Neighbor post', NEWS_ARTICLE: 'News article', POLL: 'Poll', NEW_MEMBER_ANNOUNCEMENT: 'New member' }[
        value
      ] ?? humanize(value)
    );
  }
  if (field === 'source') return value === 'discovered' ? 'Discovered in this community' : 'Built in';
  if (field === 'visibility' || field === 'pronouns') return humanize(value);
  return value;
}

/** A node's display title: theme ids become theme names. */
export function refTitle(ref: { label: string; title?: string | null; key: string }): string {
  const title = ref.title ?? ref.key;
  return ref.label === 'Theme' ? themeLabel(title) : title;
}

/** A node's subtitle: account kinds in plain words. */
export function refSubtitle(ref: { label: string; subtitle?: string | null }): string | null {
  if (!ref.subtitle) return null;
  if (ref.label === 'User') return kindLabel(ref.subtitle);
  if (ref.label === 'Theme') return ref.subtitle === 'discovered' ? 'Discovered here' : 'Built in';
  // Posts and comments carry their timestamp; show its day in the viewer's time zone.
  if (ref.label === 'Post' || ref.label === 'Comment') return day(ref.subtitle);
  return ref.subtitle;
}
