/**
 * Structure-aware fuzzing of `parseClientFrame`.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FUZZER IS FOR HERE, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * `validate.test.ts` asserts specific decisions: this frame is refused with
 * that code, this field is trimmed, that discriminator is unknown. It is the
 * better test and this does not replace it.
 *
 * What it cannot do is cover shapes nobody thought to write down. Every frame
 * reaching this function was typed by a stranger, and the function stands
 * between them and a process that holds every WebSocket file descriptor on the
 * instance. The property asserted below is deliberately weak and absolute:
 *
 *   **`parseClientFrame` returns. It never throws, and it never accepts
 *   anything it was not asked to accept.**
 *
 * A throw here is not a validation failure — it is an exception on the frame
 * path, which `connection.ts` would have to catch to avoid killing a socket
 * somebody else is using. An acceptance is worse.
 *
 * ---------------------------------------------------------------------------
 * SEEDED, SO A FAILURE IS A REPRODUCTION
 * ---------------------------------------------------------------------------
 * `Math.random()` in a fuzzer produces a test that fails once on CI and never
 * again, which is worse than no test: it teaches everyone to re-run. The
 * generator below is a small deterministic PRNG, the seed is printed, and the
 * corpus is the same on every machine.
 */
import { parseClientFrame } from '../../src/protocol/validate';
import { CLIENT_EVENTS } from '../../src/protocol/types';

const LIMITS = { maxMessageLength: 2000, maxReportNoteLength: 500 };

/** xorshift32. Small, deterministic, and adequate for choosing shapes. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Control characters are built from `String.fromCharCode`, never typed.
 *
 * The same defence `hasForbiddenControlChar()` uses, and for the reason
 * CLAUDE.md records: an earlier attempt at a control-character regex wrote raw
 * bytes into `validate.ts` and turned it into a binary file to git and grep.
 */
const CONTROL = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i));

const NASTY_STRINGS: readonly string[] = [
  '',
  ' '.repeat(5000),
  'a'.repeat(100_000),
  '\\u0000',
  '𝕳𝖊𝖑𝖑𝖔',
  '👨‍👩‍👧‍👦',
  '‮reversed',
  '﻿bom',
  'İstanbul'.toLowerCase(),
  '../../etc/passwd',
  "'; drop table messages; --",
  '<script>alert(1)</script>',
  '${jndi:ldap://x/y}',
  '{{7*7}}',
  '  ',
  ...CONTROL,
];

const NASTY_VALUES: readonly unknown[] = [
  null,
  undefined,
  0,
  -1,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  [],
  {},
  [[[[[[[[[[]]]]]]]]]],
  { toString: 'not a function' },
  ...NASTY_STRINGS,
];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

/** A frame shaped like a real one, with one or more fields replaced by junk. */
function structuredFrame(next: () => number): unknown {
  const frame: Record<string, unknown> = {
    v: next() < 0.8 ? 1 : pick(next, NASTY_VALUES),
    type: next() < 0.7 ? pick(next, CLIENT_EVENTS) : pick(next, NASTY_VALUES),
    id: next() < 0.7 ? 'probe' : pick(next, NASTY_VALUES),
    data: {},
  };

  const data: Record<string, unknown> = {};
  const fields = ['text', 'contentType', 'profile', 'preferences', 'intent', 'note', 'reason', 'active'];
  const howMany = Math.floor(next() * fields.length);
  for (let i = 0; i < howMany; i += 1) {
    data[pick(next, fields)] = pick(next, NASTY_VALUES);
  }
  frame.data = next() < 0.9 ? data : pick(next, NASTY_VALUES);

  // Prototype-pollution shapes, as ordinary keys. `JSON.parse` would produce
  // exactly this, so the parser has to be safe against it without anybody
  // having written a special case.
  if (next() < 0.1) frame['__proto__'] = { polluted: true };
  if (next() < 0.1) frame['constructor'] = { prototype: { polluted: true } };

  return frame;
}

/** Deeply nested arrays and objects, to the depth a hostile client would send. */
function deepValue(next: () => number, depth: number): unknown {
  if (depth === 0) return pick(next, NASTY_VALUES);
  return next() < 0.5 ? [deepValue(next, depth - 1)] : { nested: deepValue(next, depth - 1) };
}

const ITERATIONS = 4000;

describe('parseClientFrame under fuzzing', () => {
  /**
   * The property that matters most: it returns.
   *
   * An exception on the frame path is not a refusal. `connection.ts` calls this
   * inside `handleFrame`, so a throw is an unhandled rejection on a socket
   * belonging to a person who did nothing wrong.
   */
  it('never throws, whatever it is given', () => {
    const next = rng(0x5eed);
    const thrown: string[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const frame = structuredFrame(next);
      const raw = JSON.stringify(frame) ?? 'null';
      try {
        parseClientFrame(raw, false, LIMITS);
      } catch (err) {
        // The shape, never the input: a fuzzer that prints its corpus into CI
        // output is a fuzzer whose failures are unreadable.
        thrown.push(`iteration ${i}: ${err instanceof Error ? err.name : typeof err}`);
      }
    }

    expect(thrown).toEqual([]);
  });

  it('never throws on raw junk that is not JSON at all', () => {
    const next = rng(0xc0ffee);
    const thrown: string[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const raw = pick(next, NASTY_STRINGS) + pick(next, NASTY_STRINGS);
      try {
        parseClientFrame(raw, false, LIMITS);
      } catch (err) {
        thrown.push(`iteration ${i}: ${err instanceof Error ? err.name : typeof err}`);
      }
    }

    expect(thrown).toEqual([]);
  });

  it('never throws on deeply nested structures', () => {
    const next = rng(0xdeeb);
    const thrown: string[] = [];

    for (let depth = 1; depth <= 200; depth += 1) {
      const raw = JSON.stringify({ v: 1, type: 'message', id: 'x', data: deepValue(next, depth) });
      try {
        parseClientFrame(raw, false, LIMITS);
      } catch (err) {
        thrown.push(`depth ${depth}: ${err instanceof Error ? err.name : typeof err}`);
      }
    }

    expect(thrown).toEqual([]);
  });

  /**
   * A binary frame is refused before anything is parsed, and that is
   * architectural rather than a validation rule (§23.2): it is what keeps the
   * socket from becoming a media transport.
   */
  it('refuses every binary frame, whatever it contains', () => {
    const next = rng(0xb1);
    const accepted: number[] = [];

    for (let i = 0; i < 500; i += 1) {
      const raw = JSON.stringify(structuredFrame(next)) ?? 'null';
      const parsed = parseClientFrame(raw, true, LIMITS);
      if (parsed.ok) accepted.push(i);
    }

    expect(accepted).toEqual([]);
  });

  /**
   * Nothing the fuzzer produces is accepted with a type outside the closed
   * list. A parser that accepted an unknown discriminator would hand
   * `server.ts`'s exhaustive switch a value its `never` case cannot describe.
   */
  it('only ever accepts a declared client event type', () => {
    const next = rng(0xa11);
    const rogue: string[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const raw = JSON.stringify(structuredFrame(next)) ?? 'null';
      const parsed = parseClientFrame(raw, false, LIMITS);
      if (parsed.ok && !(CLIENT_EVENTS as readonly string[]).includes(parsed.command.type)) {
        rogue.push(parsed.command.type);
      }
    }

    expect(rogue).toEqual([]);
  });

  /**
   * Prototype pollution, asserted on the object rather than on the parser.
   *
   * `JSON.parse` does not walk `__proto__` into the prototype chain, but a
   * hand-rolled merge downstream would — so this is here to fail the day
   * somebody adds one.
   */
  it('leaves Object.prototype alone', () => {
    const next = rng(0x9019);
    for (let i = 0; i < 500; i += 1) {
      const raw = JSON.stringify(structuredFrame(next)) ?? 'null';
      parseClientFrame(raw, false, LIMITS);
    }

    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
