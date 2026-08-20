/**
 * The metrics registry (§18).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY NEVER BE A LABEL — OR A VALUE
 * ---------------------------------------------------------------------------
 * Message text, any user content, a session id, a match id, a message id, an IP
 * address, or any client-supplied string. Not as a label *name*, not as a label
 * *value*, and not as a sample value either.
 *
 * Two reasons, and the second is the one people forget. A metrics endpoint is
 * scraped into a system with its own retention, its own access control and its
 * own backups, none of which are the ones §2.1 describes — so anything that
 * reaches here has left the trusted boundary (I8). And every distinct label
 * value is a separate time series: a session id as a label is not a privacy
 * problem that also happens to be a cardinality problem, it is an outage.
 *
 * Every label in this file is drawn from a fixed, small set enumerated beside
 * it. `metrics.test.ts` scrapes the registry and asserts that nothing shaped
 * like an id ever appears in the output.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { Config, RetentionPriority } from '../config';

/** Fixed label sets. Anything not listed here is a bug, not a new value. */
export const DELIVERY_ROUTES = ['local', 'remote', 'dropped'] as const;
export const REJECT_REASONS = [
  'origin',
  'at_capacity',
  'rate_limited',
  'too_many_connections',
  'bad_path',
  'draining',
  'error',
] as const;
export const MODERATION_ACTIONS = ['allow', 'flag', 'withhold', 'block'] as const;
export const PRIORITY_CLASSES: readonly RetentionPriority[] = ['p0', 'p1', 'p2', 'p3'];

export type RejectReason = (typeof REJECT_REASONS)[number];
export type DeliveryRouteLabel = (typeof DELIVERY_ROUTES)[number];

export interface Metrics {
  readonly registry: Registry;

  /* connections and protocol */
  readonly connectionsActive: Gauge<string>;
  readonly connectionsTotal: Counter<string>;
  readonly connectionsRejected: Counter<'reason'>;
  readonly disconnects: Counter<string>;
  readonly oversizedFrames: Counter<string>;
  readonly invalidFrames: Counter<string>;
  readonly socketErrors: Counter<string>;
  readonly rateLimited: Counter<'command'>;
  /**
   * Declared profiles refused at join, by reason.
   *
   * `age_below_minimum` is the one to watch: it counts people who told this
   * service they are under 18. That is a safety signal and an input to the
   * minor-safety policy security section 24 requires before launch — a count
   * only, never who or what age, because that is a claim about a person (I8).
   */
  readonly profilesRefused: Counter<'reason'>;
  /**
   * Resume attempts, by outcome.
   *
   * `expired` is the number worth watching: a high ratio means the grace window
   * is shorter than the reconnections people actually make, and every one of
   * them was a conversation that ended when it did not have to.
   */
  readonly resumes: Counter<'outcome'>;

  /* matchmaking */
  readonly queueDepth: Gauge<'segment'>;
  readonly activeMatches: Gauge<string>;
  readonly matchAttempts: Counter<string>;
  readonly matchesCreated: Counter<string>;
  readonly matchmakingFailures: Counter<'reason'>;
  readonly skips: Counter<string>;
  readonly matchmakingLatency: Histogram<string>;

  /* messages */
  readonly messagesReceived: Counter<string>;
  readonly messagesDelivered: Counter<'route'>;
  readonly messagesRejected: Counter<'reason'>;
  readonly deliveryLatency: Histogram<'route'>;

  /* safety */
  readonly reports: Counter<string>;
  readonly blocks: Counter<'dimension'>;
  readonly enforcementActions: Counter<'action'>;
  readonly moderationFlags: Counter<'action'>;

  /* retention */
  readonly retentionQueueDepth: Gauge<'class'>;
  readonly retentionQueued: Counter<string>;
  readonly retentionFlushed: Counter<string>;
  readonly retentionDropped: Counter<'class' | 'reason'>;
  readonly retentionQuotaEvictions: Counter<string>;
  readonly retentionDeleted: Counter<'table'>;
  readonly deletionFailures: Counter<string>;

  /* spool and breaker */
  readonly spoolRecords: Gauge<string>;
  readonly spoolBytes: Gauge<string>;
  readonly spoolWrites: Counter<string>;
  readonly spoolDrained: Counter<string>;
  readonly spoolCorrupt: Counter<string>;
  readonly spoolExpired: Counter<string>;
  readonly breakerState: Gauge<string>;
  readonly breakerTransitions: Counter<'to'>;
  readonly dbWriteLatency: Histogram<string>;
  readonly dbWriteFailures: Counter<'code'>;

  /* backups */
  readonly backupLastSuccess: Gauge<string>;
  readonly backupFailures: Counter<string>;

  scrape(): Promise<string>;
}

export interface MetricsOptions {
  /**
   * Collect process metrics. On by default; off in tests, where the collector's
   * timer keeps the event loop alive after the suite has finished and makes a
   * clean exit impossible to distinguish from a leak in the code under test.
   */
  readonly processMetrics?: boolean;
}

export function createMetrics(config: Config, options: MetricsOptions = {}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ instance: config.instanceId });

  // Event-loop lag, process memory, GC and handle counts. The event-loop lag is
  // the one that matters here: it is the first thing to move when a socket
  // fan-out or a moderation regex starts costing more than it should.
  if (options.processMetrics !== false) {
    collectDefaultMetrics({ register: registry, prefix: 'chat_process_' });
  }

  const counter = <T extends string>(name: string, help: string, labelNames: T[] = []) =>
    new Counter({ name, help, labelNames, registers: [registry] });
  const gauge = <T extends string>(name: string, help: string, labelNames: T[] = []) =>
    new Gauge({ name, help, labelNames, registers: [registry] });
  const histogram = <T extends string>(
    name: string,
    help: string,
    buckets: number[],
    labelNames: T[] = [],
  ) => new Histogram({ name, help, buckets, labelNames, registers: [registry] });

  const metrics: Metrics = {
    registry,

    connectionsActive: gauge('chat_connections_active', 'WebSocket connections attached to this instance'),
    connectionsTotal: counter('chat_connections_total', 'WebSocket connections accepted'),
    connectionsRejected: counter('chat_connections_rejected_total', 'Upgrades refused, by reason', ['reason']),
    disconnects: counter('chat_disconnects_total', 'Sockets closed'),
    oversizedFrames: counter('chat_oversized_frames_total', 'Frames refused for exceeding the size limit'),
    invalidFrames: counter('chat_invalid_frames_total', 'Malformed protocol frames'),
    socketErrors: counter('chat_socket_errors_total', 'Transport-level socket errors'),
    rateLimited: counter('chat_rate_limited_total', 'Commands refused by a token bucket', ['command']),
    profilesRefused: counter('chat_profiles_refused_total', 'Declared profiles refused at join, by reason', [
      'reason',
    ]),
    resumes: counter('chat_session_resumes_total', 'Session resume attempts, by outcome', ['outcome']),

    queueDepth: gauge('chat_queue_depth', 'Sessions waiting in a queue segment', ['segment']),
    activeMatches: gauge('chat_active_matches', 'Live conversations, cluster-wide'),
    matchAttempts: counter('chat_match_attempts_total', 'tryMatch invocations'),
    matchesCreated: counter('chat_matches_created_total', 'Conversations formed'),
    matchmakingFailures: counter('chat_matchmaking_failures_total', 'Match attempts that aborted', ['reason']),
    skips: counter('chat_skips_total', 'Conversations ended by a skip'),
    matchmakingLatency: histogram(
      'chat_matchmaking_latency_seconds',
      'Time from joining the queue to being matched',
      [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120],
    ),

    messagesReceived: counter('chat_messages_received_total', 'Messages accepted from clients'),
    messagesDelivered: counter('chat_messages_delivered_total', 'Messages routed to a partner', ['route']),
    messagesRejected: counter('chat_messages_rejected_total', 'Messages refused, by reason', ['reason']),
    deliveryLatency: histogram(
      'chat_delivery_latency_seconds',
      'Time from accepting a message to handing it to the partner path',
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      ['route'],
    ),

    reports: counter('chat_reports_total', 'Reports filed'),
    blocks: counter('chat_blocks_total', 'Block dimensions recorded', ['dimension']),
    enforcementActions: counter('chat_enforcement_actions_total', 'Enforcement actions taken', ['action']),
    moderationFlags: counter('chat_moderation_flags_total', 'Moderation outcomes, by action', ['action']),

    retentionQueueDepth: gauge('chat_retention_queue_depth', 'Records waiting to be written', ['class']),
    retentionQueued: counter('chat_retention_queued_total', 'Records accepted into the queue'),
    retentionFlushed: counter('chat_retention_flushed_total', 'Records written to the database'),
    retentionDropped: counter('chat_retention_dropped_total', 'Records dropped, by class and reason', [
      'class',
      'reason',
    ]),
    retentionQuotaEvictions: counter(
      'chat_retention_session_quota_evictions_total',
      'Records evicted because one session exceeded its share of a class',
    ),
    retentionDeleted: counter('chat_retention_deleted_total', 'Rows deleted by the retention worker', ['table']),
    deletionFailures: counter('chat_deletion_failures_total', 'Deletion passes that failed'),

    spoolRecords: gauge('chat_spool_records', 'Records currently in the outage spool'),
    spoolBytes: gauge('chat_spool_bytes', 'Bytes currently in the outage spool'),
    spoolWrites: counter('chat_spool_writes_total', 'Records written to the outage spool'),
    spoolDrained: counter('chat_spool_drained_total', 'Records replayed from the outage spool'),
    spoolCorrupt: counter('chat_spool_corrupt_records_total', 'Spool lines that could not be parsed'),
    spoolExpired: counter('chat_spool_expired_total', 'Spool records dropped for age'),

    breakerState: gauge('chat_db_breaker_state', 'Database circuit breaker: 0 closed, 1 half-open, 2 open'),
    breakerTransitions: counter('chat_db_breaker_transitions_total', 'Breaker state changes', ['to']),
    dbWriteLatency: histogram(
      'chat_db_write_latency_seconds',
      'Time to write one retention batch',
      [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    ),
    dbWriteFailures: counter('chat_db_write_failures_total', 'Failed retention writes, by SQL state', ['code']),

    backupLastSuccess: gauge('chat_backup_last_success_timestamp', 'Unix time of the last observed successful backup'),
    backupFailures: counter('chat_backup_failures_total', 'Backup failures reported'),

    async scrape(): Promise<string> {
      return registry.metrics();
    },
  };

  // Zero-initialise the fixed label sets, so a dashboard shows 0 rather than
  // "no data" for something that has genuinely not happened yet — the two look
  // identical on a graph and mean very different things during an incident.
  for (const reason of REJECT_REASONS) metrics.connectionsRejected.labels(reason).inc(0);
  for (const route of DELIVERY_ROUTES) metrics.messagesDelivered.labels(route).inc(0);
  for (const action of MODERATION_ACTIONS) metrics.moderationFlags.labels(action).inc(0);
  for (const priority of PRIORITY_CLASSES) metrics.retentionQueueDepth.labels(priority).set(0);

  return metrics;
}
