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
  /**
   * An enforcement decision refusing a connection before a session exists.
   *
   * Was used by `server.ts` and missing from this list, which is the one place
   * it mattered. Every reason here is zero-initialised below so a dashboard
   * shows `0` rather than "no data" — and this was the reason that never
   * appeared until the first ban fired, so an operator could not tell "nobody
   * is banned" from "that series does not exist".
   *
   * `PHASES.md` worried that a ban misfiring at the edge would read as a
   * capacity problem rather than a safety bug. This is part of why: the
   * capacity reasons were visible at zero and the safety one was not.
   */
  'banned',
] as const;
export const MODERATION_ACTIONS = ['allow', 'flag', 'withhold', 'block'] as const;
/** Why a match attempt gave up. Every value the matchmaker can report. */
export const MATCHMAKING_FAILURES = ['already_matched', 'session_gone', 'unknown'] as const;
/** Why a frame was refused before it became a command. */
export const FRAME_REJECTIONS = ['unreadable', 'invalid', 'oversized'] as const;
/** Breaker states, as transition targets. */
export const BREAKER_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;

/**
 * Why the supervisor did not dispatch a persona (A3).
 *
 * Every value is zero-initialised, for the reason `REJECT_REASONS` records:
 * `'banned'` was written by the upgrade path and missing from that list, so the
 * series never appeared and a dashboard showed "no data" for a refusal that was
 * happening. The same mistake here would hide a fill policy that has quietly
 * stopped filling.
 */
export const PERSONA_SKIP_REASONS = [
  'disabled',
  'nobody_waiting',
  'humans_available',
  'not_waited_long_enough',
  'at_capacity',
  'character_at_capacity',
  'too_soon',
  'queue_unreadable',
] as const;

/** The six limits in D-AI-5, by name. The safety numbers that matter most. */
export const PERSONA_LIMITS = [
  'sexual',
  'minor',
  'escalation',
  'crisis',
  'personal_info',
  'identity',
] as const;

/** Token kinds, priced differently, so the bill stays explainable. */
export const PERSONA_TOKEN_KINDS = ['input', 'output', 'cache_read', 'cache_write'] as const;
export const PRIORITY_CLASSES: readonly RetentionPriority[] = ['p0', 'p1', 'p2', 'p3'];

export type RejectReason = (typeof REJECT_REASONS)[number];
export type MatchmakingFailure = (typeof MATCHMAKING_FAILURES)[number];
export type FrameRejection = (typeof FRAME_REJECTIONS)[number];
export type DeliveryRouteLabel = (typeof DELIVERY_ROUTES)[number];

export interface Metrics {
  readonly registry: Registry;

  /* connections and protocol */
  readonly connectionsActive: Gauge<string>;
  readonly connectionsTotal: Counter<string>;
  readonly connectionsRejected: Counter<'reason'>;
  readonly disconnects: Counter<string>;
  readonly oversizedFrames: Counter<string>;
  readonly invalidFrames: Counter<'reason'>;
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
   * What people declare when they join, by gender, counting `none`.
   *
   * Not the same question as `chat_queue_composition`, and the difference is
   * the point. That gauge is who is *waiting*, which is biased by how long each
   * group waits: a group that matches quickly is under-represented in any
   * snapshot of the queue, because they are not in it for long. This counts who
   * *arrives*, which nothing distorts.
   *
   * Divergence between the two is itself the signal §29.6 asks for. If arrivals
   * are 15% female and the pool is 5%, declared-female sessions are matching
   * roughly three times faster than everyone else — which is precisely what a
   * gender preference would cause, and the first sign that it is degrading the
   * experience of the group it selects for.
   */
  readonly profilesDeclared: Counter<'gender'>;
  /**
   * Resume attempts, by outcome.
   *
   * `expired` is the number worth watching: a high ratio means the grace window
   * is shorter than the reconnections people actually make, and every one of
   * them was a conversation that ended when it did not have to.
   */
  readonly resumes: Counter<'outcome'>;
  /**
   * Searches whose declared preference was not applied, by which limit stopped
   * it (§29.4).
   *
   * The only way either limit is observable at all. Both degrade to an ordinary
   * match and nothing reaches the user, which is deliberate — and it means that
   * without this counter, "the preference matched nobody" and "the preference
   * was never applied" look identical from outside. They want opposite
   * responses: the first is a thin pool, the second is a limit set too tight.
   *
   * A steady `cooldown` rate is ordinary — it is the limit doing its job on
   * people who advance quickly. A rising `budget` rate is the one to read:
   * either somebody is hunting, or the hourly number is too small for how the
   * feature is actually used.
   */
  readonly preferenceLimited: Counter<'reason'>;

  /* matchmaking */
  readonly queueDepth: Gauge<'segment'>;
  /**
   * What the pool is made of, by declared gender (§29.6).
   *
   * The denominator. Every other preference number is unreadable without it:
   * a fallback rate means nothing unless you know whether the pool was 5%
   * preferred or 40%. Sampled above a cap and exact below it, which at launch
   * volumes means exact.
   */
  readonly queueComposition: Gauge<'segment' | 'gender'>;
  /**
   * How long a conversation lasted, by how it ended.
   *
   * The one product signal nothing else carries: a three-second skip and a
   * twenty-minute conversation are otherwise the same event, both a single
   * increment of `chat_matches_created_total`. Its `_count` per reason also
   * gives the end-reason breakdown, so there is no separate counter to keep in
   * step.
   */
  readonly conversationDuration: Histogram<'reason'>;
  readonly activeMatches: Gauge<string>;
  readonly matchAttempts: Counter<string>;
  readonly matchesCreated: Counter<string>;
  readonly matchmakingFailures: Counter<'reason'>;
  readonly skips: Counter<string>;
  /** Reactions delivered to a partner. Never stored, so this is the only trace. */
  readonly reactions: Counter<string>;
  /**
   * Connections created — both sides saved and a row was written (§31).
   *
   * Counted only on the call that created the row, never on a repeat, so it is
   * a count of relationships rather than of button presses. Deliberately has no
   * counterpart for one-sided saves: that number is a measure of how often
   * somebody was not saved back, and publishing it would make a private refusal
   * into an operational statistic.
   */
  readonly connectionsMade: Counter<string>;
  readonly matchmakingLatency: Histogram<string>;

  /* messages */
  readonly messagesReceived: Counter<string>;
  readonly messagesDelivered: Counter<'route'>;
  readonly messagesRejected: Counter<'reason'>;
  readonly deliveryLatency: Histogram<'route'>;

  /* safety */
  /**
   * Enforcement actions are deliberately **not** here.
   *
   * `chat_enforcement_actions_total` used to be declared beside these and was
   * never written, because the only process that issues or revokes a sanction
   * is the moderation console — which runs on its own, deliberately isolated
   * (D32), and exposes no scrape endpoint at all. The metric could not have
   * been collected from anywhere, and a dashboard panel read it and showed an
   * empty graph that looked like "no enforcement" rather than "no data".
   *
   * Measuring it means giving the console its own metrics endpoint and
   * Prometheus job. That is a change to what the console *is*, not a wiring
   * fix, so it is not made here. What the chat process can see — a banned
   * connection being refused at the upgrade — is already
   * `chat_connections_rejected_total`.
   */
  readonly reports: Counter<string>;
  /**
   * Reports nobody has triaged yet, and how long the oldest has waited.
   *
   * The pair that makes a moderation response target measurable rather than
   * intended — and the target itself is exported beside them, so an alert can
   * compare the two instead of hardcoding a number that drifts out of step
   * with configuration.
   */
  readonly reportsOpen: Gauge<string>;
  readonly reportQueueOldest: Gauge<string>;
  readonly reportResponseTarget: Gauge<string>;
  readonly blocks: Counter<'dimension'>;
  readonly moderationFlags: Counter<'action'>;

  /* retention */
  readonly retentionQueueDepth: Gauge<'class'>;
  readonly retentionQueued: Counter<string>;
  readonly retentionFlushed: Counter<string>;
  readonly retentionDropped: Counter<'class' | 'reason'>;
  readonly retentionQuotaEvictions: Counter<string>;
  readonly retentionDeleted: Counter<'table'>;
  readonly deletionFailures: Counter<string>;

  /**
   * Limits the application is running with, exported so an alert compares
   * against them instead of repeating them.
   *
   * A threshold copied into a rule file drifts the moment somebody tunes one
   * and not the other — `SpoolNearCapacity` fired at a hardcoded 40000, which
   * is 80% of the *default* spool size and unreachable on a deployment that
   * lowered it. The rule then watches a ceiling nothing can reach while the
   * spool fills and drops records silently.
   */
  readonly spoolMaxRecords: Gauge<string>;
  readonly spoolMaxBytes: Gauge<string>;
  readonly backupMaxAge: Gauge<string>;

  /**
   * Rows past their retention deadline that still exist.
   *
   * The number that proves the deletion promise is being kept, and the reason
   * `chat_retention_deleted_total` is the wrong instrument for it: a worker
   * falling behind still deletes steadily, so throughput looks healthy while
   * the backlog grows. A worker that is keeping up has a backlog of
   * approximately zero, which is true independently of volume, batch size and
   * interval.
   */
  readonly retentionBacklog: Gauge<'table'>;

  /* ---------------------------------------------------------------------- */
  /* AI personas (D-AI-8)                                                    */
  /* ---------------------------------------------------------------------- */
  /**
   * None of these carries message content, and none ever can.
   *
   * Rule 1 names Prometheus labels *and values* explicitly, so the live persona
   * feed that everybody asks for cannot be built here. What a persona said is
   * read in the moderation console, audited. These answer how many, how fast,
   * how much, and how often a limit tripped.
   *
   * `conversation_id` is deliberately absent from every label set below: it is
   * unbounded cardinality and it is also half a content leak, since it joins a
   * time series to a transcript.
   */
  readonly personaConversations: Counter<'persona_id' | 'outcome'>;
  readonly personaReplies: Counter<'persona_id'>;
  readonly personaSessionsActive: Gauge<string>;
  readonly personaRepliesPerConversation: Histogram<string>;

  /** Fill policy — is A3 doing what it claims. */
  readonly personaFillDispatched: Counter<string>;
  readonly personaFillSuppressed: Counter<'reason'>;
  readonly personaWaitBeforeFill: Histogram<string>;
  readonly personaWithdrawn: Counter<string>;

  /** Spend. The numbers that answer "what will this cost me". */
  readonly personaTokens: Counter<'provider' | 'model' | 'kind'>;
  readonly personaCost: Counter<'provider' | 'model'>;
  readonly personaBudgetRemaining: Gauge<string>;
  readonly personaBudgetExhausted: Counter<string>;

  /** Safety. Not optional, and the reason A5 is the phase that carries A4. */
  readonly personaLimitTrips: Counter<'limit'>;
  readonly personaSessionsFlagged: Counter<'reason'>;

  /** Provider health, needed the moment there is more than one vendor. */
  readonly personaProviderRequests: Counter<'provider' | 'model' | 'outcome'>;
  readonly personaProviderLatency: Histogram<'provider'>;

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
  // `instance_id`, not `instance`. Prometheus attaches its own `instance`
  // label — the discovered target's address — and with `honor_labels` unset it
  // renames a colliding one from the exposition to `exported_instance`. So the
  // application's stable id was present under a name nothing expected, while
  // `instance` was a container address that changes on every restart.
  //
  // Nothing broke, because every dashboard query aggregates. It would break the
  // first time somebody debugged a single replica during an incident: `by
  // (instance)` groups by an address that is not stable across a deploy, so one
  // process appears as two unrelated series.
  registry.setDefaultLabels({ instance_id: config.instanceId });

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
    invalidFrames: counter('chat_invalid_frames_total', 'Malformed protocol frames, by reason', [
      'reason',
    ]),
    socketErrors: counter('chat_socket_errors_total', 'Transport-level socket errors'),
    rateLimited: counter('chat_rate_limited_total', 'Commands refused by a token bucket', ['command']),
    profilesDeclared: counter(
      'chat_profiles_declared_total',
      'Gender declared on an explicit join, counting "none" for declining it',
      ['gender'],
    ),
    profilesRefused: counter('chat_profiles_refused_total', 'Declared profiles refused at join, by reason', [
      'reason',
    ]),
    resumes: counter('chat_session_resumes_total', 'Session resume attempts, by outcome', ['outcome']),
    preferenceLimited: counter(
      'chat_preference_limited_total',
      'Searches whose declared preference was not applied, by which limit stopped it',
      ['reason'],
    ),

    queueDepth: gauge('chat_queue_depth', 'Sessions waiting in a queue segment', ['segment']),
    queueComposition: gauge(
      'chat_queue_composition',
      'Sessions waiting, by declared gender. Undeclared is reported as "none"',
      ['segment', 'gender'],
    ),
    conversationDuration: histogram(
      'chat_conversation_duration_seconds',
      'How long a conversation lasted, by how it ended',
      // Spans the two ends that matter: an instant skip, and a conversation
      // somebody stayed in. The low buckets are close together because that is
      // where the quality signal lives -- 1s versus 30s is the whole question,
      // and 10min versus 20min is not.
      [1, 3, 5, 10, 30, 60, 180, 600, 1800],
      ['reason'],
    ),
    activeMatches: gauge('chat_active_matches', 'Live conversations, cluster-wide'),
    matchAttempts: counter('chat_match_attempts_total', 'tryMatch invocations'),
    matchesCreated: counter('chat_matches_created_total', 'Conversations formed'),
    connectionsMade: counter('chat_connections_made_total', 'Mutually saved connections created'),
    matchmakingFailures: counter('chat_matchmaking_failures_total', 'Match attempts that aborted', ['reason']),
    skips: counter('chat_skips_total', 'Conversations ended by a skip'),
    reactions: counter('chat_reactions_total', 'Message reactions delivered'),
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
    reportsOpen: gauge('chat_reports_open', 'Reports waiting to be triaged'),
    reportQueueOldest: gauge(
      'chat_report_queue_oldest_seconds',
      'Age of the oldest untriaged report, in seconds',
    ),
    reportResponseTarget: gauge(
      'chat_report_response_target_seconds',
      'The configured response target, exported so alerts compare against it',
    ),
    blocks: counter('chat_blocks_total', 'Block dimensions recorded', ['dimension']),
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

    spoolMaxRecords: gauge('chat_spool_max_records', 'Configured spool record ceiling'),
    spoolMaxBytes: gauge('chat_spool_max_bytes', 'Configured spool byte ceiling'),
    backupMaxAge: gauge('chat_backup_max_age_seconds', 'Configured backup staleness window'),
    retentionBacklog: gauge(
      'chat_retention_backlog',
      'Rows past their retention deadline that still exist',
      ['table'],
    ),
    personaConversations: counter(
      'chat_persona_conversations_total',
      'Persona conversations, by character and how they ended',
      ['persona_id', 'outcome'],
    ),
    personaReplies: counter('chat_persona_replies_total', 'Messages sent by personas', ['persona_id']),
    personaSessionsActive: gauge('chat_persona_sessions_active', 'Personas currently connected'),
    personaRepliesPerConversation: histogram(
      'chat_persona_replies_per_conversation',
      'Messages a persona sent in one conversation',
      [1, 2, 4, 6, 8, 12, 16, 24],
    ),

    personaFillDispatched: counter('chat_persona_fill_dispatched_total', 'Personas dispatched to fill a gap'),
    personaFillSuppressed: counter(
      'chat_persona_fill_suppressed_total',
      'Dispatches the fill policy declined, by reason',
      ['reason'],
    ),
    personaWaitBeforeFill: histogram(
      'chat_persona_wait_before_fill_seconds',
      'How long the human had waited when a persona was dispatched',
      [5, 10, 20, 30, 60, 120, 300],
    ),
    personaWithdrawn: counter(
      'chat_persona_withdrawn_total',
      'Searching personas pulled out because humans could pair instead',
    ),

    personaTokens: counter('chat_persona_tokens_total', 'Tokens by provider, model and kind', [
      'provider',
      'model',
      'kind',
    ]),
    personaCost: counter('chat_persona_cost_micro_cents_total', 'Spend in micro-cents', [
      'provider',
      'model',
    ]),
    personaBudgetRemaining: gauge(
      'chat_persona_budget_remaining_micro_cents',
      'Micro-cents left in the current period ceiling',
    ),
    personaBudgetExhausted: counter(
      'chat_persona_budget_exhausted_total',
      'Times a call was refused because the ceiling was reached',
    ),

    personaLimitTrips: counter(
      'chat_persona_limit_trips_total',
      'D-AI-5 limits enforced, by limit',
      ['limit'],
    ),
    personaSessionsFlagged: counter(
      'chat_persona_sessions_flagged_total',
      'Persona sessions flagged for human review, by reason',
      ['reason'],
    ),

    personaProviderRequests: counter(
      'chat_persona_provider_requests_total',
      'Model calls by provider, model and outcome',
      ['provider', 'model', 'outcome'],
    ),
    personaProviderLatency: histogram(
      'chat_persona_provider_latency_seconds',
      'Model call latency',
      [0.25, 0.5, 1, 2, 4, 8, 16],
      ['provider'],
    ),

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

  // The configured limits are published by the bootstrap, not here — see
  // `publishLimits`. Setting them in this file would put their only write site
  // inside the module that declares them, and `metrics-wiring.test.ts` reads
  // "declared and written only where it is declared" as dead, which is the
  // check that found ten genuinely dead metrics.
  for (const reason of MATCHMAKING_FAILURES) metrics.matchmakingFailures.labels(reason).inc(0);
  for (const reason of FRAME_REJECTIONS) metrics.invalidFrames.labels(reason).inc(0);
  for (const state of BREAKER_STATES) metrics.breakerTransitions.labels(state).inc(0);

  // Persona label sets. The fill reasons matter most: a policy that has quietly
  // stopped filling looks identical to one that has nothing to fill, unless
  // every reason is already on the graph at zero.
  for (const reason of PERSONA_SKIP_REASONS) metrics.personaFillSuppressed.labels(reason).inc(0);
  for (const limit of PERSONA_LIMITS) metrics.personaLimitTrips.labels(limit).inc(0);
  for (const limit of PERSONA_LIMITS) metrics.personaSessionsFlagged.labels(limit).inc(0);

  return metrics;
}
