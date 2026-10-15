/**
 * Decision models through OpenRouter's Decisions API, as an alternative to
 * calling TypeSafe directly. The API takes the same Choice, Noul, and Score
 * questions and returns the same answer shapes, so this client slots in behind
 * the analyzer's SystemOneClient interface unchanged.
 *
 * Every request requires zero data retention: OpenRouter routes it only to
 * endpoints that keep neither prompts nor answers, and refuses the request
 * when no such endpoint serves the model. Neighbors' words are never sent
 * anywhere that may store them.
 */

import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { SystemOneClient } from './jev.js';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/** Routing rules sent with every request. Not configurable: privacy is not a tuning knob. */
export const PRIVATE_ROUTING = Object.freeze({ zdr: true, data_collection: 'deny' } as const);

/** Statuses worth retrying after a pause: timeouts, rate limits, and provider hiccups. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 524, 529]);

export interface OpenRouterOptions {
  apiKey: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Called with the provider and cost of each answer, for reporting. */
  onUsage?: (usage: { provider: string | null; cost: number | null; inputTokens: number }) => void;
  /** Injected in tests to skip real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/** An HTTP failure with its status, so callers can tell "out of credits" from "try again". */
export class DecisionsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`${status} ${message}`);
    this.name = 'DecisionsError';
  }
}

interface DecisionsResponse {
  model: string;
  provider?: string;
  answers: SystemOneResult<Questions>['answers'];
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OpenRouterDecisions implements SystemOneClient {
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenRouterOptions) {
    this.fetch = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.sleep = options.sleep ?? wait;
  }

  async systemOne(request: {
    state: unknown;
    questions: Questions;
    model?: string;
  }): Promise<SystemOneResult<Questions>> {
    if (!request.model) throw new Error('OpenRouter decisions need a model id, such as microsoft/microsoft-decision-1');
    const body = JSON.stringify({
      model: request.model,
      state: request.state,
      questions: request.questions,
      provider: PRIVATE_ROUTING,
    });
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(OPENROUTER_DECISIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) {
        const data = (await response.json()) as DecisionsResponse;
        this.options.onUsage?.({
          provider: data.provider ?? null,
          cost: data.usage.cost ?? null,
          inputTokens: data.usage.input_tokens,
        });
        return { model: data.model, answers: data.answers, usage: data.usage };
      }
      const message = await errorMessage(response);
      if (!RETRYABLE.has(response.status) || attempt >= this.maxRetries) {
        throw new DecisionsError(response.status, message);
      }
      await this.sleep(retryDelay(response, attempt));
    }
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string } };
    return data.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

/** Honor Retry-After (seconds) up to a minute; otherwise back off exponentially from one second. */
function retryDelay(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 60) * 1000;
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/** Model ids with a vendor prefix (vendor/model) go through OpenRouter; bare ids go to TypeSafe. */
export const isOpenRouterModel = (model: string) => model.includes('/');
