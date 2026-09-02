/**
 * The product deck (D61), and the one place it can silently become wrong.
 *
 * `chat_preference_applied_total` decomposes the score `tryMatch` returns into
 * the dimensions that contributed to it. That works only because the score is a
 * bitfield — gender 4, country 2, intent 1 — and those numbers are written
 * **in the Lua**, inside a template literal, in another file. Nothing in the
 * type system connects the two.
 *
 * So if somebody re-tunes the weights in `scripts.ts` — which §29.8 explicitly
 * anticipates, calling them a decision rather than a constant to tune — the
 * decomposition keeps running and starts attributing matches to the wrong
 * dimension. No test fails, no error appears, and the metric that exists to say
 * whether premium works reports something confidently false.
 *
 * This is the test that fails instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMetrics, FUNNEL_STEPS, PREFERENCE_DIMENSION_WEIGHTS } from '../../src/metrics/registry';
import { INTENTS } from '../../src/protocol/types';
import { loadConfig, type Config } from '../../src/config';

function config(): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  });
}

const SCRIPTS = join(__dirname, '..', '..', 'src', 'redis', 'scripts.ts');

describe('the preference score is a bitfield the metric can decompose', () => {
  it('matches the weights the Lua actually uses', () => {
    const source = readFileSync(SCRIPTS, 'utf8');

    // The three lines inside `score()`. Read by the dimension's own list name
    // rather than by position, so reordering the Lua does not fail this.
    const weights = new Map<string, number>([
      ['gender', number(source, /listed\(prefGender,\s*g\)\s*then n = n \+ (\d+)/)],
      ['country', number(source, /listed\(prefCountry,\s*c\)\s*then n = n \+ (\d+)/)],
      ['intent', number(source, /v == myIntent then n = n \+ (\d+)/)],
    ]);

    for (const [dimension, weight] of PREFERENCE_DIMENSION_WEIGHTS) {
      expect(weights.get(dimension)).toBe(weight);
    }
  });

  /**
   * A bitfield needs the weights to be distinct powers of two, or a score
   * cannot be taken apart at all: 1 + 2 and 3 alone would be the same number.
   * The current weights satisfy that, and this asserts the *property* rather
   * than the values, so it keeps holding if the weights are re-tuned within it.
   */
  it('uses distinct powers of two, without which nothing can be decomposed', () => {
    const weights = PREFERENCE_DIMENSION_WEIGHTS.map(([, weight]) => weight);
    for (const weight of weights) {
      expect(weight & (weight - 1)).toBe(0);
    }
    expect(new Set(weights).size).toBe(weights.length);
  });

  it('takes every combination apart the way the scoring put it together', () => {
    const decompose = (score: number): string[] =>
      PREFERENCE_DIMENSION_WEIGHTS.filter(([, weight]) => (score & weight) !== 0).map(
        ([dimension]) => dimension,
      );

    expect(decompose(0)).toEqual([]);
    expect(decompose(4)).toEqual(['gender']);
    expect(decompose(2)).toEqual(['country']);
    expect(decompose(1)).toEqual(['intent']);
    expect(decompose(6)).toEqual(['gender', 'country']);
    expect(decompose(7)).toEqual(['gender', 'country', 'intent']);
  });
});

describe('the product label sets are on the graph before they fire', () => {
  it('publishes every funnel step at zero', async () => {
    const metrics = createMetrics(config(), { processMetrics: false });
    const scrape = await metrics.scrape();

    // A funnel step whose series does not exist yet reads as a total collapse
    // at that step rather than as "nobody has got there", and those are
    // opposite conclusions drawn from the same graph.
    for (const step of FUNNEL_STEPS) {
      expect(scrape).toContain(`chat_funnel_total{step="${step}"`);
    }
  });

  it('publishes every declarable intent at zero', async () => {
    const metrics = createMetrics(config(), { processMetrics: false });
    const scrape = await metrics.scrape();

    for (const intent of INTENTS) {
      expect(scrape).toContain(`chat_intents_declared_total{intent="${intent}"`);
    }
  });
});

function number(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      `could not read a weight out of scripts.ts with ${String(pattern)} — the Lua was ` +
        'reshaped, and this guard has to be updated with it rather than deleted',
    );
  }
  return Number(match[1]);
}
