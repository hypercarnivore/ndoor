import { useState } from 'react';
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
  Tone,
  useLoad,
} from '../components/ui';
import { opinionLabel } from '../labels';

const OPINIONS: Record<string, string> = { favorable: '#34d399', neutral: '#94a3b8', unfavorable: '#f87171' };

export function Business({ days, onDays, onSelect, id }: PageProps & { id: string }) {
  const { data, error } = useLoad(() => api.business(id, days), [id, days]);
  const [opinion, setOpinion] = useState('');
  const b = data?.business;
  const m = data?.metrics;
  const peers = data?.peers ?? [];
  const self = peers.find((row) => row.self);
  const mentions = (data?.mentions ?? []).filter((row) => !opinion || (row.opinion ?? 'unjudged') === opinion);

  return (
    <Page
      title={b ? str(b.name) : 'Business'}
      subtitle={b ? [str(b.category), str(b.address)].filter(Boolean).join(' · ') : undefined}
      days={days}
      onDays={onDays}
      actions={
        b && (
          <>
            <button type="button" className="btn ghost" onClick={() => go('businesses')}>
              All businesses
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => go(`explore/Business/${encodeURIComponent(id)}`)}
            >
              Explore in graph
            </button>
            {b.slug && (
              <a
                className="btn ghost"
                href={`https://nextdoor.com/page/${encodeURIComponent(str(b.slug))}/`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open on Nextdoor
              </a>
            )}
          </>
        )
      }
    >
      {error && <div className="error pad">{error}</div>}
      {!data && !error && <div className="spinner pad" />}
      {data && (
        <>
          <Kpis
            items={[
              { label: 'Mentions', value: str(m?.mentions ?? 0), color: '#f472b6' },
              { label: 'People', value: str(m?.people ?? 0), color: '#60a5fa' },
              { label: 'Favorable', value: str(m?.favorable ?? 0), color: '#34d399' },
              { label: 'Unfavorable', value: str(m?.unfavorable ?? 0), color: '#f87171' },
              {
                label: 'Net sentiment',
                value: <Net value={m?.net} />,
                hint: '-100 all unfavorable, +100 all favorable',
                color: '#f59e0b',
              },
              {
                label: b?.category ? `Rank in ${str(b.category)}` : 'Rank in category',
                value: self && b?.category ? `#${str(self.rank)} of ${peers.length}` : '–',
                hint: 'by people mentioning, among businesses in the same category',
                color: '#22d3ee',
              },
              { label: 'Nextdoor faves', value: str(b?.faves ?? '–'), color: '#a78bfa' },
            ]}
          />
          <div className="grid">
            <Panel title="Opinion over time" hint="mentions per week by judged opinion">
              {data.weekly.length === 0 ? (
                <div className="muted small pad">No mentions in this period.</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={data.weekly} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="week" tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={20} />
                    <YAxis allowDecimals={false} tick={{ fill: '#64748b', fontSize: 11 }} />
                    <Tooltip {...TOOLTIP} />
                    <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                    <Bar dataKey="favorable" name="Favorable" stackId="w" fill="#34d399" />
                    <Bar dataKey="neutral" name="Neutral" stackId="w" fill="#475569" />
                    <Bar dataKey="unjudged" name="Not judged" stackId="w" fill="#1e293b" />
                    <Bar dataKey="unfavorable" name="Unfavorable" stackId="w" fill="#f87171" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Panel>
            <Panel title={b?.category ? `Peers in ${str(b.category)}` : 'Peers'} hint="click a business for its page">
              {!b?.category ? (
                <div className="muted small pad">
                  No category yet; it arrives when sync reads this business's profile.
                </div>
              ) : peers.length <= 1 ? (
                <div className="muted small pad">
                  No other business in {str(b.category)} was mentioned in this period. Categories fill in as sync reads
                  more business profiles.
                </div>
              ) : (
                <DataTable
                  rows={peers}
                  rowKey={(row) => str(row.id)}
                  selectedKey={id}
                  onRow={(row) => go(`business/${encodeURIComponent(str(row.id))}`)}
                  pageSize={12}
                  columns={[
                    { key: 'rank', name: '#', numeric: true, width: '44px' },
                    { key: 'name', name: 'Business', width: '34%', render: (row) => <Clip text={row.name} /> },
                    { key: 'people', name: 'People', numeric: true },
                    {
                      key: 'opinion',
                      name: 'Opinion',
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
                  ]}
                />
              )}
            </Panel>
            <Panel
              wide
              title={`What neighbors said (${mentions.length})`}
              hint="each mention judged for its opinion of this business · click to inspect"
            >
              <div className="chips filter-chips">
                {['', 'favorable', 'neutral', 'unfavorable', 'unjudged'].map((value) => (
                  <button
                    key={value || 'all'}
                    type="button"
                    className={opinion === value ? 'chip' : 'chip off-soft'}
                    style={{ '--accent': OPINIONS[value] ?? '#64748b' } as React.CSSProperties}
                    onClick={() => setOpinion(value)}
                  >
                    {value ? (value === 'unjudged' ? 'Not assessed' : opinionLabel(value)) : 'All'}
                  </button>
                ))}
              </div>
              <DataTable
                rows={mentions}
                rowKey={(row) => `${str(row.kind)}:${str(row.id)}`}
                onRow={(row) => onSelect({ label: str(row.kind), key: str(row.id), title: str(row.text) })}
                columns={[
                  {
                    key: 'opinion',
                    name: 'Opinion',
                    width: '96px',
                    render: (row) => (
                      <span style={{ color: OPINIONS[str(row.opinion)] ?? '#64748b' }}>
                        {row.opinion ? opinionLabel(str(row.opinion)) : 'Not assessed'}
                      </span>
                    ),
                  },
                  { key: 'text', name: 'Mention', width: '46%', render: (row) => <Clip text={row.text} /> },
                  { key: 'author', name: 'Author', render: (row) => <Clip text={row.author} /> },
                  { key: 'post', name: 'Thread', render: (row) => <Clip text={row.post} /> },
                  { key: 'reactions', name: 'Reactions', numeric: true },
                  { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
                ]}
              />
            </Panel>
            {data.ownPosts.length > 0 && (
              <Panel wide title="Posts by this business" hint="its own page posting on Nextdoor">
                <DataTable
                  rows={data.ownPosts}
                  rowKey={(row: Row) => str(row.id)}
                  onRow={(row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject) })}
                  columns={[
                    { key: 'subject', name: 'Post', width: '50%', render: (row) => <Clip text={row.subject} /> },
                    { key: 'reactions', name: 'Reactions', numeric: true },
                    { key: 'comments', name: 'Comments', numeric: true },
                    { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
                    { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
                  ]}
                />
              </Panel>
            )}
          </div>
          {m && num(m.judged) < num(m.mentions) && (
            <div className="muted small pad">
              {num(m.mentions) - num(m.judged)} mentions are not assessed yet; they will be after the next refresh.{' '}
              {pct(num(m.judged) / num(m.mentions))} judged.
            </div>
          )}
        </>
      )}
    </Page>
  );
}
