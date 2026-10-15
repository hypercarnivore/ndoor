import { useMemo, useState } from 'react';
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
import { api, type Row } from '../api';
import {
  Clip,
  DataTable,
  day,
  Kpis,
  num,
  Page,
  type PageProps,
  Panel,
  pct,
  str,
  TOOLTIP,
  Tone,
  useLoad,
} from '../components/ui';
import { toneColor } from '../theme';

/** Topic screens reachable from the overview, with their accent colors. */
export const TOPIC_CARDS = [
  { key: 'safety', name: 'Crime & safety', theme: 'crime_safety', color: '#f87171', moreIsWorse: true },
  { key: 'schools', name: 'Schools & education', theme: 'schools_youth', color: '#facc15', moreIsWorse: false },
];

const CAVEATS: Record<string, string> = {
  safety:
    'These are posts by neighbors and local agencies that an AI classifier judged to be about crime or safety. They show what the community reports and talks about, not official crime statistics: some incidents are never posted, some are posted many times, and posting habits differ between neighborhoods.',
  schools:
    'These are posts by neighbors and local agencies that an AI classifier judged to be about schools, children, or youth. They show what the community discusses, not official school data.',
};

/** Rising is red only where more posts mean more trouble. */
function trendColor(trend: number, moreIsWorse: boolean): string {
  if (trend === 0) return '#94a3b8';
  if (!moreIsWorse) return '#22d3ee';
  return trend > 0 ? '#f87171' : '#34d399';
}

/** Below this many posts from a neighborhood, its share is too noisy to compare. */
const MIN_HOOD_POSTS = 10;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** When posts come in: day of week by hour, in this browser's time zone. */
function Heatmap({ posts }: { posts: Row[] }) {
  const grid = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const row of posts) {
      const at = new Date(str(row.at));
      if (Number.isNaN(at.getTime())) continue;
      cells[(at.getDay() + 6) % 7][at.getHours()] += 1;
    }
    return cells;
  }, [posts]);
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="heatmap">
      <div className="heatmap-row heatmap-hours">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: hours are fixed positions.
          <span key={hour}>{hour % 3 === 0 ? hour : ''}</span>
        ))}
      </div>
      {grid.map((hours, weekday) => (
        <div key={DAYS[weekday]} className="heatmap-row">
          <span className="heatmap-day">{DAYS[weekday]}</span>
          {hours.map((count, hour) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: hours are fixed positions.
              key={hour}
              className="heatmap-cell"
              title={`${DAYS[weekday]} ${hour}:00 · ${count} posts`}
              style={{ opacity: count ? 0.15 + (0.85 * count) / max : 0.06 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Topic({ days, onDays, onSelect, selected, topic }: PageProps & { topic: string }) {
  const { data, error } = useLoad(() => api.topic(topic, days), [topic, days]);
  const [kind, setKind] = useState('');
  const [hood, setHood] = useState('');
  /** Neighborhoods by where things happened (default), or by where the people posting live. */
  const [placeMode, setPlaceMode] = useState<'incident' | 'poster'>('incident');
  const [bucket, setBucket] = useState('');
  const card = TOPIC_CARDS.find((entry) => entry.key === topic);
  const color = card?.color ?? '#22d3ee';
  const posts = (data?.posts ?? []).filter(
    (row) =>
      (!kind || (kind === 'Other' ? (row.kinds as string[]).length === 0 : (row.kinds as string[]).includes(kind))) &&
      (!hood || (placeMode === 'incident' ? row.placeHoodId : row.hoodId) === hood) &&
      (!bucket || row.placeBucket === bucket),
  );
  const k = data?.kpis;
  const trend = k ? k.last30 - k.prior30 : 0;
  const weekly = (data?.weekly ?? []).map((row) => ({ ...row, sharePct: Math.round(num(row.share) * 1000) / 10 }));
  const hoodName = [...(data?.incidentNeighborhoods ?? []), ...(data?.neighborhoods ?? [])].find(
    (row) => row.id === hood,
  )?.name;
  const bucketName = data?.placeBuckets.find((row) => row.key === bucket)?.name;
  const placeLabel = (row: Row) =>
    row.placeName ? str(row.placeName) : (data?.placeBuckets.find((b) => b.key === row.placeBucket)?.name ?? '');

  return (
    <Page title={data?.title ?? card?.name ?? 'Topic'} subtitle={CAVEATS[topic]} days={days} onDays={onDays}>
      {error && <div className="error pad">{error}</div>}
      {!data && !error && <div className="spinner pad" />}
      {data && k && (
        <>
          <Kpis
            items={[
              { label: 'Posts', value: k.posts.toLocaleString(), color },
              { label: 'Share of all posts', value: pct(k.share), color },
              {
                label: 'Last 30 days',
                value: (
                  <span>
                    {k.last30}{' '}
                    <span className="small" style={{ color: trendColor(trend, card?.moreIsWorse ?? false) }}>
                      {trend > 0 ? '▲' : trend < 0 ? '▼' : '·'} {Math.abs(trend)}
                    </span>
                  </span>
                ),
                hint: `${k.prior30} in the 30 days before`,
                color,
              },
              {
                label: 'Urgent posts',
                value: k.urgent,
                hint: 'judged time-sensitive (today or right now)',
                color: '#fb923c',
              },
              {
                label: 'From agencies',
                value: k.fromAgencies,
                hint: 'posted by official agency accounts',
                color: '#f87171',
              },
              { label: 'Mean tone', value: <Tone value={k.tone} />, hint: '50 is neutral', color: toneColor(k.tone) },
              {
                label: 'Local incidents',
                value: k.local,
                hint: 'posts about a specific situation in the local area, as opposed to general advice or news from elsewhere',
                color,
              },
              { label: 'Comments', value: k.comments.toLocaleString(), color: '#a78bfa' },
            ]}
          />
          {k.excluded > 0 && data.excludedReason && (
            <div className="muted small note">
              Left out: {k.excluded} posts about {data.excludedReason}, which say little about how safe the area is.
              Posts that also involve theft, scams, suspicious activity, violence, or drugs stay in.
            </div>
          )}
          <div className="grid">
            <Panel title="Over time" hint="posts per week, and their share of all posts">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={weekly} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="week" tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={24} />
                  <YAxis yAxisId="left" allowDecimals={false} tick={{ fill: '#64748b', fontSize: 11 }} />
                  <YAxis yAxisId="right" orientation="right" unit="%" tick={{ fill: '#64748b', fontSize: 11 }} />
                  <Tooltip {...TOOLTIP} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                  <Bar
                    yAxisId="left"
                    dataKey="posts"
                    name="Posts (left axis)"
                    fill={color}
                    fillOpacity={0.8}
                    radius={[3, 3, 0, 0]}
                  />
                  <Line
                    yAxisId="right"
                    dataKey="sharePct"
                    name="Share of all posts, % (right axis)"
                    stroke="#e2e8f0"
                    dot={false}
                    strokeWidth={1.5}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="Kinds of posts" hint="by keywords in the text; a post can be several kinds · click to filter">
              <ResponsiveContainer width="100%" height={Math.max(280, data.kindCounts.length * 24)}>
                <BarChart data={data.kindCounts} layout="vertical" margin={{ left: 0, right: 16 }}>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="kind"
                    width={190}
                    tick={{ fill: '#94a3b8', fontSize: 11 }}
                    interval={0}
                  />
                  <Tooltip {...TOOLTIP} />
                  <Bar
                    dataKey="posts"
                    radius={[0, 4, 4, 0]}
                    cursor="pointer"
                    onClick={(entry) => {
                      const value = str((entry as unknown as Row).kind);
                      setKind(kind === value ? '' : value);
                    }}
                  >
                    {data.kindCounts.map((row) => (
                      <Cell key={str(row.kind)} fill={color} fillOpacity={!kind || kind === row.kind ? 0.85 : 0.25} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="When posts come in" hint="day and hour, in your time zone">
              <div style={{ '--accent': color } as React.CSSProperties}>
                <Heatmap posts={data.posts} />
              </div>
              <div className="muted small">
                Darker cells had more posts. Posting time is not always when something happened.
              </div>
            </Panel>
            <Panel
              wide
              title={placeMode === 'incident' ? 'Where it happened' : 'Where the people posting live'}
              hint={
                placeMode === 'incident'
                  ? "where each post's situation is, as judged by the AI classifier; a neighborhood named in the text says which one · click to filter"
                  : `the poster's home neighborhood, which is not where things happened · share of their posts (* fewer than ${MIN_HOOD_POSTS} posts seen there)`
              }
            >
              <div className="where-controls">
                <div className="segmented small">
                  <button
                    type="button"
                    className={placeMode === 'incident' ? 'active' : undefined}
                    onClick={() => {
                      setPlaceMode('incident');
                      setHood('');
                    }}
                  >
                    Where it happened
                  </button>
                  <button
                    type="button"
                    className={placeMode === 'poster' ? 'active' : undefined}
                    onClick={() => {
                      setPlaceMode('poster');
                      setHood('');
                      setBucket('');
                    }}
                  >
                    Where posters live
                  </button>
                </div>
                {placeMode === 'incident' && (
                  <div className="chips">
                    {data.placeBuckets
                      .filter((row) => row.posts > 0)
                      .map((row) => (
                        <button
                          key={row.key}
                          type="button"
                          className={bucket === row.key ? 'chip' : 'chip off-soft'}
                          style={{ '--accent': color } as React.CSSProperties}
                          onClick={() => setBucket(bucket === row.key ? '' : row.key)}
                        >
                          {row.name} {row.posts}
                        </button>
                      ))}
                  </div>
                )}
              </div>
              {placeMode === 'incident' ? (
                data.incidentNeighborhoods.length === 0 ? (
                  <div className="muted small pad">
                    No post in this period could be placed in a specific neighborhood
                    {data.placeBuckets.find((row) => row.key === 'unjudged')?.posts
                      ? '; some are not assessed yet'
                      : ''}
                    .
                  </div>
                ) : (
                  <DataTable
                    rows={data.incidentNeighborhoods}
                    rowKey={(row) => str(row.id)}
                    selectedKey={hood}
                    initialSort={{ key: 'posts', desc: true }}
                    pageSize={12}
                    onRow={(row) => setHood(hood === row.id ? '' : str(row.id))}
                    columns={[
                      { key: 'name', name: 'Neighborhood', width: '34%' },
                      { key: 'posts', name: 'Incidents', numeric: true },
                      { key: 'members', name: 'Members', numeric: true },
                      {
                        key: 'perThousand',
                        name: 'Per 1,000 members',
                        numeric: true,
                        render: (row) => (row.perThousand === null ? '–' : num(row.perThousand).toFixed(1)),
                      },
                      { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
                    ]}
                  />
                )
              ) : (
                <DataTable
                  rows={data.neighborhoods}
                  rowKey={(row) => str(row.id)}
                  selectedKey={hood}
                  initialSort={{ key: 'posts', desc: true }}
                  pageSize={12}
                  onRow={(row) => setHood(hood === row.id ? '' : str(row.id))}
                  columns={[
                    { key: 'name', name: 'Neighborhood', width: '28%' },
                    { key: 'posts', name: 'Posts', numeric: true },
                    { key: 'allPosts', name: 'Of all posts', numeric: true },
                    {
                      key: 'share',
                      name: 'Share',
                      numeric: true,
                      // Few posts seen from a neighborhood make its share noisy (1 of 1 is "100%").
                      sortValue: (row) => (num(row.allPosts) >= MIN_HOOD_POSTS ? num(row.share) : null),
                      render: (row) =>
                        num(row.allPosts) < MIN_HOOD_POSTS ? (
                          <span className="muted" title={`Only ${str(row.allPosts)} posts seen from this neighborhood`}>
                            {pct(row.share)}*
                          </span>
                        ) : (
                          <span className="bar-cell">
                            <span style={{ width: `${Math.min(100, num(row.share) * 300)}%`, background: color }} />
                            {pct(row.share)}
                          </span>
                        ),
                    },
                    { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
                  ]}
                />
              )}
            </Panel>
            <Panel title="Who posts it" hint="neighbors, agencies, and pages">
              <div className="chips">
                {data.sources.map((row) => (
                  <span key={str(row.source)} className="chip static">
                    {str(row.source)} {str(row.posts)}
                  </span>
                ))}
              </div>
              <DataTable
                rows={data.accounts}
                rowKey={(row) => str(row.id)}
                pageSize={10}
                onRow={(row) => onSelect({ label: 'User', key: str(row.id), title: str(row.name) })}
                columns={[
                  { key: 'name', name: 'Account', width: '50%', render: (row) => <Clip text={row.name} /> },
                  { key: 'source', name: 'Type' },
                  { key: 'posts', name: 'Posts', numeric: true },
                ]}
              />
            </Panel>
            <Panel title="Most discussed" hint="by comments">
              <DataTable
                rows={data.mostDiscussed}
                rowKey={(row) => str(row.id)}
                pageSize={10}
                onRow={(row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject || row.body) })}
                columns={[
                  {
                    key: 'subject',
                    name: 'Post',
                    width: '62%',
                    render: (row) => <Clip text={row.subject || row.body} />,
                  },
                  { key: 'comments', name: 'Comments', numeric: true },
                  { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
                ]}
              />
            </Panel>
            <Panel
              wide
              title={`${posts.length} posts${kind ? ` · ${kind}` : ''}${hoodName ? ` · ${str(hoodName)}` : ''}${bucketName ? ` · ${bucketName}` : ''}`}
              hint="click a post to read it and its comments"
            >
              {(kind || hood || bucket) && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => {
                    setKind('');
                    setHood('');
                    setBucket('');
                  }}
                >
                  clear filters
                </button>
              )}
              <DataTable
                rows={posts}
                rowKey={(row) => str(row.id)}
                selectedKey={selected?.key}
                search={{ placeholder: 'Search these posts', fields: ['subject', 'body', 'author', 'neighborhood'] }}
                onRow={(row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject || row.body) })}
                columns={[
                  {
                    key: 'subject',
                    name: 'Post',
                    width: '34%',
                    render: (row) => <Clip text={row.subject || row.body} title={row.body} />,
                  },
                  {
                    key: 'kinds',
                    name: 'Kind',
                    sortable: false,
                    render: (row) => <Clip text={(row.kinds as string[]).join(', ') || 'Other'} />,
                  },
                  {
                    key: 'place',
                    name: 'Where it happened',
                    sortValue: placeLabel,
                    render: (row) => <Clip text={placeLabel(row)} />,
                  },
                  {
                    key: 'neighborhood',
                    name: "Poster's neighborhood",
                    render: (row) => <Clip text={row.neighborhood} />,
                  },
                  { key: 'author', name: 'Author', render: (row) => <Clip text={row.author} /> },
                  { key: 'comments', name: 'Comments', numeric: true },
                  {
                    key: 'urgency',
                    name: 'Urgency',
                    numeric: true,
                    render: (row) => (row.urgency === null ? '–' : num(row.urgency).toFixed(1)),
                  },
                  { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
                ]}
              />
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}
