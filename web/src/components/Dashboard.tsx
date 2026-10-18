import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Ref } from '../App';
import { api, type Health, type Newcomers, type Overview, type Row } from '../api';
import { themeLabel } from '../labels';
import { JoinsChart, NEWCOMER_NOTE } from '../pages/Newcomers';
import { TOPIC_CARDS } from '../pages/Topic';
import { LABELS, labelColor, toneColor } from '../theme';
import { go, Panel, Period } from './ui';

const TOOLTIP = {
  contentStyle: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e2e8f0' },
  itemStyle: { color: '#cbd5e1' },
};

/** Reports return names; find the node they refer to. */
async function resolve(label: string, name: string): Promise<Ref | null> {
  const groups = await api.search(name);
  const nodes = groups.find((group) => group.label === label)?.nodes ?? [];
  return nodes.find((node) => node.title.toLowerCase() === name.toLowerCase()) ?? nodes[0] ?? null;
}

function useReport(name: string, limit: number, days: number) {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let stale = false;
    setRows(null);
    api
      .report(name, limit, days)
      .then((result) => !stale && setRows(result))
      .catch(() => !stale && setRows([]));
    return () => {
      stale = true;
    };
  }, [name, limit, days]);
  return rows;
}

const str = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const n = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));

function Table({
  rows,
  columns,
  onRow,
}: {
  rows: Row[] | null;
  columns: Array<{
    key: string;
    name: string;
    render?: (row: Row) => React.ReactNode;
    numeric?: boolean;
    /** Column width, e.g. '45%'; unset columns share what is left. */
    width?: string;
  }>;
  onRow?: (row: Row) => void;
}) {
  if (!rows) return <div className="spinner pad" />;
  if (rows.length === 0)
    return <div className="muted small pad">Nothing here yet. It fills in after your data is refreshed.</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              className={column.numeric ? 'num' : undefined}
              style={column.width ? { width: column.width } : undefined}
            >
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={JSON.stringify(row)} className={onRow ? 'clickable' : undefined} onClick={() => onRow?.(row)}>
            {columns.map((column) => (
              <td key={column.key} className={column.numeric ? 'num' : undefined}>
                {column.render
                  ? column.render(row)
                  : row[column.key] === null || row[column.key] === undefined
                    ? '–'
                    : str(row[column.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const SIGNAL_NAMES: Record<string, string> = {
  civility: 'Civility',
  warmth: 'Warmth',
  agreement: 'Agreement',
  helpfulness: 'Helpfulness',
};

export function healthColor(score: number): string {
  if (score >= 8) return '#34d399';
  if (score >= 6) return '#a3e635';
  if (score >= 4) return '#f59e0b';
  return '#f87171';
}

/** The 1 to 10 community health score and the four signals behind it. */
function HealthCard({ days }: { days: number }) {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    api
      .health(days)
      .then((result) => !stale && setData(result))
      .catch((err) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, [days]);
  if (error) return <div className="health error">Community health could not load: {error}</div>;
  if (!data)
    return (
      <div className="health">
        <div className="spinner" />
      </div>
    );
  if (data.score === null) {
    return (
      <div className="health muted">
        Community health needs the AI classifier's assessments, which are not available yet. See the README to turn them
        on.
      </div>
    );
  }
  const color = healthColor(data.score);
  return (
    <section className="health">
      <div className="health-score">
        <div
          className="health-ring"
          style={{ background: `conic-gradient(${color} ${data.score * 36}deg, #1e293b 0)` }}
        >
          <div>
            <b style={{ color }}>{data.score.toFixed(1)}</b>
            <span className="muted small">of 10</span>
          </div>
        </div>
        <b>Community health</b>
        <span style={{ color }}>{data.label}</span>
      </div>
      <div className="health-signals">
        {Object.entries(data.signals).map(([name, signal]) => {
          const raw =
            signal.raw === null
              ? 'n/a'
              : name === 'warmth'
                ? `tone ${Math.round(signal.raw * 100)}`
                : `${Math.round(signal.raw * 100)}%`;
          const value = signal.value ?? 0;
          return (
            <button
              key={name}
              type="button"
              className="health-signal"
              title="See what is behind this signal"
              onClick={() => go(`health/${name}`)}
            >
              <span>
                {SIGNAL_NAMES[name] ?? name} <span className="stat-go">→</span>
              </span>
              <span className="gauge-track">
                <span
                  className="gauge-fill"
                  style={{ width: `${value * 100}%`, background: healthColor(1 + 9 * value) }}
                />
              </span>
              <span className="muted small">
                {signal.value === null ? 'no data' : `${(value * 10).toFixed(1)} · ${raw}`}
              </span>
              <small>{signal.describe}</small>
            </button>
          );
        })}
      </div>
      <details>
        <summary>How the score is computed</summary>
        Each signal maps its rate onto 0 to 10 between a worst and a best anchor: civility from 25% hostile (0) to none
        (10), warmth from tone 35 (0) to 65 (10), agreement from half of comments disagreeing (0) to none (10), and
        helpfulness from half of questions answered (0) to all (10). The score is 1 + 9 × the weighted mean, with
        weights civility 35%, warmth 25%, helpfulness 25%, agreement 15%. Bands: 8+ healthy, 6+ mostly healthy, 4+
        strained, below 4 toxic. Based on {data.basis.posts.toLocaleString()} posts,{' '}
        {data.basis.comments.toLocaleString()} comments, and {data.basis.questions} questions in this period, as
        assessed by the AI classifier.
      </details>
    </section>
  );
}

/** Where each count card leads. */
const DRILL: Record<string, string> = {
  User: 'people',
  Post: 'posts',
  Comment: 'comments',
  Neighborhood: 'neighborhoods',
  Business: 'businesses',
  Theme: 'themes',
  InterestGroup: 'groups',
};

/** Overview panel: joins per week and the neighborhoods they joined. */
function NewcomersPreview({ days }: { days: number }) {
  const [data, setData] = useState<Newcomers | null>(null);
  useEffect(() => {
    let stale = false;
    setData(null);
    api
      .newcomers(days)
      .then((result) => !stale && setData(result))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [days]);
  if (!data) return <div className="spinner pad" />;
  if (data.kpis.joins === 0) return <div className="muted small pad">No join announcements seen in this period.</div>;
  return (
    <div className="newcomers-preview">
      <div>
        <div className="mini-kpis">
          <span>
            <b>{data.kpis.joins}</b> joined
          </span>
          <span>
            <b>{data.kpis.last30}</b> in the last 30 days ({data.kpis.prior30} before)
          </span>
        </div>
        <JoinsChart data={data} height={190} />
      </div>
      <div>
        <div className="muted small">Where</div>
        <ul className="shortlist">
          {data.neighborhoods.slice(0, 6).map((row) => (
            <li key={str(row.name)}>
              <button type="button" onClick={() => go('newcomers')}>
                <span className="shortlist-name">{str(row.name)}</span>
                <span className="shortlist-metric">{str(row.joins)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="muted small">{NEWCOMER_NOTE}</div>
      </div>
    </div>
  );
}

export function Dashboard({
  days,
  onDays,
  onPick,
}: {
  days: number;
  onDays: (days: number) => void;
  onPick: (ref: Ref) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sentiment = useReport('sentiment', 52, days);
  const themes = useReport('themes', 30, days);
  const influencers = useReport('influencers', 10, days);
  const conversations = useReport('conversations', 10, days);
  const businesses = useReport('businesses', 10, days);
  const neighborhoods = useReport('neighborhoods', 14, days);
  const removed = useReport('removed', 8, days);
  const topPosts = useReport('top-posts', 14, days);

  /** Topic cards show the same count as their screens (which skip join announcements). */
  const [topicCounts, setTopicCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let stale = false;
    setTopicCounts({});
    for (const card of TOPIC_CARDS) {
      api
        .topic(card.key, days)
        .then((report) => !stale && setTopicCounts((current) => ({ ...current, [card.key]: report.kpis.posts })))
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
  }, [days]);

  useEffect(() => {
    api
      .overview()
      .then(setOverview)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  /** Reports name things; find the node and open it (businesses get their own page). */
  const openByName = (label: string, name: unknown) => {
    if (!name) return;
    void resolve(label, String(name)).then((ref) => {
      if (!ref) return;
      if (label === 'Business') go(`business/${encodeURIComponent(ref.key)}`);
      else onPick(ref);
    });
  };

  const weeks = sentiment ? [...sentiment].reverse().map((row) => ({ ...row, week: str(row.week).slice(0, 10) })) : [];

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div>
          <h1>Your community</h1>
          <div className="muted small">
            {overview?.lastSync ? `Last sync ${new Date(overview.lastSync).toLocaleString()}` : 'No sync recorded'} ·
            nothing here calls Nextdoor
          </div>
        </div>
        <Period days={days} onDays={onDays} />
      </div>
      {error && <div className="error pad">{error}</div>}
      <HealthCard days={days} />
      <div className="stats">
        {overview &&
          ['User', 'Post', 'Comment', 'Neighborhood', 'Business', 'Theme', 'InterestGroup'].map((label) => (
            <button
              key={label}
              type="button"
              className="stat clickable"
              title={`Explore ${(LABELS[label]?.plural ?? label).toLowerCase()}`}
              style={{ '--accent': labelColor(label) } as React.CSSProperties}
              onClick={() => go(DRILL[label])}
            >
              <b>{(overview.counts[label] ?? 0).toLocaleString()}</b>
              <span>
                {LABELS[label]?.plural ?? label} <span className="stat-go">→</span>
              </span>
            </button>
          ))}
        {overview &&
          TOPIC_CARDS.map((card) => {
            const count = topicCounts[card.key];
            return (
              <button
                key={card.key}
                type="button"
                className="stat clickable topic"
                title={`${card.name}: trends, kinds, neighborhoods, and posts`}
                style={{ '--accent': card.color } as React.CSSProperties}
                onClick={() => go(`topic/${card.key}`)}
              >
                <b>{count === undefined ? '–' : count.toLocaleString()}</b>
                <span>
                  {card.name} <span className="stat-go">→</span>
                </span>
              </button>
            );
          })}
      </div>
      <div className="grid">
        <Panel
          title="Mood over time"
          hint="by week"
          action={{ label: 'Tone details', onClick: () => go('health/warmth') }}
        >
          <div className="chart">
            <ResponsiveContainer width="100%" height={430}>
              <ComposedChart data={weeks} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis dataKey="week" tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={24} />
                <YAxis yAxisId="left" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip {...TOOLTIP} />
                <Legend
                  verticalAlign="bottom"
                  iconSize={10}
                  wrapperStyle={{ fontSize: 12, color: '#94a3b8', paddingTop: 10 }}
                />
                <Bar
                  yAxisId="left"
                  dataKey="posts"
                  name="Posts per week (left axis)"
                  fill="#1d4ed8"
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  yAxisId="right"
                  dataKey="postTone"
                  name="Post tone, 0 to 100, 50 = neutral (right axis)"
                  stroke="#34d399"
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  yAxisId="right"
                  dataKey="hostileCommentPct"
                  name="Hostile comments, % of the week's (right axis)"
                  stroke="#f87171"
                  dot={false}
                  strokeWidth={2}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="muted small chart-note">
            Each bar is one week. Volume reflects what ndoor has synced, which leans toward recent feeds, so older weeks
            look quieter than they were; tone and hostile share are rates and compare fairly across weeks.
          </p>
        </Panel>
        <Panel
          title="Themes"
          hint="built-in blue, discovered cyan · click for posts"
          action={{ label: 'All themes', onClick: () => go('themes') }}
        >
          <div className="chart">
            <ResponsiveContainer width="100%" height={Math.max(260, (themes?.length ?? 0) * 19)}>
              <BarChart data={themes ?? []} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="theme"
                  tickFormatter={(id: string) => themeLabel(id)}
                  width={232}
                  tick={{ fill: '#94a3b8', fontSize: 10.5 }}
                  interval={0}
                />
                <Tooltip {...TOOLTIP} labelFormatter={(id) => themeLabel(String(id))} />
                <Bar
                  dataKey="posts"
                  radius={[0, 4, 4, 0]}
                  cursor="pointer"
                  onClick={(entry) => go(`posts?theme=${encodeURIComponent(str((entry as unknown as Row).theme))}`)}
                >
                  {(themes ?? []).map((row) => (
                    <Cell key={str(row.theme)} fill={row.source === 'discovered' ? '#22d3ee' : '#3b82f6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Most reacted posts" action={{ label: 'All posts', onClick: () => go('posts?sort=reactions') }}>
          <Table
            rows={topPosts}
            onRow={(row) => openByName('Post', row.post)}
            columns={[
              {
                key: 'post',
                name: 'Post',
                width: '40%',
                render: (row) => (
                  <span className="clip" title={str(row.post)}>
                    {str(row.post)}
                  </span>
                ),
              },
              {
                key: 'author',
                name: 'Author',
                render: (row) => (
                  <span className="clip" title={str(row.author)}>
                    {str(row.author)}
                  </span>
                ),
              },
              { key: 'reactions', name: 'Reactions', numeric: true, width: '76px' },
              { key: 'comments', name: 'Comments', numeric: true, width: '80px' },
            ]}
          />
        </Panel>
        <Panel
          wide
          title="Influencers"
          hint="ranked by reactions + 3 × replies received"
          action={{ label: 'All people', onClick: () => go('people') }}
        >
          <Table
            rows={influencers}
            onRow={(row) => openByName('User', row.name)}
            columns={[
              { key: 'name', name: 'Person' },
              { key: 'neighborhood', name: 'Neighborhood' },
              {
                key: 'posts',
                name: 'Posts',
                numeric: true,
                // Until a sync reads someone's post history, only posts seen in feeds are known.
                render: (row) =>
                  row.historyRead ? (
                    str(row.posts)
                  ) : (
                    <span className="muted" title="Post history not read yet: at least this many">
                      {str(row.posts)}+
                    </span>
                  ),
              },
              { key: 'comments', name: 'Comments', numeric: true },
              { key: 'reactions', name: 'Reactions', numeric: true },
              { key: 'repliesReceived', name: 'Replies', numeric: true },
              { key: 'distinctRepliers', name: 'From people', numeric: true },
            ]}
          />
        </Panel>
        <Panel
          title="Who argues with whom"
          hint="replies and disagreements"
          action={{ label: 'Contested threads', onClick: () => go('health/agreement') }}
        >
          <Table
            rows={conversations}
            onRow={(row) => openByName('User', row.from)}
            columns={[
              { key: 'from', name: 'From' },
              { key: 'to', name: 'To' },
              { key: 'replies', name: 'Replies', numeric: true },
              {
                key: 'disagreements',
                name: 'Disagree',
                numeric: true,
                render: (row) => (
                  <span
                    style={{ color: n(row.disagreements) / Math.max(1, n(row.replies)) > 0.5 ? '#f87171' : undefined }}
                  >
                    {str(row.disagreements)}
                  </span>
                ),
              },
              {
                key: 'tone',
                name: 'Tone',
                numeric: true,
                render: (row) => <span style={{ color: toneColor(n(row.tone) / 100) }}>{str(row.tone)}</span>,
              },
            ]}
          />
        </Panel>
        <Panel
          title="Neighborhoods"
          hint="posts, colored by mood"
          action={{ label: 'All neighborhoods', onClick: () => go('neighborhoods') }}
        >
          <div className="chart">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={neighborhoods ?? []} margin={{ top: 8, right: 8, bottom: 40, left: -18 }}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="neighborhood"
                  tick={{ fill: '#94a3b8', fontSize: 10 }}
                  interval={0}
                  angle={-35}
                  textAnchor="end"
                />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip {...TOOLTIP} />
                <Bar
                  dataKey="posts"
                  radius={[3, 3, 0, 0]}
                  cursor="pointer"
                  onClick={(entry) => openByName('Neighborhood', (entry as unknown as Row).neighborhood)}
                >
                  {(neighborhoods ?? []).map((row) => (
                    <Cell key={str(row.neighborhood)} fill={toneColor(row.tone === null ? null : n(row.tone) / 100)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel
          title="Businesses neighbors mention"
          hint="people · favorable / unfavorable"
          action={{ label: 'Business analytics', onClick: () => go('businesses') }}
        >
          <Table
            rows={businesses}
            onRow={(row) => openByName('Business', row.business)}
            columns={[
              { key: 'business', name: 'Business' },
              { key: 'category', name: 'Category' },
              { key: 'people', name: 'People', numeric: true },
              {
                key: 'favorable',
                name: 'Liked',
                numeric: true,
                render: (row) =>
                  n(row.judged) ? (
                    <span
                      title={`${str(row.favorable)} favorable, ${str(row.unfavorable)} unfavorable of ${str(row.judged)} judged mentions`}
                    >
                      <span style={{ color: '#34d399' }}>{str(row.favorable)}</span>
                      <span className="muted"> / </span>
                      <span style={{ color: '#f87171' }}>{str(row.unfavorable)}</span>
                    </span>
                  ) : (
                    <span className="muted" title="Not assessed yet">
                      –
                    </span>
                  ),
              },
            ]}
          />
        </Panel>
        <Panel title="Removed content" hint="seen by ndoor, later gone">
          <Table
            rows={removed}
            onRow={(row) => openByName('User', row.name)}
            columns={[
              { key: 'name', name: 'Author' },
              { key: 'removedPosts', name: 'Posts', numeric: true },
              { key: 'removedComments', name: 'Comments', numeric: true },
              { key: 'removedPct', name: '% of theirs', numeric: true },
            ]}
          />
        </Panel>
        <Panel
          title="New neighbors"
          hint="people joining Nextdoor nearby"
          span2
          action={{ label: 'Details', onClick: () => go('newcomers') }}
        >
          <NewcomersPreview days={days} />
        </Panel>
      </div>
    </div>
  );
}
