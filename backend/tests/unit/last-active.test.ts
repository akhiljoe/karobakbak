import { lastActiveBucket } from '../../src/accounts/presence';
import { SESSION_EVENT_VERSION, decodeSessionEvent, encodeSessionEvent, toClientFrame } from '../../src/ws/events';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A stamp is the start of an hour; "now" is measured from the end of it. */
function ago(ms: number): ReturnType<typeof lastActiveBucket> {
  const now = new Date('2026-10-11T12:30:00Z');
  const stamp = new Date(now.getTime() - HOUR - ms);
  return lastActiveBucket(stamp, now);
}

describe('lastActiveBucket (D65)', () => {
  it('reads anything inside the last hour as "within the last hour"', () => {
    expect(ago(0)).toEqual({ unit: 'hour', count: 0 });
    expect(ago(59 * 60 * 1000)).toEqual({ unit: 'hour', count: 0 });
    // A stamp in the current hour is "now", not a negative age.
    expect(lastActiveBucket(new Date('2026-10-11T12:00:00Z'), new Date('2026-10-11T12:30:00Z'))).toEqual({
      unit: 'hour',
      count: 0,
    });
  });

  it('counts whole hours below a day, rounded down', () => {
    expect(ago(HOUR)).toEqual({ unit: 'hour', count: 1 });
    expect(ago(3 * HOUR + 59 * 60 * 1000)).toEqual({ unit: 'hour', count: 3 });
    expect(ago(23 * HOUR + 59 * 60 * 1000)).toEqual({ unit: 'hour', count: 23 });
  });

  it('switches to days, then weeks, then months, then years', () => {
    expect(ago(DAY)).toEqual({ unit: 'day', count: 1 });
    expect(ago(6 * DAY + 23 * HOUR)).toEqual({ unit: 'day', count: 6 });
    expect(ago(7 * DAY)).toEqual({ unit: 'week', count: 1 });
    expect(ago(29 * DAY)).toEqual({ unit: 'week', count: 4 });
    expect(ago(30 * DAY)).toEqual({ unit: 'month', count: 1 });
    expect(ago(359 * DAY)).toEqual({ unit: 'month', count: 11 });
    expect(ago(360 * DAY)).toEqual({ unit: 'year', count: 1 });
    expect(ago(800 * DAY)).toEqual({ unit: 'year', count: 2 });
  });

  it('never answers finer than an hour, however the stamp was written', () => {
    // A stamp off the hour boundary still produces only a whole-unit bucket.
    const odd = lastActiveBucket(new Date('2026-10-11T03:17:42Z'), new Date('2026-10-11T12:30:00Z'));
    expect(odd).toEqual({ unit: 'hour', count: 8 });
  });
});

describe('a friend asking to chat, through pub/sub', () => {
  const AT = '2026-10-11T12:00:00.000Z';

  it("carries the recipient's own label to the client frame", () => {
    const decoded = decodeSessionEvent(
      encodeSessionEvent(
        { event: 'reconnect_request', matchId: '', offer: 'o'.repeat(32), friend: { label: 'Sam' } },
        AT,
      ),
    );
    expect(decoded).toEqual({
      event: 'reconnect_request',
      matchId: '',
      offer: 'o'.repeat(32),
      friend: { label: 'Sam' },
    });
    expect(toClientFrame(decoded!)?.payload).toEqual({ offer: 'o'.repeat(32), friend: { label: 'Sam' } });
  });

  it('keeps a past partner request free of any friend marker', () => {
    const decoded = decodeSessionEvent(
      encodeSessionEvent({ event: 'reconnect_request', matchId: '', offer: 'o'.repeat(32) }, AT),
    );
    expect(toClientFrame(decoded!)?.payload).toEqual({ offer: 'o'.repeat(32) });
  });

  it('drops a malformed marker rather than passing it through', () => {
    const wire = JSON.stringify({
      v: SESSION_EVENT_VERSION,
      event: 'reconnect_request',
      matchId: '',
      at: AT,
      data: { offer: 'o'.repeat(32), friend: { label: 'x'.repeat(41) } },
    });
    const decoded = decodeSessionEvent(wire);
    expect(decoded).toEqual({ event: 'reconnect_request', matchId: '', offer: 'o'.repeat(32) });
  });
});
