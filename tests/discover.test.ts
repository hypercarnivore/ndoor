import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assignDiscoveredThemes,
  claudeCliProposer,
  type DiscoveredTheme,
  discoverThemes,
  discoveryPrompt,
  parseDiscoveredThemes,
  parseProposals,
  pickSample,
  readDiscoveredThemes,
  themeSetId,
  writeDiscoveredThemes,
} from '../src/lib/discover.js';
import { GraphStore } from '../src/lib/graph.js';
import { JevAnalyzer, type SystemOneClient } from '../src/lib/jev.js';
import { mapPost } from '../src/lib/model.js';
import { REPORTS } from '../src/lib/reports.js';
import { parseWatches } from '../src/lib/watch.js';
import { post } from './fixtures/payloads.js';

const NOW = '2026-10-11T08:00:00.000Z';
const SINCE = '2000-01-01T00:00:00.000Z';
const TROLLEY: DiscoveredTheme = {
  id: 'trolley_service',
  description: 'the trolley schedule, fares, or service disruptions',
};
const PLANT: DiscoveredTheme = { id: 'plant_odor', description: 'smell or emissions from the treatment plant' };

describe('themes file', () => {
  it('round-trips and validates ids, collisions, and duplicates', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ndoor-themes-')), 'cfg', 'themes.json5');
    expect(readDiscoveredThemes(path)).toEqual([]);
    writeDiscoveredThemes(path, [TROLLEY]);
    expect(readDiscoveredThemes(path)).toEqual([TROLLEY]);
    expect(() => parseDiscoveredThemes('{ themes: [{ id: "Bad Id", description: "something long" }] }')).toThrow(
      /lowercase/,
    );
    expect(() => parseDiscoveredThemes('{ themes: [{ id: "crime_safety", description: "something long" }] }')).toThrow(
      /built-in/,
    );
    const twice = JSON.stringify({ themes: [TROLLEY, TROLLEY] });
    expect(() => parseDiscoveredThemes(twice)).toThrow(/duplicate/);
  });

  it('versions a set by content, not order', () => {
    expect(themeSetId([TROLLEY, PLANT])).toBe(themeSetId([PLANT, TROLLEY]));
    expect(themeSetId([TROLLEY])).not.toBe(themeSetId([{ ...TROLLEY, description: 'trolleys only' }]));
    expect(themeSetId([TROLLEY])).toMatch(/^discovered-[0-9a-f]{12}$/);
  });
});

describe('pickSample', () => {
  const row = (id: string, body: string, fit: number | null, primaryTheme: string | null = null) => ({
    id,
    subject: '',
    body,
    fit,
    primaryTheme,
  });

  it('favors poorly fitting posts, then fills by engagement, skipping duplicates and fragments', () => {
    const rows = [
      row('a', 'well explained post about a lost dog', 0.9),
      row('b', 'well explained post about a lost cat', 0.95),
      row('c', 'the plant smells terrible again this morning', 0.2),
      row('d', 'the plant smells terrible again this morning', 0.1),
      row('e', 'trolley canceled, anyone know why it stopped', null, 'other'),
      row('f', 'too short', 0.1),
    ];
    expect(pickSample(rows, 3).map((p) => p.id)).toEqual(['c', 'e', 'a']);
  });
});

describe('proposals', () => {
  const sample = [
    { id: 'post_1', text: 'trolley late' },
    { id: 'post_2', text: 'trolley canceled' },
  ];

  it('normalizes ids, maps example numbers to post ids, and rejects clashes', () => {
    const { themes, rejected } = parseProposals(
      {
        themes: [
          { id: 'Trolley-Service', description: 'the trolley schedule or fares?', examples: [1, 2, 9] },
          { id: 'crime_safety', description: 'crime and safety things', examples: [1] },
          { id: 'trolley_service', description: 'duplicate of the first', examples: [] },
          { id: 'x', description: 'too short an id', examples: [] },
          { id: 'plant_odor', description: 'smell from the plant', examples: [] },
        ],
      },
      sample,
      { crime_safety: 'crime' },
      1,
    );
    expect(themes).toEqual([
      { id: 'trolley_service', description: 'the trolley schedule or fares', examples: ['post_1', 'post_2'] },
    ]);
    expect(rejected).toEqual([
      expect.stringMatching(/^crime_safety:/),
      'trolley_service: already tracked',
      expect.stringMatching(/^x:/),
    ]);
    expect(() => parseProposals({}, sample, {}, 5)).toThrow(/no themes/);
  });

  it('builds a prompt that lists tracked themes and numbered posts inside a data block', () => {
    const prompt = discoveryPrompt(sample, { trolley_service: 'trolleys' }, 4);
    expect(prompt).toContain('- trolley_service: trolleys');
    expect(prompt).toContain('<posts>\n[1] trolley late\n[2] trolley canceled\n</posts>');
    expect(prompt).toContain('up to 4 additional themes');
  });
});

describe('claudeCliProposer', () => {
  // A stand-in executable with the claude CLI's print-mode contract: reads stdin, prints a JSON result.
  function fakeCli(script: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'ndoor-cli-')), 'claude');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o700);
    return path;
  }

  it('sends the prompt on stdin, passes no tools, and returns structured output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndoor-cli-args-'));
    const command = fakeCli(
      `printf '%s\\n' "$@" > '${dir}/args'; input=$(cat); printf '{"is_error":false,"structured_output":{"echo":"%s"}}' "$input"`,
    );
    const result = await claudeCliProposer({ command, model: 'haiku' }).propose('hello', { type: 'object' });
    expect(result).toEqual({ echo: 'hello' });
    const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
    expect(args.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('fails loudly on errors and missing binaries', async () => {
    const failing = fakeCli(`cat >/dev/null; echo '{"is_error":true,"result":"rate limited"}'; exit 1`);
    await expect(claudeCliProposer({ command: failing }).propose('x', {})).rejects.toThrow(/rate limited/);
    await expect(claudeCliProposer({ command: '/nonexistent/claude' }).propose('x', {})).rejects.toThrow(
      /Could not run the claude CLI/,
    );
  });
});

describe('discovery over a real graph', () => {
  let store: GraphStore;

  beforeEach(async () => {
    store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-discover-')), 'graph.lbug'));
    for (let i = 0; i < 24; i++) {
      const body =
        i % 2 ? `The trolley was canceled again, trip number ${i}` : `Treatment plant smell is strong today, day ${i}`;
      await store.ingestPost(mapPost(post(`P${i}`, { subject: '', body }))!, NOW);
    }
  });

  afterEach(async () => {
    await store?.close();
  });

  it('samples only cached posts and validates what the proposer returns', async () => {
    let prompt = '';
    const result = await discoverThemes(
      store,
      {
        async propose(text) {
          prompt = text;
          return {
            themes: [
              { ...TROLLEY, examples: [1, 2] },
              { id: 'crime_safety', description: 'dup', examples: [] },
            ],
          };
        },
      },
      { since: SINCE, sample: 30, max: 5, current: [PLANT] },
    );
    expect(result.sampled).toBe(24);
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0].examples).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(prompt).toContain('- plant_odor: smell or emissions from the treatment plant');
    expect(prompt).toContain('The trolley was canceled again');
  });

  it('refuses to propose from a nearly empty graph', async () => {
    await expect(
      discoverThemes(store, { propose: async () => ({ themes: [] }) }, { since: NOW, sample: 30, max: 5, current: [] }),
    ).rejects.toThrow(/run `ndoor sync` first/);
  });

  it('assigns themes with Jev, skips judged posts, and re-judges when the set changes', async () => {
    const asked: string[][] = [];
    const client: SystemOneClient = {
      async systemOne(request) {
        const ids = Object.keys(request.questions);
        asked.push(ids);
        const body = JSON.stringify(request.state);
        return {
          model: 'jev-test',
          usage: { input_tokens: 5 },
          answers: Object.fromEntries(
            ids.map((id) => [
              id,
              { type: 'noul', noul: id.includes('trolley') === body.includes('trolley') ? 0.9 : 0.05 },
            ]),
          ),
        } as never;
      },
    };
    const analyzer = new JevAnalyzer(client, { concurrency: 4 });

    const first = await assignDiscoveredThemes(store, analyzer, [TROLLEY, PLANT], { limit: 100 });
    expect(first).toEqual({ posts: 24, inputTokens: 120 });
    expect(asked[0].sort()).toEqual(['theme.plant_odor', 'theme.trolley_service']);
    const rows = await store.run(REPORTS.themes.cypher, { limit: 10, since: SINCE });
    expect(rows.map((row) => [row.theme, row.source, row.posts])).toEqual(
      expect.arrayContaining([
        ['trolley_service', 'discovered', 12],
        ['plant_odor', 'discovered', 12],
      ]),
    );

    expect(await assignDiscoveredThemes(store, analyzer, [PLANT, TROLLEY], { limit: 100 })).toMatchObject({ posts: 0 });

    const again = await assignDiscoveredThemes(store, analyzer, [TROLLEY], { limit: 100 });
    expect(again.posts).toBe(24);
    const themes = await store.run("MATCH (t:Theme) WHERE t.source = 'discovered' RETURN t.name AS name");
    expect(themes).toEqual([{ name: 'trolley_service' }]);

    expect(await assignDiscoveredThemes(store, analyzer, [], { limit: 100 })).toEqual({ posts: 0, inputTokens: 0 });
    expect(await store.run("MATCH (t:Theme) WHERE t.source = 'discovered' RETURN t.name")).toEqual([]);
  });
});

describe('watches with discovered themes', () => {
  it('accepts discovered theme ids passed in and still rejects unknown ones', () => {
    const text = '{ watches: [{ name: "trolley", themes: ["trolley_service"] }] }';
    expect(() => parseWatches(text)).toThrow(/unknown theme "trolley_service"/);
    expect(parseWatches(text, ['trolley_service'])[0]).toMatchObject({ themes: ['trolley_service'] });
  });
});
