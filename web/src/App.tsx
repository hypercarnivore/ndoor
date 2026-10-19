import { useCallback, useEffect, useState } from 'react';
import type { NodeRef } from './api';
import { Community } from './components/Community';
import { Dashboard } from './components/Dashboard';
import { Explorer, type ExplorerCommand } from './components/Explorer';
import { Inspector } from './components/Inspector';
import { SearchBar } from './components/SearchBar';
import type { PageProps } from './components/ui';
import { Business } from './pages/Business';
import { Businesses } from './pages/Businesses';
import { Comments } from './pages/Comments';
import { HealthDrill } from './pages/HealthDrill';
import { Newcomers } from './pages/Newcomers';
import { People } from './pages/People';
import { Groups, Neighborhoods, Themes } from './pages/Places';
import { Politics } from './pages/Politics';
import { Posts } from './pages/Posts';
import { Topic } from './pages/Topic';
import { WhatIf } from './pages/WhatIf';

export type Ref = Pick<NodeRef, 'label' | 'key'> & Partial<Pick<NodeRef, 'title' | 'subtitle'>>;

/** Screens reached by the hash route; explore and community stay mounted once opened. */
const PAGES = [
  'people',
  'posts',
  'comments',
  'neighborhoods',
  'themes',
  'groups',
  'businesses',
  'business',
  'health',
  'topic',
  'newcomers',
  'politics',
  'whatif',
] as const;
type PageName = (typeof PAGES)[number];
export type View = 'overview' | 'explore' | 'community' | PageName;

interface Route {
  view: View;
  /** The rest of the path: a business id, a health signal, or an explore Label/key. */
  rest: string[];
  params: URLSearchParams;
}

/** Routes: #/overview, #/businesses, #/topic/<safety|schools>, #/politics, #/business/<id>, #/people, #/posts?theme=..., #/health/<signal>, #/whatif?scenario=<people|threads|hostility|answers|themes|places>, #/explore/<Label>/<key>, #/community. */
function parseHash(hash: string): Route {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const head = parts[0] ?? 'overview';
  const known = ['overview', 'explore', 'community', ...PAGES] as string[];
  return {
    view: (known.includes(head) ? head : 'overview') as View,
    rest: parts.slice(1),
    params: new URLSearchParams(search),
  };
}

const exploreRef = (route: Route): Ref | null =>
  route.view === 'explore' && route.rest.length >= 2
    ? { label: route.rest[0], key: route.rest.slice(1).join('/') }
    : null;

const TABS: Array<{ view: View; name: string }> = [
  { view: 'overview', name: 'Overview' },
  { view: 'businesses', name: 'Businesses' },
  { view: 'politics', name: 'Politics' },
  { view: 'whatif', name: 'What if' },
  { view: 'explore', name: 'Explore' },
  { view: 'community', name: 'Community 3D' },
];

export function App() {
  const initial = parseHash(window.location.hash);
  const [route, setRoute] = useState<Route>(initial);
  const [selected, setSelected] = useState<Ref | null>(exploreRef(initial));
  const [command, setCommand] = useState<ExplorerCommand | null>(() => {
    const ref = exploreRef(initial);
    return ref ? { type: 'focus', ref, nonce: 0 } : null;
  });
  const [flyTo, setFlyTo] = useState<{ id: string; nonce: number } | null>(null);
  const [visited, setVisited] = useState<Set<View>>(new Set([initial.view]));
  /** One period for every screen, so drilling down keeps the window you were looking at. */
  const [days, setDays] = useState(365);

  useEffect(() => {
    const onHash = () => {
      const next = parseHash(window.location.hash);
      setRoute(next);
      setVisited((seen) => new Set(seen).add(next.view));
      const ref = exploreRef(next);
      if (ref) {
        setSelected(ref);
        setCommand((current) =>
          current?.ref.key === ref.key && current?.ref.label === ref.label
            ? current
            : { type: 'focus', ref, nonce: Date.now() },
        );
      }
      document.querySelector('.stage .dashboard')?.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /** Recenter the explorer on a node (a navigation: it lands in history). */
  const explore = useCallback((ref: Ref) => {
    setSelected(ref);
    setCommand({ type: 'focus', ref, nonce: Date.now() });
    window.location.hash = `#/explore/${encodeURIComponent(ref.label)}/${encodeURIComponent(ref.key)}`;
  }, []);

  const expand = useCallback((ref: Ref) => {
    setSelected(ref);
    setCommand({ type: 'expand', ref, nonce: Date.now() });
  }, []);

  const view = route.view;
  const pick = useCallback(
    (ref: Ref) => {
      if (view === 'community') {
        setSelected(ref);
        setFlyTo({ id: ref.key, nonce: Date.now() });
      } else if (ref.label === 'Business') {
        window.location.hash = `#/business/${encodeURIComponent(ref.key)}`;
      } else {
        explore(ref);
      }
    },
    [view, explore],
  );

  const pageProps: PageProps = { days, onDays: setDays, onSelect: setSelected, selected, params: route.params };
  const isPage = (PAGES as readonly string[]).includes(view);
  const showInspector = view === 'explore' || view === 'community' || (isPage && selected !== null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          ndoor <em>atlas</em>
        </div>
        <nav className="tabs">
          {TABS.map((tab) => (
            <button
              key={tab.view}
              type="button"
              className={view === tab.view || (tab.view === 'businesses' && view === 'business') ? 'tab active' : 'tab'}
              onClick={() => {
                window.location.hash = `#/${tab.view}`;
              }}
            >
              {tab.name}
            </button>
          ))}
        </nav>
        <SearchBar onPick={pick} />
      </header>
      <main className={`body view-${view}`}>
        <section className="stage">
          {view === 'overview' && (
            <div className="pane">
              <Dashboard days={days} onDays={setDays} onPick={explore} />
            </div>
          )}
          {isPage && (
            <div className="pane">
              {view === 'people' && <People {...pageProps} />}
              {view === 'posts' && <Posts key={route.params.toString()} {...pageProps} />}
              {view === 'comments' && <Comments {...pageProps} />}
              {view === 'neighborhoods' && <Neighborhoods {...pageProps} />}
              {view === 'themes' && <Themes {...pageProps} />}
              {view === 'groups' && <Groups {...pageProps} />}
              {view === 'businesses' && <Businesses {...pageProps} />}
              {view === 'business' && route.rest[0] && (
                <Business key={route.rest[0]} {...pageProps} id={route.rest[0]} />
              )}
              {view === 'health' && <HealthDrill {...pageProps} signal={route.rest[0] ?? 'civility'} />}
              {view === 'topic' && route.rest[0] && <Topic key={route.rest[0]} {...pageProps} topic={route.rest[0]} />}
              {view === 'newcomers' && <Newcomers {...pageProps} />}
              {view === 'politics' && <Politics {...pageProps} />}
              {view === 'whatif' && <WhatIf {...pageProps} />}
            </div>
          )}
          {visited.has('explore') && (
            <div className="pane" hidden={view !== 'explore'}>
              <Explorer command={command} selected={selected} onSelect={setSelected} onFocus={explore} />
            </div>
          )}
          {visited.has('community') && (
            <div className="pane" hidden={view !== 'community'}>
              <Community active={view === 'community'} flyTo={flyTo} selected={selected} onSelect={setSelected} />
            </div>
          )}
        </section>
        {showInspector && (
          <Inspector
            selected={selected}
            canExpand={view === 'explore'}
            onSelect={setSelected}
            onExplore={explore}
            onExpand={expand}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}
