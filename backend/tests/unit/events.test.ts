import {
  SESSION_EVENT_VERSION,
  decodeSessionEvent,
  encodeSessionEvent,
  toClientFrame,
  type SessionEvent,
} from '../../src/ws/events';
import { PROTOCOL_VERSION } from '../../src/protocol/types';

const AT = '2026-08-18T12:00:00.000Z';

const matched: SessionEvent = {
  event: 'matched',
  matchId: 'm_1',
  startedAt: AT,
  you: { nickname: 'Quiet Heron', colour: '#2DD4BF', profile: null },
  partner: { nickname: 'Amber Fox', colour: '#7C5CFF', profile: null },
};

function roundTrip(event: SessionEvent): SessionEvent | null {
  return decodeSessionEvent(encodeSessionEvent(event, AT));
}

describe('session event encoding', () => {
  it('uses the documented wire shape', () => {
    const wire = JSON.parse(encodeSessionEvent({ event: 'partner_skipped', matchId: 'm_1' }, AT));
    expect(wire).toEqual({
      v: SESSION_EVENT_VERSION,
      event: 'partner_skipped',
      matchId: 'm_1',
      at: AT,
      data: {},
    });
  });

  it('round-trips every event the design names', () => {
    const events: SessionEvent[] = [
      matched,
      {
        event: 'message',
        matchId: 'm_1',
        messageId: 'msg_1',
        contentType: 'text',
        text: 'hello there',
        sentAt: AT,
      },
      { event: 'partner_typing', matchId: 'm_1', active: true },
      { event: 'partner_skipped', matchId: 'm_1' },
      { event: 'partner_disconnected', matchId: 'm_1' },
      { event: 'session_evicted', matchId: 'm_1', reason: 'reaped' },
    ];
    for (const event of events) {
      expect(roundTrip(event)).toEqual(event);
    }
  });

  it('carries the internal version independently of the protocol version', () => {
    // The bus between instances and the wire to browsers version separately:
    // a client-visible protocol change must not force a bus change.
    const wire = JSON.parse(encodeSessionEvent(matched, AT));
    expect(wire.v).toBe(SESSION_EVENT_VERSION);
    expect(wire.protocolVersion).toBeUndefined();
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('session event decoding is defensive', () => {
  it('returns null rather than throwing on anything malformed', () => {
    for (const payload of ['', 'not json', '[]', 'null', '42', '"string"', '{}']) {
      expect(decodeSessionEvent(payload)).toBeNull();
    }
  });

  it('ignores an event from a different bus version', () => {
    const wire = JSON.stringify({ v: 99, event: 'partner_skipped', matchId: 'm_1', at: AT, data: {} });
    expect(decodeSessionEvent(wire)).toBeNull();
  });

  it('ignores an event name it does not know', () => {
    // Exactly what a rolling deploy looks like from the older instance's side:
    // it must degrade into no UI update, not into a thrown exception on the
    // socket's message path.
    const wire = JSON.stringify({
      v: SESSION_EVENT_VERSION,
      event: 'friend_request',
      matchId: 'm_1',
      at: AT,
      data: {},
    });
    expect(decodeSessionEvent(wire)).toBeNull();
  });

  it('rejects an event whose data does not match its name', () => {
    const cases = [
      { event: 'matched', data: { startedAt: AT } },
      { event: 'matched', data: { startedAt: AT, you: { nickname: 'a' }, partner: {} } },
      { event: 'partner_typing', data: { active: 'yes' } },
      { event: 'message', data: { messageId: 'm', text: 'hi', sentAt: AT, contentType: 'image' } },
      { event: 'message', data: { messageId: 'm', sentAt: AT, contentType: 'text' } },
      { event: 'session_evicted', data: { reason: 'because' } },
    ];
    for (const { event, data } of cases) {
      const wire = JSON.stringify({ v: SESSION_EVENT_VERSION, event, matchId: 'm_1', at: AT, data });
      expect(decodeSessionEvent(wire)).toBeNull();
    }
  });

  it('rejects a missing matchId', () => {
    const wire = JSON.stringify({ v: SESSION_EVENT_VERSION, event: 'partner_skipped', at: AT });
    expect(decodeSessionEvent(wire)).toBeNull();
  });

  it('never coerces a media content type into text (§23.6)', () => {
    const wire = JSON.stringify({
      v: SESSION_EVENT_VERSION,
      event: 'message',
      matchId: 'm_1',
      at: AT,
      data: { messageId: 'msg_1', text: 'caption', sentAt: AT, contentType: 'image' },
    });
    expect(decodeSessionEvent(wire)).toBeNull();
  });
});

describe('building the recipient frame', () => {
  it('turns matched into a stamped matched frame carrying both identities', () => {
    const frame = toClientFrame(matched);
    expect(frame).toMatchObject({
      type: 'matched',
      version: PROTOCOL_VERSION,
      payload: {
        matchId: 'm_1',
        startedAt: AT,
        you: { nickname: 'Quiet Heron' },
        partner: { nickname: 'Amber Fox' },
      },
    });
    expect(frame?.id).toMatch(/^f_/);
    expect(frame?.timestamp).toBeTruthy();
  });

  it('marks an inbound message as coming from the partner', () => {
    const frame = toClientFrame({
      event: 'message',
      matchId: 'm_1',
      messageId: 'msg_1',
      contentType: 'text',
      text: 'hi',
      sentAt: AT,
    });
    expect(frame?.payload).toEqual({
      matchId: 'm_1',
      messageId: 'msg_1',
      type: 'text',
      text: 'hi',
      sentAt: AT,
      from: 'partner',
    });
  });

  it('never sends a partner session id in any frame', () => {
    for (const event of [
      matched,
      { event: 'partner_skipped', matchId: 'm_1' } as SessionEvent,
      { event: 'partner_disconnected', matchId: 'm_1' } as SessionEvent,
      { event: 'partner_typing', matchId: 'm_1', active: false } as SessionEvent,
    ]) {
      const payload = toClientFrame(event)?.payload as unknown as Record<string, unknown>;
      expect(Object.keys(payload)).not.toContain('partnerSessionId');
      expect(Object.keys(payload)).not.toContain('sessionId');
    }
  });

  it('gives session_evicted no frame — the socket is closed, not informed', () => {
    expect(toClientFrame({ event: 'session_evicted', matchId: 'm_1', reason: 'reaped' })).toBeNull();
  });
});
