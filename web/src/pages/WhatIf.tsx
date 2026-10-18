import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type WhatIfCatalog, type WhatIfResult } from '../api';
import { healthColor, SIGNAL_NAMES } from '../components/Dashboard';
import { Clip, DataTable, Kpis, num, Page, type PageProps, Panel, pct, str, TOOLTIP, useLoad } from '../components/ui';
import { themeLabel } from '../labels';

type Scenario = keyof WhatIfCatalog['scenarios'];
type View = WhatIfResult['before'];
type Signal = View['signals'][keyof View['signals']];

const ORDER: Scenario[] = ['people', 'threads', 'hostility', 'answers', 'themes', 'places'];

export const WHATIF_NOTE =
  'Pick a change and see how the community health score would move. This is arithmetic on the posts and comments Jev has judged, not a forecast.';

/** A value that follows `value` after it has stopped changing for a moment (so dragging a slider asks once). */
function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Ring({ view, title }: { view: View; title: string }) {
  if (view.score === null) return <div className="muted">{title}: not measurable</div>;
  const color = healthColor(view.score);
  return (
    <div className="health-score">
      <div className="health-ring" style={{ background: `conic-gradient(${color} ${view.score * 36}deg, #1e293b 0)` }}>
        <div>
          <b style={{ color }}>{view.score.toFixed(1)}</b>
          <span className="muted small">of 10</span>
        </div>
      </div>
      <b>{title}</b>
      <span style={{ color }}>{view.label}</span>
    </div>
  );
}

const rawText = (name: string, raw: number | null) =>
  raw === null ? 'no data' : name === 'warmth' ? `tone ${Math.round(raw * 100)}` : `${Math.round(raw * 100)}%`;

function SignalRow({ name, before, after }: { name: string; before: Signal; after: Signal }) {
  const bar = (value: number | null, faded: boolean) => (
    <span className="gauge-track">
      <span
        className="gauge-fill"
        style={{
          width: `${(value ?? 0) * 100}%`,
          background: healthColor(1 + 9 * (value ?? 0)),
          opacity: faded ? 0.45 : 1,
        }}
      />
    </span>
  );
  const moved = before.value !== null && after.value !== null ? (after.value - before.value) * 10 : 0;
  return (
    <div className="whatif-signal">
      <span>{SIGNAL_NAMES[name] ?? name}</span>
      <div>
        {bar(before.value, true)}
        {bar(after.value, false)}
      </div>
      <span className="muted small">
        {rawText(name, before.raw)} → {rawText(name, after.raw)}
      </span>
      <span className="small" style={{ color: moved > 0.05 ? '#34d399' : moved < -0.05 ? '#f87171' : '#94a3b8' }}>
        {moved > 0.05 || moved < -0.05 ? `${moved > 0 ? '+' : ''}${moved.toFixed(1)}` : '·'}
      </span>
    </div>
  );
}

function Curve({ result, n }: { result: WhatIfResult; n: number }) {
  const points = (result.curve ?? []).filter((point) => point.score !== null);
  if (points.length < 2) return <div className="muted small pad">Nothing to rank in this period.</div>;
  const at = points.find((point) => point.n === Math.min(n, points[points.length - 1].n));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={points} margin={{ top: 12, right: 12, bottom: 4, left: -12 }}>
        <CartesianGrid stroke="#1e293b" vertical={false} />
        <XAxis dataKey="n" tick={{ fill: '#64748b', fontSize: 11 }} />
        <YAxis
          domain={[
            (min: number) => Math.floor((min - 0.2) * 10) / 10,
            (max: number) => Math.ceil((max + 0.2) * 10) / 10,
          ]}
          tick={{ fill: '#64748b', fontSize: 11 }}
        />
        <Tooltip
          {...TOOLTIP}
          formatter={(value) => [num(value).toFixed(1), 'Health score']}
          labelFormatter={(label) => `Top ${label} removed`}
        />
        <Line type="monotone" dataKey="score" stroke="#22d3ee" strokeWidth={2} dot={false} />
        {at && at.score !== null && <ReferenceDot x={at.n} y={at.score} r={5} fill="#f59e0b" stroke="none" />}
      </LineChart>
    </ResponsiveContainer>
  );
}

function Subjects({ result, onSelect }: { result: WhatIfResult; onSelect: PageProps['onSelect'] }) {
  const rows = result.subjects ?? [];
  if (!rows.length) return null;
  const common = { rowKey: (row: Record<string, unknown>) => str(row.id), rows, pageSize: 25 };
  if (result.scenario === 'people') {
    return (
      <Panel wide title="Who would be removed" hint="most affected first; click a person to inspect">
        <DataTable
          {...common}
          onRow={(row) => onSelect({ label: 'User', key: str(row.id), title: str(row.name) })}
          columns={[
            { key: 'rank', name: '#', numeric: true, width: '48px' },
            { key: 'name', name: 'Person' },
            { key: 'items', name: 'Items', numeric: true },
            { key: 'hostile', name: 'Hostile', numeric: true },
            { key: 'hostileShare', name: 'Share hostile', numeric: true, render: (row) => pct(row.hostileShare) },
            { key: 'helpful', name: 'Helpful', numeric: true },
            {
              key: 'alone',
              name: 'Alone (pts)',
              numeric: true,
              render: (row) =>
                row.alone === null ? '–' : `${num(row.alone) > 0 ? '+' : ''}${num(row.alone).toFixed(2)}`,
            },
          ]}
        />
      </Panel>
    );
  }
  const isThread = result.scenario === 'threads';
  return (
    <Panel wide title={isThread ? 'Which threads' : 'Questions with no helpful answer'} hint="click a post to inspect">
      <DataTable
        {...common}
        onRow={(row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject) })}
        columns={[
          { key: 'rank', name: '#', numeric: true, width: '48px' },
          { key: 'subject', name: 'Post', width: '46%', render: (row) => <Clip text={row.subject || row.id} /> },
          { key: 'author', name: 'Author' },
          ...(isThread
            ? [
                { key: 'hostile', name: 'Hostile items', numeric: true },
                { key: 'items', name: 'Items', numeric: true },
              ]
            : [{ key: 'comments', name: 'Comments', numeric: true }]),
        ]}
      />
    </Panel>
  );
}

function Table({ result }: { result: WhatIfResult }) {
  const rows = result.table ?? [];
  const themes = result.scenario === 'themes';
  if (!rows.length) {
    return (
      <Panel wide title={themes ? 'Topics' : 'Neighborhoods'}>
        <div className="muted small pad">Not enough judged posts in this period.</div>
      </Panel>
    );
  }
  return (
    <Panel
      wide
      title={themes ? 'Score without each topic' : 'Score without each neighborhood'}
      hint="biggest improvement first"
    >
      <DataTable
        rows={rows}
        rowKey={(row) => str(row.key)}
        initialSort={{ key: 'delta', desc: true }}
        pageSize={25}
        columns={[
          {
            key: 'name',
            name: themes ? 'Topic' : 'Neighborhood',
            render: (row) => (themes ? themeLabel(str(row.key)) : str(row.name)),
          },
          { key: 'posts', name: 'Posts', numeric: true },
          { key: 'share', name: 'Share', numeric: true, render: (row) => pct(row.share) },
          {
            key: 'score',
            name: 'Without',
            numeric: true,
            render: (row) => (row.score === null ? '–' : num(row.score).toFixed(1)),
          },
          {
            key: 'delta',
            name: 'Change',
            numeric: true,
            render: (row) =>
              row.delta === null ? (
                '–'
              ) : (
                <span style={{ color: num(row.delta) > 0 ? '#34d399' : num(row.delta) < 0 ? '#f87171' : '#94a3b8' }}>
                  {num(row.delta) > 0 ? '+' : ''}
                  {num(row.delta).toFixed(2)}
                </span>
              ),
          },
        ]}
      />
    </Panel>
  );
}

export function WhatIf({ days, onDays, onSelect, params }: PageProps) {
  const catalog = useLoad(() => api.whatIfCatalog(), []);
  const first = params.get('scenario');
  const [scenario, setScenario] = useState<Scenario>(
    ORDER.includes(first as Scenario) ? (first as Scenario) : 'people',
  );
  const [n, setN] = useState(10);
  const [rank, setRank] = useState('hostile');
  const [share, setShare] = useState(100);
  const [cascade, setCascade] = useState(false);
  const settled = useSettled({ n, rank, share, cascade });
  const spec = catalog.data?.scenarios[scenario];
  const { data, error } = useLoad(
    () =>
      spec
        ? api.whatIf(scenario, {
            days,
            n: settled.n,
            rank: settled.rank,
            share: settled.share / 100,
            cascade: settled.cascade,
          })
        : Promise.resolve(null),
    [scenario, days, settled, spec !== undefined],
  );
  const controls = spec?.controls ?? [];
  const k = data?.removed;
  return (
    <Page title="What if" subtitle={WHATIF_NOTE} days={days} onDays={onDays}>
      <div className="segmented whatif-tabs">
        {ORDER.map((key) => (
          <button
            key={key}
            type="button"
            className={key === scenario ? 'active' : undefined}
            onClick={() => setScenario(key)}
          >
            {catalog.data?.scenarios[key].title ?? key}
          </button>
        ))}
      </div>
      {spec && <p className="muted whatif-question">{spec.question}</p>}
      {controls.length > 0 && (
        <div className="controls">
          {controls.includes('rank') && catalog.data && (
            <label>
              Rank people by
              <select value={rank} onChange={(event) => setRank(event.target.value)}>
                {Object.entries(catalog.data.ranks).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {controls.includes('n') && (
            <label>
              {scenario === 'threads' ? 'Threads removed' : 'People removed'}: {n}
              <input
                type="range"
                min={0}
                max={scenario === 'threads' ? 25 : 50}
                value={n}
                onChange={(event) => setN(Number(event.target.value))}
              />
            </label>
          )}
          {controls.includes('share') && (
            <label>
              {scenario === 'answers' ? 'Open questions answered' : 'Hostile writing removed'}: {share}%
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={share}
                onChange={(event) => setShare(Number(event.target.value))}
              />
            </label>
          )}
          {controls.includes('cascade') && (
            <label
              className="check"
              title="Also remove the comments under their posts and the replies to their comments, whoever wrote them"
            >
              <input type="checkbox" checked={cascade} onChange={(event) => setCascade(event.target.checked)} />
              Also remove what grew from it
            </label>
          )}
        </div>
      )}
      {(error || catalog.error) && <div className="error pad">{error ?? catalog.error}</div>}
      {!data && !error && !catalog.error && <div className="spinner pad" />}
      {data && k && (
        <>
          <Panel title="Community health" hint={data.before.score === null ? undefined : 'before and after'}>
            <div className="whatif-compare">
              <Ring view={data.before} title="Today" />
              <div className="whatif-delta">
                {data.delta === null ? (
                  '–'
                ) : (
                  <b style={{ color: data.delta > 0 ? '#34d399' : data.delta < 0 ? '#f87171' : '#94a3b8' }}>
                    {data.delta > 0 ? '+' : ''}
                    {data.delta.toFixed(1)}
                  </b>
                )}
                <span className="muted small">points</span>
              </div>
              <Ring view={data.after} title="In this scenario" />
              <div className="whatif-signals">
                {Object.keys(data.before.signals).map((name) => (
                  <SignalRow
                    key={name}
                    name={name}
                    before={data.before.signals[name as keyof View['signals']]}
                    after={data.after.signals[name as keyof View['signals']]}
                  />
                ))}
                <div className="muted small">Light bar: today. Solid bar: this scenario.</div>
              </div>
            </div>
          </Panel>
          <Kpis
            items={[
              { label: 'People removed', value: k.people, color: '#f59e0b' },
              { label: 'Posts removed', value: k.posts, color: '#f59e0b' },
              { label: 'Comments removed', value: k.comments, color: '#f59e0b' },
              { label: 'Of all judged content', value: pct(k.share), color: k.share > 0.25 ? '#f87171' : '#22d3ee' },
            ]}
          />
          <div className="grid">
            {data.curve && (
              <Panel
                wide
                title="Diminishing returns"
                hint="score after removing the top 1, 2, 3 ... (orange dot: your choice)"
              >
                <Curve result={data} n={n} />
              </Panel>
            )}
            <Subjects result={data} onSelect={onSelect} />
            {data.table && <Table result={data} />}
            <Panel wide title="Read this with care">
              <ul className="whatif-caveats">
                {data.caveats.map((text) => (
                  <li key={text} className="muted small">
                    {text}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}
