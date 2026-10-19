import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type PoliticsReport } from '../api';
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
  useLoad,
} from '../components/ui';

/** Left, right, and neutral keep one color everywhere on this screen. */
const LEAN = { left: '#60a5fa', right: '#f87171', neutral: '#64748b' } as const;
const LEVEL = { local: '#34d399', state: '#facc15', national: '#a78bfa' } as const;

const CAVEAT =
  'Posts about local, state, or national politics, sorted by an AI into left-leaning, right-leaning, or neutral based on what each post says. It is an estimate, and it only covers what neighbors chose to post, not the whole town.';

/** Lean as an index from -100 (left) to +100 (right). */
const index = (value: unknown) => Math.round(num(value) * 100);
const signed = (value: unknown) => {
  const n = index(value);
  return `${n > 0 ? '+' : ''}${n}`;
};
const leanColor = (value: number) => (value > 0.1 ? LEAN.right : value < -0.1 ? LEAN.left : LEAN.neutral);

/** Left / neutral / right shares of one group as a single bar, counts on hover. */
function LeanBar({ left, neutral, right }: { left: number; neutral: number; right: number }) {
  const total = left + neutral + right;
  if (!total) return <span className="muted small">–</span>;
  const part = (n: number) => `${(100 * n) / total}%`;
  return (
    <div className="mixbar inline" title={`${left} left · ${neutral} neutral · ${right} right`}>
      <span style={{ width: part(left), background: LEAN.left }} />
      <span style={{ width: part(neutral), background: LEAN.neutral }} />
      <span style={{ width: part(right), background: LEAN.right }} />
    </div>
  );
}

/** Point on the gauge arc: value -1 (far left) to +1 (far right), radius r around (cx, cy). */
function arcPoint(value: number, r: number, cx: number, cy: number) {
  const angle = Math.PI * (1 - (value + 1) / 2);
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

function arcPath(from: number, to: number, r: number, cx: number, cy: number) {
  const a = arcPoint(from, r, cx, cy);
  const b = arcPoint(to, r, cx, cy);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}`;
}

/** Plain-words reading of the overall lean, and whether it is clearly off center. */
function describeLean(value: number, low: number | null, high: number | null): string {
  const size = Math.abs(index(value));
  const clear = low !== null && high !== null && (low > 0 || high < 0);
  if (size < 8 || !clear) return size < 8 ? 'Centered' : 'Close to center';
  const side = value > 0 ? 'right' : 'left';
  return size < 25 ? `Leans slightly ${side}` : size < 50 ? `Leans ${side}` : `Leans strongly ${side}`;
}

/**
 * Half-circle dial from far left to far right. The track has no neutral color in the middle, because a grey
 * wedge reads as a "centrist" zone the data does not define; the needle alone says where the average sits.
 */
function Gauge({
  value,
  low,
  high,
  left,
  right,
  neutral,
}: {
  value: number;
  low: number | null;
  high: number | null;
  left: number;
  right: number;
  neutral: number;
}) {
  const cx = 130;
  const cy = 120;
  const r = 90;
  const tip = arcPoint(value, r - 14, cx, cy);
  const total = left + right + neutral;
  const sided = left + right;
  const top = arcPoint(0, r + 14, cx, cy);
  const topIn = arcPoint(0, r - 10, cx, cy);
  return (
    <div className="lean-gauge">
      <svg
        viewBox="0 0 260 150"
        role="img"
        aria-label={`Overall lean ${signed(value)} on a scale from -100 left to +100 right`}
      >
        <path d={arcPath(-1, -0.015, r, cx, cy)} fill="none" stroke={LEAN.left} strokeWidth={16} opacity={0.55} />
        <path d={arcPath(0.015, 1, r, cx, cy)} fill="none" stroke={LEAN.right} strokeWidth={16} opacity={0.55} />
        <line x1={topIn.x} y1={topIn.y} x2={top.x} y2={top.y} stroke="#64748b" strokeWidth={1} />
        <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke="#e2e8f0" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={6} fill="#e2e8f0" />
        <text x={cx - r} y={cy + 20} textAnchor="middle" fill="#94a3b8" fontSize={11}>
          Left
        </text>
        <text x={cx + r} y={cy + 20} textAnchor="middle" fill="#94a3b8" fontSize={11}>
          Right
        </text>
      </svg>
      <div className="lean-gauge-reading" style={{ color: leanColor(value) }}>
        {signed(value)}
      </div>
      <div className="lean-gauge-label">{describeLean(value, low, high)}</div>
      {low !== null && high !== null && (
        <div className="lean-gauge-split muted small">
          With this many posts, the true average could be anywhere from {signed(low)} to {signed(high)}.
        </div>
      )}
      {total > 0 && (
        <div className="lean-gauge-split muted small">
          {neutral} of {total} posts take no side. Of the {sided} that do, {left} lean left and {right} lean right.
        </div>
      )}
    </div>
  );
}

export function Politics({ days, onDays }: PageProps) {
  /** Which kinds of source to include; all by default. */
  const [sources, setSources] = useState<string[]>(['feed', 'mine', 'open']);
  const { data, error } = useLoad(() => api.politics(days, sources), [days, sources]);
  const [level, setLevel] = useState('');
  const [lean, setLean] = useState('');
  /** Neighborhoods with too few posts to compare are listed, but can be hidden. */
  const [hideSmall, setHideSmall] = useState(false);
  const k = data?.kpis;
  const trend = k ? k.last30 - k.prior30 : 0;

  const monthly = useMemo(
    () =>
      (data?.monthly ?? []).map((row) => ({
        ...row,
        index: row.meanLean === null ? null : index(row.meanLean),
        band:
          row.low === null || row.high === null
            ? null
            : [Math.max(-100, index(row.low)), Math.min(100, index(row.high))],
        leftPct: row.total ? Math.round((1000 * row.left) / row.total) / 10 : null,
        rightPct: row.total ? Math.round((1000 * row.right) / row.total) / 10 : null,
        // The remainder, so rounding never pushes a month past 100%.
        neutralPct: row.total
          ? Math.round(1000 - Math.round((1000 * row.left) / row.total) - Math.round((1000 * row.right) / row.total)) /
            10
          : null,
      })),
    [data],
  );
  const posts = (data?.posts ?? []).filter((row) => (!level || row.level === level) && (!lean || row.lean === lean));
  const hoods = (data?.neighborhoods ?? []).filter((row) => !hideSmall || row.p !== null);
  const smallCount = (data?.neighborhoods ?? []).filter((row) => row.p === null).length;

  return (
    <Page title="Politics" subtitle={CAVEAT} days={days} onDays={onDays}>
      {error && <div className="error pad">{error}</div>}
      {!data && !error && <div className="spinner pad" />}
      {data && k && (
        <PoliticsBody
          data={data}
          monthly={monthly}
          trend={trend}
          posts={posts}
          hoods={hoods}
          level={level}
          lean={lean}
          hideSmall={hideSmall}
          smallCount={smallCount}
          setLevel={setLevel}
          setLean={setLean}
          setHideSmall={setHideSmall}
          sources={sources}
          setSources={setSources}
        />
      )}
    </Page>
  );
}

function PoliticsBody({
  data,
  monthly,
  trend,
  posts,
  hoods,
  level,
  lean,
  hideSmall,
  smallCount,
  setLevel,
  setLean,
  setHideSmall,
  sources,
  setSources,
}: {
  data: PoliticsReport;
  monthly: Array<PoliticsReport['monthly'][number] & Record<string, unknown>>;
  trend: number;
  posts: PoliticsReport['posts'];
  hoods: PoliticsReport['neighborhoods'];
  level: string;
  lean: string;
  hideSmall: boolean;
  smallCount: number;
  setLevel: (value: string) => void;
  setLean: (value: string) => void;
  setHideSmall: (value: boolean) => void;
  sources: string[];
  setSources: (value: string[]) => void;
}) {
  const k = data.kpis;
  const noHood = k.posts - data.neighborhoods.reduce((total, row) => total + row.posts, 0);
  const tick = { fill: '#64748b', fontSize: 11 };
  const switcher = (
    <div className="source-switch">
      <span className="muted small">Where posts come from</span>
      <div className="chips">
        {(['feed', 'mine', 'open'] as const).map((key) => {
          const on = sources.includes(key);
          return (
            <button
              key={key}
              type="button"
              className={on ? 'chip' : 'chip off-soft'}
              aria-pressed={on}
              title={
                key === 'open'
                  ? 'Open groups near you that you have not joined: anyone can read them, but their members are not your neighbors'
                  : undefined
              }
              onClick={() => {
                const next = on ? sources.filter((value) => value !== key) : [...sources, key];
                if (next.length) setSources(next);
              }}
            >
              {data.sources.names[key]} {data.sources.counts[key]}
            </button>
          );
        })}
      </div>
    </div>
  );
  if (k.posts === 0) {
    return (
      <>
        {switcher}
        <div className="muted pad">
          No political posts judged in this period yet
          {k.pending > 0 ? `; ${k.pending} posts about government are waiting for the next judge run (make judge)` : ''}
          .
        </div>
      </>
    );
  }
  return (
    <>
      {switcher}
      <Kpis
        items={[
          { label: 'Political posts', value: k.posts.toLocaleString(), color: '#a78bfa' },
          { label: 'Share of all posts', value: pct(k.share), color: '#a78bfa' },
          {
            label: 'Last 30 days',
            value: (
              <span>
                {k.last30}{' '}
                <span className="small" style={{ color: '#94a3b8' }}>
                  {trend > 0 ? '▲' : trend < 0 ? '▼' : '·'} {Math.abs(trend)}
                </span>
              </span>
            ),
            hint: `${k.prior30} in the 30 days before`,
            color: '#a78bfa',
          },
          { label: 'Left-leaning', value: k.left.toLocaleString(), color: LEAN.left },
          { label: 'Neutral', value: k.neutral.toLocaleString(), color: LEAN.neutral },
          { label: 'Right-leaning', value: k.right.toLocaleString(), color: LEAN.right },
          {
            label: 'Lean',
            value: k.meanLean === null ? '–' : signed(k.meanLean),
            hint: '-100 is all left, +100 is all right',
            color: leanColor(k.meanLean ?? 0),
          },
          { label: 'Authors', value: k.authors.toLocaleString(), color: '#94a3b8' },
        ]}
      />
      {(k.pending > 0 || data.unclear > 0) && (
        <div className="muted small note">
          {k.pending > 0 && `${k.pending} posts about government are not judged yet. `}
          {data.unclear > 0 && `${data.unclear} judged posts were too uncertain to count.`}
        </div>
      )}
      <div className="grid">
        {k.meanLean !== null && (
          <Panel title="Overall direction" hint="for the selected period">
            <Gauge
              value={k.meanLean}
              low={k.meanLow}
              high={k.meanHigh}
              left={k.left}
              right={k.right}
              neutral={k.neutral}
            />
            <div className="muted small">
              Scale runs from -100 (all left) to +100 (all right). Posts that take no side count as 0, so they pull the
              average toward the middle. Each author counts once, so frequent posters do not dominate.
            </div>
          </Panel>
        )}
        <Panel title="What stands out" hint="hover a line to see the test behind it">
          <ul className="findings">
            {data.findings.map((finding) => (
              <li
                key={finding.text}
                className={finding.significant ? 'finding strong' : 'finding'}
                title={finding.detail}
              >
                <span className="finding-mark" aria-hidden="true">
                  {finding.significant ? '●' : '○'}
                </span>
                {finding.text}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <div className="grid">
        <Panel title="Lean over time" hint="average lean each month; above zero is right, below is left">
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={monthly} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="month" tick={tick} minTickGap={24} />
              <YAxis domain={[-100, 100]} allowDataOverflow tick={tick} />
              <Tooltip {...TOOLTIP} />
              <ReferenceLine y={0} stroke="#475569" />
              <Area
                dataKey="band"
                name="Plausible range"
                stroke="none"
                fill="#94a3b8"
                fillOpacity={0.18}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                dataKey="index"
                name="Lean"
                stroke="#e2e8f0"
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="muted small">
            The shaded band is the range the average could plausibly be. Months with few posts have wide bands.
          </div>
        </Panel>
        <Panel title="Mix over time" hint="share of each month's political posts">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthly} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="month" tick={tick} minTickGap={24} />
              <YAxis unit="%" domain={[0, 100]} tick={tick} />
              <Tooltip {...TOOLTIP} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
              <Bar dataKey="leftPct" name="Left %" stackId="mix" fill={LEAN.left} isAnimationActive={false} />
              <Bar dataKey="neutralPct" name="Neutral %" stackId="mix" fill={LEAN.neutral} isAnimationActive={false} />
              <Bar dataKey="rightPct" name="Right %" stackId="mix" fill={LEAN.right} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Volume over time" hint="political posts per month, by level of government">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthly} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="month" tick={tick} minTickGap={24} />
              <YAxis allowDecimals={false} tick={tick} />
              <Tooltip {...TOOLTIP} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
              <Bar dataKey="local" name="Local" stackId="level" fill={LEVEL.local} isAnimationActive={false} />
              <Bar dataKey="state" name="State" stackId="level" fill={LEVEL.state} isAnimationActive={false} />
              <Bar dataKey="national" name="National" stackId="level" fill={LEVEL.national} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel
          title="By level of government"
          hint={`${k.posts} posts in this period · click a level to filter the posts below`}
        >
          <DataTable
            rows={data.levels}
            rowKey={(row) => str(row.level)}
            selectedKey={level}
            onRow={(row) => setLevel(level === row.level ? '' : str(row.level))}
            columns={[
              { key: 'name', name: 'Level' },
              { key: 'posts', name: 'Posts', numeric: true },
              {
                key: 'mix',
                name: 'Left / neutral / right',
                sortable: false,
                render: (row) => <LeanBar left={num(row.left)} neutral={num(row.neutral)} right={num(row.right)} />,
              },
              {
                key: 'meanLean',
                name: 'Lean',
                numeric: true,
                render: (row) => (row.meanLean === null ? '–' : signed(row.meanLean)),
              },
            ]}
          />
        </Panel>
        <Panel
          wide
          title="Neighborhoods"
          hint={`${data.neighborhoods.length} neighborhoods in this period, by where the author lives${noHood > 0 ? ` · ${noHood} posts have no neighborhood` : ''}`}
          action={
            smallCount
              ? {
                  label: hideSmall ? `Show ${smallCount} with few posts` : `Hide ${smallCount} with few posts`,
                  onClick: () => setHideSmall(!hideSmall),
                }
              : undefined
          }
        >
          <DataTable
            rows={hoods}
            rowKey={(row) => str(row.id)}
            initialSort={{ key: 'posts', desc: true }}
            pageSize={15}
            search={{ placeholder: 'Filter neighborhoods', fields: ['name'] }}
            columns={[
              { key: 'name', name: 'Neighborhood', width: '17%' },
              { key: 'posts', name: 'Posts', numeric: true },
              { key: 'authors', name: 'Authors', numeric: true },
              {
                key: 'mix',
                name: 'Left / neutral / right',
                width: '16%',
                sortable: false,
                render: (row) => <LeanBar left={num(row.left)} neutral={num(row.neutral)} right={num(row.right)} />,
              },
              {
                key: 'meanLean',
                name: 'Lean',
                numeric: true,
                render: (row) => <span style={{ color: leanColor(num(row.meanLean)) }}>{signed(row.meanLean)}</span>,
              },
              {
                key: 'difference',
                name: 'Gap vs. rest of town',
                width: '22%',
                render: (row) =>
                  row.difference === null ? (
                    <span className="muted small">–</span>
                  ) : (
                    <span
                      title="how far this neighborhood's average is from the rest of town, with the range it could plausibly be"
                      style={{ color: row.significant || row.leaning ? leanColor(num(row.difference)) : '#94a3b8' }}
                    >
                      {signed(row.difference)}{' '}
                      <span className="muted small">
                        ({signed(row.differenceLow)} to {signed(row.differenceHigh)})
                      </span>
                    </span>
                  ),
              },
              {
                key: 'verdict',
                name: 'Different from town?',
                width: '22%',
                sortValue: (row) => (row.significant ? 2 : row.leaning ? 1 : row.difference === null ? -1 : 0),
                render: (row) => {
                  if (row.difference === null) return <span className="muted small">too few to compare</span>;
                  const side = num(row.difference) > 0 ? 'right' : 'left';
                  if (row.significant) {
                    return <span style={{ color: leanColor(num(row.difference)) }}>Yes, more {side}</span>;
                  }
                  if (row.leaning) return <span>Leaning {side}, needs more posts</span>;
                  return <span className="muted small">Not enough posts to be sure</span>;
                },
              },
            ]}
          />
          <div className="muted small">
            The number is how far the neighborhood sits from the rest of town (right is positive), and the range in
            brackets is how far off it could plausibly be. "Yes" means the gap is bigger than chance would explain, even
            after allowing for how many neighborhoods were checked. "Leaning" means it looks that way but could still be
            chance. "Not enough posts to be sure" means the range includes zero, which is common with few posts.
          </div>
        </Panel>
        <Panel
          wide
          title="Posts"
          hint={`${posts.length} posts in this period, newest first, authors not shown`}
          action={lean ? { label: `Clear ${lean} filter`, onClick: () => setLean('') } : undefined}
        >
          <div className="chips">
            {(['left', 'neutral', 'right'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={lean === value ? 'chip' : 'chip off-soft'}
                style={{ '--accent': LEAN[value] } as React.CSSProperties}
                onClick={() => setLean(lean === value ? '' : value)}
              >
                {value}
              </button>
            ))}
            {level && (
              <button type="button" className="chip" onClick={() => setLevel('')}>
                {level} ✕
              </button>
            )}
          </div>
          <DataTable
            rows={posts as unknown as Array<Record<string, unknown>>}
            rowKey={(row) => str(row.id)}
            pageSize={12}
            search={{ placeholder: 'Filter posts', fields: ['subject', 'body', 'neighborhood'] }}
            columns={[
              { key: 'at', name: 'Date', render: (row) => day(row.at) },
              {
                key: 'subject',
                name: 'Post',
                width: '44%',
                render: (row) => <Clip text={row.subject || row.body} title={row.body} />,
              },
              { key: 'level', name: 'Level' },
              {
                key: 'source',
                name: 'Source',
                render: (row) => data.sources.names[str(row.source)] ?? str(row.source),
              },
              { key: 'neighborhood', name: 'Neighborhood' },
              {
                key: 'score',
                name: 'Lean',
                numeric: true,
                render: (row) => (
                  <span style={{ color: leanColor(num(row.score)) }}>
                    {str(row.lean)} {signed(row.score)}
                  </span>
                ),
              },
              { key: 'comments', name: 'Comments', numeric: true },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
