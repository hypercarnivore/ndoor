import { useState } from 'react';
import { api, type Row } from '../api';
import {
  Clip,
  DataTable,
  day,
  go,
  num,
  Page,
  type PageProps,
  Panel,
  SearchInput,
  SortSelect,
  str,
  Tone,
  useLoad,
} from '../components/ui';
import { themeLabel } from '../labels';

const SORTS = {
  recent: 'Most recent',
  reactions: 'Most reactions',
  comments: 'Most comments',
  hostile: 'Most hostile',
  urgent: 'Most urgent',
  warmest: 'Warmest',
  coldest: 'Coldest',
};

export function Posts({ days, onDays, onSelect, selected, params }: PageProps) {
  const [sort, setSort] = useState(params.get('sort') ?? 'recent');
  const [q, setQ] = useState('');
  const theme = params.get('theme') ?? '';
  const hood = params.get('hood') ?? '';
  const themes = useLoad(() => api.themes(days), [days]);
  const hoods = useLoad(() => api.neighborhoods(days), [days]);
  const { data, error } = useLoad(() => api.posts({ days, sort, q, theme, hood }), [days, sort, q, theme, hood]);
  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    const text = next.toString();
    go(`posts${text ? `?${text}` : ''}`);
  };
  const hoodName = hoods.data?.find((row) => row.id === hood)?.name;

  return (
    <Page
      title="Posts"
      subtitle={
        [theme && `about ${themeLabel(theme)}`, hood && `from ${str(hoodName ?? hood)}`].filter(Boolean).join(' · ') ||
        'Every post in the period'
      }
      days={days}
      onDays={onDays}
      actions={
        <>
          <SearchInput placeholder="Search text" onChange={setQ} />
          <label className="inline-control">
            Theme
            <select value={theme} onChange={(event) => setFilter('theme', event.target.value)}>
              <option value="">all</option>
              {(themes.data ?? []).map((row) => (
                <option key={str(row.name)} value={str(row.name)}>
                  {themeLabel(str(row.name))}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-control">
            Neighborhood
            <select value={hood} onChange={(event) => setFilter('hood', event.target.value)}>
              <option value="">all</option>
              {(hoods.data ?? [])
                .filter((row) => num(row.posts) > 0)
                .map((row) => (
                  <option key={str(row.id)} value={str(row.id)}>
                    {str(row.name)}
                  </option>
                ))}
            </select>
          </label>
          <SortSelect value={sort} options={SORTS} onChange={setSort} />
        </>
      }
    >
      {error && <div className="error pad">{error}</div>}
      <Panel wide title={`${data?.length ?? '…'} posts`} hint="click a post to read its thread">
        <DataTable
          rows={data}
          rowKey={(row) => str(row.id)}
          selectedKey={selected?.key}
          onRow={(row: Row) => onSelect({ label: 'Post', key: str(row.id), title: str(row.subject || row.body) })}
          columns={[
            {
              key: 'subject',
              name: 'Post',
              width: '34%',
              render: (row) => <Clip text={row.subject || row.body} title={row.body} />,
            },
            { key: 'author', name: 'Author', render: (row) => <Clip text={row.author} /> },
            { key: 'neighborhood', name: 'Neighborhood', render: (row) => <Clip text={row.neighborhood} /> },
            {
              key: 'theme',
              name: 'Theme',
              render: (row) => <Clip text={row.theme ? themeLabel(str(row.theme)) : '–'} />,
            },
            { key: 'reactions', name: 'Reactions', numeric: true },
            { key: 'comments', name: 'Comments', numeric: true },
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
      </Panel>
    </Page>
  );
}
