import { useState } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type Row } from '../api';
import {
  Clip,
  DataTable,
  day,
  num,
  Page,
  type PageProps,
  Panel,
  SearchInput,
  SortSelect,
  str,
  TOOLTIP,
  Tone,
  useLoad,
} from '../components/ui';
import { stanceLabel } from '../labels';
import { STANCE_COLORS } from '../theme';

const SORTS = {
  recent: 'Most recent',
  reactions: 'Most reactions',
  hostile: 'Most hostile',
  helpful: 'Most helpful',
  coldest: 'Coldest',
};

export function Comments({ days, onDays, onSelect, selected }: PageProps) {
  const [sort, setSort] = useState('recent');
  const [q, setQ] = useState('');
  const [stance, setStance] = useState('');
  const { data, error } = useLoad(() => api.comments({ days, sort, q, stance }), [days, sort, q, stance]);
  return (
    <Page
      title="Comments"
      subtitle="Every comment in the period, with how it responds to what it answers"
      days={days}
      onDays={onDays}
      actions={
        <>
          <SearchInput placeholder="Search text" onChange={setQ} />
          <SortSelect value={sort} options={SORTS} onChange={setSort} />
        </>
      }
    >
      {error && <div className="error pad">{error}</div>}
      <div className="grid">
        <Panel wide title="How comments respond" hint="click a bar to filter">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data?.stances ?? []} layout="vertical" margin={{ left: 10, right: 20 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="stance"
                width={90}
                tickFormatter={(id: string) => stanceLabel(id)}
                tick={{ fill: '#94a3b8', fontSize: 12 }}
              />
              <Tooltip {...TOOLTIP} labelFormatter={(id) => stanceLabel(String(id))} />
              <Bar
                dataKey="comments"
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                onClick={(entry) => {
                  const value = str((entry as unknown as Row).stance);
                  setStance(stance === value ? '' : value);
                }}
              >
                {(data?.stances ?? []).map((row) => (
                  <Cell
                    key={str(row.stance)}
                    fill={STANCE_COLORS[str(row.stance)] ?? '#64748b'}
                    fillOpacity={!stance || stance === row.stance ? 1 : 0.3}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel
          wide
          title={`${data?.rows.length ?? '…'} comments${stance ? ` that ${stance.replace('_', ' ')}` : ''}`}
          hint={stance ? 'click the bar again to clear the filter' : 'click a comment to inspect it'}
        >
          <DataTable
            rows={data?.rows ?? null}
            rowKey={(row) => str(row.id)}
            selectedKey={selected?.key}
            onRow={(row: Row) => onSelect({ label: 'Comment', key: str(row.id), title: str(row.body) })}
            columns={[
              {
                key: 'body',
                name: 'Comment',
                width: '34%',
                render: (row) => (
                  <span className={row.removed ? 'removed-text' : undefined}>
                    <Clip text={row.body} />
                  </span>
                ),
              },
              { key: 'author', name: 'Author', render: (row) => <Clip text={row.author} /> },
              { key: 'post', name: 'On post', render: (row) => <Clip text={row.post} /> },
              {
                key: 'stance',
                name: 'Stance',
                render: (row) => (
                  <span style={{ color: STANCE_COLORS[str(row.stance)] }}>
                    {row.stance ? stanceLabel(str(row.stance)) : '–'}
                  </span>
                ),
              },
              { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
              {
                key: 'hostility',
                name: 'Hostility',
                numeric: true,
                render: (row) => (row.hostility === null ? '–' : num(row.hostility).toFixed(1)),
              },
              { key: 'reactions', name: 'Reactions', numeric: true },
              { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
            ]}
          />
        </Panel>
      </div>
    </Page>
  );
}
