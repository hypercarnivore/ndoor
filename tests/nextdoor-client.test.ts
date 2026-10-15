import { describe, expect, it } from 'vitest';
import { NextdoorApiError, NextdoorClient, StaleOperationError, ThrottledError } from '../src/lib/nextdoor-client.js';

const cookies = { jar: { csrftoken: 'tok', ndbr_at: 'x' }, csrfToken: 'tok', source: 'test' };

function clientReturning(status: number, body: string, capture: { init?: RequestInit } = {}) {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capture.init = init;
    return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }) as unknown as typeof fetch;
  return new NextdoorClient(cookies, { fetchImpl });
}

describe('NextdoorClient', () => {
  it('requires a csrf token', () => {
    expect(() => new NextdoorClient({ jar: {}, csrfToken: null, source: null } as never)).toThrow(NextdoorApiError);
  });

  it('parses JSON served as text/plain and sends persisted-query payloads', async () => {
    const capture: { init?: RequestInit } = {};
    const client = clientReturning(200, '{"data": {"ok": true}}', capture);
    await expect(client.persisted('getMe', 'h'.repeat(64), { a: 1 })).resolves.toEqual({ ok: true });
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers['X-CSRFToken']).toBe('tok');
    expect(JSON.parse(String(capture.init?.body))).toEqual({
      operationName: 'getMe',
      variables: { a: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: 'h'.repeat(64) } },
    });
  });

  it('sends raw documents', async () => {
    const capture: { init?: RequestInit } = {};
    await clientReturning(200, '{"data": {}}', capture).gql('Q', 'query Q { __typename }');
    expect(JSON.parse(String(capture.init?.body)).query).toBe('query Q { __typename }');
  });

  it('maps PersistedQueryNotFound to StaleOperationError', async () => {
    const client = clientReturning(200, '{"errors": [{"message": "PersistedQueryNotFound"}]}');
    await expect(client.persisted('FeedItem', 'x')).rejects.toBeInstanceOf(StaleOperationError);
  });

  it('dedupes GraphQL error messages', async () => {
    const client = clientReturning(400, '{"errors": [{"message": "bad"}, {"message": "bad"}]}');
    await expect(client.gql('Q', 'q')).rejects.toThrow('GraphQL error from Q: bad');
  });

  it('reports auth rejection and non-JSON bodies', async () => {
    await expect(clientReturning(403, '<html>').gql('Q', 'q')).rejects.toThrow(/session may be expired/);
    await expect(clientReturning(500, '<html>').gql('Q', 'q')).rejects.toThrow(/non-JSON response \(HTTP 500\)/);
  });

  it('rejects empty data', async () => {
    await expect(clientReturning(200, '{"data": null}').gql('Q', 'q')).rejects.toThrow(/Empty response data/);
  });

  it('wraps network failures and timeouts', async () => {
    const failing = new NextdoorClient(cookies, {
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await expect(failing.gql('Q', 'q')).rejects.toThrow(/Network error calling Q: ECONNRESET/);

    const slow = new NextdoorClient(cookies, {
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        })) as unknown as typeof fetch,
    });
    await expect(slow.gql('Q', 'q')).rejects.toThrow(/timed out after 5ms/);
  });

  it('retries throttled requests with exponential backoff, then gives up', async () => {
    const bodies = [
      '{"errors": [{"message": "Request throttled", "extensions": {"code": 1008}}]}',
      '{"errors": [{"message": "Request throttled"}]}',
      '{"data": {"ok": 1}}',
    ];
    const waits: number[] = [];
    const client = new NextdoorClient(cookies, {
      throttleBackoffMs: 1,
      onThrottle: (_op, ms) => waits.push(ms),
      fetchImpl: (async () => new Response(bodies.shift() ?? '', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(client.gql('Q', 'q')).resolves.toEqual({ ok: 1 });
    expect(waits).toEqual([1, 2]);

    const stubborn = new NextdoorClient(cookies, {
      throttleRetries: 1,
      throttleBackoffMs: 1,
      fetchImpl: (async () =>
        new Response('{"errors": [{"message": "Request throttled"}]}')) as unknown as typeof fetch,
    });
    await expect(stubborn.gql('Q', 'q')).rejects.toBeInstanceOf(ThrottledError);
  });
});
