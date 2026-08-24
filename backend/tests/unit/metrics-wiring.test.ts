/**
 * Every declared metric is written by something.
 *
 * Ten metrics were declared, documented, typed — and incremented by nothing,
 * anywhere in `src/`, for as long as they had existed. Two of them were
 * charted: `chat_matchmaking_latency_seconds` drove three dashboard panels
 * showing the product's headline indicator, and had never received a sample.
 *
 * No test that reads the *scrape* could have caught it, which is why
 * `metrics.test.ts` — a good suite, which asserts the metric names are present
 * and that nothing identifying ever escapes — passed throughout. `prom-client`
 * emits an unlabelled counter or histogram at zero as soon as it is registered,
 * so a dead metric is not missing from the output. It is present, plausible and
 * permanently zero, which on a graph is indistinguishable from a healthy system
 * with no traffic.
 *
 * So this reads the source instead. A name declared in the `Metrics` interface
 * has to appear somewhere that is not the file declaring it. It is a crude
 * check, deliberately: it is cheap, it has no opinion about *how* a metric is
 * written, and it is the one that would have failed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const REGISTRY = join(SRC, 'metrics', 'registry.ts');

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** The field names of the `Metrics` interface, read from its own source. */
function declaredMetrics(): string[] {
  const source = readFileSync(REGISTRY, 'utf8');
  const pattern = /^\s+readonly (\w+):\s*(?:Counter|Gauge|Histogram)</gm;
  return [...source.matchAll(pattern)].map((match) => match[1] as string);
}

describe('the metrics registry', () => {
  it('declares the metrics this build actually has', () => {
    // A guard on the guard: if the interface is ever restructured so the
    // pattern above matches nothing, the real assertion below would pass
    // vacuously — which is the same failure mode this whole file exists for.
    const names = declaredMetrics();
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain('matchmakingLatency');
    expect(names).toContain('messagesReceived');
  });

  it('writes every metric it declares', () => {
    const names = declaredMetrics();
    const elsewhere = sourceFiles(SRC)
      .filter((file) => file !== REGISTRY)
      .map((file) => readFileSync(file, 'utf8'));

    const dead = names.filter((name) => {
      const used = new RegExp('\\.' + name + '\\b');
      return !elsewhere.some((source) => used.test(source));
    });

    // If this fails, the choice is to wire the metric or to delete it. A
    // declared-and-dead metric is worse than an absent one, because it is
    // charted and believed. `chat_enforcement_actions_total` was deleted for
    // exactly that reason: the only process that issues a sanction is the
    // console, which is deliberately isolated and exposes no scrape endpoint,
    // so the metric could not have been collected from anywhere.
    expect(dead).toEqual([]);
  });
});
