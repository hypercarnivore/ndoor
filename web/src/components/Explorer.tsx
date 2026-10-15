import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from '../App';
import { api, type LinkGroup, type NodeDetail, type NodeRef, nodeId } from '../api';
import { refSubtitle, refTitle } from '../labels';
import { LABELS, labelColor, relName } from '../theme';

export interface ExplorerCommand {
  type: 'focus' | 'expand';
  ref: Ref;
  nonce: number;
}

type EntityData = { ref: NodeRef; expanded: boolean; root: boolean; badge: string | null; selected: boolean };
type HubData = { owner: NodeRef; group: LinkGroup; loaded: number; color: string };
type EntityNode = Node<EntityData, 'entity'>;
type HubNode = Node<HubData, 'hub'>;
type FlowNode = EntityNode | HubNode;

/** Card size plus breathing room, for layout. */
const CARD = { width: 236, height: 64 };

const hubId = (owner: NodeRef, group: LinkGroup) =>
  `hub:${nodeId(owner)}:${group.rel}:${group.direction}:${group.label}`;

const CENTER_HANDLE = { left: '50%', top: '50%', opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0 };

const EntityCard = memo(({ data }: NodeProps<EntityNode>) => {
  const { ref, expanded, root, badge, selected } = data;
  const color = labelColor(ref.label);
  return (
    <div
      className={`entity${root ? ' root' : ''}${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}`}
      style={{ '--accent': color } as React.CSSProperties}
      title={ref.title}
    >
      <Handle type="target" position={Position.Top} style={CENTER_HANDLE} isConnectable={false} />
      <span className="entity-glyph">{LABELS[ref.label]?.glyph ?? '?'}</span>
      <span className="entity-text">
        <span className="entity-title">{refTitle(ref)}</span>
        <span className="entity-sub">
          {LABELS[ref.label]?.name ?? ref.label}
          {refSubtitle(ref) ? ` · ${refSubtitle(ref)}` : ''}
        </span>
      </span>
      {badge && <span className="entity-badge">{badge}</span>}
      <Handle type="source" position={Position.Bottom} style={CENTER_HANDLE} isConnectable={false} />
    </div>
  );
});

const HubPill = memo(({ data }: NodeProps<HubNode>) => {
  const { group, loaded, color } = data;
  const more = group.total - loaded;
  return (
    <div className="hub" style={{ '--accent': color } as React.CSSProperties}>
      <Handle type="target" position={Position.Top} style={CENTER_HANDLE} isConnectable={false} />
      <span>{relName(group.rel, group.direction)}</span>
      <b>{group.total}</b>
      {more > 0 && <span className="hub-more">+{more} more</span>}
      <Handle type="source" position={Position.Bottom} style={CENTER_HANDLE} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { entity: EntityCard, hub: HubPill };

function edgeBadge(rel: string, edge: Record<string, unknown>): string | null {
  if (rel === 'ABOUT' && typeof edge.p === 'number') return `${Math.round(edge.p * 100)}%`;
  if (rel === 'REACTED' && typeof edge.kind === 'string') return edge.kind.replace(/_/g, ' ');
  return null;
}

/**
 * Lay a node's link groups out around it: each group gets an angular sector
 * (wider for bigger groups), its hub sits on an inner ring, and its members
 * fill arcs further out. `facing` limits the fan to a half circle pointing
 * away from the rest of the graph when expanding.
 */
function layoutGroups(
  center: { x: number; y: number },
  groups: LinkGroup[],
  facing: number | null,
): Array<{ group: LinkGroup; hub: { x: number; y: number }; members: Array<{ x: number; y: number }> }> {
  const span = facing === null ? Math.PI * 2 : Math.PI * 1.3;
  const start = facing === null ? -Math.PI / 2 : facing - span / 2;
  const weights = groups.map((group) => Math.sqrt(group.nodes.length) + 1);
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  let angle = start;
  return groups.map((group, index) => {
    const width = (span * weights[index]) / total;
    const mid = angle + width / 2;
    // A lone group fans out all around: its hub sits just below the center so spokes do not cross it.
    const hubRadius = groups.length === 1 && facing === null ? 110 : 190;
    const hub = { x: center.x + Math.cos(mid) * hubRadius, y: center.y + Math.sin(mid) * hubRadius };
    const members: Array<{ x: number; y: number }> = [];
    // Cards are wide and short: neighbors along an arc need less room on the left and right sides
    // (the arc runs vertically there) and more at the top and bottom, and the reverse between rings.
    const along = Math.abs(Math.sin(mid)) * CARD.width + Math.abs(Math.cos(mid)) * CARD.height;
    const across = Math.abs(Math.cos(mid)) * CARD.width + Math.abs(Math.sin(mid)) * CARD.height;
    let radius = 360 + across / 2;
    let remaining = group.nodes.length;
    while (remaining > 0) {
      const capacity = Math.max(1, Math.floor((width * radius) / along));
      const count = Math.min(capacity, remaining);
      for (let i = 0; i < count; i++) {
        const a = count === 1 ? mid : angle + (width * (i + 0.5)) / count;
        members.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
      }
      remaining -= count;
      radius += across;
    }
    angle += width;
    return { group, hub, members };
  });
}

/** Approximate rendered size, for overlap checks before React Flow has measured a node. */
function boxOf(node: FlowNode): { w: number; h: number } {
  if (node.measured?.width && node.measured.height) return { w: node.measured.width, h: node.measured.height };
  if (node.type === 'hub') return { w: 130, h: 26 };
  return node.data.root ? { w: 250, h: 58 } : { w: 214, h: 48 };
}

/**
 * Push newly added nodes apart (and off existing ones, which stay put) until no
 * two cards overlap: a few passes of moving each overlapping pair along the
 * axis where they overlap least.
 */
function separate(fixed: FlowNode[], moving: FlowNode[]): FlowNode[] {
  const GAP = 14;
  const boxes = [
    ...fixed.map((node) => ({ node, ...boxOf(node), x: node.position.x, y: node.position.y, movable: false })),
    ...moving.map((node) => ({ node, ...boxOf(node), x: node.position.x, y: node.position.y, movable: true })),
  ];
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a.movable && !b.movable) continue;
        const dx = b.x + b.w / 2 - (a.x + a.w / 2);
        const dy = b.y + b.h / 2 - (a.y + a.h / 2);
        const overlapX = (a.w + b.w) / 2 + GAP - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + GAP - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        const share = a.movable && b.movable ? 0.5 : 1;
        if (overlapY < overlapX) {
          const push = (dy >= 0 ? 1 : -1) * overlapY * share;
          if (b.movable) b.y += push;
          if (a.movable) a.y -= push;
        } else {
          const push = (dx >= 0 ? 1 : -1) * overlapX * share;
          if (b.movable) b.x += push;
          if (a.movable) a.x -= push;
        }
      }
    }
    if (!moved) break;
  }
  return boxes.map((box) => (box.movable ? { ...box.node, position: { x: box.x, y: box.y } } : box.node));
}

function ExplorerInner({
  command,
  selected,
  onSelect,
  onFocus,
}: {
  command: ExplorerCommand | null;
  selected: Ref | null;
  onSelect: (ref: Ref) => void;
  onFocus: (ref: Ref) => void;
}) {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flow = useReactFlow();
  const handled = useRef<number | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  /** Add a node's groups around it. Existing nodes are reused and linked, never duplicated. */
  const grow = useCallback(
    (detail: NodeDetail, center: { x: number; y: number }, facing: number | null, fresh: boolean) => {
      const owner = detail.ref;
      const ownerId = nodeId(owner);
      const placed = layoutGroups(center, detail.links, facing);
      const base: FlowNode[] = fresh ? [] : nodesRef.current;
      const known = new Set(base.map((node) => node.id));
      const added: FlowNode[] = [];
      const newEdges: Edge[] = [];
      if (!known.has(ownerId)) {
        added.push({
          id: ownerId,
          type: 'entity',
          position: center,
          data: { ref: owner, expanded: true, root: fresh, badge: null, selected: false },
        });
        known.add(ownerId);
      }
      for (const { group, hub, members } of placed) {
        const id = hubId(owner, group);
        const color = labelColor(group.label);
        if (!known.has(id)) {
          added.push({
            id,
            type: 'hub',
            position: hub,
            data: { owner, group, loaded: group.nodes.length, color },
          });
          known.add(id);
        }
        newEdges.push({
          id: `${ownerId}->${id}`,
          source: ownerId,
          target: id,
          type: 'straight',
          className: 'edge-hub',
        });
        group.nodes.forEach((member, index) => {
          const memberId = nodeId(member);
          if (!known.has(memberId)) {
            added.push({
              id: memberId,
              type: 'entity',
              position: members[index],
              data: {
                ref: member,
                expanded: false,
                root: false,
                badge: edgeBadge(group.rel, member.edge),
                selected: false,
              },
            });
            known.add(memberId);
          }
          newEdges.push({
            id: `${id}->${memberId}`,
            source: id,
            target: memberId,
            type: 'straight',
            style: { stroke: color },
            className: 'edge-member',
          });
        });
      }
      const kept = fresh
        ? []
        : base.map((node) =>
            node.id === ownerId && node.type === 'entity' ? { ...node, data: { ...node.data, expanded: true } } : node,
          );
      setNodes(separate(kept, added));
      setEdges((current) => {
        const all = fresh ? newEdges : [...current, ...newEdges];
        return [...new Map(all.map((edge) => [edge.id, edge])).values()];
      });
    },
    [],
  );

  const run = useCallback(
    async (cmd: ExplorerCommand) => {
      setBusy(true);
      setError(null);
      try {
        const detail = await api.node(cmd.ref.label, cmd.ref.key);
        const id = nodeId(detail.ref);
        const existing = nodesRef.current.find((node) => node.id === id);
        if (cmd.type === 'focus' || !existing) {
          grow(detail, { x: 0, y: 0 }, null, true);
          setTimeout(() => flow.fitView({ duration: 500, padding: 0.15 }), 60);
        } else {
          const others = nodesRef.current.filter((node) => node.id !== id);
          const cx = others.reduce((sum, node) => sum + node.position.x, 0) / (others.length || 1);
          const cy = others.reduce((sum, node) => sum + node.position.y, 0) / (others.length || 1);
          const facing = Math.atan2(existing.position.y - cy, existing.position.x - cx);
          grow(detail, existing.position, facing, false);
          setTimeout(() => flow.fitView({ duration: 500, padding: 0.15 }), 60);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [flow, grow],
  );

  useEffect(() => {
    if (!command || handled.current === command.nonce) return;
    handled.current = command.nonce;
    void run(command);
  }, [command, run]);

  /** Next page of a hub's group, placed on the next ring out. */
  const loadMore = useCallback(async (hub: HubNode) => {
    const { owner, group, loaded } = hub.data;
    if (loaded >= group.total) return;
    setBusy(true);
    try {
      const page = await api.links(owner.label, owner.key, group, loaded, 25);
      const ownerNode = nodesRef.current.find((node) => node.id === nodeId(owner));
      const origin = ownerNode?.position ?? { x: 0, y: 0 };
      const angle = Math.atan2(hub.position.y - origin.y, hub.position.x - origin.x);
      const known = new Set(nodesRef.current.map((node) => node.id));
      const color = labelColor(group.label);
      const ring = 420 + 120 * (Math.floor(loaded / 8) + 1);
      const added: FlowNode[] = [];
      const newEdges: Edge[] = [];
      page.nodes.forEach((member, index) => {
        const memberId = nodeId(member);
        const a = angle + ((index - page.nodes.length / 2) * 0.9) / Math.max(4, page.nodes.length / 2);
        if (!known.has(memberId)) {
          added.push({
            id: memberId,
            type: 'entity',
            position: { x: origin.x + Math.cos(a) * ring, y: origin.y + Math.sin(a) * ring },
            data: {
              ref: member,
              expanded: false,
              root: false,
              badge: edgeBadge(group.rel, member.edge),
              selected: false,
            },
          });
        }
        newEdges.push({
          id: `${hub.id}->${memberId}`,
          source: hub.id,
          target: memberId,
          type: 'straight',
          style: { stroke: color },
          className: 'edge-member',
        });
      });
      setNodes((current) =>
        separate(
          current.map((node) =>
            node.id === hub.id
              ? ({ ...node, data: { ...hub.data, loaded: loaded + page.nodes.length } } as HubNode)
              : node,
          ),
          added,
        ),
      );
      setEdges((current) => [...current, ...newEdges]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const selectedId = selected ? nodeId(selected) : null;
  const visible = useMemo(() => {
    const hiddenIds = new Set<string>();
    const shown = nodes.filter((node) => {
      const label = node.type === 'entity' ? node.data.ref.label : (node as HubNode).data.group.label;
      const isHidden = hidden.has(label) && !(node.type === 'entity' && node.data.root);
      if (isHidden) hiddenIds.add(node.id);
      return !isHidden;
    });
    const near = new Set<string>();
    if (selectedId) {
      for (const edge of edges) {
        if (edge.source === selectedId) near.add(edge.target);
        if (edge.target === selectedId) near.add(edge.source);
      }
    }
    return {
      nodes: shown.map((node) =>
        node.type === 'entity' ? { ...node, data: { ...node.data, selected: node.id === selectedId } } : node,
      ),
      edges: edges
        .filter((edge) => !hiddenIds.has(edge.source) && !hiddenIds.has(edge.target))
        .map((edge) =>
          selectedId && (edge.source === selectedId || edge.target === selectedId || near.has(edge.source))
            ? { ...edge, className: `${edge.className ?? ''} edge-lit`, animated: edge.source === selectedId }
            : edge,
        ),
    };
  }, [nodes, edges, hidden, selectedId]);

  const presentLabels = useMemo(
    () => [...new Set(nodes.flatMap((node) => (node.type === 'entity' ? [node.data.ref.label] : [])))],
    [nodes],
  );

  return (
    <div className="explorer">
      {nodes.length === 0 && !busy && (
        <div className="empty">
          <h2>Explore connections</h2>
          <p>
            Search for a person, post, place, business, or theme (<kbd>⌘K</kbd>), or pick one from the overview. Click a
            card to inspect it, double-click to recenter on it, and click a relationship pill to load more.
          </p>
        </div>
      )}
      <ReactFlow
        nodes={visible.nodes}
        edges={visible.edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current) as FlowNode[])}
        onNodeClick={(_, node) => {
          if (node.type === 'hub') void loadMore(node as HubNode);
          else onSelect((node as EntityNode).data.ref);
        }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'entity') onFocus((node as EntityNode).data.ref);
        }}
        minZoom={0.05}
        maxZoom={2.5}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="#1e293b" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          bgColor="#0b1120"
          maskColor="rgba(2, 6, 23, 0.7)"
          nodeColor={(node) => (node.type === 'hub' ? '#334155' : labelColor((node as EntityNode).data.ref.label))}
        />
      </ReactFlow>
      <div className="explorer-toolbar">
        {presentLabels.map((label) => (
          <button
            key={label}
            type="button"
            className={hidden.has(label) ? 'chip off' : 'chip'}
            style={{ '--accent': labelColor(label) } as React.CSSProperties}
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(label)) next.delete(label);
                else next.add(label);
                return next;
              })
            }
          >
            {LABELS[label]?.name ?? label}
          </button>
        ))}
        {nodes.length > 0 && (
          <span className="muted small">
            {nodes.filter((node) => node.type === 'entity').length} nodes · double-click to recenter
          </span>
        )}
        {busy && <span className="spinner" />}
        {error && <span className="error small">{error}</span>}
      </div>
    </div>
  );
}

export function Explorer(props: Parameters<typeof ExplorerInner>[0]) {
  return (
    <ReactFlowProvider>
      <ExplorerInner {...props} />
    </ReactFlowProvider>
  );
}
