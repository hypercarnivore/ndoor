import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type Row } from '../api';
import {
  Clip,
  DataTable,
  go,
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
import { themeLabel } from '../labels';
import { toneColor } from '../theme';

export function Neighborhoods({ days, onDays, onSelect, selected }: PageProps) {
  const { data, error } = useLoad(() => api.neighborhoods(days), [days]);
  const top = (data ?? []).filter((row) => num(row.posts) > 0).slice(0, 20);
  return (
    <Page title="Neighborhoods" subtitle="Where posts come from and where people live" days={days} onDays={onDays}>
      {error && <div className="error pad">{error}</div>}
      <div className="grid">
        <Panel wide title="Most active neighborhoods" hint="posts, colored by mood · click to see their posts">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={top} margin={{ top: 8, right: 8, bottom: 60, left: -10 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis
                dataKey="name"
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
                onClick={(entry) => go(`posts?hood=${encodeURIComponent(str((entry as unknown as Row).id))}`)}
              >
                {top.map((row) => (
                  <Cell key={str(row.id)} fill={toneColor(row.tone === null ? null : num(row.tone))} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel wide title="All neighborhoods" hint="click to inspect">
          <DataTable
            rows={data}
            rowKey={(row) => str(row.id)}
            selectedKey={selected?.key}
            onRow={(row) => onSelect({ label: 'Neighborhood', key: str(row.id), title: str(row.name) })}
            search={{ placeholder: 'Filter neighborhoods', fields: ['name', 'city'] }}
            columns={[
              { key: 'name', name: 'Neighborhood', width: '20%' },
              { key: 'city', name: 'City' },
              { key: 'neighbors', name: 'Members', numeric: true },
              { key: 'residents', name: 'Seen', numeric: true },
              { key: 'posts', name: 'Posts', numeric: true },
              { key: 'comments', name: 'Comments', numeric: true },
              { key: 'reactions', name: 'Reactions', numeric: true },
              { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
              { key: 'hostileShare', name: 'Hostile', numeric: true, render: (row) => pct(row.hostileShare) },
              {
                key: 'topTheme',
                name: 'Top theme',
                render: (row) => <Clip text={row.topTheme ? themeLabel(str(row.topTheme)) : '–'} />,
              },
            ]}
          />
        </Panel>
      </div>
    </Page>
  );
}

function Sparkline({ points }: { points: Row[] }) {
  if (points.length < 2) return <span className="muted small">–</span>;
  return (
    <ResponsiveContainer width="100%" height={26}>
      <LineChart data={points}>
        <Line dataKey="posts" stroke="#22d3ee" dot={false} strokeWidth={1.5} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function Themes({ days, onDays, onSelect }: PageProps) {
  const { data, error } = useLoad(() => api.themes(days), [days]);
  return (
    <Page
      title="Themes"
      subtitle="What posts are about, as sorted by the AI classifier, including themes discovered in this community"
      days={days}
      onDays={onDays}
    >
      {error && <div className="error pad">{error}</div>}
      <Panel wide title="All themes" hint="click a theme to see its posts">
        <DataTable
          rows={data}
          rowKey={(row) => str(row.name)}
          initialSort={{ key: 'posts', desc: true }}
          onRow={(row) => go(`posts?theme=${encodeURIComponent(str(row.name))}`)}
          search={{ placeholder: 'Filter themes', fields: ['name', 'description'] }}
          columns={[
            {
              key: 'name',
              name: 'Theme',
              width: '22%',
              sortValue: (row) => themeLabel(str(row.name)),
              render: (row) => (
                <Clip text={themeLabel(str(row.name))} title={row.description ?? themeLabel(str(row.name))} />
              ),
            },
            {
              key: 'source',
              name: 'Source',
              render: (row) => (row.source === 'discovered' ? 'Discovered here' : 'Built in'),
            },
            { key: 'posts', name: 'Posts', numeric: true },
            {
              key: 'avgReactions',
              name: 'Avg reactions',
              numeric: true,
              render: (row) => num(row.avgReactions).toFixed(1),
            },
            { key: 'comments', name: 'Comments', numeric: true },
            { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
            { key: 'hostileShare', name: 'Hostile', numeric: true, render: (row) => pct(row.hostileShare) },
            {
              key: 'weekly',
              name: 'Weekly trend',
              width: '18%',
              sortable: false,
              render: (row) => <Sparkline points={(row.weekly as Row[]) ?? []} />,
            },
            {
              key: 'explore',
              name: '',
              width: '70px',
              sortable: false,
              render: (row) => (
                <button
                  type="button"
                  className="link small"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect({ label: 'Theme', key: str(row.name) });
                  }}
                >
                  inspect
                </button>
              ),
            },
          ]}
        />
      </Panel>
    </Page>
  );
}

export function Groups({ days, onDays, onSelect, selected }: PageProps) {
  const { data, error } = useLoad(() => api.groups(days), [days]);
  return (
    <Page title="Groups" subtitle="Interest groups ndoor has seen" days={days} onDays={onDays}>
      {error && <div className="error pad">{error}</div>}
      <Panel wide title="All groups" hint="click to inspect">
        <DataTable
          rows={data}
          rowKey={(row) => str(row.id)}
          selectedKey={selected?.key}
          onRow={(row) => onSelect({ label: 'InterestGroup', key: str(row.id), title: str(row.name) })}
          columns={[
            { key: 'name', name: 'Group', width: '34%' },
            { key: 'members', name: 'Members', numeric: true },
            { key: 'joined', name: 'You', render: (row) => (row.joined ? 'member' : '') },
            { key: 'posts', name: 'Posts', numeric: true },
            { key: 'reactions', name: 'Reactions', numeric: true },
            { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
          ]}
        />
      </Panel>
    </Page>
  );
}
