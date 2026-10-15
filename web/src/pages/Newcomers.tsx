import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type Newcomers as NewcomersData, type Row } from '../api';
import { DataTable, day, Kpis, num, Page, type PageProps, Panel, str, TOOLTIP, useLoad } from '../components/ui';

export const NEWCOMER_NOTE =
  'From the "just joined" announcements in the feeds ndoor has read. A join means someone joined Nextdoor here; it often, but not always, means they moved in. Coverage grows with every sync.';

export function JoinsChart({ data, height = 220 }: { data: NewcomersData; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data.weekly} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#1e293b" vertical={false} />
        <XAxis dataKey="week" tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={24} />
        <YAxis allowDecimals={false} tick={{ fill: '#64748b', fontSize: 11 }} />
        <Tooltip {...TOOLTIP} />
        <Bar dataKey="joins" name="New neighbors" fill="#34d399" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Newcomers({ days, onDays, onSelect, selected }: PageProps) {
  const { data, error } = useLoad(() => api.newcomers(days), [days]);
  const k = data?.kpis;
  const trend = k ? k.last30 - k.prior30 : 0;
  return (
    <Page title="New neighbors" subtitle={NEWCOMER_NOTE} days={days} onDays={onDays}>
      {error && <div className="error pad">{error}</div>}
      {!data && !error && <div className="spinner pad" />}
      {data && k && (
        <>
          <Kpis
            items={[
              { label: 'Joined in this period', value: k.joins, color: '#34d399' },
              {
                label: 'Last 30 days',
                value: (
                  <span>
                    {k.last30}{' '}
                    <span className="small" style={{ color: trend === 0 ? '#94a3b8' : '#22d3ee' }}>
                      {trend > 0 ? '▲' : trend < 0 ? '▼' : '·'} {Math.abs(trend)}
                    </span>
                  </span>
                ),
                hint: `${k.prior30} in the 30 days before`,
                color: '#34d399',
              },
              { label: 'Neighborhoods', value: k.neighborhoods, color: '#34d399' },
              {
                label: 'Profiles with a move-in year',
                value: k.residentsWithYear,
                hint: 'from neighbor profiles sync has read',
                color: '#60a5fa',
              },
            ]}
          />
          <div className="grid">
            <Panel title="Joins per week">
              {data.weekly.length ? (
                <JoinsChart data={data} height={260} />
              ) : (
                <div className="muted small pad">None seen in this period.</div>
              )}
            </Panel>
            <Panel title="Where they joined" hint="joins, and per 1,000 Nextdoor members there">
              <DataTable
                rows={data.neighborhoods}
                rowKey={(row) => str(row.name)}
                initialSort={{ key: 'joins', desc: true }}
                pageSize={10}
                onRow={(row) => row.id && onSelect({ label: 'Neighborhood', key: str(row.id), title: str(row.name) })}
                columns={[
                  { key: 'name', name: 'Neighborhood', width: '40%' },
                  { key: 'joins', name: 'Joins', numeric: true },
                  {
                    key: 'perThousand',
                    name: 'Per 1,000',
                    numeric: true,
                    render: (row) => (row.perThousand === null ? '–' : num(row.perThousand).toFixed(1)),
                  },
                  { key: 'latest', name: 'Latest', numeric: true, render: (row) => day(row.latest) },
                ]}
              />
            </Panel>
            <Panel title="When residents moved in" hint="the move-in year neighbors list on their profiles">
              {data.residentSince.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.residentSince} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fill: '#64748b', fontSize: 11 }} />
                    <Tooltip {...TOOLTIP} />
                    <Bar dataKey="residents" name="Residents" fill="#60a5fa" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="muted small pad">No profiles with a move-in year yet; sync reads them gradually.</div>
              )}
            </Panel>
            <Panel wide title="Recent joins" hint="click a person to inspect">
              <DataTable
                rows={data.recent}
                rowKey={(row: Row) => str(row.id)}
                selectedKey={selected?.key}
                onRow={(row) => onSelect({ label: 'User', key: str(row.userId), title: str(row.name) })}
                columns={[
                  { key: 'name', name: 'Neighbor', width: '40%' },
                  { key: 'neighborhood', name: 'Neighborhood' },
                  { key: 'at', name: 'Joined', numeric: true, render: (row) => day(row.at) },
                ]}
              />
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}
