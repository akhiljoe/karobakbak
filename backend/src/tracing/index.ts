/**
 * Tracing (phase 29), and the only file allowed to import the OpenTelemetry SDK.
 *
 * Same rule as `gateway.ts` and the model providers (D-AI-10): a vendor SDK
 * scattered across a codebase is a vendor that cannot be changed, and this one
 * would otherwise be reaching into the process that owns every WebSocket file
 * descriptor.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE MOST DANGEROUS THING IN THE OBSERVABILITY WORK
 * ---------------------------------------------------------------------------
 * There is no application-level message encryption (D15), so the observability
 * pipeline is the most likely path for content to *leave* the trusted boundary
 * (§18.1, I8). Logs have had a control since the beginning. Traces arrive with
 * none, written by libraries that have no idea what this system considers
 * content — and the defaults are actively wrong here:
 *
 *  * `pg` captures `db.statement`, which on this system is
 *    `insert into messages (conversation_id, body, ...)`.
 *  * `http` captures the request line including the query string, and
 *    `/auth/callback?code=...` is proxied through this origin.
 *
 * So: three controls, deliberately overlapping.
 *
 *  1. **Chosen instrumentations, not the auto bundle.** Four, named below.
 *     `auto-instrumentations-node` pulls in around forty packages and enables
 *     whatever it finds, which means the set of things that can write an
 *     attribute grows when a dependency is added rather than when somebody
 *     decides.
 *  2. **The dangerous captures are off at the instrumentation** (D53) — see
 *     each one's options.
 *  3. **`ScrubbingSpanProcessor` denies them again on the way out** (D52),
 *     sharing `logger.ts`'s field list, because (2) is a setting somebody can
 *     re-enable while looking for detail during an incident.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT TRACED, AND IT IS MOST OF THE PRODUCT
 * ---------------------------------------------------------------------------
 * The WebSocket message path has no spans. A socket is one HTTP request that
 * never ends, so an HTTP span per connection would stay open for the life of a
 * session and describe nothing that happened inside it — and adding manual
 * spans to the message path means instrumenting the hot path of a chat server
 * for observability, which is a cost this phase did not take.
 *
 * So what tracing answers here is: the HTTP routes (sign-in, payments, the
 * console-adjacent surface) with their database and Redis work beneath them,
 * and the **write-behind retention path**, which is where `DESIGN.md` makes its
 * strongest claims and which nothing else can show as a causal chain. The
 * cross-instance conversation flow §2.1 describes is still read from metrics
 * and logs. That gap is stated rather than papered over.
 *
 * ---------------------------------------------------------------------------
 * OFF BY DEFAULT
 * ---------------------------------------------------------------------------
 * `TRACING_ENABLED` ships false. Not caution for its own sake: tracing is the
 * one part of this stack that adds code to the address space holding the
 * sockets, and a deployment that is not looking at traces should not be
 * carrying the risk of producing them.
 */
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { ScrubbingSpanProcessor } from './scrub';

export interface Tracing {
  shutdown(): Promise<void>;
}

/**
 * What tracing needs, as plain values rather than as `Config`.
 *
 * Deliberate: this runs from a `--require` preload, before `loadConfig` has
 * been called and before anything in `src/` has been imported. A dependency on
 * `Config` here would drag the whole configuration module — and everything it
 * imports — into the preload, which is the opposite of what a preload is for.
 */
export interface TracingOptions {
  readonly endpoint: string;
  readonly serviceName: string;
  readonly instanceId: string;
  /** Throw on a denied attribute instead of redacting. True outside production. */
  readonly strict: boolean;
  /** Where a violation or an SDK diagnostic goes. One JSON line, like the logger. */
  readonly report: (level: 'warn' | 'error', message: string, fields: Record<string, unknown>) => void;
}

/**
 * Start tracing, or return null when it is off.
 *
 * Null rather than a no-op, the same shape as the payment routes: an
 * unconfigured deployment gets nothing rather than something that pretends.
 */
export function startTracing(options: TracingOptions): Tracing {

  // The SDK's own diagnostics, at warn. Its `error` channel is where an
  // exporter reports that it cannot reach the collector, which is worth seeing;
  // `info` narrates every batch.
  diag.setLogger(
    {
      error: (m) => options.report('warn', 'tracing', { component: 'otel', detail: String(m) }),
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    DiagLogLevel.WARN,
  );

  const exporter = new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      // The package version, read at build time. There is no version on
      // `Config` and adding one for a span attribute would put a field on the
      // contract that nothing else reads.
      [ATTR_SERVICE_VERSION]: String(process.env.npm_package_version ?? '0.1.0'),
      // The application's own stable id, not the container address. Same
      // reasoning as `instance_id` on the metrics registry: a container address
      // changes on every restart, so one process appears as two unrelated
      // things across a deploy.
      'service.instance.id': options.instanceId,
    }),
    spanProcessors: [
      new ScrubbingSpanProcessor(new BatchSpanProcessor(exporter), {
        // Derived from the same fact the logger derives its own strictness
        // from, rather than being a second setting that can disagree.
        strict: options.strict,
        onViolation: (spanName, attribute) => {
          // The attribute NAME and the span name, never the value. A control
          // that reports a leak by quoting it has made a second copy of it.
          options.report('error', 'span carried a forbidden attribute', {
            spanName,
            attribute,
          });
        },
      }),
    ],
  });

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        /*
          The upgrade is the interesting request and it never ends, so a span
          per WebSocket connection would be one open span for the life of a
          session — minutes to hours — and would say nothing about what
          happened inside it. The lifecycle is already described by metrics and
          by the session's own log lines.
        */
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? '';
          return (
            url.startsWith('/ws') ||
            url === '/health' ||
            url === '/ready' ||
            url === '/metrics'
          );
        },
      }),
      new PgInstrumentation({
        /*
          THE ONE THAT MATTERS (D53).

          `enhancedDatabaseReporting` adds the statement and its parameters to
          every span. On this system the statement is
          `insert into messages (conversation_id, body, ...)` and the parameters
          are the message rows, so the stock setting ships every retained
          conversation to a tracing backend.

          False is also the library default. It is set explicitly anyway,
          because a default that is relied upon silently is a default that
          changes in a minor version with nobody reading the changelog — and the
          blast radius here is every message this service has ever stored.
        */
        enhancedDatabaseReporting: false,
        /*
          FALSE, AND THAT IS THE POINT OF TRACING THIS SYSTEM AT ALL.

          `true` traces only queries that happen inside an already-traced
          request, which sounds like sensible noise control and here removes
          exactly the thing worth watching. The write-behind retention path runs
          on a timer with no parent — batched inserts, the circuit breaker, the
          spool drain — so with a parent required it produces no spans at all,
          and the subsystem `DESIGN.md` makes its strongest claims about stays
          invisible.

          The cost is that background queries arrive as root spans rather than
          hanging off a request. That is honest: they genuinely have no request.
        */
        requireParentSpan: false,
      }),
      new IORedisInstrumentation({
        /*
          Redis carries message text in exactly one place — a Pub/Sub payload in
          flight (rule 1) — and `dbStatementSerializer` is what would put it in
          a span. Replaced with one that emits the command name and nothing
          else, so a `publish` is visible as an operation and its payload is
          not expressible.
        */
        dbStatementSerializer: (cmdName) => cmdName,
        /*
          TRUE here, unlike `pg`, and the asymmetry is deliberate.

          Redis is on every heartbeat, every route resolution and every
          matchmaking attempt — orders of magnitude more operations than the
          database sees, most of them sub-millisecond. Root spans for all of
          them would be volume without information, and would bury the retention
          spans this configuration exists to surface.
        */
        requireParentSpan: true,
      }),
    ],
  });

  provider.register();

  return {
    async shutdown(): Promise<void> {
      try {
        await provider.shutdown();
      } catch {
        // A collector that is unreachable at shutdown must not fail a shutdown.
      }
    },
  };
}
