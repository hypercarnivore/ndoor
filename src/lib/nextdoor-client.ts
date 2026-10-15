/**
 * Nextdoor GraphQL client.
 *
 * Nextdoor's web app talks to a single GraphQL gateway:
 *   POST https://nextdoor.com/api/gql/<OperationName>
 * authenticated with the browser cookie jar plus the csrftoken echoed in the
 * `X-CSRFToken` header (Django style - the exact capitalization matters; a
 * lowercase header is rejected with HTTP 403). The web app uses Apollo
 * persisted queries (operation name + sha256 hash, see operations.ts); raw
 * query documents are also accepted but introspection is disabled.
 *
 * This module owns the transport (headers, POST, error handling) only. The
 * gateway labels JSON bodies `text/plain`, so the body is parsed regardless of
 * the declared content type.
 */

import { buildCookieHeader, type NextdoorCookies } from './cookies.js';

const GQL_BASE = 'https://nextdoor.com/api/gql';
const ORIGIN = 'https://nextdoor.com';
const REFERER = 'https://nextdoor.com/news_feed/';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** A single GraphQL error returned by the gateway. */
export interface GraphqlError {
  message: string;
  error_code?: number;
  extensions?: Record<string, unknown>;
}

/** Raised when the gateway returns an error (auth, WAF, or GraphQL errors). */
export class NextdoorApiError extends Error {
  readonly status: number;
  readonly errors: GraphqlError[];

  constructor(message: string, status: number, errors: GraphqlError[] = []) {
    super(message);
    this.name = 'NextdoorApiError';
    this.status = status;
    this.errors = errors;
  }
}

/** Raised when a persisted-query hash is no longer known to the server. */
export class StaleOperationError extends NextdoorApiError {
  readonly operationName: string;

  constructor(operationName: string) {
    super(
      `Nextdoor no longer recognizes the ${operationName} query hash (the web app was probably updated). ` +
        'Capture fresh traffic and run `ndoor ops harvest <file.har>` (see `make harvest`).',
      200,
    );
    this.name = 'StaleOperationError';
    this.operationName = operationName;
  }
}

/** Raised when Nextdoor rate-limits a request ("Request throttled", code 1008). */
export class ThrottledError extends NextdoorApiError {
  constructor(readonly operation: string) {
    super(`Nextdoor throttled ${operation}; slow down and retry later.`, 200);
    this.name = 'ThrottledError';
  }
}

export interface NextdoorClientOptions {
  /** Request timeout in milliseconds (default 20s). */
  timeoutMs?: number;
  /** Override the fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
  /** Retries after a throttled response, with exponential backoff (default 5). */
  throttleRetries?: number;
  /** First throttle backoff in ms, doubled per retry (default 5000). */
  throttleBackoffMs?: number;
  /** Notified before each throttle backoff wait. */
  onThrottle?: (operationName: string, waitMs: number) => void;
}

export class NextdoorClient {
  private readonly cookieHeader: string;
  private readonly csrfToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly throttleRetries: number;
  private readonly throttleBackoffMs: number;
  private readonly onThrottle?: (operationName: string, waitMs: number) => void;

  constructor(cookies: NextdoorCookies, options: NextdoorClientOptions = {}) {
    if (!cookies.csrfToken) {
      throw new NextdoorApiError('Missing csrftoken cookie - cannot authenticate with Nextdoor.', 0);
    }
    this.cookieHeader = buildCookieHeader(cookies.jar);
    this.csrfToken = cookies.csrfToken;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.throttleRetries = options.throttleRetries ?? 5;
    this.throttleBackoffMs = options.throttleBackoffMs ?? 5000;
    this.onThrottle = options.onThrottle;
  }

  /**
   * Execute a raw GraphQL document against the gateway.
   * @param operationName matches both the URL path segment and the document's name.
   * @param query the full GraphQL document string.
   * @param variables operation variables.
   */
  gql<T = unknown>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>(operationName, { operationName, variables, query });
  }

  /** Execute a persisted query by its sha256 hash. */
  persisted<T = unknown>(operationName: string, hash: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>(operationName, {
      operationName,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
  }

  private async request<T>(operationName: string, payload: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(operationName, payload);
      } catch (error) {
        if (!(error instanceof ThrottledError) || attempt >= this.throttleRetries) throw error;
        const waitMs = this.throttleBackoffMs * 2 ** attempt;
        this.onThrottle?.(operationName, waitMs);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  private async requestOnce<T>(operationName: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${GQL_BASE}/${operationName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: this.cookieHeader,
          'X-CSRFToken': this.csrfToken,
          Origin: ORIGIN,
          Referer: REFERER,
          'x-requested-with': 'XMLHttpRequest',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NextdoorApiError(`Request timed out after ${this.timeoutMs}ms (${operationName}).`, 0);
      }
      throw new NextdoorApiError(
        `Network error calling ${operationName}: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: { data?: T; errors?: GraphqlError[] };
    try {
      body = JSON.parse(text);
    } catch {
      // The gateway returns the SPA HTML shell (not JSON) on auth/WAF rejection.
      if (response.status === 401 || response.status === 403) {
        throw new NextdoorApiError(
          `Request rejected (${response.status}). Your session may be expired or blocked - log in to nextdoor.com again.`,
          response.status,
        );
      }
      throw new NextdoorApiError(
        `Unexpected non-JSON response (HTTP ${response.status}) from ${operationName}.`,
        response.status,
      );
    }

    if (body.errors && body.errors.length > 0) {
      if (body.errors.some((e) => e.message === 'Request throttled' || e.extensions?.code === 1008)) {
        throw new ThrottledError(operationName);
      }
      if (body.errors.some((e) => e.message === 'PersistedQueryNotFound')) {
        throw new StaleOperationError(operationName);
      }
      const message = [...new Set(body.errors.map((e) => e.message))].join('; ');
      throw new NextdoorApiError(`GraphQL error from ${operationName}: ${message}`, response.status, body.errors);
    }

    if (body.data === undefined || body.data === null) {
      throw new NextdoorApiError(`Empty response data from ${operationName}.`, response.status);
    }

    return body.data;
  }
}
