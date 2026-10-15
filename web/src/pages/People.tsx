import { useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { api, type Row } from '../api';
import {
  DataTable,
  num,
  Page,
  type PageProps,
  Panel,
  pct,
  SearchInput,
  SortSelect,
  str,
  TOOLTIP,
  Tone,
  useLoad,
} from '../components/ui';
import { toneColor } from '../theme';

const SORTS = {
  influence: 'Influence (reactions + 3 × replies)',
  reactions: 'Reactions',
  posts: 'Posts',
  comments: 'Comments',
  warmest: 'Warmest tone',
  coldest: 'Coldest tone',
  hostile: 'Most hostile',
  contrarian: 'Most contrarian',
};

export function People({ days, onDays, onSelect, selected }: PageProps) {
  const [sort, setSort] = useState('influence');
  const [q, setQ] = useState('');
  const { data, error } = useLoad(() => api.people({ days, sort, q }), [days, sort, q]);
  const select = (row: Row) => onSelect({ label: 'User', key: str(row.id), title: str(row.name) });
  const points = (data ?? [])
    .filter((row) => row.tone !== null)
    .map((row) => ({ ...row, activity: num(row.posts) + num(row.comments), tone100: Math.round(num(row.tone) * 100) }));

  return (
    <Page
      title="People"
      subtitle="Everyone who posted or commented in the period"
      days={days}
      onDays={onDays}
      actions={
        <>
          <SearchInput placeholder="Find a person" onChange={setQ} />
          <SortSelect value={sort} options={SORTS} onChange={setSort} />
        </>
      }
    >
      {error && <div className="error pad">{error}</div>}
      <div className="grid">
        <Panel
          wide
          title="Tone and reach"
          hint="each dot is a person: activity (log scale) against mean tone · click to inspect"
        >
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: -10 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis
                dataKey="activity"
                name="posts + comments"
                type="number"
                scale="log"
                domain={[1, 'auto']}
                tick={{ fill: '#64748b', fontSize: 11 }}
              />
              <YAxis
                dataKey="tone100"
                name="tone"
                type="number"
                domain={[0, 100]}
                tick={{ fill: '#64748b', fontSize: 11 }}
              />
              <ZAxis dataKey="reactions" range={[20, 400]} name="reactions" />
              <Tooltip
                {...TOOLTIP}
                cursor={{ stroke: '#334155' }}
                content={({ payload }) => {
                  const row = payload?.[0]?.payload as Row | undefined;
                  if (!row) return null;
                  return (
                    <div className="tip-box">
                      <b>{str(row.name)}</b>
                      <div>
                        {str(row.posts)} posts · {str(row.comments)} comments · {str(row.reactions)} reactions
                      </div>
                      <div>
                        tone {str(row.tone100)} · {pct(row.hostileShare)} hostile
                      </div>
                    </div>
                  );
                }}
              />
              <Scatter
                data={points}
                cursor="pointer"
                onClick={(point) => select(point as unknown as Row)}
                shape={(props: { cx?: number; cy?: number; size?: number; payload?: Row }) => (
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={Math.sqrt(props.size ?? 20) / 2}
                    fill={toneColor(num(props.payload?.tone))}
                    fillOpacity={selected?.key === props.payload?.id ? 1 : 0.55}
                    stroke={selected?.key === props.payload?.id ? '#fff' : 'none'}
                  />
                )}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </Panel>
        <Panel wide title="Directory" hint="click a person to inspect; click a column to sort">
          <DataTable
            rows={data}
            rowKey={(row) => str(row.id)}
            selectedKey={selected?.key}
            onRow={select}
            columns={[
              { key: 'name', name: 'Person', width: '18%' },
              { key: 'neighborhood', name: 'Neighborhood', width: '16%' },
              {
                key: 'posts',
                name: 'Posts',
                numeric: true,
                render: (row) =>
                  row.historyRead ? (
                    str(row.posts)
                  ) : (
                    <span className="muted" title="Post history not read yet">
                      {str(row.posts)}+
                    </span>
                  ),
              },
              { key: 'comments', name: 'Comments', numeric: true },
              { key: 'reactions', name: 'Reactions', numeric: true },
              { key: 'repliesReceived', name: 'Replies', numeric: true },
              { key: 'repliers', name: 'From people', numeric: true },
              { key: 'helpful', name: 'Helpful', numeric: true },
              { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
              { key: 'hostileShare', name: 'Hostile', numeric: true, render: (row) => pct(row.hostileShare) },
              { key: 'disagreeShare', name: 'Disagrees', numeric: true, render: (row) => pct(row.disagreeShare) },
            ]}
          />
        </Panel>
      </div>
    </Page>
  );
}
