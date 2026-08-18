import { FakeConnection, FakePublisher, silentLogger } from '../helpers/fakes';
import { EventDispatcher } from '../../src/ws/dispatch';
import { decodeSessionEvent, type SessionEvent } from '../../src/ws/events';
import { ConnectionRegistry } from '../../src/ws/registry';

const AT = '2026-08-18T12:00:00.000Z';
const skipped: SessionEvent = { event: 'partner_skipped', matchId: 'm_1' };

function build() {
  const logger = silentLogger();
  const registry = new ConnectionRegistry(logger);
  const publisher = new FakePublisher();
  return {
    logger,
    registry,
    publisher,
    dispatcher: new EventDispatcher(registry, publisher, logger),
  };
}

describe('local delivery (D9)', () => {
  it('writes the frame straight to an attached socket, with no Redis hop', async () => {
    const { dispatcher, registry, publisher } = build();
    const connection = new FakeConnection('s_local');
    registry.add(connection);

    expect(await dispatcher.toSession('s_local', skipped, AT)).toBe('local');
    expect(connection.parsed()).toEqual([
      expect.objectContaining({ type: 'partner_skipped', payload: { matchId: 'm_1' } }),
    ]);
    expect(publisher.published).toEqual([]);
  });

  it('counts a session_evicted as delivered even though it has no frame', async () => {
    const { dispatcher, registry } = build();
    const connection = new FakeConnection('s_local');
    registry.add(connection);

    const route = await dispatcher.toSession(
      's_local',
      { event: 'session_evicted', matchId: 'm_1', reason: 'reaped' },
      AT,
    );
    expect(route).toBe('local');
    expect(connection.frames).toEqual([]);
  });

  it('reports a drop when the local socket refuses the frame', async () => {
    const { dispatcher, registry, publisher } = build();
    const connection = new FakeConnection('s_slow');
    connection.refuseSend = true;
    registry.add(connection);

    expect(await dispatcher.toSession('s_slow', skipped, AT)).toBe('dropped');
    // Not re-routed through Redis: this instance owns the socket, so publishing
    // would only deliver the event back to itself.
    expect(publisher.published).toEqual([]);
  });

  it('publishes instead when the attached socket is already closed', async () => {
    const { dispatcher, registry, publisher } = build();
    const connection = new FakeConnection('s_closing');
    connection.isOpen = false;
    registry.add(connection);
    publisher.subscribed.add('s_closing');

    expect(await dispatcher.toSession('s_closing', skipped, AT)).toBe('remote');
    expect(publisher.published).toHaveLength(1);
  });
});

describe('remote delivery', () => {
  it('publishes to the session channel when the socket is elsewhere', async () => {
    const { dispatcher, publisher } = build();
    publisher.subscribed.add('s_remote');

    expect(await dispatcher.toSession('s_remote', skipped, AT)).toBe('remote');
    expect(publisher.published[0]?.sessionId).toBe('s_remote');
    expect(decodeSessionEvent(publisher.published[0]?.payload ?? '')).toEqual(skipped);
  });

  it('reports a drop when nobody is subscribed', async () => {
    const { dispatcher } = build();
    // Correct by design: the event reports state already committed in Redis,
    // so the worst case is one stale label the next action corrects (§11).
    expect(await dispatcher.toSession('s_nowhere', skipped, AT)).toBe('dropped');
  });

  it('survives a publish failure instead of failing the transition that caused it', async () => {
    const { dispatcher, publisher } = build();
    publisher.failNextPublish = true;

    // The match has already been ended in Redis. Throwing here would turn a
    // cosmetic failure into a real one.
    await expect(dispatcher.toSession('s_remote', skipped, AT)).resolves.toBe('dropped');
  });
});

describe('delivery never leaks message content (I8)', () => {
  it('logs the event name only when a publish fails', async () => {
    const { dispatcher, publisher, logger } = build();
    publisher.failNextPublish = true;

    await dispatcher.toSession('s_remote', {
      event: 'message',
      matchId: 'm_1',
      messageId: 'msg_1',
      contentType: 'text',
      text: 'SECRET_CANARY_BODY',
      sentAt: AT,
    }, AT);

    expect(logger.lines).toHaveLength(1);
    expect(JSON.stringify(logger.lines)).not.toContain('SECRET_CANARY_BODY');
    expect(logger.lines[0]?.fields).toMatchObject({ sessionEvent: 'message' });
  });

  it('logs the event name only when a local socket refuses a message', async () => {
    const { dispatcher, registry, logger } = build();
    const connection = new FakeConnection('s_slow');
    connection.refuseSend = true;
    registry.add(connection);

    await dispatcher.toSession('s_slow', {
      event: 'message',
      matchId: 'm_1',
      messageId: 'msg_1',
      contentType: 'text',
      text: 'SECRET_CANARY_BODY',
      sentAt: AT,
    }, AT);

    expect(JSON.stringify(logger.lines)).not.toContain('SECRET_CANARY_BODY');
  });
});
