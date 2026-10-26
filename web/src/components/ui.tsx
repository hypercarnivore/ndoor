import { useEffect, useMemo, useRef, useState } from 'react';
import type { Row } from '../api';
import { day } from '../dates';
import { toneColor } from '../theme';

export const PERIODS = [
  { days: 30, name: '30 days' },
  { days: 90, name: '90 days' },
  { days: 365, name: '1 year' },
  { days: 36500, name: 'all time' },
];

export const str = (value: unknown) => (value === null || value === undefined ? '' : String(value));
export const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
export const pct = (value: unknown) =>
  value === null || value === undefined ? '–' : `${Math.round(num(value) * 100)}%`;
export { day };

/** Navigate within the app (hash routes). */
export function go(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
}

/**
 * Load data for a screen. It reloads whenever `deps` change (compared by value)
 * and ignores answers that arrive after a newer request started.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(load);
  latest.current = load;
  const key = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger; the effect reads the latest loader.
  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    latest
      .current()
      .then((result) => !stale && setData(result))
      .catch((err) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, [key]);
  return { data, error };
}

export function Period({ days, onDays }: { days: number; onDays: (days: number) => void }) {
  return (
    <div className="segmented">
      {PERIODS.map((period) => (
        <button
          key={period.days}
          type="button"
          className={days === period.days ? 'active' : undefined}
          onClick={() => onDays(period.days)}
        >
          {period.name}
        </button>
      ))}
    </div>
  );
}

/** A drill-down screen: breadcrumb back to the overview, title, period, and content. */
export function Page({
  title,
  subtitle,
  days,
  onDays,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  days?: number;
  onDays?: (days: number) => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard">
      <div className="crumbs">
        <button type="button" className="link" onClick={() => go('overview')}>
          Overview
        </button>
        <span className="muted"> / </span>
        <span>{title}</span>
      </div>
      <div className="dash-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
        <div className="head-actions">
          {actions}
          {days !== undefined && onDays && <Period days={days} onDays={onDays} />}
        </div>
      </div>
      {children}
    </div>
  );
}

export function Panel({
  title,
  hint,
  wide,
  span2,
  action,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  wide?: boolean;
  /** Span two columns on wide screens. */
  span2?: boolean;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <section className={`panel${wide ? ' wide' : ''}${span2 ? ' span2' : ''}`}>
      <header>
        <h3>{title}</h3>
        <span className="panel-meta">
          {hint && <span className="muted small">{hint}</span>}
          {action && (
            <button type="button" className="link small" onClick={action.onClick}>
              {action.label} →
            </button>
          )}
        </span>
      </header>
      {children}
    </section>
  );
}

export function Kpis({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode; hint?: string; color?: string }>;
}) {
  return (
    <div className="stats">
      {items.map((item) => (
        <div
          key={item.label}
          className="stat"
          title={item.hint}
          style={{ '--accent': item.color ?? '#22d3ee' } as React.CSSProperties}
        >
          <b>{item.value}</b>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Favorable / neutral / unfavorable as one stacked bar with counts on hover. */
export function OpinionBar({
  favorable,
  neutral,
  unfavorable,
}: {
  favorable: number;
  neutral: number;
  unfavorable: number;
}) {
  const total = favorable + neutral + unfavorable;
  if (!total) return <span className="muted small">not judged</span>;
  const part = (n: number) => `${(100 * n) / total}%`;
  return (
    <div className="mixbar inline" title={`${favorable} favorable · ${neutral} neutral · ${unfavorable} unfavorable`}>
      <span style={{ width: part(favorable), background: '#34d399' }} />
      <span style={{ width: part(neutral), background: '#475569' }} />
      <span style={{ width: part(unfavorable), background: '#f87171' }} />
    </div>
  );
}

export function Tone({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">–</span>;
  return <span style={{ color: toneColor(num(value)) }}>{Math.round(num(value) * 100)}</span>;
}

/** Net sentiment, -1..1, as a signed percentage. */
export function Net({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">–</span>;
  const n = num(value);
  return (
    <span
      style={{ color: n > 0.2 ? '#34d399' : n < -0.1 ? '#f87171' : '#f59e0b' }}
    >{`${n > 0 ? '+' : ''}${Math.round(n * 100)}`}</span>
  );
}

export interface Column {
  key: string;
  name: string;
  numeric?: boolean;
  width?: string;
  render?: (row: Row) => React.ReactNode;
  /** What to sort by when it is not the raw value; null sorts last. */
  sortValue?: (row: Row) => number | string | null;
  sortable?: boolean;
}

/** Sortable, filterable table with incremental "show more". */
export function DataTable({
  rows,
  columns,
  initialSort,
  onRow,
  rowKey,
  search,
  pageSize = 50,
  selectedKey,
}: {
  rows: Row[] | null;
  columns: Column[];
  initialSort?: { key: string; desc: boolean };
  onRow?: (row: Row) => void;
  rowKey: (row: Row) => string;
  /** Client-side text filter over these fields. */
  search?: { placeholder: string; fields: string[] };
  pageSize?: number;
  selectedKey?: string | null;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [text, setText] = useState('');
  const [shown, setShown] = useState(pageSize);
  const sorted = useMemo(() => {
    if (!rows) return null;
    const q = text.trim().toLowerCase();
    const filtered =
      q && search ? rows.filter((row) => search.fields.some((f) => str(row[f]).toLowerCase().includes(q))) : rows;
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    const value = (row: Row) => (column?.sortValue ? column.sortValue(row) : (row[sort.key] as number | string | null));
    return [...filtered].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.desc ? -order : order;
    });
  }, [rows, sort, text, columns, search]);

  if (!sorted) return <div className="spinner pad" />;
  return (
    <div>
      {search && (
        <input
          className="filter"
          placeholder={search.placeholder}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setShown(pageSize);
          }}
        />
      )}
      {sorted.length === 0 ? (
        <div className="muted small pad">Nothing matches.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const sortable = column.sortable !== false;
                return (
                  <th
                    key={column.key}
                    className={`${column.numeric ? 'num' : ''}${sortable ? ' sortable' : ''}${active ? ' sorted' : ''}`}
                    style={column.width ? { width: column.width } : undefined}
                    onClick={() =>
                      sortable &&
                      setSort((current) =>
                        current?.key === column.key
                          ? { key: column.key, desc: !current.desc }
                          : { key: column.key, desc: column.numeric ?? false },
                      )
                    }
                  >
                    {column.name}
                    {active ? (sort?.desc ? ' ↓' : ' ↑') : ''}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, shown).map((row) => (
              <tr
                key={rowKey(row)}
                className={`${onRow ? 'clickable' : ''}${selectedKey === rowKey(row) ? ' selected' : ''}`}
                onClick={() => onRow?.(row)}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'num' : undefined}>
                    {column.render
                      ? column.render(row)
                      : row[column.key] === null || row[column.key] === undefined
                        ? '–'
                        : str(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sorted.length > shown && (
        <button type="button" className="link more-rows" onClick={() => setShown(shown + pageSize)}>
          Show {Math.min(pageSize, sorted.length - shown)} more of {sorted.length - shown}
        </button>
      )}
    </div>
  );
}

export const TOOLTIP = {
  contentStyle: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e2e8f0' },
  itemStyle: { color: '#cbd5e1' },
};

export function Clip({ text, title }: { text: unknown; title?: unknown }) {
  return (
    <span className="clip" title={str(title ?? text)}>
      {str(text)}
    </span>
  );
}

/** What every drill-down screen receives from the app. */
export interface PageProps {
  days: number;
  onDays: (days: number) => void;
  onSelect: (ref: import('../App').Ref) => void;
  selected: import('../App').Ref | null;
  /** Filters carried in the route, such as #/posts?theme=crime_safety. */
  params: URLSearchParams;
}

/** A sort control backed by the server's whitelisted orders. */
export function SortSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="inline-control">
      Sort
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(options).map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Text input that reports its value after the user pauses typing. */
export function SearchInput({ placeholder, onChange }: { placeholder: string; onChange: (value: string) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, onChange]);
  return (
    <input className="filter inline" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
  );
}
