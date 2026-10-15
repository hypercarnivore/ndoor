import type {
  BusinessSentiment,
  Health,
  LinkGroup,
  Network,
  NodeDetail,
  NodeRef,
  Overview,
  PersonSentiment,
  SearchGroup,
  Thread,
  ThreadComment,
} from '../../src/lib/explore.js';

export type {
  BusinessSentiment,
  Health,
  LinkGroup,
  Network,
  NodeDetail,
  NodeRef,
  Overview,
  PersonSentiment,
  SearchGroup,
  Thread,
  ThreadComment,
};
export type Row = Record<string, unknown>;

/**
 * This run's access token. It arrives once in the `?token=` link `ndoor ui`
 * prints, is kept in localStorage (scoped to this exact origin, unlike
 * cookies, which every port on 127.0.0.1 would share), and leaves the address
 * bar right away.
 */
const TOKEN_KEY = 'ndoor-ui-token';

function readToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromLink = params.get('token');
  if (fromLink) {
    try {
      localStorage.setItem(TOKEN_KEY, fromLink);
    } catch {
      // Storage disabled: the token still works for this page load.
    }
    params.delete('token');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
    return fromLink;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

const token = readToken();

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json', 'x-ndoor-token': token } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

const seg = encodeURIComponent;

/** Query string from defined, non-empty values. */
function query(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${seg(key)}=${seg(String(value))}`)
    .join('&');
}

export interface DrillSection {
  title: string;
  hint?: string;
  kind: 'items' | 'people' | 'threads' | 'histogram' | 'pairs';
  rows: Row[];
}

export interface BusinessSummary {
  kpis: {
    businesses: number;
    mentions: number;
    people: number;
    favorable: number;
    neutral: number;
    unfavorable: number;
    judged: number;
  };
  categories: Row[];
  uncategorized: number;
  weekly: Row[];
  loved: Row[];
  attention: Row[];
  rising: Row[];
  demand: { requests: number; answered: number; loaded: number; unanswered: Row[]; recent: Row[] };
}

export interface TopicReport {
  key: string;
  title: string;
  themes: string[];
  kinds: string[];
  kpis: {
    posts: number;
    share: number | null;
    last30: number;
    prior30: number;
    urgent: number;
    fromAgencies: number;
    tone: number | null;
    comments: number;
    excluded: number;
    local: number;
  };
  excludedReason: string | null;
  placeBuckets: Array<{ key: string; name: string; posts: number }>;
  incidentNeighborhoods: Row[];
  weekly: Row[];
  kindCounts: Row[];
  neighborhoods: Row[];
  sources: Row[];
  accounts: Row[];
  mostDiscussed: Row[];
  posts: Row[];
}

export interface Newcomers {
  kpis: { joins: number; last30: number; prior30: number; neighborhoods: number; residentsWithYear: number };
  weekly: Row[];
  neighborhoods: Row[];
  residentSince: Row[];
  recent: Row[];
}

export interface BusinessDetail {
  business: Row;
  metrics: Row | null;
  weekly: Row[];
  mentions: Row[];
  peers: Row[];
  ownPosts: Row[];
}

export const api = {
  overview: () => get<Overview>('/api/overview'),
  search: (q: string) => get<SearchGroup[]>(`/api/search?q=${seg(q)}`),
  node: (label: string, key: string) => get<NodeDetail>(`/api/node/${seg(label)}/${seg(key)}`),
  links: (label: string, key: string, group: LinkGroup, offset: number, limit = 25) =>
    get<LinkGroup>(
      `/api/links/${seg(label)}/${seg(key)}/${seg(group.rel)}/${group.direction}/${seg(group.label)}?offset=${offset}&limit=${limit}`,
    ),
  thread: (postId: string) => get<Thread>(`/api/thread/${seg(postId)}`),
  sentiment: (label: 'User' | 'Business', key: string) =>
    get<PersonSentiment | BusinessSentiment>(`/api/sentiment/${label}/${seg(key)}`),
  health: (days: number) => get<Health>(`/api/health?days=${days}`),
  healthDrill: (signal: string, days: number) => get<DrillSection[]>(`/api/health/${seg(signal)}?${query({ days })}`),
  people: (options: { days: number; sort?: string; q?: string }) => get<Row[]>(`/api/people?${query(options)}`),
  posts: (options: { days: number; sort?: string; q?: string; theme?: string; hood?: string }) =>
    get<Row[]>(`/api/posts?${query(options)}`),
  comments: (options: { days: number; sort?: string; q?: string; stance?: string }) =>
    get<{ rows: Row[]; stances: Row[] }>(`/api/comments?${query(options)}`),
  neighborhoods: (days: number) => get<Row[]>(`/api/neighborhoods?${query({ days })}`),
  themes: (days: number) => get<Row[]>(`/api/themes?${query({ days })}`),
  groups: (days: number) => get<Row[]>(`/api/groups?${query({ days })}`),
  businesses: (days: number) => get<Row[]>(`/api/businesses?${query({ days })}`),
  businessSummary: (days: number) => get<BusinessSummary>(`/api/businesses/summary?${query({ days })}`),
  business: (id: string, days: number) => get<BusinessDetail>(`/api/business/${seg(id)}?${query({ days })}`),
  topic: (key: string, days: number) => get<TopicReport>(`/api/topic/${seg(key)}?${query({ days })}`),
  newcomers: (days: number) => get<Newcomers>(`/api/newcomers?${query({ days })}`),
  network: (options: { days: number; min: number; limit: number; businesses: boolean }) =>
    get<Network>(
      `/api/network?days=${options.days}&min=${options.min}&limit=${options.limit}&businesses=${options.businesses ? 1 : 0}`,
    ),
  report: (name: string, limit = 25, days = 365) => get<Row[]>(`/api/report/${seg(name)}?limit=${limit}&days=${days}`),
};

/** Stable id for a node across views. */
export const nodeId = (ref: { label: string; key: string }) => `${ref.label}:${ref.key}`;
