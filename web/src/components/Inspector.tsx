import { useEffect, useState } from 'react';
import type { Ref } from '../App';
import { api, type LinkGroup, type NodeDetail, type Thread, type ThreadComment } from '../api';
import { FIELDS, fieldValue, intentLabel, placeLabel, refSubtitle, refTitle, stanceLabel, themeLabel } from '../labels';
import { LABELS, labelColor, relName, STANCE_COLORS, toneColor } from '../theme';
import { SentimentCard } from './Sentiment';

const HIDDEN = new Set(['id', 'name', 'subject', 'body', 'biography', 'description', 'url', 'profileUrl', 'shareId']);
const JEV_POST = [
  'primaryTheme',
  'primaryThemeConfidence',
  'intent',
  'tone',
  'hostility',
  'urgency',
  'asksQuestion',
  'accuses',
];
const JEV_COMMENT = ['stance', 'tone', 'hostility', 'helpful', 'recommendsBusiness'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function formatValue(name: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">none</span>;
  if (typeof value === 'string' && ISO.test(value)) return new Date(value).toLocaleString();
  if (typeof value === 'string' && name !== 'reactionsByType') return fieldValue(name, value);
  if (name === 'reactionsByType' && typeof value === 'string') {
    try {
      const counts = JSON.parse(value) as Record<string, number>;
      return (
        <span className="chips">
          {Object.entries(counts).map(([kind, n]) => (
            <span key={kind} className="chip static">
              {kind} {n}
            </span>
          ))}
        </span>
      );
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">none</span>;
    return (
      <span className="chips">
        {value.map((item) => (
          <span key={String(item)} className="chip static">
            {String(item)
              .replace(/^https?:\/\//, '')
              .slice(0, 40)}
          </span>
        ))}
      </span>
    );
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' && !Number.isInteger(value)) return value.toFixed(2);
  return String(value);
}

function Gauge({ label, value, max, color }: { label: string; value: number | null; max: number; color: string }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="gauge">
      <span className="gauge-label">{label}</span>
      <span className="gauge-track">
        <span className="gauge-fill" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
      </span>
      <span className="gauge-value">{max === 1 ? `${Math.round(value * 100)}%` : value.toFixed(1)}</span>
    </div>
  );
}

const num = (value: unknown) => (typeof value === 'number' ? value : null);

function JevPanel({ label, props }: { label: string; props: Record<string, unknown> }) {
  if (!props.jevVersion) return null;
  const hostility = num(props.hostility);
  return (
    <div className="card">
      <div className="card-title">AI assessment</div>
      <div className="chips">
        {typeof props.primaryTheme === 'string' && (
          <span className="chip static" style={{ '--accent': labelColor('Theme') } as React.CSSProperties}>
            {themeLabel(props.primaryTheme)}
            {num(props.primaryThemeConfidence) !== null && ` ${Math.round(num(props.primaryThemeConfidence)! * 100)}%`}
          </span>
        )}
        {typeof props.intent === 'string' && <span className="chip static">{intentLabel(props.intent)}</span>}
        {typeof props.placeScope === 'string' && <span className="chip static">{placeLabel(props.placeScope)}</span>}
        {typeof props.stance === 'string' && (
          <span className="chip static" style={{ '--accent': STANCE_COLORS[props.stance] } as React.CSSProperties}>
            {stanceLabel(props.stance)}
          </span>
        )}
      </div>
      <Gauge label="Tone" value={num(props.tone)} max={1} color={toneColor(num(props.tone))} />
      <Gauge
        label="Hostility"
        value={hostility}
        max={3}
        color={hostility !== null && hostility >= 1.5 ? '#f87171' : '#f59e0b'}
      />
      {label === 'Post' && <Gauge label="Urgency" value={num(props.urgency)} max={3} color="#fb923c" />}
      {label === 'Post' && <Gauge label="Asks a question" value={num(props.asksQuestion)} max={1} color="#60a5fa" />}
      {label === 'Post' && <Gauge label="Accuses someone" value={num(props.accuses)} max={1} color="#f87171" />}
      {label === 'Comment' && <Gauge label="Helpful" value={num(props.helpful)} max={1} color="#34d399" />}
      {label === 'Comment' && (
        <Gauge
          label="Recommends a business"
          value={num(props.recommendsBusiness)}
          max={1}
          color={labelColor('Business')}
        />
      )}
    </div>
  );
}

function CommentNode({
  comment,
  tree,
  onPick,
}: {
  comment: ThreadComment;
  tree: Map<string, ThreadComment[]>;
  onPick: (ref: Ref) => void;
}) {
  const replies = tree.get(comment.id) ?? [];
  return (
    <div className={comment.removed ? 'comment removed' : 'comment'}>
      <div className="comment-head">
        <span className="tone-dot" style={{ background: toneColor(comment.tone) }} title="tone" />
        {comment.author ? (
          <button type="button" className="link" onClick={() => onPick({ label: 'User', key: comment.author!.id })}>
            {comment.author.name}
          </button>
        ) : (
          <span className="muted">unknown</span>
        )}
        {comment.stance && (
          <span className="stance" style={{ color: STANCE_COLORS[comment.stance] }}>
            {stanceLabel(comment.stance)}
          </span>
        )}
        {comment.hostility !== null && comment.hostility >= 1.5 && <span className="stance hostile">hostile</span>}
        <span className="muted small">
          {comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : ''}
          {comment.reactions ? ` · ${comment.reactions} reactions` : ''}
          {comment.removed ? ' · removed' : ''}
        </span>
      </div>
      <button type="button" className="comment-body" onClick={() => onPick({ label: 'Comment', key: comment.id })}>
        {comment.body || <span className="muted">(no text)</span>}
      </button>
      {replies.length > 0 && (
        <div className="replies">
          {replies.map((reply) => (
            <CommentNode key={reply.id} comment={reply} tree={tree} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadView({ thread, onPick }: { thread: Thread; onPick: (ref: Ref) => void }) {
  const ids = new Set(thread.comments.map((comment) => comment.id));
  const children = new Map<string, ThreadComment[]>();
  const top: ThreadComment[] = [];
  for (const comment of thread.comments) {
    if (comment.replyTo && ids.has(comment.replyTo)) {
      children.set(comment.replyTo, [...(children.get(comment.replyTo) ?? []), comment]);
    } else {
      top.push(comment);
    }
  }
  return (
    <div className="card">
      <div className="card-title">
        Thread <span className="muted">{thread.comments.length} comments seen</span>
      </div>
      {top.length === 0 && <div className="muted small">No comments loaded for this post.</div>}
      {top.map((comment) => (
        <CommentNode key={comment.id} comment={comment} tree={children} onPick={onPick} />
      ))}
    </div>
  );
}

function LinkList({
  owner,
  group,
  onSelect,
  onExplore,
}: {
  owner: Ref;
  group: LinkGroup;
  onSelect: (ref: Ref) => void;
  onExplore: (ref: Ref) => void;
}) {
  const [items, setItems] = useState(group.nodes);
  const [open, setOpen] = useState(group.total <= 6);
  useEffect(() => setItems(group.nodes), [group]);
  const more = group.total - items.length;
  return (
    <div className="links">
      <button type="button" className="links-head" onClick={() => setOpen(!open)}>
        <span className="dot" style={{ background: labelColor(group.label) }} />
        {relName(group.rel, group.direction)}
        <span className="muted">
          {group.total}{' '}
          {(group.total === 1
            ? (LABELS[group.label]?.name ?? group.label)
            : (LABELS[group.label]?.plural ?? group.label)
          ).toLowerCase()}
        </span>
        <span className="caret">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <ul>
          {items.map((item) => (
            <li key={`${item.label}:${item.key}`}>
              <button
                type="button"
                className="link-item"
                onClick={() => onSelect(item)}
                onDoubleClick={() => onExplore(item)}
              >
                <span className="link-title">{refTitle(item)}</span>
                {refSubtitle(item) && <span className="muted small">{refSubtitle(item)}</span>}
                {typeof item.edge.p === 'number' && (
                  <span className="muted small">{Math.round(item.edge.p * 100)}%</span>
                )}
              </button>
            </li>
          ))}
          {more > 0 && (
            <li>
              <button
                type="button"
                className="link more"
                onClick={async () => {
                  const page = await api.links(owner.label, owner.key, group, items.length, 25);
                  setItems((current) => [...current, ...page.nodes]);
                }}
              >
                load {Math.min(25, more)} more of {more}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function Inspector({
  selected,
  canExpand,
  onSelect,
  onExplore,
  onExpand,
  onClose,
}: {
  selected: Ref | null;
  canExpand: boolean;
  onSelect: (ref: Ref) => void;
  onExplore: (ref: Ref) => void;
  onExpand: (ref: Ref) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setError(null);
    setThread(null);
    api
      .node(selected.label, selected.key)
      .then((result) => !stale && setDetail(result))
      .catch((err) => !stale && setError(err instanceof Error ? err.message : String(err)));
    if (selected.label === 'Post') {
      api
        .thread(selected.key)
        .then((result) => !stale && setThread(result))
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
  }, [selected]);

  if (!selected) {
    return (
      <aside className="inspector">
        <div className="muted pad">Select a node to see its details and connections.</div>
      </aside>
    );
  }
  const current = detail && detail.ref.key === selected.key && detail.ref.label === selected.label ? detail : null;
  const props = current?.properties ?? {};
  const label = selected.label;
  // Nextdoor bodies usually repeat the subject as their first line; show it once.
  const body = typeof props.body === 'string' ? props.body : '';
  const subject = typeof props.subject === 'string' && !body.startsWith(props.subject) ? props.subject : '';
  const text = [subject, body, props.biography, props.description].filter(
    (value, index, all): value is string => typeof value === 'string' && value !== '' && all.indexOf(value) === index,
  );
  const external =
    typeof props.url === 'string' ? props.url : typeof props.profileUrl === 'string' ? props.profileUrl : null;
  const jevKeys = new Set(label === 'Post' ? JEV_POST : label === 'Comment' ? JEV_COMMENT : []);
  // Only fields with a plain-language name are shown, in that order; the rest are internal.
  const rows = Object.keys(FIELDS)
    .filter((name) => name in props && !HIDDEN.has(name) && !jevKeys.has(name))
    .map((name) => [name, props[name]] as const);

  return (
    <aside className="inspector" style={{ '--accent': labelColor(label) } as React.CSSProperties}>
      <div className="inspector-head">
        <span className="type-pill">{LABELS[label]?.name ?? label}</span>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <h2 className="inspector-title">{refTitle(current?.ref ?? selected)}</h2>
      <div className="actions">
        <button type="button" className="btn" onClick={() => onExplore(selected)}>
          Explore from here
        </button>
        {canExpand && (
          <button type="button" className="btn ghost" onClick={() => onExpand(selected)}>
            Expand in place
          </button>
        )}
        {label === 'Business' && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              window.location.hash = `#/business/${encodeURIComponent(selected.key)}`;
            }}
          >
            Business page
          </button>
        )}
        {external && (
          <a className="btn ghost" href={external} target="_blank" rel="noreferrer noopener">
            Open on Nextdoor
          </a>
        )}
      </div>
      {error && <div className="error pad">{error}</div>}
      {!current && !error && <div className="spinner pad" />}
      {current && (
        <>
          {text.map((paragraph) => (
            <p key={paragraph.slice(0, 40)} className="prose">
              {paragraph}
            </p>
          ))}
          {(label === 'User' || label === 'Business') && <SentimentCard label={label} nodeKey={selected.key} />}
          <JevPanel label={label} props={props} />
          <div className="card">
            <div className="card-title">Properties</div>
            <dl className="props">
              {rows.map(([name, value]) => (
                <div key={name}>
                  <dt>{FIELDS[name]}</dt>
                  <dd>{formatValue(name, value)}</dd>
                </div>
              ))}
            </dl>
          </div>
          {thread && <ThreadView thread={thread} onPick={onSelect} />}
          <div className="card">
            <div className="card-title">Connections</div>
            {current.links.length === 0 && <div className="muted small">No connections.</div>}
            {current.links.map((group) => (
              <LinkList
                key={`${group.rel}:${group.direction}:${group.label}`}
                owner={selected}
                group={group}
                onSelect={onSelect}
                onExplore={onExplore}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
