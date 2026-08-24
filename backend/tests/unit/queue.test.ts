/**
 * The bounded write-behind queue (D26): per-class capacity and the per-session
 * sub-quota inside each class.
 */
import { loadConfig, type Config, type Env } from '../../src/config';
import { RetentionQueue } from '../../src/storage/queue';
import { priorityFor, type RetentionRecord } from '../../src/storage/records';

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

let counter = 0;

function message(sessionId: string, action: 'allow' | 'flag' = 'allow'): RetentionRecord {
  counter += 1;
  return {
    kind: 'message',
    messageId: `msg_${counter}`,
    conversationId: 'c1',
    senderSessionId: sessionId,
    serverTimestamp: '2026-08-18T12:00:00.000Z',
    type: 'text',
    body: 'hello',
    moderationAction: action,
    moderationFlags: action === 'allow' ? [] : ['url'],
  };
}

function report(sessionId: string): RetentionRecord {
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

describe('priority assignment (D27)', () => {
  it('puts every server-generated safety record in P0', () => {
    expect(priorityFor(report('s_a'))).toBe('p0');
    expect(
      priorityFor({
        kind: 'conversation_started',
        conversationId: 'c1',
        sessionA: 's_a',
        sessionB: 's_b',
        segment: 'default',
        startedAt: '2026-08-18T12:00:00.000Z',
        profileA: null,
        profileB: null,
      }),
    ).toBe('p0');
  });

  it('promotes a moderated message to P1, from the engine own output', () => {
    expect(priorityFor(message('s_a', 'flag'))).toBe('p1');
    expect(
      priorityFor(message('s_a'), { moderationAction: 'withhold', conversationReported: false }),
    ).toBe('p1');
  });

  it('puts a message in a reported conversation in P2', () => {
    expect(
      priorityFor(message('s_a'), { moderationAction: 'allow', conversationReported: true }),
    ).toBe('p2');
  });

  it('leaves an ordinary message in P3', () => {
    expect(
      priorityFor(message('s_a'), { moderationAction: 'allow', conversationReported: false }),
    ).toBe('p3');
  });

  it('takes nothing from the record that a client could have chosen', () => {
    // The message body is the only client-controlled input, and it does not
    // appear in the decision at all.
    const short = { ...message('s_a'), body: 'x' } as RetentionRecord;
    const long = { ...message('s_a'), body: 'x'.repeat(400) } as RetentionRecord;
    expect(priorityFor(short)).toBe(priorityFor(long));
  });
});

describe('per-class capacity', () => {
  it('accepts up to the class capacity', () => {
    const queue = new RetentionQueue(config({ RETENTION_QUEUE_MAX_P3: '3' }));
    for (let i = 0; i < 3; i += 1) {
      expect(queue.enqueue(message(`s_${i}`)).accepted).toBe(true);
    }
    expect(queue.stats().depth.p3).toBe(3);
  });

  it('does not let a full class consume another class budget', () => {
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P3: '2', RETENTION_QUEUE_MAX_P0: '2' }),
    );
    for (let i = 0; i < 10; i += 1) queue.enqueue(message(`s_${i}`));

    // P3 is full and has been shedding; P0 is untouched and still has room.
    // This is what makes "shed chat before evidence" structural.
    expect(queue.stats().depth.p3).toBe(2);
    expect(queue.enqueue(report('s_x')).accepted).toBe(true);
    expect(queue.stats().depth.p0).toBe(1);
  });

  it('evicts the oldest of the class when the sender is within quota', () => {
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P3: '2', RETENTION_QUEUE_SESSION_QUOTA_PCT: '100' }),
    );
    const first = message('s_a');
    queue.enqueue(first);
    queue.enqueue(message('s_b'));

    const outcome = queue.enqueue(message('s_c'));
    expect(outcome.accepted).toBe(true);
    expect(outcome.evicted?.record).toBe(first);
    expect(outcome.reason).toBe('class_full');
  });
});

describe('P0 is never taken from another session', () => {
  // The class-full eviction above was only ever exercised on P3, so the rule
  // it encodes was applied to safety evidence without anyone testing what that
  // meant. What it meant: a report from a session within its quota displaced
  // an *older* report belonging to somebody else, and `enqueue` returned
  // accepted — so the report handler sent `report_ack` for the new one while
  // the earlier reporter, already acknowledged, silently lost their evidence.

  it('refuses a new report rather than displacing another session report', () => {
    const queue = new RetentionQueue(config({ RETENTION_QUEUE_MAX_P0: '2' }));
    const first = report('s_alice');
    queue.enqueue(first);
    queue.enqueue(report('s_bob'));

    // Carol is within her quota and the class is full, so the only room is
    // somebody else's.
    const outcome = queue.enqueue(report('s_carol'));

    expect(outcome.accepted).toBe(false);
    expect(outcome.evicted).toBeNull();
    expect(outcome.reason).toBe('class_full');
    // Alice's report is still there, and still first out.
    expect(queue.stats().depth.p0).toBe(2);
    expect(queue.take(1)[0]?.record).toBe(first);
  });

  it('still makes a flooding session displace its own records first (D26)', () => {
    // The per-session branch is unchanged, and has to be: without it one
    // flooder fills P0 and every honest report is refused from then on.
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P0: '4', RETENTION_QUEUE_SESSION_QUOTA_PCT: '50' }),
    );
    expect(queue.quotaFor('p0')).toBe(2);

    const honest = report('s_honest');
    queue.enqueue(honest);
    const flooderFirst = report('s_flood');
    queue.enqueue(flooderFirst);
    queue.enqueue(report('s_flood'));
    queue.enqueue(report('s_other'));

    // At capacity, and the flooder is at its share. It pays for itself.
    const outcome = queue.enqueue(report('s_flood'));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe('quota');
    expect(outcome.evicted?.record).toBe(flooderFirst);

    // Nobody else lost anything.
    const remaining = queue.drainAll().map((entry) => entry.record);
    expect(remaining).toContain(honest);
  });

  it('refuses every later report once the class is full of other sessions', () => {
    // Anonymous users open fresh sessions freely, so a distributed flood never
    // trips the sub-quota. The class fills and refuses, which pages through
    // `SafetyRecordsDropped` — the operator learns, and no acknowledged
    // evidence disappears.
    const queue = new RetentionQueue(config({ RETENTION_QUEUE_MAX_P0: '3' }));
    for (let i = 0; i < 3; i += 1) queue.enqueue(report(`s_filler_${i}`));

    for (let i = 0; i < 5; i += 1) {
      expect(queue.enqueue(report(`s_fresh_${i}`)).accepted).toBe(false);
    }
    expect(queue.stats().depth.p0).toBe(3);
  });

  it('sheds the oldest across sessions in the lower classes, as before', () => {
    // P1 carries evidence too, and deliberately still sheds: nothing
    // acknowledges a P1 record to anybody, so this is honest load-shedding
    // rather than a broken promise, and the sub-quota is what aims it fairly.
    const queue = new RetentionQueue(config({ RETENTION_QUEUE_MAX_P1: '2' }));
    const first = message('s_a', 'flag');
    queue.enqueue(first);
    queue.enqueue(message('s_b', 'flag'));

    const outcome = queue.enqueue(message('s_c', 'flag'));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe('class_full');
    expect(outcome.evicted?.record).toBe(first);
  });
});

describe('per-session quota inside a class', () => {
  it('makes a flooding session displace its own records first', () => {
    // 10 slots, 20% quota = 2 per session.
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P1: '10', RETENTION_QUEUE_SESSION_QUOTA_PCT: '20' }),
    );
    expect(queue.quotaFor('p1')).toBe(2);

    // Eight honest records from other people fill most of the class.
    for (let i = 0; i < 8; i += 1) queue.enqueue(message(`s_honest_${i}`, 'flag'));
    // The attacker takes its two, filling the class.
    queue.enqueue(message('s_attacker', 'flag'));
    queue.enqueue(message('s_attacker', 'flag'));
    expect(queue.stats().depth.p1).toBe(10);

    // Now it keeps going. Every further record evicts one of its own.
    for (let i = 0; i < 20; i += 1) {
      const outcome = queue.enqueue(message('s_attacker', 'flag'));
      expect(outcome.accepted).toBe(true);
      expect(outcome.reason).toBe('quota');
      expect(outcome.evicted?.sessionId).toBe('s_attacker');
    }

    // Every honest record is still there. Without the sub-quota the attacker
    // would have evicted all eight — which is the attack the quota exists for.
    const remaining = queue.drainAll();
    const honest = remaining.filter((entry) => entry.sessionId.startsWith('s_honest'));
    expect(honest).toHaveLength(8);
  });

  it('never lets the quota round down to zero', () => {
    // 1% of 10 is 0.1; a quota of zero would mean nobody could hold anything.
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P3: '10', RETENTION_QUEUE_SESSION_QUOTA_PCT: '1' }),
    );
    expect(queue.quotaFor('p3')).toBe(1);
    expect(queue.enqueue(message('s_a')).accepted).toBe(true);
  });

  it('counts quota per class, not across classes', () => {
    const queue = new RetentionQueue(
      config({
        RETENTION_QUEUE_MAX_P1: '4',
        RETENTION_QUEUE_MAX_P3: '4',
        RETENTION_QUEUE_SESSION_QUOTA_PCT: '25',
      }),
    );
    queue.enqueue(message('s_a', 'flag'));
    // The same session holding its P1 slot still has its full P3 share.
    expect(queue.enqueue(message('s_a')).accepted).toBe(true);
    expect(queue.stats().depth.p1).toBe(1);
    expect(queue.stats().depth.p3).toBe(1);
  });
});

describe('taking work out', () => {
  it('hands out the highest priority first', () => {
    const queue = new RetentionQueue(config());
    queue.enqueue(message('s_a'));
    queue.enqueue(message('s_b', 'flag'));
    queue.enqueue(report('s_c'));

    const taken = queue.take(3);
    // Strict priority, not weighted: under pressure the point is that safety
    // records leave before ordinary chat, and weighting makes that "mostly".
    expect(taken.map((entry) => entry.priority)).toEqual(['p0', 'p1', 'p3']);
  });

  it('respects the limit and leaves the rest', () => {
    const queue = new RetentionQueue(config());
    for (let i = 0; i < 5; i += 1) queue.enqueue(message(`s_${i}`));
    expect(queue.take(2)).toHaveLength(2);
    expect(queue.size).toBe(3);
  });

  it('frees quota when entries leave', () => {
    const queue = new RetentionQueue(
      config({ RETENTION_QUEUE_MAX_P3: '2', RETENTION_QUEUE_SESSION_QUOTA_PCT: '50' }),
    );
    queue.enqueue(message('s_a'));
    queue.take(1);
    // The slot it held is released, so it is not immediately over quota again.
    const outcome = queue.enqueue(message('s_a'));
    expect(outcome).toMatchObject({ accepted: true, evicted: null });
  });

  it('puts a failed batch back at the front of its lane', () => {
    const queue = new RetentionQueue(config());
    const first = message('s_a');
    queue.enqueue(first);
    queue.enqueue(message('s_b'));

    const batch = queue.take(1);
    queue.enqueue(message('s_c'));
    queue.requeue(batch);

    // Order is restored: the retried batch goes back ahead of what arrived
    // while it was away.
    expect(queue.take(1)[0]?.record).toBe(first);
    expect(queue.size).toBe(2);
  });

  it('drains everything in priority order', () => {
    const queue = new RetentionQueue(config());
    queue.enqueue(message('s_a'));
    queue.enqueue(report('s_b'));
    const drained = queue.drainAll();
    expect(drained.map((entry) => entry.priority)).toEqual(['p0', 'p3']);
    expect(queue.size).toBe(0);
  });
});
