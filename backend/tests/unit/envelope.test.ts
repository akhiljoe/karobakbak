import { encode, encodeError, errorFrame, isRetryable, serverFrame } from '../../src/protocol/envelope';
import { PROTOCOL_ERROR_CODES, PROTOCOL_VERSION } from '../../src/protocol/types';

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
    const json = encode('matched', { matchId: 'm_1', startedAt: '2026-01-01T00:00:00.000Z' });
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      type: 'matched',
      version: PROTOCOL_VERSION,
      payload: { matchId: 'm_1', startedAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('never leaks a partner session id in a matched frame', () => {
    const json = encode('matched', { matchId: 'm_1', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(Object.keys(JSON.parse(json).payload).sort()).toEqual(['matchId', 'startedAt']);
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
