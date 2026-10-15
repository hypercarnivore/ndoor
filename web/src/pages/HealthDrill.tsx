import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type DrillSection, type Row } from '../api';
import {
  Clip,
  DataTable,
  day,
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
import { toneColor } from '../theme';

const SIGNALS: Record<string, string> = {
  civility: 'Civility',
  warmth: 'Warmth',
  agreement: 'Agreement',
  helpfulness: 'Helpfulness',
};

function Section({ section, onSelect }: { section: DrillSection; onSelect: PageProps['onSelect'] }) {
  const rowKey = (row: Row) => str(row.id ?? `${str(row.fromId)}-${str(row.toId)}`);
  switch (section.kind) {
    case 'histogram':
      return (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={section.rows} margin={{ left: -10 }}>
            <XAxis dataKey="bin" tick={{ fill: '#94a3b8', fontSize: 11 }} />
            <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
            <Tooltip {...TOOLTIP} />
            <Bar dataKey="items" radius={[3, 3, 0, 0]}>
              {section.rows.map((row, index) => (
                <Cell key={str(row.bin)} fill={toneColor((index + 0.5) / 10)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    case 'items':
      return (
        <DataTable
          rows={section.rows}
          rowKey={rowKey}
          onRow={(row) => onSelect({ label: str(row.kind), key: str(row.id), title: str(row.body) })}
          columns={[
            { key: 'body', name: 'Text', width: '42%', render: (row) => <Clip text={row.body} /> },
            { key: 'author', name: 'Author', render: (row) => <Clip text={row.author} /> },
            { key: 'subject', name: 'Thread', render: (row) => <Clip text={row.subject} /> },
            { key: 'tone', name: 'Tone', numeric: true, render: (row) => <Tone value={row.tone} /> },
            {
              key: 'hostility',
              name: 'Hostility',
              numeric: true,
              render: (row) => (row.hostility === null ? '–' : num(row.hostility).toFixed(1)),
            },
            { key: 'at', name: 'Date', numeric: true, render: (row) => day(row.at) },
          ]}
        />
      );
    case 'people':
      return (
        <DataTable
          rows={section.rows}
          rowKey={rowKey}
          onRow={(row) => onSelect({ label: 'User', key: str(row.id), title: str(row.name) })}
          columns={[
            { key: 'name', name: 'Person', width: '40%' },
            ...(section.rows[0] && 'hostile' in section.rows[0]
              ? [{ key: 'hostile', name: 'Hostile', numeric: true }]
              : [{ key: 'helpful', name: 'Helpful', numeric: true }]),
            { key: 'judged', name: 'Of judged', numeric: true },
            { key: 'share', name: 'Share', numeric: true, render: (row: Row) => pct(row.share) },
          ]}
        />
      );
    case 'threads':
      return (
        <DataTable
          rows={section.rows}
          rowKey={rowKey}
          onRow={(row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject) })}
          columns={[
            { key: 'subject', name: 'Post', width: '50%', render: (row) => <Clip text={row.subject} /> },
            { key: 'author', name: 'Author', render: (row) => <Clip text={row.author} /> },
            ...(section.rows[0] && 'disagreements' in section.rows[0]
              ? [
                  { key: 'disagreements', name: 'Disagree', numeric: true },
                  { key: 'share', name: 'Share', numeric: true, render: (row: Row) => pct(row.share) },
                ]
              : [{ key: 'comments', name: 'Comments', numeric: true }]),
            { key: 'at', name: 'Date', numeric: true, render: (row: Row) => day(row.at) },
          ]}
        />
      );
    case 'pairs':
      return (
        <DataTable
          rows={section.rows}
          rowKey={rowKey}
          onRow={(row) => onSelect({ label: 'User', key: str(row.fromId), title: str(row.from) })}
          columns={[
            { key: 'from', name: 'From' },
            { key: 'to', name: 'To' },
            { key: 'replies', name: 'Replies', numeric: true },
            { key: 'disagreements', name: 'Disagree', numeric: true },
          ]}
        />
      );
  }
}

export function HealthDrill({ days, onDays, onSelect, signal }: PageProps & { signal: string }) {
  const health = useLoad(() => api.health(days), [days]);
  const { data, error } = useLoad(() => api.healthDrill(signal, days), [signal, days]);
  const current = health.data?.signals[signal as keyof NonNullable<typeof health.data>['signals']];
  return (
    <Page
      title={`Community health: ${SIGNALS[signal] ?? signal}`}
      subtitle={current?.describe}
      days={days}
      onDays={onDays}
    >
      <div className="tabs-row">
        {Object.entries(SIGNALS).map(([key, name]) => {
          const value = health.data?.signals[key as keyof NonNullable<typeof health.data>['signals']]?.value;
          return (
            <button
              key={key}
              type="button"
              className={key === signal ? 'tab active' : 'tab'}
              onClick={() => go(`health/${key}`)}
            >
              {name}
              {value !== null && value !== undefined && <b className="tab-score">{(value * 10).toFixed(1)}</b>}
            </button>
          );
        })}
        {health.data?.score !== null && health.data?.score !== undefined && (
          <span className="muted small">overall {health.data.score.toFixed(1)} / 10</span>
        )}
      </div>
      {error && <div className="error pad">{error}</div>}
      {!data && !error && <div className="spinner pad" />}
      <div className="grid">
        {data?.map((section) => (
          <Panel
            key={section.title}
            wide={section.kind !== 'histogram' || data.length === 1}
            title={section.title}
            hint={section.hint}
          >
            {section.rows.length === 0 ? (
              <div className="muted small pad">Nothing in this period.</div>
            ) : (
              <Section section={section} onSelect={onSelect} />
            )}
          </Panel>
        ))}
      </div>
    </Page>
  );
}
