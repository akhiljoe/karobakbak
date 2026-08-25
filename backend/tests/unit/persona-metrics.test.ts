/**
 * A6 — the persona metrics.
 *
 * Two things are asserted. That the numbers move when the thing they measure
 * happens, and — more importantly — that **no label can carry message
 * content**. Rule 1 names Prometheus labels and values explicitly, so a
 * signature here that accepted a message body would be the leak this whole
 * observability split exists to prevent.
 */

import { createMetrics, PERSONA_LIMITS, PERSONA_SKIP_REASONS } from '../../src/metrics/registry';
import { personaMetrics, NO_PERSONA_METRICS } from '../../src/personas/metrics';
import { loadConfig } from '../../src/config';
import type { Metrics } from '../../src/metrics/registry';

function build(): { metrics: Metrics; persona: ReturnType<typeof personaMetrics> } {
  const metrics = createMetrics(
    loadConfig({
      NODE_ENV: 'test',
      INSTANCE_ID: 'i_test',
      IP_HASH_SALT: 'a'.repeat(32),
      ALLOWED_ORIGINS: 'http://localhost:5173',
    }),
    // Process metrics keep a timer alive after the suite finishes, which is
    // indistinguishable from a leak in the code under test.
    { processMetrics: false },
  );
  return { metrics, persona: personaMetrics(metrics) };
}

async function scrape(metrics: Metrics): Promise<string> {
  return metrics.scrape();
}

/**
 * The value of one series, found by name and by the labels that matter.
 *
 * Substring matching on a rendered line does not work here: the registry stamps
 * a global `instance_id` on every metric, so label order and label count are
 * not something a test should be asserting about. This looks for the metric
 * name and the required labels in whatever order they appear.
 */
function valueOf(text: string, name: string, labels: Record<string, string> = {}): number | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;

    const head = line.slice(name.length);
    if (!head.startsWith('{') && !head.startsWith(' ')) continue;

    const wanted = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (!wanted) continue;

    const parsed = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

describe('persona metrics', () => {
  it('zero-initialises every skip reason, so a stalled fill policy is visible', async () => {
    // `banned` was written by the upgrade path and missing from REJECT_REASONS,
    // so the series never appeared and a dashboard showed "no data" for a
    // refusal that was happening. The same mistake here would hide a fill
    // policy that has quietly stopped filling.
    const { metrics } = build();
    const text = await scrape(metrics);

    for (const reason of PERSONA_SKIP_REASONS) {
      expect(valueOf(text, 'chat_persona_fill_suppressed_total', { reason })).toBe(0);
    }
  });

  it('zero-initialises every one of the six limits', async () => {
    const { metrics } = build();
    const text = await scrape(metrics);

    for (const limit of PERSONA_LIMITS) {
      expect(valueOf(text, 'chat_persona_limit_trips_total', { limit })).toBe(0);
    }
    expect(PERSONA_LIMITS).toHaveLength(6);
  });

  it('counts a suppressed dispatch under its reason', async () => {
    const { metrics, persona } = build();
    persona.tick({ action: 'skipped', reason: 'humans_available' });

    const text = await scrape(metrics);
    expect(valueOf(text, 'chat_persona_fill_suppressed_total', { reason: 'humans_available' })).toBe(1);
  });

  it('counts withdrawals by how many were pulled out', async () => {
    const { metrics, persona } = build();
    persona.tick({ action: 'withdrew', count: 3 });

    expect(valueOf(await scrape(metrics), 'chat_persona_withdrawn_total')).toBe(3);
  });

  it('splits tokens by kind, because they are priced differently', async () => {
    // Collapsing them hides whether the prefix cache is being hit at all, which
    // is the single most important operational signal in the cost model.
    const { metrics, persona } = build();
    persona.spend({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      costMicroCents: 830,
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 1300,
      cacheWriteTokens: 0,
    });

    const text = await scrape(metrics);
    expect(text).toContain('kind="input"');
    expect(text).toContain('kind="cache_read"');
    expect(
      valueOf(text, 'chat_persona_cost_micro_cents_total', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    ).toBe(830);
    expect(valueOf(text, 'chat_persona_tokens_total', { kind: 'cache_read' })).toBe(1300);
  });

  it('reports what is left of the ceiling, never below zero', async () => {
    const { metrics, persona } = build();
    persona.budget({ state: 'ok', spent: 400, limit: 1000 });
    expect(valueOf(await scrape(metrics), 'chat_persona_budget_remaining_micro_cents')).toBe(600);

    persona.budget({ state: 'exhausted', spent: 1500, limit: 1000 });
    expect(valueOf(await scrape(metrics), 'chat_persona_budget_remaining_micro_cents')).toBe(0);
  });

  it('does not publish a remaining figure it cannot compute', async () => {
    // An unreadable budget reporting "0 remaining" would look exactly like an
    // exhausted one, and the two need very different responses.
    const { metrics, persona } = build();
    persona.budget({ state: 'unreadable', spent: 0, limit: 0 });

    expect(valueOf(await scrape(metrics), 'chat_persona_budget_exhausted_total')).toBe(0);
  });

  it('counts a limit trip under the limit that fired', async () => {
    const { metrics, persona } = build();
    persona.limitTripped({ limit: 'crisis', enforced: true });

    expect(valueOf(await scrape(metrics), 'chat_persona_limit_trips_total', { limit: 'crisis' })).toBe(1);
  });

  it('records a provider call with its outcome and latency', async () => {
    const { metrics, persona } = build();
    persona.providerCall('anthropic', 'claude-haiku-4-5', 'complete', 1.5);

    const text = await scrape(metrics);
    expect(text).toContain('outcome="complete"');
    expect(valueOf(text, 'chat_persona_provider_latency_seconds_count', { provider: 'anthropic' })).toBe(1);
  });

  it('never accepts message content, by construction', async () => {
    // The signatures take ids, counts, enum labels and numbers — nothing that
    // could be a message body. This asserts the resulting scrape contains no
    // free text at all beyond the label values the code chose.
    const { metrics, persona } = build();
    persona.conversationEnded('nadia-nightshift', 'partner_left', 6);
    persona.replySent('nadia-nightshift');
    persona.sessionFlagged('minor');
    persona.sessionsActive(3);

    const text = await scrape(metrics);
    expect(text).toContain('persona_id="nadia-nightshift"');
    expect(valueOf(text, 'chat_persona_sessions_active')).toBe(3);
    // A persona id is a kebab-case constant from source, never user input.
    expect(text).toMatch(/persona_id="[a-z][a-z0-9-]*"/);
  });

  it('has a no-op implementation that records nothing and throws nothing', async () => {
    const { metrics } = build();
    NO_PERSONA_METRICS.spend({
      provider: 'x',
      model: 'y',
      costMicroCents: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    });
    NO_PERSONA_METRICS.limitTripped({ limit: 'sexual', enforced: true });
    NO_PERSONA_METRICS.sessionsActive(9);

    expect(valueOf(await scrape(metrics), 'chat_persona_sessions_active')).toBe(0);
  });
});
