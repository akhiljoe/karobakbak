import { encode, encodeError, errorFrame, isRetryable, serverFrame } from '../../src/protocol/envelope';
import { PROTOCOL_ERROR_CODES, PROTOCOL_VERSION, type MatchedPayload } from '../../src/protocol/types';

/** A representative `matched` payload, including both temporary identities. */
function matched(): MatchedPayload {
  return {
    matchId: 'm_1',
    startedAt: '2026-01-01T00:00:00.000Z',
    you: { nickname: 'Amber Fox', colour: '#7C5CFF' },
    partner: { nickname: 'Quiet Heron', colour: '#2DD4BF' },
  };
}

describe('server frames', () => {
  it('stamps version, a server-generated id and a server-generated ISO timestamp', () => {
    const frame = serverFrame('pong', { serverTime: '2026-01-01T00:00:00.000Z' });
    expect(frame.type).toBe('pong');
    expect(frame.version).toBe(PROTOCOL_VERSION);
    expect(frame.id).toMatch(/^f_[A-Za-z0-9_-]+$/);
    expect(new Date(String(frame.timestamp)).toISOString()).toBe(frame.timestamp);
  });

  it('generates a unique id per frame', () => {
    const ids = new Set(Array.from({ length: 200 }, () => serverFrame('pong', { serverTime: 'x' }).id));
    expect(ids.size).toBe(200);
  });

  it('round-trips through JSON', () => {
    const json = encode('matched', matched());
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      type: 'matched',
      version: PROTOCOL_VERSION,
      payload: { matchId: 'm_1', startedAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('never leaks a partner session id in a matched frame', () => {
    const payload = JSON.parse(encode('matched', matched())).payload;
    expect(Object.keys(payload).sort()).toEqual(['matchId', 'partner', 'startedAt', 'you']);
    // The temporary identity is a nickname and a colour and nothing else: an
    // identity carrying a session id would be a deanonymisation primitive.
    expect(Object.keys(payload.partner).sort()).toEqual(['colour', 'nickname']);
    expect(Object.keys(payload.you).sort()).toEqual(['colour', 'nickname']);
  });
});

describe('revision-2 server frames', () => {
  it('marks presence counts as approximate on the wire', () => {
    const payload = JSON.parse(encode('presence', { online: 412, conversations: 96, approximate: true })).payload;
    // The UI cannot present these as exact, because the frame says so itself
    // (D21): fabricated or precise-looking social proof is unrecoverable.
    expect(payload).toEqual({ online: 412, conversations: 96, approximate: true });
  });

  it('reports a withheld message as an ack rather than an error', () => {
    const payload = JSON.parse(
      encode('message_ack', {
        clientMsgId: 'c_1',
        messageId: 'm_1',
        matchId: 'match_1',
        acceptedAt: '2026-01-01T00:00:00.000Z',
        route: 'local',
        delivered: false,
      }),
    ).payload;
    // Accepted and recorded, but not delivered (D20). The sender is told,
    // because an ack indistinguishable from delivery makes "sent" meaningless.
    expect(payload.delivered).toBe(false);
    expect(payload.route).toBe('local');
  });

  it('acknowledges a report without carrying any moderation detail', () => {
    const payload = JSON.parse(
      encode('report_ack', { reportId: 'r_1', acceptedAt: '2026-01-01T00:00:00.000Z' }),
    ).payload;
    // No verdict, no next steps, nothing about the reported user (security §31).
    expect(Object.keys(payload).sort()).toEqual(['acceptedAt', 'reportId']);
  });

  it('carries no identity in partner_typing beyond the match it belongs to', () => {
    const payload = JSON.parse(encode('partner_typing', { matchId: 'm_1', active: true })).payload;
    expect(Object.keys(payload).sort()).toEqual(['active', 'matchId']);
  });
});

describe('error frames', () => {
  it('marks transient failures retryable and state failures not', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(true);
    expect(isRetryable('SERVER_SHUTTING_DOWN')).toBe(true);
    expect(isRetryable('INTERNAL_ERROR')).toBe(true);
    expect(isRetryable('NOT_MATCHED')).toBe(false);
    expect(isRetryable('BAD_JSON')).toBe(false);
    expect(isRetryable('SESSION_GONE')).toBe(false);
  });

  it('carries only code, message and retryable — no internal state', () => {
    const frame = errorFrame('NOT_MATCHED', 'you are not in a match');
    expect(Object.keys(frame.payload).sort()).toEqual(['code', 'message', 'retryable']);
    expect(frame.payload).toEqual({
      code: 'NOT_MATCHED',
      message: 'you are not in a match',
      retryable: false,
    });
  });

  it('serialises every declared error code', () => {
    for (const code of PROTOCOL_ERROR_CODES) {
      const parsed = JSON.parse(encodeError(code, 'reason'));
      expect(parsed.payload.code).toBe(code);
      expect(typeof parsed.payload.retryable).toBe('boolean');
    }
  });
});
