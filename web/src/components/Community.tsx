import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-3d';
import type { Ref } from '../App';
import { api, type Network } from '../api';
import { labelColor, PALETTE } from '../theme';

type GNode = NodeObject & Network['nodes'][number];
type GLink = LinkObject<GNode> & Omit<Network['links'][number], 'source' | 'target'>;

const PERIODS = [
  { days: 30, name: '30 days' },
  { days: 90, name: '90 days' },
  { days: 365, name: '1 year' },
  { days: 36500, name: 'all' },
];

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Blue (agreeable) to red (mostly disagreements) for reply links. */
function disagreementColor(link: GLink, alpha: number): string {
  if (link.kind === 'recommends') return `rgba(244, 114, 182, ${alpha})`;
  if (link.kind === 'comment') return `rgba(148, 163, 184, ${alpha * 0.75})`;
  const ratio = link.weight ? link.disagreements / link.weight : 0;
  const r = Math.round(96 + (248 - 96) * ratio);
  const g = Math.round(165 + (113 - 165) * ratio);
  const b = Math.round(250 + (113 - 250) * ratio);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const endId = (end: GLink['source']) => (typeof end === 'object' && end ? String((end as GNode).id) : String(end));

function useSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

export function Community({
  active,
  flyTo,
  selected,
  onSelect,
}: {
  active: boolean;
  flyTo: { id: string; nonce: number } | null;
  selected: Ref | null;
  onSelect: (ref: Ref) => void;
}) {
  const [days, setDays] = useState(365);
  const [min, setMin] = useState(1);
  const [businesses, setBusinesses] = useState(false);
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const size = useSize(container);
  const graph = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);

  useEffect(() => {
    let stale = false;
    setError(null);
    api
      .network({ days, min, limit: 6000, businesses })
      .then((network) => {
        if (stale) return;
        setData({ nodes: network.nodes as GNode[], links: network.links as GLink[] });
      })
      .catch((err) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, [days, min, businesses]);

  useEffect(() => {
    if (!graph.current) return;
    if (active) graph.current.resumeAnimation();
    else graph.current.pauseAnimation();
  }, [active]);

  /** Neighborhoods with the most people get palette colors; the rest share gray. */
  const hoods = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data?.nodes ?? []) {
      if (node.label === 'User' && node.group) counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PALETTE.length)
      .map(([name, count], index) => ({ name, count, color: PALETTE[index] }));
  }, [data]);
  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of data?.links ?? []) {
      for (const end of [endId(link.source), endId(link.target)]) counts.set(end, (counts.get(end) ?? 0) + 1);
    }
    return counts;
  }, [data]);
  const hoodColor = useMemo(() => new Map(hoods.map((hood) => [hood.name, hood.color])), [hoods]);

  // Highlight only when the selection is someone in this network (it may come from the explorer).
  const selectedId = selected && data?.nodes.some((node) => node.id === selected.key) ? selected.key : null;
  const fitted = useRef<unknown>(null);
  const neighbors = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId || !data) return ids;
    for (const link of data.links) {
      const s = endId(link.source);
      const t = endId(link.target);
      if (s === selectedId) ids.add(t);
      if (t === selectedId) ids.add(s);
    }
    return ids;
  }, [data, selectedId]);

  useEffect(() => {
    if (!flyTo || !graph.current || !data) return;
    const node = data.nodes.find((candidate) => candidate.id === flyTo.id);
    if (!node || node.x === undefined) return;
    const distance = 420;
    const ratio = 1 + distance / Math.hypot(node.x ?? 1, node.y ?? 1, node.z ?? 1);
    graph.current.cameraPosition(
      { x: (node.x ?? 0) * ratio, y: (node.y ?? 0) * ratio, z: (node.z ?? 0) * ratio },
      { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 },
      1200,
    );
  }, [flyTo, data]);

  const people = data?.nodes.filter((node) => node.label === 'User').length ?? 0;

  return (
    <div className="community" ref={setContainer}>
      {data && (
        <ForceGraph3D<GNode, GLink>
          ref={graph}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="#020617"
          showNavInfo={false}
          nodeId="id"
          nodeRelSize={4.5}
          nodeResolution={10}
          nodeVal={(node) => (node.label === 'Business' ? 6 : 1 + Math.sqrt(node.posts + node.comments))}
          nodeLabel={(node) =>
            `<div class="tip"><b>${escapeHtml(node.name)}</b><br/>${escapeHtml(node.group ?? '')}` +
            (node.label === 'User' ? `<br/>${node.posts} posts · ${node.comments} comments` : '') +
            '</div>'
          }
          nodeColor={(node) => {
            const base =
              node.label === 'Business' ? labelColor('Business') : (hoodColor.get(node.group ?? '') ?? '#64748b');
            if (!selectedId) return base;
            if (node.id === selectedId) return '#ffffff';
            return neighbors.has(String(node.id)) ? base : '#1e293b';
          }}
          nodeOpacity={0.92}
          // The library multiplies link colors by linkOpacity (default 0.2); let the colors' own alpha decide.
          linkOpacity={1}
          linkColor={(link) => {
            if (!selectedId) return disagreementColor(link, 0.75);
            const lit = endId(link.source) === selectedId || endId(link.target) === selectedId;
            return disagreementColor(link, lit ? 1 : 0.08);
          }}
          linkWidth={(link) =>
            selectedId && (endId(link.source) === selectedId || endId(link.target) === selectedId)
              ? 0.8 + Math.log2(link.weight + 1)
              : 0.6 + 0.7 * Math.log2(link.weight + 1)
          }
          linkDirectionalParticles={(link) =>
            selectedId && (endId(link.source) === selectedId || endId(link.target) === selectedId)
              ? Math.min(6, link.weight)
              : 0
          }
          linkDirectionalParticleWidth={1.6}
          linkDirectionalParticleColor={(link) => disagreementColor(link, 1)}
          onNodeClick={(node) => onSelect({ label: node.label, key: String(node.id), title: node.name })}
          onBackgroundClick={() => undefined}
          onEngineStop={() => {
            if (fitted.current === data) return;
            fitted.current = data;
            // Fit the connected core; small islands drift far away and would shrink everything.
            graph.current?.zoomToFit(900, 30, (node) => (degree.get(String(node.id)) ?? 0) >= 2);
          }}
          cooldownTicks={180}
          warmupTicks={20}
          enableNodeDrag={false}
        />
      )}
      <div className="overlay top-left">
        <div className="card compact">
          <div className="card-title">Who talks to whom</div>
          <div className="controls">
            <label>
              Period
              <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                {PERIODS.map((period) => (
                  <option key={period.days} value={period.days}>
                    {period.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Min. exchanges
              <select value={min} onChange={(event) => setMin(Number(event.target.value))}>
                {[1, 2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={businesses} onChange={(event) => setBusinesses(event.target.checked)} />
              Businesses
            </label>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => graph.current?.zoomToFit(800, 30, (node) => (degree.get(String(node.id)) ?? 0) >= 2)}
            >
              Fit
            </button>
          </div>
          <div className="muted small">
            {data ? `${people} people · ${data.links.length} links` : 'Loading network…'}
            {error && <span className="error"> {error}</span>}
          </div>
          <div className="legend">
            <span>
              <i style={{ background: '#60a5fa' }} /> replies, mostly agreeable
            </span>
            <span>
              <i style={{ background: '#f87171' }} /> replies, mostly disagreeing
            </span>
            <span>
              <i style={{ background: '#94a3b8' }} /> comments on posts
            </span>
            {businesses && (
              <span>
                <i style={{ background: labelColor('Business') }} /> mentions a business
              </span>
            )}
          </div>
        </div>
      </div>
      {hoods.length > 0 && (
        <div className="overlay bottom-left">
          <div className="card compact legend hoods">
            {hoods.map((hood) => (
              <span key={hood.name}>
                <i style={{ background: hood.color }} /> {hood.name} <span className="muted">{hood.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="overlay bottom-right muted small">drag to orbit · scroll to zoom · click a person</div>
    </div>
  );
}
