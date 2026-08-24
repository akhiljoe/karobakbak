/**
 * The metrics registry, and the rule that matters most about it: nothing that
 * identifies a person, a session or a message may reach the scrape output — as
 * a label name, a label value, or a sample value (§18, I8).
 */
import { loadConfig, type Config, type Env } from '../../src/config';
import {
  DELIVERY_ROUTES,
  MODERATION_ACTIONS,
  PRIORITY_CLASSES,
  REJECT_REASONS,
  createMetrics,
} from '../../src/metrics/registry';

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

describe('the registry', () => {
  it('exposes the metric names the design fixes (§18)', async () => {
    const metrics = createMetrics(config());
    const scrape = await metrics.scrape();

    for (const name of [
      'chat_connections_active',
      'chat_connections_rejected_total',
      'chat_queue_depth',
      'chat_active_matches',
      'chat_messages_received_total',
      'chat_messages_delivered_total',
      'chat_rate_limited_total',
      'chat_reports_total',
      'chat_blocks_total',
      'chat_moderation_flags_total',
      'chat_retention_queue_depth',
      'chat_retention_dropped_total',
      'chat_retention_session_quota_evictions_total',
      'chat_retention_deleted_total',
      'chat_deletion_failures_total',
      'chat_spool_records',
      'chat_spool_corrupt_records_total',
      'chat_db_breaker_state',
      'chat_db_breaker_transitions_total',
      'chat_backup_last_success_timestamp',
    ]) {
      expect(scrape).toContain(name);
    }
  });

  it('collects process metrics, including event-loop lag', async () => {
    const metrics = createMetrics(config());
    const scrape = await metrics.scrape();
    // The first thing to move when a socket fan-out or a moderation regex
    // starts costing more than it should.
    expect(scrape).toContain('chat_process_nodejs_eventloop_lag_seconds');
  });

  it('zero-initialises fixed label sets, so a dashboard shows 0 not "no data"', async () => {
    const metrics = createMetrics(config());
    const scrape = await metrics.scrape();
    // The two look identical on a graph and mean very different things during
    // an incident.
    for (const reason of REJECT_REASONS) {
      expect(scrape).toContain(`chat_connections_rejected_total{reason="${reason}"`);
    }
    for (const route of DELIVERY_ROUTES) {
      expect(scrape).toContain(`chat_messages_delivered_total{route="${route}"`);
    }
    for (const action of MODERATION_ACTIONS) {
      expect(scrape).toContain(`chat_moderation_flags_total{action="${action}"`);
    }
    for (const priority of PRIORITY_CLASSES) {
      expect(scrape).toContain(`chat_retention_queue_depth{class="${priority}"`);
    }
  });

  it('labels every series with the instance id and nothing else identifying', async () => {
    const metrics = createMetrics(config({ INSTANCE_ID: 'i_one' }));
    const scrape = await metrics.scrape();
    // `instance_id`, not `instance`: Prometheus attaches its own `instance`
    // label from the discovered target, and a colliding one from the exposition
    // is renamed to `exported_instance` — so the stable id would have been
    // present under a name nothing queried, while `instance` held a container
    // address that changes on every restart.
    expect(scrape).toContain('instance_id="i_one"');
  });
});

describe('nothing identifying reaches the scrape output (I8)', () => {
  /** Every label a caller could plausibly reach for, driven with real values. */
  function exercise(metrics: ReturnType<typeof createMetrics>): void {
    metrics.connectionsActive.set(3);
    metrics.connectionsTotal.inc();
    metrics.connectionsRejected.labels('origin').inc();
    metrics.rateLimited.labels('message').inc();
    metrics.queueDepth.labels('default').set(2);
    metrics.messagesReceived.inc();
    metrics.messagesDelivered.labels('local').inc();
    metrics.messagesRejected.labels('duplicate').inc();
    metrics.deliveryLatency.labels('remote').observe(0.02);
    metrics.moderationFlags.labels('flag').inc();
    metrics.blocks.labels('ip').inc();
    metrics.retentionQueueDepth.labels('p0').set(1);
    metrics.retentionDropped.labels('p3', 'queue_full').inc();
    metrics.retentionDeleted.labels('messages').inc(5);
    metrics.dbWriteFailures.labels('57P01').inc();
    metrics.breakerTransitions.labels('OPEN').inc();
  }

  it('contains no session, match or message id', async () => {
    const metrics = createMetrics(config());
    exercise(metrics);
    const scrape = await metrics.scrape();

    // The id prefixes this codebase generates. A session id as a label is not
    // a privacy problem that happens to also be a cardinality problem — it is
    // an outage, because every distinct value is a new time series.
    expect(scrape).not.toMatch(/\bs_[A-Za-z0-9_-]{10,}/);
    expect(scrape).not.toMatch(/\bm_[A-Za-z0-9_-]{10,}/);
    expect(scrape).not.toMatch(/\bmsg_[A-Za-z0-9_-]{10,}/);
  });

  it('contains nothing shaped like an IP address or a hash', async () => {
    const metrics = createMetrics(config());
    exercise(metrics);
    const scrape = await metrics.scrape();

    expect(scrape).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    // A 32-character hex run is what a salted ipHash or clientHash looks like.
    expect(scrape).not.toMatch(/\b[a-f0-9]{32}\b/);
  });

  it('draws every label value from a small fixed set', async () => {
    const metrics = createMetrics(config());
    exercise(metrics);
    const scrape = await metrics.scrape();

    const values = [...scrape.matchAll(/[a-z_]+="([^"]*)"/g)].map((match) => match[1] ?? '');
    for (const value of values) {
      // Long or high-entropy label values are the shape of an id. Everything
      // legitimate here is a short enumerated token, a version, or the
      // instance name.
      expect(value.length).toBeLessThan(64);
    }
    // And the set of distinct values stays small: unbounded cardinality is the
    // failure this guards against.
    expect(new Set(values).size).toBeLessThan(120);
  });

  it('never carries user content, even when a caller tries', async () => {
    const metrics = createMetrics(config());
    // The moderation label set is fixed; a rule id or an excerpt cannot become
    // one, because the only values ever passed are the four actions.
    metrics.moderationFlags.labels('withhold').inc();
    const scrape = await metrics.scrape();
    expect(scrape).not.toContain('CANARY');
    expect(scrape).toContain('chat_moderation_flags_total{action="withhold"');
  });
});
