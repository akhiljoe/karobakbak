/**
 * The control that keeps message content out of the tracing pipeline (I8).
 *
 * ---------------------------------------------------------------------------
 * WHY A SPAN PROCESSOR AND NOT A CONFIGURATION SETTING
 * ---------------------------------------------------------------------------
 * `db.statement` is disabled at the `pg` instrumentation (D53), and that is the
 * first control. This is the second, and it exists because the first one is a
 * setting: it can be turned back on by anybody looking for detail during an
 * incident, at exactly the moment nobody is thinking about invariants. A span
 * that carries a message body must not be exportable regardless of how it came
 * to have one.
 *
 * It shares `logger.ts`'s field list (D52) so the two controls cannot drift,
 * and applies it to the other path out of the boundary. What it does on a hit
 * differs from the logger, for a structural reason set out below.
 *
 * ---------------------------------------------------------------------------
 * IT REDACTS. IT DOES NOT THROW AT RUNTIME, AND THAT IS NOT THE LOGGER'S RULE
 * ---------------------------------------------------------------------------
 * `logger.ts` throws outside production, and the first version of this copied
 * that on the reasoning that a leak should be impossible to miss where new
 * instrumentation is written. The comment claimed the throw was safe because
 * `onEnd` runs "on the SDK's own path rather than the application's, so the
 * tracer swallows it".
 *
 * That was wrong, and running it said so within seconds. `SpanProcessor.onEnd`
 * is called synchronously from `span.end()`, which the instrumentation calls
 * inside the operation it is measuring — so the throw propagates into the
 * database call it was observing. The load stack went into a restart loop on
 * the first query, and the thing that crashed it was the safety control.
 *
 * A control that takes the service down is not a safety control; it is an
 * outage with good intentions. The difference from the logger is structural and
 * not a matter of taste: a log call is application code, and a test can wrap it.
 * A span processor is a callback the vendor invokes from inside somebody else's
 * call stack.
 *
 * So: **redact always, report loudly, never throw in a running process.**
 * `strict` survives as a constructor option because the test suite needs to
 * assert refusal directly, and `tracing.test.ts` is its only caller. It must
 * never be derived from `NODE_ENV` again.
 */
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';

import { isForbiddenAttributeKey } from '../redaction';

export const REDACTED = '[redacted]';

/** Thrown when a span carries a denied attribute and `strict` is set. Tests only. */
export class ForbiddenSpanAttributeError extends Error {
  constructor(
    readonly spanName: string,
    readonly attribute: string,
  ) {
    super(`span "${spanName}" carried a forbidden attribute: ${attribute}`);
    this.name = 'ForbiddenSpanAttributeError';
  }
}

/**
 * Replace every denied attribute on a span, in place.
 *
 * Returns the keys it acted on, so a caller can report them without the values
 * ever being read — which is the same rule `verify-log-hygiene.mjs` follows:
 * a control that reports a leak by quoting it has made a second copy of it.
 *
 * Exported for the test, which asserts the decision rather than the plumbing.
 */
export function scrubAttributes(attributes: Attributes): string[] {
  const hit: string[] = [];
  for (const key of Object.keys(attributes)) {
    if (!isForbiddenAttributeKey(key)) continue;
    hit.push(key);
    attributes[key] = REDACTED;
  }
  return hit;
}

export interface ScrubOptions {
  /**
   * Throw on a violation rather than redacting it.
   *
   * **For tests only.** See the note at the top of this file: `onEnd` runs
   * inside the instrumented operation's call stack, so a throw here fails the
   * database query it was watching. Enabling this in a running process is an
   * outage. Nothing outside `tracing.test.ts` passes it.
   */
  readonly strict: boolean;
  /** Told about each violation, for a metric or a log line. Never the value. */
  readonly onViolation?: (spanName: string, attribute: string) => void;
}

/**
 * A `SpanProcessor` that scrubs on the way out.
 *
 * Wraps the real exporting processor rather than replacing it: this one has no
 * opinion about batching, retries or shutdown, and delegating means the SDK's
 * own behaviour is unchanged. Order matters — this must be the outer one, so
 * nothing reaches the exporter unscrubbed.
 */
export class ScrubbingSpanProcessor implements SpanProcessor {
  /** Attribute keys already reported, so a per-query denial is logged once. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly inner: SpanProcessor,
    private readonly options: ScrubOptions,
  ) {}

  onStart(span: Span, parentContext: Parameters<SpanProcessor['onStart']>[1]): void {
    this.inner.onStart(span, parentContext);
  }

  /**
   * Scrub, then hand on.
   *
   * `onEnd` and not `onStart`, because an instrumentation is free to set
   * attributes at any point in a span's life and most of the interesting ones —
   * `db.statement` among them — are set as the operation completes. A check at
   * the start would run before the dangerous values existed.
   */
  onEnd(span: ReadableSpan): void {
    const hit = scrubAttributes(span.attributes);
    if (hit.length > 0) {
      const first = hit[0] as string;
      /*
        Reported once per distinct attribute key, not once per span.

        `db.query.text` turned out to be set by `instrumentation-pg` on every
        single query despite `enhancedDatabaseReporting: false`, so the
        un-deduplicated version wrote an error line per database operation. That
        would bury the log stream and — worse — train whoever reads it to ignore
        this message. What an operator needs to know is *that* an attribute is
        being denied, not how many times.

        Bounded by the denylist: at most one entry per key ever refused.
      */
      if (!this.reported.has(first)) {
        this.reported.add(first);
        this.options.onViolation?.(span.name, first);
      }
      if (this.options.strict) {
        throw new ForbiddenSpanAttributeError(span.name, first);
      }
    }
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
