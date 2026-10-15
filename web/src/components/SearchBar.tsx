import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type NodeRef, type SearchGroup } from '../api';
import { refSubtitle, refTitle } from '../labels';
import { LABELS, labelColor } from '../theme';

/** Global search (Cmd/Ctrl-K or /): people, places, businesses, themes, posts, and comments. */
export function SearchBar({ onPick }: { onPick: (ref: NodeRef) => void }) {
  const [text, setText] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const flat = useMemo(() => groups.flatMap((group) => group.nodes), [groups]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setGroups([]);
      return;
    }
    let stale = false;
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((result) => {
          if (stale) return;
          setGroups(result);
          setActive(0);
        })
        .catch(() => !stale && setGroups([]))
        .finally(() => !stale && setBusy(false));
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [text]);

  const choose = (ref: NodeRef | undefined) => {
    if (!ref) return;
    onPick(ref);
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="search">
      <input
        ref={input}
        value={text}
        placeholder="Search people, posts, places, businesses, themes"
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') setActive((i) => Math.min(i + 1, flat.length - 1));
          else if (event.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
          else if (event.key === 'Enter') choose(flat[active]);
          else if (event.key === 'Escape') input.current?.blur();
          else return;
          event.preventDefault();
        }}
      />
      <kbd className="search-hint">⌘K</kbd>
      {open && text.trim().length >= 2 && (
        <div className="search-results">
          {busy && flat.length === 0 && <div className="muted pad">Searching…</div>}
          {!busy && flat.length === 0 && <div className="muted pad">No matches</div>}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="search-group">{LABELS[group.label]?.name ?? group.label}</div>
              {group.nodes.map((node) => {
                const index = flat.indexOf(node);
                return (
                  <button
                    type="button"
                    key={`${node.label}:${node.key}`}
                    className={index === active ? 'search-item active' : 'search-item'}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(node)}
                  >
                    <span className="dot" style={{ background: labelColor(node.label) }} />
                    <span className="search-title">{refTitle(node)}</span>
                    {refSubtitle(node) && <span className="muted small">{refSubtitle(node)}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
