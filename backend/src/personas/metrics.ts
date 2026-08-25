/**
 * Where persona behaviour becomes numbers (D-AI-8).
 *
 * ---------------------------------------------------------------------------
 * ONE WRITER, SO NOTHING IS DECLARED AND DEAD
 * ---------------------------------------------------------------------------
 * `metrics-wiring.test.ts` fails on any metric that is declared in the registry
 * and never written anywhere else, because a declared-and-dead metric is worse
 * than an absent one: it is charted, it reads zero, and it is believed. That
 * test caught every persona counter the moment they were declared, which is the
 * reason this module exists rather than each caller reaching into the registry.
 *
 * Gathering the writes here also keeps the one rule that cannot bend visible in
 * a single place: **no argument to any function below is message content, and
 * none can become a label.** Rule 1 names Prometheus labels *and values*, so the
 * live persona feed everybody asks for cannot be built here. What a persona said
 * is read in the console, audited.
 *
 * Note what is deliberately absent from every signature: `conversation_id`. It
 * is unbounded cardinality, and it is also half a content leak, since it joins a
 * time series to a transcript.
 */

import type { Metrics } from '../metrics/registry';
import type { LimitTrip } from './guard';
import type { SpendEvent } from './voice-model';
import type { SkipReason, TickOutcome } from './supervisor';
import type { BudgetCheck } from './budget';

/** How a persona conversation ended. A closed set, so the label stays bounded. */
export type ConversationOutcome = 'partner_left' | 'we_left' | 'blocked' | 'dropped';

/**
 * The recorder.
 *
 * A thin object rather than free functions so the whole subsystem takes one
 * dependency and tests can pass a no-op without a registry.
 */
export interface PersonaMetrics {
  conversationStarted(): void;
  conversationEnded(personaId: string, outcome: ConversationOutcome, replies: number): void;
  replySent(personaId: string): void;
  sessionsActive(count: number): void;

  tick(outcome: TickOutcome): void;
  dispatched(waitedSeconds: number): void;

  spend(event: SpendEvent): void;
  budget(check: BudgetCheck): void;

  limitTripped(trip: LimitTrip): void;
  sessionFlagged(reason: string): void;

  providerCall(provider: string, model: string, outcome: string, seconds: number): void;
}

/** Records nothing. For tests and for a deployment with metrics disabled. */
export const NO_PERSONA_METRICS: PersonaMetrics = {
  conversationStarted: () => undefined,
  conversationEnded: () => undefined,
  replySent: () => undefined,
  sessionsActive: () => undefined,
  tick: () => undefined,
  dispatched: () => undefined,
  spend: () => undefined,
  budget: () => undefined,
  limitTripped: () => undefined,
  sessionFlagged: () => undefined,
  providerCall: () => undefined,
};

export function personaMetrics(metrics: Metrics): PersonaMetrics {
  return {
    conversationStarted(): void {
      metrics.personaFillDispatched.inc();
    },

    conversationEnded(personaId, outcome, replies): void {
      metrics.personaConversations.labels(personaId, outcome).inc();
      metrics.personaRepliesPerConversation.observe(replies);
    },

    replySent(personaId): void {
      metrics.personaReplies.labels(personaId).inc();
    },

    sessionsActive(count): void {
      metrics.personaSessionsActive.set(count);
    },

    /**
     * One supervisor decision.
     *
     * Every skip reason is zero-initialised in the registry, so a policy that
     * has quietly stopped filling shows a flat line at zero rather than "no
     * data" — the two look identical on a graph and mean very different things.
     */
    tick(outcome): void {
      if (outcome.action === 'skipped') {
        metrics.personaFillSuppressed.labels(outcome.reason satisfies SkipReason).inc();
        return;
      }
      if (outcome.action === 'withdrew') {
        metrics.personaWithdrawn.inc(outcome.count);
      }
    },

    dispatched(waitedSeconds): void {
      metrics.personaWaitBeforeFill.observe(waitedSeconds);
    },

    /**
     * Token usage split by kind, because the kinds are priced differently.
     *
     * Collapsing them into one number makes the bill unexplainable at exactly
     * the moment somebody asks why it is what it is — and it hides the single
     * most important operational signal here, which is whether the prefix cache
     * is being hit at all.
     */
    spend(event): void {
      const { provider, model } = event;
      metrics.personaTokens.labels(provider, model, 'input').inc(event.inputTokens);
      metrics.personaTokens.labels(provider, model, 'output').inc(event.outputTokens);
      metrics.personaTokens.labels(provider, model, 'cache_read').inc(event.cacheReadTokens);
      metrics.personaTokens.labels(provider, model, 'cache_write').inc(event.cacheWriteTokens);
      metrics.personaCost.labels(provider, model).inc(event.costMicroCents);
    },

    budget(check): void {
      if (check.state === 'unreadable') return;
      metrics.personaBudgetRemaining.set(Math.max(0, check.limit - check.spent));
      if (check.state === 'exhausted') metrics.personaBudgetExhausted.inc();
    },

    limitTripped(trip): void {
      metrics.personaLimitTrips.labels(trip.limit).inc();
    },

    sessionFlagged(reason): void {
      metrics.personaSessionsFlagged.labels(reason).inc();
    },

    providerCall(provider, model, outcome, seconds): void {
      metrics.personaProviderRequests.labels(provider, model, outcome).inc();
      metrics.personaProviderLatency.labels(provider).observe(seconds);
    },
  };
}
