import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type Row } from '../api';
import {
  Clip,
  DataTable,
  day,
  go,
  Kpis,
  Net,
  num,
  OpinionBar,
  Page,
  type PageProps,
  Panel,
  pct,
  str,
  TOOLTIP,
  useLoad,
} from '../components/ui';

const open = (row: Row) => go(`business/${encodeURIComponent(str(row.id))}`);

/** Compact business list for the standout panels. */
function Shortlist({ rows, metric }: { rows: Row[]; metric: (row: Row) => React.ReactNode }) {
  if (rows.length === 0) return <div className="muted small pad">None yet in this period.</div>;
  return (
    <ul className="shortlist">
      {rows.map((row) => (
        <li key={str(row.id)}>
          <button type="button" onClick={() => open(row)}>
            <span className="shortlist-name">{str(row.name)}</span>
            <span className="muted small">{str(row.category) || 'no category yet'}</span>
            <span className="shortlist-metric">{metric(row)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Businesses({ days, onDays, onSelect }: PageProps) {
  const summary = useLoad(() => api.businessSummary(days), [days]);
  const list = useLoad(() => api.businesses(days), [days]);
  const [category, setCategory] = useState('');
  const rows = useMemo(
    () => (list.data ?? []).filter((row) => !category || str(row.category || 'Uncategorized') === category),
    [list.data, category],
  );
  const kpis = summary.data?.kpis;
  const demand = summary.data?.demand;
  const weekly = (summary.data?.weekly ?? []).map((row) => ({
    ...row,
    week: day(row.week),
    other: num(row.mentions) - num(row.favorable) - num(row.unfavorable),
  }));
  const categories = (summary.data?.categories ?? []).slice(0, 14);

  return (
    <Page
      title="Businesses"
      subtitle="Every business neighbors @mention: how they talk about it, what is rising, and what people are asking for"
      days={days}
      onDays={onDays}
    >
      {(summary.error || list.error) && <div className="error pad">{summary.error ?? list.error}</div>}
      {kpis && (
        <Kpis
          items={[
            { label: 'Businesses mentioned', value: kpis.businesses.toLocaleString(), color: '#f472b6' },
            { label: 'Mentions', value: kpis.mentions.toLocaleString(), color: '#f472b6' },
            { label: 'People mentioning', value: kpis.people.toLocaleString(), color: '#60a5fa' },
            {
              label: 'Favorable',
              value: kpis.judged ? pct(kpis.favorable / kpis.judged) : '–',
              hint: `${kpis.favorable} of ${kpis.judged} judged mentions`,
              color: '#34d399',
            },
            {
              label: 'Unfavorable',
              value: kpis.judged ? pct(kpis.unfavorable / kpis.judged) : '–',
              hint: `${kpis.unfavorable} of ${kpis.judged} judged mentions`,
              color: '#f87171',
            },
            {
              label: 'Requests answered',
              value: demand?.loaded ? pct(demand.answered / demand.loaded) : '–',
              hint: 'recommendation requests whose replies named at least one business',
              color: '#f59e0b',
            },
          ]}
        />
      )}
      <div className="grid">
        <Panel title="Mentions per week" hint="favorable, other, and unfavorable mentions">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={weekly} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="week" tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={24} />
              <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
              <Tooltip {...TOOLTIP} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
              <Bar dataKey="favorable" name="Favorable" stackId="m" fill="#34d399" />
              <Bar dataKey="other" name="Neutral or not judged" stackId="m" fill="#475569" />
              <Bar dataKey="unfavorable" name="Unfavorable" stackId="m" fill="#f87171" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel
          title="Sentiment by category"
          hint={
            summary.data?.uncategorized
              ? `${summary.data.uncategorized} businesses have no category until sync reads their profile · click to filter`
              : 'click to filter the table'
          }
        >
          <ResponsiveContainer width="100%" height={Math.max(260, categories.length * 22)}>
            <BarChart data={categories} layout="vertical" margin={{ left: 0, right: 12 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="category"
                width={170}
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                interval={0}
              />
              <Tooltip {...TOOLTIP} />
              {(['favorable', 'neutral', 'unfavorable'] as const).map((key) => (
                <Bar
                  key={key}
                  dataKey={key}
                  stackId="c"
                  fill={{ favorable: '#34d399', neutral: '#475569', unfavorable: '#f87171' }[key]}
                  cursor="pointer"
                  onClick={(entry) => {
                    const value = str((entry as unknown as Row).category);
                    setCategory(category === value ? '' : value);
                  }}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Most loved" hint="at least 3 judged mentions, mostly favorable">
          <Shortlist
            rows={summary.data?.loved ?? []}
            metric={(row) => (
              <span style={{ color: '#34d399' }}>{pct(num(row.favorable) / num(row.judged))} favorable</span>
            )}
          />
        </Panel>
        <Panel title="Needs attention" hint="30% or more of judged mentions unfavorable">
          <Shortlist
            rows={summary.data?.attention ?? []}
            metric={(row) => (
              <span style={{ color: '#f87171' }}>
                {str(row.unfavorable)} of {str(row.judged)} unfavorable
              </span>
            )}
          />
        </Panel>
        <Panel title="Rising" hint="more mentions in the last 30 days than the 30 before">
          <Shortlist
            rows={summary.data?.rising ?? []}
            metric={(row) => (
              <span style={{ color: '#22d3ee' }}>
                {str(row.prior30)} → {str(row.last30)}
              </span>
            )}
          />
        </Panel>
        <Panel
          title="Demand: requests for recommendations"
          hint={
            demand
              ? `${demand.requests} requests · ${demand.answered} of ${demand.loaded} loaded threads got a business named`
              : undefined
          }
        >
          <div className="muted small">
            Unanswered: nobody named a business in reply (as far as ndoor has loaded the thread).
          </div>
          <DataTable
            rows={demand?.unanswered ?? null}
            rowKey={(row) => str(row.id)}
            pageSize={10}
            onRow={(row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject) })}
            columns={[
              { key: 'subject', name: 'Request', width: '60%', render: (row) => <Clip text={row.subject} /> },
              { key: 'comments', name: 'Replies', numeric: true },
              { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
            ]}
          />
        </Panel>
        <Panel
          wide
          title={category ? `Businesses in ${category}` : 'All businesses'}
          hint="click a business for its full page"
        >
          {category && (
            <button type="button" className="link small" onClick={() => setCategory('')}>
              clear category filter
            </button>
          )}
          <DataTable
            rows={list.data ? rows : null}
            rowKey={(row) => str(row.id)}
            onRow={open}
            initialSort={{ key: 'people', desc: true }}
            search={{ placeholder: 'Filter businesses', fields: ['name', 'category', 'address'] }}
            columns={[
              {
                key: 'name',
                name: 'Business',
                width: '20%',
                render: (row) => <Clip text={row.name} title={row.address ?? row.name} />,
              },
              { key: 'category', name: 'Category', render: (row) => <Clip text={row.category || '–'} /> },
              { key: 'people', name: 'People', numeric: true },
              { key: 'mentions', name: 'Mentions', numeric: true },
              {
                key: 'opinion',
                name: 'Opinion',
                width: '14%',
                sortValue: (row) => num(row.favorable) - num(row.unfavorable),
                render: (row) => (
                  <OpinionBar
                    favorable={num(row.favorable)}
                    neutral={num(row.neutral)}
                    unfavorable={num(row.unfavorable)}
                  />
                ),
              },
              { key: 'net', name: 'Net', numeric: true, render: (row) => <Net value={row.net} /> },
              {
                key: 'last30',
                name: '30d trend',
                numeric: true,
                sortValue: (row) => num(row.last30) - num(row.prior30),
                render: (row) => {
                  const delta = num(row.last30) - num(row.prior30);
                  return (
                    <span
                      style={{ color: delta > 0 ? '#34d399' : delta < 0 ? '#f87171' : undefined }}
                      title={`${str(row.prior30)} → ${str(row.last30)} mentions`}
                    >
                      {delta > 0 ? '▲' : delta < 0 ? '▼' : '·'} {str(row.last30)}
                    </span>
                  );
                },
              },
              { key: 'faves', name: 'Faves', numeric: true },
              { key: 'lastMentioned', name: 'Last mention', numeric: true, render: (row) => day(row.lastMentioned) },
            ]}
          />
        </Panel>
      </div>
    </Page>
  );
}
