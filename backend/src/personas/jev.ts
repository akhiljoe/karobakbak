/**
 * TypeSafe's Jev, a decision model, used beside the voice (never as it).
 *
 * ---------------------------------------------------------------------------
 * WHAT JEV IS, AND WHY IT CANNOT SPEAK
 * ---------------------------------------------------------------------------
 * Jev writes no text. It reads a `state`, answers typed questions about it —
 * a yes/no probability (`noul`), one option from a set (`choice`), or a level
 * on a rubric (`score`) — and reports how sure it is. That makes it the right
 * tool for the questions the persona kept getting wrong *before* it spoke:
 *
 *   - what kind of turn is this ("hi" is a greeting, not "how are you"),
 *   - did the stranger ask something that must be answered,
 *   - does the drafted reply actually respond to what they said,
 *   - and a second opinion on the safety limits, beside the word lists.
 *
 * The voice is still the language model. Jev only steers it and checks it.
 *
 * ---------------------------------------------------------------------------
 * EVERY PATH OUT OF HERE IS A FALLBACK, NEVER AN ERROR
 * ---------------------------------------------------------------------------
 * `ask` returns `null` for anything other than a well-formed answer: no host
 * configured, every host's breaker open, a timeout, a 401/422/429/529, a body
 * that does not parse. The caller then uses the rule-based reading it would
 * have used before Jev existed (`judge.ts`). A judgement that cannot be made
 * must cost the conversation nothing but the judgement.
 *
 * Hosts are tried **in order**, one attempt each, with no retry inside a turn:
 * the reply is already waiting on this, and a second attempt at a host that
 * just said 529 spends the stranger's patience to learn the same thing again.
 * Each host has its own breaker — after `breakerThreshold` consecutive failures
 * it is skipped for `breakerCooldownMs` — so a host that is down costs one
 * timeout per cooldown rather than one per message.
 *
 * ---------------------------------------------------------------------------
 * CONTENT
 * ---------------------------------------------------------------------------
 * `state` carries conversation text, exactly as the voice's own request does.
 * Nothing here logs it, puts it in an error, or labels a metric with it (I8,
 * rule 1). Failures are reported by host index and HTTP status only.
 */

import type { Logger } from '../logger';

/** A question Jev is asked. Mirrors the wire shape of `POST /v1/systemone`. */
export type JevQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    };

export type JevAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    };

export interface JevResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Why a call produced no answer. A closed set: it is a metric label. */
export type JevOutcome =
  | 'ok'
  | 'timeout'
  | 'http_error'
  | 'rate_limited'
  | 'bad_response'
  | 'network'
  | 'breaker_open';

export const JEV_OUTCOMES: readonly JevOutcome[] = [
  'ok',
  'timeout',
  'http_error',
  'rate_limited',
  'bad_response',
  'network',
  'breaker_open',
];

export interface JevHost {
  /** Base URL; `/v1/systemone` is appended. */
  readonly url: string;
  readonly apiKey: string;
}

export interface JevClientOptions {
  /** Tried in order. Empty means Jev is off and every `ask` is null at once. */
  readonly hosts: readonly JevHost[];
  readonly model: string;
  readonly timeoutMs: number;
  readonly breakerThreshold: number;
  readonly breakerCooldownMs: number;
  readonly logger: Logger;
  /** Called once per host attempt, for metrics. `host` is the index, never the URL. */
  readonly onCall?: (host: number, outcome: JevOutcome, seconds: number) => void;
  /** Injected in tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface JevClient {
  readonly enabled: boolean;
  ask(state: string, questions: Readonly<Record<string, JevQuestion>>): Promise<JevResult | null>;
}

/** A client that is never asked anything. What a deployment without a key gets. */
export const NO_JEV: JevClient = {
  enabled: false,
  ask: async () => null,
};

interface BreakerState {
  failures: number;
  openUntil: number;
}

export function jevClient(options: JevClientOptions): JevClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const breakers: BreakerState[] = options.hosts.map(() => ({ failures: 0, openUntil: 0 }));

  const fail = (index: number): void => {
    const breaker = breakers[index];
    if (breaker === undefined) return;
    breaker.failures += 1;
    if (breaker.failures >= options.breakerThreshold) {
      // Logged on the transition only. A host that stays down would otherwise
      // write one line per message for as long as it is down.
      if (breaker.openUntil <= now()) {
        options.logger.warn('jev host unavailable; skipping it for a while', {
          host: index,
          cooldownMs: options.breakerCooldownMs,
        });
      }
      breaker.openUntil = now() + options.breakerCooldownMs;
    }
  };

  const succeed = (index: number): void => {
    const breaker = breakers[index];
    if (breaker === undefined) return;
    breaker.failures = 0;
    breaker.openUntil = 0;
  };

  return {
    enabled: options.hosts.length > 0,

    async ask(state, questions): Promise<JevResult | null> {
      for (let index = 0; index < options.hosts.length; index += 1) {
        const host = options.hosts[index];
        const breaker = breakers[index];
        if (host === undefined || breaker === undefined) continue;

        if (breaker.openUntil > now()) {
          options.onCall?.(index, 'breaker_open', 0);
          continue;
        }

        const started = now();
        const { outcome, result } = await attempt(doFetch, host, options, state, questions);
        options.onCall?.(index, outcome, (now() - started) / 1000);

        if (result !== null) {
          succeed(index);
          return result;
        }

        // A malformed body is the host answering, not the host being down, so
        // it does not count toward the breaker; everything else does.
        if (outcome !== 'bad_response') fail(index);
      }
      return null;
    },
  };
}

async function attempt(
  doFetch: typeof fetch,
  host: JevHost,
  options: JevClientOptions,
  state: string,
  questions: Readonly<Record<string, JevQuestion>>,
): Promise<{ outcome: JevOutcome; result: JevResult | null }> {
  let response: Response;
  try {
    response = await doFetch(`${host.url.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: options.model, state, questions }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { outcome: timedOut ? 'timeout' : 'network', result: null };
  }

  if (!response.ok) {
    // The body is not read: a 422 echoes the offending field, and the field is
    // the conversation.
    options.logger.warn('jev call refused', { status: response.status });
    const outcome: JevOutcome =
      response.status === 429 || response.status === 529 ? 'rate_limited' : 'http_error';
    return { outcome, result: null };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { outcome: 'bad_response', result: null };
  }

  const result = parseResult(body, Object.keys(questions));
  return result === null ? { outcome: 'bad_response', result: null } : { outcome: 'ok', result };
}

/**
 * The response, or null if any asked question came back missing or malformed.
 *
 * All-or-nothing on purpose. A half-answered judgement mixed with rule-based
 * halves would be a reading nobody can reason about; the rules are a complete
 * fallback and so is Jev.
 */
export function parseResult(body: unknown, asked: readonly string[]): JevResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const answers = record['answers'];
  if (typeof answers !== 'object' || answers === null) return null;

  const parsed: Record<string, JevAnswer> = {};
  for (const name of asked) {
    const answer = parseAnswer((answers as Record<string, unknown>)[name]);
    if (answer === null) return null;
    parsed[name] = answer;
  }

  const usage = (record['usage'] ?? {}) as Record<string, unknown>;
  return {
    model: typeof record['model'] === 'string' ? record['model'] : 'jev',
    answers: parsed,
    usage: {
      inputTokens: nonNegative(usage['input_tokens']),
      outputTokens: nonNegative(usage['output_tokens']),
    },
  };
}

function parseAnswer(raw: unknown): JevAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;

  if (a['type'] === 'noul') {
    const p = a['noul'];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
    return { type: 'noul', noul: p };
  }

  if (a['type'] === 'choice') {
    const choice = a['choice'];
    const confidence = a['confidence'];
    const probabilities = a['probabilities'];
    if (typeof choice !== 'string') return null;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
    if (typeof probabilities !== 'object' || probabilities === null) return null;
    const probs: Record<string, number> = {};
    for (const [key, value] of Object.entries(probabilities)) {
      if (typeof value === 'number' && Number.isFinite(value)) probs[key] = value;
    }
    return { type: 'choice', choice, confidence, probabilities: probs };
  }

  return null;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
