/**
 * The message pipeline against a fake store, where the order of operations and
 * the failure branches can be arranged exactly (§14.1).
 */
import { FakeConnection, FakePublisher, silentLogger } from '../helpers/fakes';
import { loadConfig, type Config, type Env, type RateLimitedCommand } from '../../src/config';
import { EventDispatcher } from '../../src/ws/dispatch';
import { MessagePipeline, type MessageStore } from '../../src/ws/messages';
import type { RetentionSink } from '../../src/storage/sink';
import type { MessagePriorityContext, RetentionRecord } from '../../src/storage/records';
import { priorityFor } from '../../src/storage/records';
import type { EnqueueResult } from '../../src/storage/retention';
import { ConnectionRegistry } from '../../src/ws/registry';
import type {
  RateLimitResult,
  ResolvePartnerResult,
  ResolveRouteResult,
} from '../../src/redis/store';

/** Records the order in which the pipeline touched the store. */
class ScriptedStore implements MessageStore {
  readonly calls: string[] = [];
  rateLimitResult: RateLimitResult = { allowed: true, retryAfterMs: 0, tokens: 4 };
  resolveResult: ResolvePartnerResult = {
    status: 'ok',
    matchId: 'm_1',
    partnerSessionId: 's_partner',
    partnerInstanceId: 'i_one',
  };
  routeResult: ResolveRouteResult = {
    status: 'ok',
    matchId: 'm_1',
    partnerSessionId: 's_partner',
    partnerInstanceId: 'i_one',
  };
  readonly dedupeIds: string[] = [];

  async rateLimit(command: RateLimitedCommand): Promise<RateLimitResult> {
    this.calls.push(`rateLimit:${command}`);
    return this.rateLimitResult;
  }

  async resolvePartner(_sessionId: string, clientMsgId: string): Promise<ResolvePartnerResult> {
    this.calls.push('resolvePartner');
    this.dedupeIds.push(clientMsgId);
    return this.resolveResult;
  }

  async resolveRoute(): Promise<ResolveRouteResult> {
    this.calls.push('resolveRoute');
    return this.routeResult;
  }
}

/**
 * A sink that keeps what it was given.
 *
 * This suite used `NullRetentionSink` throughout, which made the whole
 * retention half of `send()` invisible to it — and `send()` has two jobs, not
 * one: route the message, and hand it plus its moderation signals to
 * retention. Only the first was ever asserted, which is how a hard-blocked
 * message came to be the one kind of message that left no evidence at all: the
 * early return sat above the only `persist()` call, and nothing here could see
 * the difference.
 */
class RecordingSink implements RetentionSink {
  readonly records: Array<{ record: RetentionRecord; context?: MessagePriorityContext }> = [];
  reported = false;

  enqueue(record: RetentionRecord, context?: MessagePriorityContext): EnqueueResult {
    this.records.push(context === undefined ? { record } : { record, context });
    return { accepted: true };
  }

  isConversationReported(): boolean {
    return this.reported;
  }

  /** Every record of one kind, in the order the pipeline produced them. */
  ofKind<K extends RetentionRecord['kind']>(
    kind: K,
  ): Array<Extract<RetentionRecord, { kind: K }>> {
    return this.records
      .map((entry) => entry.record)
      .filter((record): record is Extract<RetentionRecord, { kind: K }> => record.kind === kind);
  }

  /** The priority the queue would assign, computed the way the queue does. */
  priorities(): string[] {
    return this.records.map((entry) => priorityFor(entry.record, entry.context));
  }
}

function build(env: Env = {}) {
  const logger = silentLogger();
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_one',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...env,
  });
  const registry = new ConnectionRegistry(logger);
  const publisher = new FakePublisher();
  const dispatcher = new EventDispatcher(registry, publisher, logger);
  const store = new ScriptedStore();
  const sink = new RecordingSink();
  return {
    logger,
    config,
    registry,
    publisher,
    store,
    sink,
    pipeline: new MessagePipeline(store, dispatcher, config, logger, sink),
  };
}

describe('sending a message', () => {
  it('rate limits, resolves and delivers, in that order', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'hello');

    // The limit is checked before the work, because a limit applied after the
    // work has been done is not a limit.
    expect(ctx.store.calls).toEqual(['rateLimit:message', 'resolvePartner']);
    expect(outcome).toMatchObject({ kind: 'accepted', matchId: 'm_1', status: 'routed' });
    expect(partner.parsed()[0]).toMatchObject({
      type: 'message',
      payload: { matchId: 'm_1', text: 'hello', type: 'text', from: 'partner' },
    });
  });

  it('never lets the client choose the message id', async () => {
    const ctx = build();
    const outcome = await ctx.pipeline.send('s_me', 'c_client_chosen', 'text', 'hi');
    if (outcome.kind !== 'accepted') throw new Error('expected acceptance');
    // The client id is the dedupe key and is echoed in the ack; the message id
    // is server-generated and is what everything else refers to.
    expect(outcome.messageId).toMatch(/^msg_/);
    expect(outcome.messageId).not.toContain('c_client_chosen');
  });

  it('passes the client id through as the dedupe key (I14)', async () => {
    const ctx = build();
    await ctx.pipeline.send('s_me', 'c_dedupe_key', 'text', 'hi');
    expect(ctx.store.dedupeIds).toEqual(['c_dedupe_key']);
  });

  it('refuses without resolving when the bucket is empty', async () => {
    const ctx = build();
    ctx.store.rateLimitResult = { allowed: false, retryAfterMs: 250, tokens: 0 };

    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'hi');
    expect(outcome).toEqual({ kind: 'rate_limited', retryAfterMs: 250 });
    // Crucially no resolvePartner: a rate-limited message must not consume a
    // dedupe id, or a client could exhaust its own replay protection by
    // sending too fast.
    expect(ctx.store.calls).toEqual(['rateLimit:message']);
  });

  it('reports a duplicate without delivering it', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);
    ctx.store.resolveResult = { status: 'duplicate', matchId: 'm_1' };

    expect(await ctx.pipeline.send('s_me', 'c_1', 'text', 'hi')).toEqual({ kind: 'duplicate' });
    expect(partner.frames).toEqual([]);
  });

  it('refuses when the replay-protection set is full', async () => {
    const ctx = build();
    ctx.store.resolveResult = { status: 'dedupe_full', matchId: 'm_1' };
    // Accepting past the cap would mean a replay is deliverable, which is the
    // one thing the set exists to prevent.
    expect(await ctx.pipeline.send('s_me', 'c_1', 'text', 'hi')).toEqual({ kind: 'dedupe_full' });
  });

  it('reports not matched for a session with no conversation', async () => {
    const ctx = build();
    ctx.store.resolveResult = { status: 'not_matched' };
    expect(await ctx.pipeline.send('s_me', 'c_1', 'text', 'hi')).toEqual({ kind: 'not_matched' });
  });

  it('treats a vanished partner as not matched', async () => {
    const ctx = build();
    ctx.store.resolveResult = { status: 'partner_gone', matchId: 'm_1' };
    // There is nobody to deliver to and no conversation to be in; telling the
    // sender it is still in one would be worse than telling it the truth.
    expect(await ctx.pipeline.send('s_me', 'c_1', 'text', 'hi')).toEqual({ kind: 'not_matched' });
  });

  it('labels the route from where the partner is, not from the delivery', async () => {
    const local = build();
    expect((await local.pipeline.send('s_me', 'c_1', 'text', 'hi')) as { route: string }).toMatchObject({
      route: 'local',
    });

    const remote = build();
    remote.store.resolveResult = {
      status: 'ok',
      matchId: 'm_1',
      partnerSessionId: 's_partner',
      partnerInstanceId: 'i_two',
    };
    // Nobody is subscribed, so the publish reaches no one — and the ack still
    // says 'remote', because `route` reports which path was taken and
    // message_ack has never meant "received" (D14).
    expect((await remote.pipeline.send('s_me', 'c_1', 'text', 'hi')) as { route: string }).toMatchObject({
      route: 'remote',
    });
  });

  it('still accepts when the partner could not be reached', async () => {
    const ctx = build();
    ctx.store.resolveResult = {
      status: 'ok',
      matchId: 'm_1',
      partnerSessionId: 's_elsewhere',
      partnerInstanceId: 'i_two',
    };
    ctx.publisher.failNextPublish = true;

    // The dedupe entry is already written; unwinding here would burn an id for
    // a message nobody has.
    expect(await ctx.pipeline.send('s_me', 'c_1', 'text', 'hi')).toMatchObject({
      kind: 'accepted',
    });
  });

  it('never writes message text into a log line (I8)', async () => {
    const ctx = build();
    ctx.store.resolveResult = { status: 'dedupe_full', matchId: 'm_1' };
    await ctx.pipeline.send('s_me', 'c_1', 'text', 'SECRET_CANARY_BODY');
    expect(JSON.stringify(ctx.logger.lines)).not.toContain('SECRET_CANARY_BODY');
    expect(ctx.logger.lines).toHaveLength(1);
  });
});

describe('moderation in the pipeline (§14.2)', () => {
  it('delivers a flagged message and reports the flags on the ack', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'visit example.com');
    // Flag-and-deliver is the default (D20): a false positive here would be a
    // person told they cannot say something they are allowed to say.
    expect(outcome).toMatchObject({ kind: 'accepted', status: 'routed', flags: ['url'] });
    expect(partner.frames).toHaveLength(1);
  });

  it('withholds without delivering, and still acks', async () => {
    const ctx = build({ MODERATION_DEFAULT_ACTION: 'withhold' });
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'visit example.com');
    // Accepted and recorded, not handed on. Reported through the ack rather
    // than an error, because the frame was valid and there is nothing to retry.
    expect(outcome).toMatchObject({ kind: 'accepted', status: 'withheld' });
    expect(partner.frames).toEqual([]);
  });

  it('refuses a hard-blocked message outright', async () => {
    const ctx = build({ MODERATION_HARD_BLOCK_RULES: 'crypto_address' });
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send(
      's_me',
      'c_1',
      'text',
      'send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    );
    expect(outcome).toMatchObject({ kind: 'withheld', flags: ['crypto_address'] });
    expect(partner.frames).toEqual([]);
  });

  it('leaves a clean message unflagged', async () => {
    const ctx = build();
    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'how is your day going');
    expect(outcome).toMatchObject({ kind: 'accepted', flags: [] });
  });

  it('says so when nobody was there to receive it', async () => {
    // No partner connection is registered here, so the dispatcher genuinely
    // drops the frame — and this used to be acked as delivered, because the
    // field reported the moderation verdict rather than what happened. Under
    // §28 that state is ordinary and lasts tens of seconds, so the sender was
    // shown a "sent" tick for a message that reached nobody.
    const ctx = build();
    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'anyone there');
    expect(outcome).toMatchObject({ kind: 'accepted', status: 'undelivered', flags: [] });
  });

  it('says routed when the partner was actually there', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'how is your day going');

    expect(outcome).toMatchObject({ kind: 'accepted', status: 'routed', flags: [] });
    expect(partner.parsed()).toHaveLength(1);
  });

  /* --- what reaches retention, on every branch ----------------------------- */

  it('retains a hard-blocked message and its moderation events (I10)', async () => {
    // The regression this suite could not previously see. `send()` returned at
    // the hard-block branch, above the only call that hands anything to
    // retention — so the highest-severity policy matches in the system were
    // the only ones that left no `messages` row and no `moderation_event`.
    // A moderator investigating the most serious abuse had nothing to read,
    // and nothing to attach to a report or an enforcement decision.
    const ctx = build({ MODERATION_HARD_BLOCK_RULES: 'crypto_address' });
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send(
      's_me',
      'c_1',
      'text',
      'send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    );

    expect(outcome).toMatchObject({ kind: 'withheld', flags: ['crypto_address'] });
    // Still not delivered. The record is the only thing that changed.
    expect(partner.frames).toEqual([]);

    const messages = ctx.sink.ofKind('message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      body: 'send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      senderSessionId: 's_me',
      conversationId: 'm_1',
      moderationAction: 'block',
      moderationFlags: ['crypto_address'],
    });

    const events = ctx.sink.ofKind('moderation_event');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rule: 'crypto_address',
      action: 'block',
      messageId: messages[0]!.messageId,
    });

    // The evidence lands in the safety classes, not in ordinary chat: the
    // moderation event is P0, and a moderated message is P1 (D27).
    expect(ctx.sink.priorities()).toEqual(['p1', 'p0']);
  });

  it('retains a flagged-but-delivered message with one event per rule', async () => {
    const ctx = build({ MODERATION_FLAG_RULES: 'email' });
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    await ctx.pipeline.send('s_me', 'c_1', 'text', 'reach me at someone@example.com');

    expect(partner.parsed()).toHaveLength(1);
    const stored = ctx.sink.ofKind('message');
    expect(stored[0]).toMatchObject({ moderationAction: 'flag' });

    // One row per rule that fired, not one per message — an address contains a
    // host, so this text trips `url` as well, and triage has to be able to ask
    // which rule without reading any body.
    const rules = ctx.sink.ofKind('moderation_event').map((event) => event.rule);
    expect(rules).toEqual(stored[0]!.moderationFlags);
    expect(rules).toContain('email');
    expect(new Set(rules).size).toBe(rules.length);
  });

  it('retains an ordinary message with no events, in the lowest class', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    await ctx.pipeline.send('s_me', 'c_1', 'text', 'how is your day going');

    expect(ctx.sink.ofKind('message')).toHaveLength(1);
    expect(ctx.sink.ofKind('moderation_event')).toEqual([]);
    expect(ctx.sink.priorities()).toEqual(['p3']);
  });

  it('retains nothing for a message that was never accepted', async () => {
    // A refusal is not an utterance. Storing the body of a message the system
    // declined to carry would retain content on a path the sender was told
    // failed.
    const ctx = build();
    ctx.store.rateLimitResult = { allowed: false, retryAfterMs: 500, tokens: 0 };
    await ctx.pipeline.send('s_me', 'c_1', 'text', 'hello');

    ctx.store.rateLimitResult = { allowed: true, retryAfterMs: 0, tokens: 4 };
    ctx.store.resolveResult = { status: 'not_matched' };
    await ctx.pipeline.send('s_me', 'c_2', 'text', 'hello again');

    expect(ctx.sink.records).toEqual([]);
  });

  it('never writes the message or the matched fragment into a log line (I8)', async () => {
    const ctx = build({ MODERATION_HARD_BLOCK_RULES: 'email' });
    await ctx.pipeline.send('s_me', 'c_1', 'text', 'reach me at CANARY@example.com');
    await ctx.pipeline.send('s_me', 'c_2', 'text', 'also SECOND_CANARY.com is mine');

    const logged = JSON.stringify(ctx.logger.lines);
    expect(logged).not.toContain('CANARY@example.com');
    expect(logged).not.toContain('SECOND_CANARY');
    // What does get logged is the rule id and the severity.
    expect(logged).toContain('moderationFlags');
  });

  it('moderates after the dedupe, so a duplicate is never judged twice', async () => {
    const ctx = build();
    ctx.store.resolveResult = { status: 'duplicate', matchId: 'm_1' };
    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'visit example.com');
    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(ctx.logger.lines).toEqual([]);
  });
});

describe('typing', () => {
  it('routes without consuming a dedupe id', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    expect(await ctx.pipeline.typing('s_me', true)).toEqual({ kind: 'sent' });
    // resolveRoute, not resolvePartner: routing a keystroke through replay
    // protection would let a client exhaust its own dedupe set by typing.
    expect(ctx.store.calls).toEqual(['rateLimit:typing', 'resolveRoute']);
    expect(ctx.store.dedupeIds).toEqual([]);
    expect(partner.parsed()[0]).toMatchObject({
      type: 'partner_typing',
      payload: { matchId: 'm_1', active: true },
    });
  });

  it('carries the stop as its own event', async () => {
    const ctx = build();
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);
    await ctx.pipeline.typing('s_me', false);
    expect(partner.parsed()[0]?.payload).toMatchObject({ active: false });
  });

  it('has its own bucket, so typing cannot spend the message budget', async () => {
    const ctx = build();
    await ctx.pipeline.typing('s_me', true);
    expect(ctx.store.calls[0]).toBe('rateLimit:typing');
  });

  it('refuses without routing when the bucket is empty', async () => {
    const ctx = build();
    ctx.store.rateLimitResult = { allowed: false, retryAfterMs: 100, tokens: 0 };
    expect(await ctx.pipeline.typing('s_me', true)).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 100,
    });
    expect(ctx.store.calls).toEqual(['rateLimit:typing']);
  });

  it('reports not matched with no conversation', async () => {
    const ctx = build();
    ctx.store.routeResult = { status: 'not_matched' };
    expect(await ctx.pipeline.typing('s_me', true)).toEqual({ kind: 'not_matched' });
  });

  it('treats a vanished partner as nothing to do, not as an error', async () => {
    const ctx = build();
    ctx.store.routeResult = { status: 'partner_gone', matchId: 'm_1' };
    // Advisory traffic: there is nothing for the sender to fix or retry.
    expect(await ctx.pipeline.typing('s_me', true)).toEqual({ kind: 'no_partner' });
  });
});
