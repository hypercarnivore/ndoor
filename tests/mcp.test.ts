import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from '../src/lib/graph.js';
import { createMcpServer, type McpApi } from '../src/lib/mcp.js';
import { mapPost } from '../src/lib/model.js';
import { post } from './fixtures/payloads.js';

// Real MCP client and server over an in-memory transport; the Nextdoor API is faked, the graph is real.

let store: GraphStore;
let client: Client;
const calls: string[] = [];

const api: McpApi = {
  async feed({ count, sort }) {
    calls.push(`feed:${count}:${sort}`);
    return { posts: [mapPost(post('A', { body: 'x'.repeat(2000) }))!], adsDropped: 4, skipped: {}, pagesFetched: 1 };
  },
  async post(id) {
    calls.push(`post:${id}`);
    return mapPost(post(id))!;
  },
  async search(query) {
    return { query, hits: [], nextCursor: null };
  },
  async notifications() {
    return [];
  },
};

function text(result: unknown): unknown {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0].text);
}

beforeEach(async () => {
  store = await GraphStore.open(join(mkdtempSync(join(tmpdir(), 'ndoor-mcp-')), 'graph.lbug'));
  await store.ingestPost(mapPost(post('G'))!, '2026-10-11T08:00:00.000Z');
  const server = createMcpServer({
    version: 'test',
    api: () => api,
    query: (cypher, params) => store.run(cypher, params),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client?.close();
  await store?.close();
});

describe('ndoor MCP server', () => {
  it('lists read-only tools that warn about untrusted text', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'graph_query',
      'graph_report',
      'graph_reports',
      'graph_schema',
      'nextdoor_feed',
      'nextdoor_notifications',
      'nextdoor_read_post',
      'nextdoor_search',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    expect(tools.find((tool) => tool.name === 'nextdoor_feed')?.description).toMatch(/untrusted/);
  });

  it('returns a compact ad-free feed with defaults', async () => {
    const result = text(await client.callTool({ name: 'nextdoor_feed', arguments: {} })) as {
      adsDropped: number;
      posts: { body: string; id: string }[];
    };
    expect(calls).toContain('feed:20:RECENT_POSTS');
    expect(result.adsDropped).toBe(4);
    expect(result.posts[0].body.length).toBeLessThan(1300);
  });

  it('reads a post from a URL', async () => {
    await client.callTool({
      name: 'nextdoor_read_post',
      arguments: { post: 'https://nextdoor.com/p/abc123?view=detail' },
    });
    expect(calls).toContain('post:abc123');
  });

  it('runs reports and Cypher against the graph', async () => {
    const top = text(
      await client.callTool({ name: 'graph_report', arguments: { name: 'top-posts', sinceDays: 36500 } }),
    );
    expect(top).toMatchObject([{ reactions: 5 }]);
    const rows = text(
      await client.callTool({
        name: 'graph_query',
        arguments: { cypher: 'MATCH (p:Post) WHERE p.id = $id RETURN p.subject AS s', params: { id: 'post_G' } },
      }),
    );
    expect(rows).toEqual([{ s: 'Subject G' }]);
    const schema = text(await client.callTool({ name: 'graph_schema', arguments: {} })) as { nodes: object };
    expect(Object.keys(schema.nodes)).toContain('Post');
  });

  it('refuses Cypher that could read files or reach the network', async () => {
    const result = await client.callTool({
      name: 'graph_query',
      arguments: { cypher: "LOAD FROM '/etc/passwd' RETURN *" },
    });
    expect(result.isError).toBe(true);
  });

  it('searches, lists notifications, and lists reports', async () => {
    expect(text(await client.callTool({ name: 'nextdoor_search', arguments: { query: 'plumber' } }))).toMatchObject({
      query: 'plumber',
    });
    expect(text(await client.callTool({ name: 'nextdoor_notifications', arguments: {} }))).toEqual([]);
    const reports = text(await client.callTool({ name: 'graph_reports', arguments: {} })) as { name: string }[];
    expect(reports.map((report) => report.name)).toContain('influencers');
  });

  it('rejects unknown reports', async () => {
    const result = await client.callTool({ name: 'graph_report', arguments: { name: 'nope' } });
    expect(result.isError).toBe(true);
  });
});
