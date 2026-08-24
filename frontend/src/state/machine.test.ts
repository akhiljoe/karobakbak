/**
 * The UI state machine. Pure, so every interesting decision this client makes
 * is testable without a browser, a socket or a render.
 */
import { describe, expect, it } from 'vitest';

import { canSend, initialState, reduce, type ChatState } from './machine';
import { messageKindFor } from '../components/MessageList';
import { toAction } from '../hooks/useChat';
import type { AnyServerEnvelope, ErrorPayload, ServerFeatures } from '../protocol/types';

const FEATURES: ServerFeatures = { typing: true, presence: true, report: true, block: true };

const LIMITS = {
  maxMessageLength: 500,
  maxReportNoteLength: 500,
  messagesPerSecond: 5,
  burst: 10,
  typingPerSecond: 4,
  maxFrameBytes: 16384,
};

const YOU = { nickname: 'Quiet Heron', colour: '#2DD4BF', profile: null };
const PARTNER = { nickname: 'Amber Fox', colour: '#7C5CFF', profile: null };

function connected(state = initialState): ChatState {
  return reduce(state, {
    type: 'connected',
    payload: {
      sessionId: 's_abc',
      protocolVersion: 1,
      serverTime: '2026-08-19T10:00:00.000Z',
      limits: LIMITS,
      features: FEATURES,
      resumeToken: 't_test',
      resumeGraceSeconds: 20,
    },
  });
}

function matched(state = connected()): ChatState {
  return reduce(state, {
    type: 'matched',
    payload: {
      matchId: 'm_1',
      startedAt: '2026-08-19T10:00:01.000Z',
      you: YOU,
      partner: PARTNER,
    },
  });
}

describe('connecting', () => {
  it('enables nothing until the server says what it supports', () => {
    // Offering a control the server has turned off means sending a command
    // that gets refused, then having to explain the refusal.
    expect(initialState.features).toEqual({
      typing: false,
      presence: false,
      report: false,
      block: false,
    });
    expect(initialState.screen).toBe('connecting');
  });

  it('takes its capabilities and limits from the connected frame', () => {
    const state = connected();
    expect(state.screen).toBe('idle');
    expect(state.features).toEqual(FEATURES);
    expect(state.limits?.maxMessageLength).toBe(500);
  });
});

describe('matching', () => {
  it('shows the conversation with both identities', () => {
    const state = matched();
    expect(state.screen).toBe('chatting');
    expect(state.matchId).toBe('m_1');
    expect(state.you).toEqual(YOU);
    expect(state.partner).toEqual(PARTNER);
  });

  it('clears the previous conversation completely', () => {
    let state = matched();
    state = reduce(state, {
      type: 'message',
      payload: {
        matchId: 'm_1',
        messageId: 'msg_1',
        type: 'text',
        text: 'hello',
        sentAt: '2026-08-19T10:00:02.000Z',
        from: 'partner',
      },
    });
    expect(state.messages).toHaveLength(1);

    const next = reduce(state, {
      type: 'matched',
      payload: { matchId: 'm_2', startedAt: 'x', you: YOU, partner: PARTNER },
    });
    // Nothing from the last stranger may appear in the next conversation.
    expect(next.messages).toEqual([]);
    expect(next.partnerTyping).toBe(false);
    expect(next.reportSent).toBe(false);
  });

  it('reports the queue depth while searching', () => {
    const state = reduce(connected(), {
      type: 'queue_status',
      payload: { state: 'SEARCHING', waiting: 7 },
    });
    expect(state.screen).toBe('searching');
    expect(state.waiting).toBe(7);
  });
});

describe('messages', () => {
  it('shows an inbound message from the partner', () => {
    const state = reduce(matched(), {
      type: 'message',
      payload: {
        matchId: 'm_1',
        messageId: 'msg_1',
        type: 'text',
        text: 'hi there',
        sentAt: '2026-08-19T10:00:02.000Z',
        from: 'partner',
      },
    });
    expect(state.messages).toEqual([
      { id: 'msg_1', from: 'partner', type: 'text', text: 'hi there', at: '2026-08-19T10:00:02.000Z' },
    ]);
  });

  it('drops a frame for a conversation this client has left', () => {
    // The server is authoritative about which match is current; a late frame
    // from the previous one is not news.
    const state = reduce(matched(), {
      type: 'message',
      payload: {
        matchId: 'm_old',
        messageId: 'msg_1',
        type: 'text',
        text: 'from before',
        sentAt: 'x',
        from: 'partner',
      },
    });
    expect(state.messages).toEqual([]);
  });

  it('marks an outgoing message sent, never read', () => {
    let state = reduce(matched(), {
      type: 'send_pending',
      id: 'c_1',
      text: 'hello',
      at: '2026-08-19T10:00:03.000Z',
    });
    expect(state.messages[0]?.status).toBe('sending');

    state = reduce(state, {
      type: 'message_ack',
      payload: {
        clientMsgId: 'c_1',
        messageId: 'msg_1',
        matchId: 'm_1',
        acceptedAt: 'x',
        route: 'remote',
        status: 'routed',
      },
    });
    // message_ack means accepted and routed (D14). There is no read receipt in
    // this protocol, and rendering one would invent a guarantee.
    expect(state.messages[0]?.status).toBe('sent');
  });

  it('tells the sender plainly when policy withheld a message', () => {
    let state = reduce(matched(), { type: 'send_pending', id: 'c_1', text: 'x', at: 'x' });
    state = reduce(state, {
      type: 'message_ack',
      payload: {
        clientMsgId: 'c_1',
        messageId: 'msg_1',
        matchId: 'm_1',
        acceptedAt: 'x',
        route: 'local',
        status: 'withheld',
      },
    });
    // Not silently shown as sent: the sender would otherwise believe it landed.
    expect(state.messages[0]?.status).toBe('withheld');
  });

  it('ignores an ack with no client id', () => {
    const state = reduce(matched(), {
      type: 'message_ack',
      payload: {
        clientMsgId: null,
        messageId: 'msg_1',
        matchId: 'm_1',
        acceptedAt: 'x',
        route: 'local',
        status: 'routed',
      },
    });
    expect(state.messages).toEqual([]);
  });
});

describe('the conversation ending', () => {
  it('cannot tell a block from a skip, because the server does not say', () => {
    const state = reduce(matched(), { type: 'partner_left', matchId: 'm_1' });
    // Security §32: the same event covers both, and the client must not invent
    // a distinction it was deliberately not given.
    expect(state.screen).toBe('ended');
    expect(state.endReason).toBe('partner_left');
    expect(state.messages).toEqual([]);
  });

  it('holds the conversation on screen while the socket comes back (§28)', () => {
    const talking = reduce(matched(), {
      type: 'message',
      payload: {
        matchId: 'm_1',
        messageId: 'srv_1',
        type: 'text',
        text: 'hello',
        sentAt: '2026-08-19T10:00:01.000Z',
        from: 'partner',
      },
    });
    const state = reduce(talking, { type: 'socket_closed', code: 1006 });
    expect(state.screen).toBe('disconnected');
    expect(state.sessionId).toBeNull();
    // Kept, not cleared. The server is holding the seat, so throwing the
    // transcript away here would be visibly wrong the moment the resume lands —
    // and would be an ending the server never announced.
    expect(state.matchId).not.toBeNull();
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.partnerTyping).toBe(false);
  });

  it('drops the conversation when the reconnection brings nothing back', () => {
    // The ending belongs here: after the server has said the seat is gone, not
    // on the guess that it will be.
    const dropped = reduce(matched(), { type: 'socket_closed', code: 1006 });
    const fresh = connected(dropped);
    expect(fresh.screen).toBe('idle');
    expect(fresh.matchId).toBeNull();
  });

  it('restores the conversation when the reconnection resumes it', () => {
    const dropped = reduce(matched(), { type: 'socket_closed', code: 1006 });
    const back = reduce(dropped, {
      type: 'connected',
      payload: {
        sessionId: 's_new',
        protocolVersion: 1,
        serverTime: '2026-08-19T10:00:05.000Z',
        limits: LIMITS,
        features: FEATURES,
        resumeToken: 't_rotated',
        resumeGraceSeconds: 20,
        resumed: {
          matchId: 'm_1',
          startedAt: '2026-08-19T10:00:00.000Z',
          you: YOU,
          partner: PARTNER,
        },
      },
    });
    expect(back.screen).toBe('chatting');
    expect(back.matchId).toBe('m_1');
    expect(back.partnerAway).toBeNull();
  });

  it('marks the partner away without ending the conversation', () => {
    const away = reduce(matched(), {
      type: 'partner_reconnecting',
      matchId: 'm_1',
      until: '2026-08-19T10:00:20.000Z',
    });
    expect(away.screen).toBe('chatting');
    expect(away.partnerAway).toBe('2026-08-19T10:00:20.000Z');

    const back = reduce(away, { type: 'partner_returned', matchId: 'm_1' });
    expect(back.partnerAway).toBeNull();
  });

  it('keeps the user searching after their own skip', () => {
    const state = reduce(matched(), { type: 'user_skipped' });
    expect(state.screen).toBe('searching');
    expect(state.messages).toEqual([]);
  });

  it('leaves a blocker idle rather than straight back into the queue', () => {
    const state = reduce(matched(), { type: 'user_blocked' });
    expect(state.screen).toBe('ended');
    expect(state.endReason).toBe('you_blocked');
  });
});

describe('reports', () => {
  it('acknowledges without promising anything further', () => {
    const state = reduce(matched(), { type: 'report_ack' });
    expect(state.reportSent).toBe(true);
    // The ack carries no verdict; the UI must not imply one.
    expect(state.notice).not.toMatch(/ban|remov|action taken|investigat/i);
  });
});

describe('errors are translated, not echoed', () => {
  it('turns a rate limit into something a person can act on', () => {
    const state = reduce(matched(), {
      type: 'server_error',
      payload: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
    });
    expect(state.notice).toBe('Slow down a moment.');
  });

  it('says nothing for a duplicate, because nothing went wrong', () => {
    // The first copy was delivered; the repeat was refused (I14).
    const state = reduce(matched(), {
      type: 'server_error',
      payload: { code: 'DUPLICATE_MESSAGE', message: 'x', retryable: false },
    });
    expect(state.notice).toBeNull();
  });

  it('ends the conversation on NOT_MATCHED', () => {
    const state = reduce(matched(), {
      type: 'server_error',
      payload: { code: 'NOT_MATCHED', message: 'x', retryable: false },
    });
    expect(state.matchId).toBeNull();
    expect(state.screen).toBe('idle');
  });

  it('gives a general line for anything a user cannot act on', () => {
    const state = reduce(matched(), {
      type: 'server_error',
      payload: { code: 'VALIDATION_FAILED', message: 'payload.text must be a string', retryable: false },
    });
    // Telling somebody their frame failed validation helps nobody, and the
    // server's wording is developer-authored.
    expect(state.notice).toBe('Something went wrong. Please try again.');
  });
});

describe('presence', () => {
  it('records the counts the server sent', () => {
    const state = reduce(connected(), {
      type: 'presence',
      payload: { online: 412, conversations: 96, approximate: true },
    });
    expect(state.presence).toEqual({ online: 412, conversations: 96 });
  });
});

describe('sending is only possible inside a conversation', () => {
  it('is allowed while chatting and never otherwise', () => {
    expect(canSend(matched())).toBe(true);
    expect(canSend(connected())).toBe(false);
    expect(canSend(initialState)).toBe(false);
    expect(canSend(reduce(matched(), { type: 'partner_left', matchId: 'm_1' }))).toBe(false);
  });
});

describe('leaving a conversation (the back button)', () => {
  it('goes straight to the landing screen, not into another search', () => {
    const left = reduce(matched(), { type: 'user_left' });
    expect(left.screen).toBe('idle');
    expect(left.matchId).toBeNull();
    expect(left.partner).toBeNull();
    expect(left.messages).toEqual([]);
  });

  it('ignores the SEARCHING status that its own skip produces', () => {
    // `leave_chat` is one server-side transition, but a queue_status can still
    // be in flight from whatever came before. While a leave is pending, a
    // SEARCHING status is not news and must not bounce the screen.
    const left = reduce(matched(), { type: 'user_left' });
    const echoed = reduce(left, {
      type: 'queue_status',
      payload: { state: 'SEARCHING', waiting: 3 },
    });
    expect(echoed.screen).toBe('idle');
    // The count is still worth taking; only the screen change is suppressed.
    expect(echoed.waiting).toBe(3);
  });

  it('settles when the server confirms IDLE', () => {
    const left = reduce(matched(), { type: 'user_left' });
    const settled = reduce(left, {
      type: 'queue_status',
      payload: { state: 'IDLE', waiting: 0 },
    });
    expect(settled.screen).toBe('idle');
    expect(settled.leaving).toBe(false);
  });

  it('stops suppressing once the user deliberately searches again', () => {
    const left = reduce(matched(), { type: 'user_left' });
    const searching = reduce(left, { type: 'user_searching' });
    expect(searching.leaving).toBe(false);
    expect(searching.screen).toBe('searching');

    // A SEARCHING status now means what it says.
    const status = reduce(searching, {
      type: 'queue_status',
      payload: { state: 'SEARCHING', waiting: 2 },
    });
    expect(status.screen).toBe('searching');
  });

  it('is not confused with a skip, which does re-enter the queue', () => {
    const skipped = reduce(matched(), { type: 'user_skipped' });
    expect(skipped.screen).toBe('searching');
    expect(skipped.leaving).toBe(false);
  });
});

describe('the rendering boundary (§23.4)', () => {
  it('renders text through the text branch', () => {
    expect(messageKindFor('text')).toBe('text');
  });

  it('renders a placeholder for a type this build does not implement', () => {
    // A client that crashed on an unfamiliar type would turn a server rollout
    // into a broken page for everyone still on the old bundle.
    for (const type of ['image', 'voice', 'video', 'sticker', '', 'TEXT']) {
      expect(messageKindFor(type)).toBe('unsupported');
    }
  });
});

describe('frames this client does not know', () => {
  it('are dropped rather than thrown on', () => {
    const unknown = { type: 'friend_request', version: 1, payload: {} } as unknown as AnyServerEnvelope;
    expect(toAction(unknown)).toBeNull();
  });

  it('map every event the protocol defines today', () => {
    const frames: AnyServerEnvelope[] = [
      { type: 'queue_status', version: 1, payload: { state: 'IDLE', waiting: 0 } },
      { type: 'partner_skipped', version: 1, payload: { matchId: 'm_1' } },
      { type: 'partner_disconnected', version: 1, payload: { matchId: 'm_1' } },
      { type: 'report_ack', version: 1, payload: { reportId: 'r_1', acceptedAt: 'x' } },
      { type: 'server_shutdown', version: 1, payload: { reason: 'shutdown' } },
    ];
    for (const frame of frames) expect(toAction(frame)).not.toBeNull();
    // A pong needs no UI change at all.
    expect(toAction({ type: 'pong', version: 1, payload: { serverTime: 'x' } })).toBeNull();
  });
});

/**
 * The resume token's lifetime.
 *
 * It belongs to the *session*, not to a conversation. `partner_left` used to
 * clear it, which meant that after the first stranger walked away — the
 * ordinary way a conversation ends here — the tab held nothing, and the next
 * dropped socket opened a brand new session instead of reclaiming the one the
 * server was still holding a seat for.
 *
 * Asserted as state rather than through `sessionStorage`. The reducer no longer
 * writes storage at all: it returns the value and `useChat` persists it in an
 * effect, so these tests need no shim and describe the decision rather than its
 * side effect.
 */
describe('the resume token', () => {
  it('is taken from the connected frame', () => {
    expect(connected().resumeToken).toBe('t_test');
  });

  it('survives a partner leaving, because the session does', () => {
    const ended = reduce(matched(), { type: 'partner_left', matchId: 'm_1' });

    expect(ended.screen).toBe('ended');
    // The conversation ended; the session did not.
    expect(ended.resumeToken).toBe('t_test');
  });

  it('survives a skip and a block for the same reason', () => {
    expect(reduce(matched(), { type: 'user_skipped' }).resumeToken).toBe('t_test');
    expect(reduce(matched(), { type: 'user_blocked' }).resumeToken).toBe('t_test');
  });

  it('is untouched by a stale frame for a conversation that already ended', () => {
    // The clear used to run *above* the guard below, so a late
    // `partner_skipped` for a finished match discarded the token belonging to
    // the conversation the user was in now. Moving the write out of the reducer
    // is what makes that ordering impossible rather than merely fixed.
    const state = matched();
    const after = reduce(state, { type: 'partner_left', matchId: 'm_previous' });

    expect(after).toBe(state);
    expect(after.resumeToken).toBe('t_test');
  });

  it('is dropped when the server says the session itself is gone', () => {
    const gone = reduce(matched(), {
      type: 'server_error',
      payload: { code: 'SESSION_GONE', message: 'no such session', retryable: false },
    });

    expect(gone.screen).toBe('disconnected');
    // Nothing left to reclaim: offering this on the next connection would
    // present a credential for a session that no longer exists.
    expect(gone.resumeToken).toBeNull();
  });

  it('is replaced, not appended to, on every connection', () => {
    const rotated = reduce(matched(), {
      type: 'connected',
      payload: {
        sessionId: 's_next',
        protocolVersion: 1,
        serverTime: '2026-08-19T10:00:30.000Z',
        limits: LIMITS,
        features: FEATURES,
        resumeToken: 't_rotated_once',
        resumeGraceSeconds: 20,
      },
    });
    // The server rotates on redemption; keeping the old one would offer a
    // spent credential and lose a conversation that could have resumed.
    expect(rotated.resumeToken).toBe('t_rotated_once');
  });
});

/**
 * A refused join used to leave the screen searching for ever.
 *
 * `start()` moves to `searching` as soon as the frame goes out. The server can
 * refuse a join — an empty bucket, an age below the floor, a moderated name —
 * and every one of those paths replies with an error and no `queue_status`,
 * because nothing was queued. Nothing else was ever coming, so the optimistic
 * screen stayed on "Looking for someone…" and the user waited for a match that
 * could not arrive. Auto-search made it reachable in ordinary use, and its own
 * backoff was switched off by the bug it exists to handle: the countdown only
 * runs from `ended`, and the stuck screen is `searching`.
 */
describe('a refused join', () => {
  const searching = (): ChatState => reduce(connected(), { type: 'user_searching' });

  const refuse = (state: ChatState, code: ErrorPayload['code']): ChatState =>
    reduce(state, {
      type: 'server_error',
      payload: { code, message: 'refused', retryable: false },
    });

  it('rolls the optimistic search back when the bucket was empty', () => {
    const state = searching();
    expect(state.screen).toBe('searching');
    expect(state.searchPending).toBe(true);

    const after = refuse(state, 'RATE_LIMITED');

    expect(after.screen).toBe('idle');
    expect(after.searchPending).toBe(false);
    // Auto-search reads this to lengthen its countdown rather than retrying
    // into the same refusal.
    expect(after.rateLimitedAt).not.toBeNull();
  });

  it('rolls back and names the field when a declared name is refused', () => {
    const after = refuse(searching(), 'NAME_REFUSED');

    expect(after.screen).toBe('idle');
    // Its own code rather than VALIDATION_FAILED, which every malformed frame
    // in the protocol also produces — "invalid input" for a well-formed name
    // tells the user nothing they can act on.
    expect(after.notice).toBe('That name cannot be used. Try a different one.');
  });

  it('rolls back and says what the service is when the age is below the floor', () => {
    const after = refuse(searching(), 'AGE_BELOW_MINIMUM');

    expect(after.screen).toBe('idle');
    expect(after.notice).toBe('You must be 18 or over to use this service.');
  });

  it('rolls back on a code it has no copy for, rather than staying stuck', () => {
    const after = refuse(searching(), 'VALIDATION_FAILED');

    expect(after.screen).toBe('idle');
    expect(after.notice).toBe('Something went wrong. Please try again.');
  });

  it('leaves a confirmed search alone', () => {
    // Once the server has said SEARCHING the session really is queued, and an
    // error after that is about something else. Rolling back on any error
    // would drop a genuinely queued user out of the queue on screen.
    const queued = reduce(searching(), {
      type: 'queue_status',
      payload: { state: 'SEARCHING', waiting: 3 },
    });
    expect(queued.screen).toBe('searching');
    expect(queued.searchPending).toBe(false);

    const after = refuse(queued, 'RATE_LIMITED');
    expect(after.screen).toBe('searching');
  });

  it('is confirmed by a match as well as by a queue status', () => {
    const matchedFromPending = reduce(searching(), {
      type: 'matched',
      payload: {
        matchId: 'm_9',
        startedAt: '2026-08-19T10:00:00.000Z',
        you: YOU,
        partner: PARTNER,
      },
    });
    expect(matchedFromPending.searchPending).toBe(false);
  });

  it('does not carry a pending join across a reconnection', () => {
    // The socket that would have confirmed it is gone. A stale flag would roll
    // back the next unrelated error, and a stale `leaving` would swallow the
    // next genuine SEARCHING status.
    const dropped = reduce(searching(), { type: 'socket_closed', code: 1006 });
    const fresh = connected(dropped);

    expect(fresh.searchPending).toBe(false);
    expect(fresh.leaving).toBe(false);
  });
});
