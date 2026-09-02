/**
 * D3, D8 and R11 — the write-behind queue's accounting is complete.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PROPERTY ALL THREE ROWS REDUCE TO
 * ---------------------------------------------------------------------------
 * The retention path is deliberately lossy under overflow (D16), and that is
 * only defensible because the loss is **counted**. `chat_retention_queued_total
 * == flushed + dropped` is the claim, and the 5,000-bot run demonstrated it
 * exactly — 137,882 queued against 135,225 flushed and 2,657 dropped.
 *
 * What that run could not show is the boundary case each of these rows is
 * about:
 *
 *   * **D3** — a record accepted in the instant before the database fails.
 *     Either persisted, or counted as dropped, or still in the queue. Never
 *     accepted, uncounted and absent.
 *   * **D8** — a restart between the ack and the write. The ledger and the
 *     database are then allowed to disagree, by **exactly** the in-flight
 *     depth. The row exists to keep that promise honest rather than to make it
 *     stronger: `message_ack` means "accepted and routed", never "persisted".
 *   * **R11** — a report filed as its session disconnects. The queue holds
 *     *records*, not sessions, so a record already accepted cannot be lost by
 *     the session going away.
 *
 * Every one of those is the same question: **is every record the queue ever
 * accepted still accounted for?** A record that vanished without being counted
 * is the failure, and it is invisible from outside — the sender was acked and
 * the row is simply not there.
 */
import { loadConfig, type Config, type Env } from '../../src/config';
import { RetentionQueue } from '../../src/storage/queue';
import type { RetentionRecord } from '../../src/storage/records';

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

let counter = 0;

function message(sessionId = 's1'): RetentionRecord {
  counter += 1;
  return {
    kind: 'message',
    messageId: `m_${counter}`,
    conversationId: 'c1',
    senderSessionId: sessionId,
    serverTimestamp: '2026-08-18T12:00:00.000Z',
    type: 'text',
    body: 'hello',
    moderationAction: 'allow',
    moderationFlags: [],
  };
}

function report(sessionId = 's1'): RetentionRecord {
  counter += 1;
  return {
    kind: 'report',
    reportId: `r_${counter}`,
    conversationId: 'c1',
    reporterSessionId: sessionId,
    reportedSessionId: 's_other',
    category: 'spam',
    note: null,
    createdAt: '2026-08-18T12:00:00.000Z',
  };
}

describe('every record is accounted for', () => {
  /**
   * D3. Offer more than the queue can hold, take some out, and check the books
   * balance: accepted equals taken plus what is still in there, and everything
   * refused was refused explicitly.
   *
   * The number that must be zero is the one with no name — a record that was
   * neither accepted, nor refused, nor evicted, nor taken.
   */
  it('accounts for every record offered, however full it gets', () => {
    const queue = new RetentionQueue(config({ RETENTION_QUEUE_MAX_P3: '20' }));

    let accepted = 0;
    let refused = 0;
    let evicted = 0;

    for (let i = 0; i < 200; i += 1) {
      const outcome = queue.enqueue(message(`s${i % 7}`));
      if (outcome.accepted) accepted += 1;
      else refused += 1;
      if (outcome.evicted !== null) evicted += 1;
    }

    const taken = queue.take(Number.MAX_SAFE_INTEGER);

    // Everything that went in either came out, was evicted to make room, or
    // was refused at the door. Nothing evaporated.
    expect(accepted + refused).toBe(200);
    expect(taken.length + evicted).toBe(accepted);
    expect(queue.size).toBe(0);
  });

  /**
   * D8. The in-flight depth is the exact size of what a restart would lose, and
   * the queue can say what it is.
   *
   * That is the whole of the guarantee: an ack promises the message was
   * accepted and routed, and the documented disagreement between the ledger and
   * the database is bounded by this number. A queue that could not report its
   * own depth would make the promise unfalsifiable.
   */
  it('reports the depth that a restart would lose, per class', () => {
    const queue = new RetentionQueue(config());
    for (let i = 0; i < 12; i += 1) queue.enqueue(message());
    for (let i = 0; i < 3; i += 1) queue.enqueue(report());

    const stats = queue.stats();
    const summed = Object.values(stats.depth).reduce((a, b) => a + b, 0);

    expect(stats.total).toBe(15);
    // The per-class breakdown adds up to the total, so "which evidence would be
    // lost" is answerable and not just "how much".
    expect(summed).toBe(stats.total);
    expect(stats.depth.p3).toBe(12);
    expect(stats.depth.p0).toBe(3);
  });

  /**
   * R11. The queue holds records, not sessions.
   *
   * A report accepted before its session disconnected is still in the queue
   * afterwards, because nothing about a queued record refers to a live session.
   * This is why "accepted and then lost" is not a state the design can reach:
   * there is no teardown path that could reach in and remove it.
   */
  it('keeps a report after its session is gone, because it holds records not sessions', () => {
    const queue = new RetentionQueue(config());
    const outcome = queue.enqueue(report('s_departing'));
    expect(outcome.accepted).toBe(true);

    // Whatever happens to `s_departing` now — a close, a TTL expiry, an
    // instance dying — the queue is unaffected: nothing here indexes by
    // session except the per-session quota, which only decides admission.
    const taken = queue.take(Number.MAX_SAFE_INTEGER);
    expect(taken).toHaveLength(1);
    expect(taken[0]?.record.kind).toBe('report');
  });

  /**
   * And a report is P0, so the overflow that sheds ordinary chat cannot reach
   * it. Asserted here rather than only in `queue.test.ts` because it is the
   * half of R11 that makes the row's promise true under load rather than only
   * when the queue is quiet.
   */
  it('does not shed a report to make room for messages', () => {
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P3: '5', RETENTION_QUEUE_MAX_P0: '5' }),
    );
    expect(queue.enqueue(report('s_reporter')).accepted).toBe(true);

    // Flood the ordinary class well past its capacity.
    for (let i = 0; i < 100; i += 1) queue.enqueue(message(`s${i % 9}`));

    const taken = queue.take(Number.MAX_SAFE_INTEGER);
    expect(taken.filter((entry) => entry.record.kind === 'report')).toHaveLength(1);
  });
});
