/**
 * The write-behind pipeline end to end: queue, breaker, spool and the paced
 * drain, against a real PostgreSQL and a real spool file.
 */
import { randomUUID } from 'node:crypto';

import { brokenDatabase, createPostgresContext, type PostgresContext } from '../helpers/postgres';
import { createNullLogger } from '../../src/logger';
import { RetentionWriter } from '../../src/storage/retention';
import { FileSpool } from '../../src/storage/spool';
import type { MessageRecord, RetentionRecord } from '../../src/storage/records';

let ctx: PostgresContext;

beforeAll(async () => {
  ctx = await createPostgresContext();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(async () => {
  await ctx.db.query('truncate conversations, messages, reports cascade');
});

let counter = 0;

function conversationId(): string {
  return randomUUID();
}

function conversation(id: string): RetentionRecord {
  return {
    kind: 'conversation_started',
    conversationId: id,
    sessionA: 's_a',
    sessionB: 's_b',
    segment: 'default',
    startedAt: new Date().toISOString(),
  };
}

function message(id: string, sessionId = 's_a'): MessageRecord {
  counter += 1;
  return {
    kind: 'message',
    messageId: randomUUID(),
    conversationId: id,
    senderSessionId: sessionId,
    serverTimestamp: new Date().toISOString(),
    type: 'text',
    body: `message ${counter}`,
    moderationAction: 'allow',
    moderationFlags: [],
  };
}

describe('the happy path', () => {
  it('accepts without blocking and writes on the next flush', async () => {
    const writer = ctx.writer();
    const id = conversationId();

    const before = process.hrtime.bigint();
    writer.enqueue(conversation(id));
    for (let i = 0; i < 20; i += 1) writer.enqueue(message(id));
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1_000_000;

    // Chat never waits on the database: enqueue does no I/O at all (D16).
    expect(elapsedMs).toBeLessThan(50);
    expect(await ctx.count('messages')).toBe(0);

    await writer.flush();
    expect(await ctx.count('messages')).toBe(20);
  });

  it('writes in batches no larger than configured', async () => {
    const writer = ctx.writer({ RETENTION_BATCH_SIZE: '5' });
    const id = conversationId();
    writer.enqueue(conversation(id));
    for (let i = 0; i < 12; i += 1) writer.enqueue(message(id));

    await writer.flush();
    // One conversation row plus four messages in the first batch of five.
    expect(await ctx.count('messages')).toBe(4);
    await writer.flush();
    await writer.flush();
    expect(await ctx.count('messages')).toBe(12);
  });

  it('writes safety records before ordinary chat', async () => {
    const writer = ctx.writer({ RETENTION_BATCH_SIZE: '2' });
    const id = conversationId();
    writer.enqueue(conversation(id));
    for (let i = 0; i < 5; i += 1) writer.enqueue(message(id));
    writer.enqueue({
      kind: 'report',
      reportId: randomUUID(),
      conversationId: id,
      reporterSessionId: 's_a',
      reportedSessionId: 's_b',
      category: 'spam',
      note: null,
      createdAt: new Date().toISOString(),
    });

    await writer.flush();
    // The first batch is P0: the conversation row and the report, not chat.
    expect(await ctx.count('reports')).toBe(1);
    expect(await ctx.count('messages')).toBe(0);
  });
});

describe('a database outage', () => {
  function brokenWriter(overrides: Record<string, string> = {}) {
    const config = ctx.writer(overrides);
    void config;
    const writerConfig = {
      ...ctx.config,
      breaker: { ...ctx.config.breaker, failureThreshold: 2, cooldownMs: 50 },
      spool: { ...ctx.config.spool },
      retention: { ...ctx.config.retention, batchSize: 100 },
    };
    const spool = new FileSpool(writerConfig, createNullLogger());
    spool.open();
    return {
      spool,
      writer: new RetentionWriter(writerConfig, createNullLogger(), brokenDatabase(), spool),
    };
  }

  it('opens the breaker and spools instead of writing', async () => {
    const { writer, spool } = brokenWriter();
    const id = conversationId();
    writer.enqueue(conversation(id));
    writer.enqueue(message(id));

    // Two failures at the configured threshold.
    await writer.flush();
    await writer.flush();
    expect(writer.snapshot().breaker).toBe('OPEN');

    // Nothing further is attempted; the records go to the spool instead.
    await writer.flush();
    expect(spool.stats().records).toBeGreaterThan(0);
    spool.clear();
  });

  it('keeps chat unaffected: enqueue still returns immediately', async () => {
    const { writer, spool } = brokenWriter();
    const id = conversationId();
    await writer.flush();
    await writer.flush();

    const before = process.hrtime.bigint();
    for (let i = 0; i < 50; i += 1) writer.enqueue(message(id));
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1_000_000;
    // A database outage must never become a chat outage (D16).
    expect(elapsedMs).toBeLessThan(50);
    spool.clear();
  });

  it('drains the spool into the database once it recovers', async () => {
    const id = conversationId();
    // Spool some records with a broken database.
    const broken = brokenWriter();
    broken.writer.enqueue(conversation(id));
    broken.writer.enqueue(message(id));
    broken.writer.enqueue(message(id));
    await broken.writer.flush();
    await broken.writer.flush();
    await broken.writer.flush();
    expect(broken.spool.stats().records).toBe(3);

    // A new writer over the same spool directory, with a working database:
    // this is what a restart after an outage looks like.
    const recovered = ctx.writer({ BREAKER_DRAIN_BATCHES_PER_SEC: '1000' });
    await recovered.flush();

    expect(await ctx.count('conversations')).toBe(1);
    expect(await ctx.count('messages')).toBe(2);
    expect(recovered.snapshot().spool.records).toBe(0);
  });

  it('paces the drain rather than replaying the backlog at once', async () => {
    const id = conversationId();
    const broken = brokenWriter();
    broken.writer.enqueue(conversation(id));
    for (let i = 0; i < 6; i += 1) broken.writer.enqueue(message(id));
    await broken.writer.flush();
    await broken.writer.flush();
    await broken.writer.flush();

    const recovered = ctx.writer({
      RETENTION_BATCH_SIZE: '2',
      BREAKER_DRAIN_BATCHES_PER_SEC: '0.01',
    });
    await recovered.flush();
    const afterFirst = await ctx.count('messages');
    await recovered.flush();
    await recovered.flush();

    // Recovery that replays everything at once is how an outage repeats
    // itself: the recovery load is the load that could not be served.
    expect(await ctx.count('messages')).toBe(afterFirst);
    expect(afterFirst).toBeLessThan(6);
  });

  it('leaves the spool intact when the drain itself fails', async () => {
    const id = conversationId();
    const broken = brokenWriter();
    broken.writer.enqueue(conversation(id));
    broken.writer.enqueue(message(id));
    await broken.writer.flush();
    await broken.writer.flush();
    await broken.writer.flush();
    const spooled = broken.spool.stats().records;

    // Still broken: a failed drain must not consume what it could not write.
    await broken.writer.flush();
    expect(broken.spool.stats().records).toBe(spooled);
    broken.spool.clear();
  });
});

describe('capacity exhaustion', () => {
  it('refuses a P0 record when its class is full, so the caller can fail the client', async () => {
    const writer = ctx.writer({ RETENTION_QUEUE_MAX_P0: '2', RETENTION_ENABLED: 'true' });
    const id = conversationId();
    const report = (): RetentionRecord => ({
      kind: 'report',
      reportId: randomUUID(),
      conversationId: id,
      reporterSessionId: 's_flood',
      reportedSessionId: 's_b',
      category: 'spam',
      note: null,
      createdAt: new Date().toISOString(),
    });

    writer.enqueue(report());
    writer.enqueue(report());
    // At capacity with the same session over quota, the newest is evicted and
    // the caller is told — a report that could not be recorded must not be
    // acknowledged (§14.3).
    const results = [writer.enqueue(report()), writer.enqueue(report())];
    expect(results.some((result) => !result.accepted || writer.counters.quotaEvictions > 0)).toBe(true);
  });

  it('sheds ordinary chat without touching the safety classes', async () => {
    const writer = ctx.writer({ RETENTION_QUEUE_MAX_P3: '3' });
    const id = conversationId();
    writer.enqueue(conversation(id));
    for (let i = 0; i < 50; i += 1) writer.enqueue(message(id, `s_${i}`));

    const snapshot = writer.snapshot();
    expect(snapshot.queue.depth.p3).toBe(3);
    expect(snapshot.queue.depth.p0).toBe(1);
    // Every drop is counted; none is silent.
    expect(Object.values(snapshot.counters.dropped).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('does nothing at all when retention is disabled', async () => {
    const writer = ctx.writer({ RETENTION_ENABLED: 'false' });
    const id = conversationId();
    expect(writer.enqueue(conversation(id)).accepted).toBe(true);
    await writer.flush();
    expect(await ctx.count('conversations')).toBe(0);
  });
});

describe('shutdown', () => {
  it('flushes what it holds', async () => {
    const writer = ctx.writer();
    const id = conversationId();
    writer.enqueue(conversation(id));
    writer.enqueue(message(id));

    await writer.stop();
    expect(await ctx.count('messages')).toBe(1);
  });

  it('spools what it cannot write', async () => {
    const writerConfig = {
      ...ctx.config,
      breaker: { ...ctx.config.breaker, failureThreshold: 1, cooldownMs: 60_000 },
    };
    const spool = new FileSpool(writerConfig, createNullLogger());
    spool.open();
    const writer = new RetentionWriter(
      writerConfig,
      createNullLogger(),
      brokenDatabase(),
      spool,
    );

    const id = conversationId();
    writer.enqueue(conversation(id));
    await writer.stop();

    // Losing records silently at exactly the moment an operator restarts the
    // process would be the least excusable time to do it.
    expect(spool.stats().records).toBeGreaterThan(0);
    spool.clear();
  });
});
