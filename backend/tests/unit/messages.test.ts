/**
 * The message pipeline against a fake store, where the order of operations and
 * the failure branches can be arranged exactly (§14.1).
 */
import { FakeConnection, FakePublisher, silentLogger } from '../helpers/fakes';
import { loadConfig, type Config, type Env, type RateLimitedCommand } from '../../src/config';
import { EventDispatcher } from '../../src/ws/dispatch';
import { MessagePipeline, type MessageStore } from '../../src/ws/messages';
import { NullRetentionSink } from '../../src/storage/sink';
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
  return {
    logger,
    config,
    registry,
    publisher,
    store,
    pipeline: new MessagePipeline(store, dispatcher, config, logger, new NullRetentionSink()),
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
    expect(outcome).toMatchObject({ kind: 'accepted', matchId: 'm_1', delivered: true });
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
    expect(outcome).toMatchObject({ kind: 'accepted', delivered: true, flags: ['url'] });
    expect(partner.frames).toHaveLength(1);
  });

  it('withholds without delivering, and still acks', async () => {
    const ctx = build({ MODERATION_DEFAULT_ACTION: 'withhold' });
    const partner = new FakeConnection('s_partner');
    ctx.registry.add(partner);

    const outcome = await ctx.pipeline.send('s_me', 'c_1', 'text', 'visit example.com');
    // Accepted and recorded, not handed on. Reported through the ack rather
    // than an error, because the frame was valid and there is nothing to retry.
    expect(outcome).toMatchObject({ kind: 'accepted', delivered: false });
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
    expect(outcome).toMatchObject({ kind: 'accepted', delivered: true, flags: [] });
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
