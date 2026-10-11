/**
 * The UI state machine. Pure, so every interesting decision this client makes
 * is testable without a browser, a socket or a render.
 */
import { describe, expect, it } from 'vitest';

import { canSend, initialState, reduce, type ChatState } from './machine';
import { composerDisabled } from '../view/presentation';
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
      {
        id: 'msg_1',
        // The same value for an inbound message: the id it arrived with *is*
        // the one the server gave it. They only diverge for our own messages,
        // which carry a local id until the ack lands.
        serverId: 'msg_1',
        from: 'partner',
        type: 'text',
        text: 'hi there',
        at: '2026-08-19T10:00:02.000Z',
      },
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

/**
 * The author seeing a reaction on a message they sent.
 *
 * This is the path that failed in use: the sender of a reaction saw their own
 * heart while the author of the message saw nothing. The two sides key the same
 * message differently — the author by the envelope id they generated, the
 * recipient by the id the server assigned — so a reaction naming the server's
 * id has to find the author's locally-keyed copy.
 */
describe('reactions', () => {
  function authorWithSentMessage() {
    const pending = reduce(matched(), {
      type: 'send_pending',
      id: 'c_local_1',
      text: 'hello',
      at: '2026-08-19T10:00:02.000Z',
    });
    return reduce(pending, {
      type: 'message_ack',
      payload: {
        clientMsgId: 'c_local_1',
        messageId: 'msg_server_1',
        matchId: 'm_1',
        acceptedAt: '2026-08-19T10:00:02.000Z',
        route: 'local',
        status: 'routed',
      },
    });
  }

  it('learns the server id from the ack', () => {
    const state = authorWithSentMessage();
    expect(state.messages[0]?.id).toBe('c_local_1');
    expect(state.messages[0]?.serverId).toBe('msg_server_1');
  });

  it('shows a partner reaction on our own message, keyed by the server id', () => {
    const state = reduce(authorWithSentMessage(), {
      type: 'partner_reacted',
      payload: {
        matchId: 'm_1',
        messageId: 'msg_server_1',
        reaction: 'heart',
        active: true,
      },
    });
    expect(state.messages[0]?.reactions?.partner).toBe('heart');
  });

  it('removes it again when the partner takes it back', () => {
    const reacted = reduce(authorWithSentMessage(), {
      type: 'partner_reacted',
      payload: { matchId: 'm_1', messageId: 'msg_server_1', reaction: 'heart', active: true },
    });
    const removed = reduce(reacted, {
      type: 'partner_reacted',
      payload: { matchId: 'm_1', messageId: 'msg_server_1', reaction: 'heart', active: false },
    });
    expect(removed.messages[0]?.reactions?.partner).toBeUndefined();
  });

  it('shows our own reaction on an inbound message', () => {
    const inbound = reduce(matched(), {
      type: 'message',
      payload: {
        matchId: 'm_1',
        messageId: 'msg_server_2',
        type: 'text',
        text: 'hi there',
        sentAt: '2026-08-19T10:00:02.000Z',
        from: 'partner',
      },
    });
    const state = reduce(inbound, {
      type: 'user_reacted',
      messageId: 'msg_server_2',
      reaction: 'heart',
      active: true,
    });
    expect(state.messages[0]?.reactions?.you).toBe('heart');
  });
});

/**
 * Skipping while the stranger's seat is still held (§28, D42).
 *
 * Supported and ordinary: the window is an offer to wait, not an obligation.
 * What must not happen is the flag outliving the conversation it belongs to —
 * it disables the composer, so carrying it forward opened the next
 * conversation unable to send anything.
 */
describe('a held seat does not outlive its conversation', () => {
  function partnerAway() {
    return reduce(matched(), {
      type: 'partner_reconnecting',
      matchId: 'm_1',
      until: '2026-08-19T10:00:20.000Z',
    });
  }

  it('clears the countdown when the user skips instead of waiting', () => {
    const away = partnerAway();
    expect(away.partnerAway).not.toBeNull();
    expect(composerDisabled(away)).toBe(true);

    const skipped = reduce(away, { type: 'user_skipped' });
    expect(skipped.partnerAway).toBeNull();
  });

  it('leaves the next conversation able to send', () => {
    // The symptom this came from: a new stranger, a banner counting down a
    // deadline that had already passed, and a composer that refused everything.
    const next = reduce(reduce(partnerAway(), { type: 'user_skipped' }), {
      type: 'matched',
      payload: {
        matchId: 'm_2',
        startedAt: '2026-08-19T10:01:00.000Z',
        you: YOU,
        partner: PARTNER,
      },
    });
    expect(next.partnerAway).toBeNull();
    expect(composerDisabled(next)).toBe(false);
  });

  it('clears it when the stranger leaves for good', () => {
    const left = reduce(partnerAway(), { type: 'partner_left', matchId: 'm_1' });
    expect(left.partnerAway).toBeNull();
  });
});

/**
 * Saved connections, client side (§31).
 *
 * The clearing tests are the ones that matter most, and they exist because
 * `partnerAway` taught this file a lesson: a per-conversation flag that is not
 * reset in `clearedConversation` survives into the next conversation, nothing
 * throws, every test passes, and the interface quietly lies about a stranger
 * who was never involved.
 */
describe('saving a connection', () => {
  function saved(): ChatState {
    return reduce(matched(), { type: 'connection_state', matchId: 'm_1', saved: true });
  }

  it('starts unsaved and unconnected', () => {
    const state = matched();
    expect(state.connectionSaved).toBe(false);
    expect(state.connectionMade).toBe(false);
  });

  it('records your own press without claiming a connection', () => {
    // The whole privacy shape in one assertion: pressing save says nothing
    // about the other person, so `connectionMade` must stay false.
    expect(saved()).toMatchObject({ connectionSaved: true, connectionMade: false });
  });

  it('lets the press be withdrawn', () => {
    const state = reduce(saved(), { type: 'connection_state', matchId: 'm_1', saved: false });
    expect(state.connectionSaved).toBe(false);
  });

  it('marks both when the server says the pair completed', () => {
    const state = reduce(saved(), { type: 'connection_made', matchId: 'm_1' });
    expect(state).toMatchObject({ connectionSaved: true, connectionMade: true });
    expect(state.notice).toMatch(/connected/i);
  });

  it('forces the saved flag true on connection_made, even if the ack was lost', () => {
    // `connection_made` can only exist because both sides pressed. A client
    // that never received its own `connection_state` must still render a
    // coherent pair rather than "connected but not saved".
    const state = reduce(matched(), { type: 'connection_made', matchId: 'm_1' });
    expect(state).toMatchObject({ connectionSaved: true, connectionMade: true });
  });

  it('ignores a frame for a conversation that is not the live one', () => {
    // A late ack for a conversation that already ended would otherwise light
    // the button in the next one — the same shape of fault as the held seat
    // that leaked across a skip.
    const state = matched();
    expect(reduce(state, { type: 'connection_state', matchId: 'm_old', saved: true })).toBe(state);
    expect(reduce(state, { type: 'connection_made', matchId: 'm_old' })).toBe(state);
  });

  it('is cleared when the conversation ends', () => {
    const state = reduce(saved(), { type: 'partner_left', matchId: 'm_1' });
    expect(state.connectionSaved).toBe(false);
    expect(state.connectionMade).toBe(false);
  });

  it('does not survive a skip into the next conversation', () => {
    // The regression `partnerAway` already caused once. A saved flag carried
    // across would show a pressed button for a stranger nobody saved, and a
    // carried `connectionMade` would claim a connection that does not exist.
    const after = reduce(saved(), { type: 'user_skipped' });
    expect(after.connectionSaved).toBe(false);
    expect(after.connectionMade).toBe(false);

    const next = reduce(after, {
      type: 'matched',
      payload: {
        matchId: 'm_2',
        startedAt: '2026-08-19T10:05:00.000Z',
        you: YOU,
        partner: PARTNER,
      },
    });
    expect(next.connectionSaved).toBe(false);
    expect(next.connectionMade).toBe(false);
  });

  it('maps both server frames off the wire', () => {
    // `toAction` is the boundary: a frame this does not translate is a feature
    // that works in the reducer and never fires in the running app.
    expect(
      toAction({
        type: 'connection_state',
        version: 1,
        id: 'f_1',
        timestamp: '2026-08-19T10:00:02.000Z',
        payload: { matchId: 'm_1', saved: true },
      } as AnyServerEnvelope),
    ).toEqual({ type: 'connection_state', matchId: 'm_1', saved: true });

    expect(
      toAction({
        type: 'connection_made',
        version: 1,
        id: 'f_2',
        timestamp: '2026-08-19T10:00:03.000Z',
        payload: { matchId: 'm_1' },
      } as AnyServerEnvelope),
    ).toEqual({ type: 'connection_made', matchId: 'm_1' });
  });
});

/**
 * What the capacity probe is allowed to change (§28.9).
 *
 * The probe answers over HTTP while the socket is retrying on its own timer,
 * so the ordering between the two is not fixed and the reducer is where that
 * race is resolved.
 */
describe('the capacity probe answer', () => {
  it('is recorded while the socket is away', () => {
    const dropped = reduce(initialState, { type: 'socket_closed', code: 1006 });
    const probed = reduce(dropped, { type: 'capacity_probed', state: 'busy' });
    expect(probed.capacity).toBe('busy');
    // The screen is unchanged: the probe explains the wait, it does not decide
    // what is on screen.
    expect(probed.screen).toBe(dropped.screen);
  });

  it('is ignored once the socket has come back', () => {
    // The probe is fired from a close handler and answered over HTTP, so a
    // reconnect can easily land first. A late "busy" would then caption a
    // working connection with the reason the previous attempt failed.
    const talking = connected(reduce(initialState, { type: 'socket_open' }));
    expect(reduce(talking, { type: 'capacity_probed', state: 'busy' })).toBe(talking);
  });

  it('is cleared when a socket opens, not left standing', () => {
    const dropped = reduce(initialState, { type: 'socket_closed', code: 1006 });
    const busy = reduce(dropped, { type: 'capacity_probed', state: 'busy' });
    expect(reduce(busy, { type: 'socket_open' }).capacity).toBe('unknown');
  });
});

describe('a handshake that was refused', () => {
  it('does not claim a connection was lost, because none was ever held', () => {
    // The toast said "Connection lost. Reconnecting…" on a first visit to a
    // busy service, beside a landing line saying it was busy: two messages,
    // one of them false and the more alarming of the two.
    const refused = reduce(initialState, {
      type: 'socket_closed',
      code: 1006,
      everOpened: false,
    });
    expect(refused.notice).toBeNull();
    expect(refused.screen).toBe('disconnected');
  });

  it('still says so for a socket that was up and dropped', () => {
    // The absent field means "it was up", which is what every caller before
    // this one described.
    expect(reduce(connected(), { type: 'socket_closed', code: 1006 }).notice).toContain(
      'Connection lost',
    );
    expect(
      reduce(connected(), { type: 'socket_closed', code: 1006, everOpened: true }).notice,
    ).toContain('Connection lost');
  });
});

describe('a reconnect request from a friend (D65)', () => {
  it("carries the recipient's own name for them, and forgets it once answered", () => {
    const frame = {
      type: 'reconnect_request',
      version: 1,
      payload: { offer: 'o'.repeat(32), friend: { label: 'Sam' } },
    } as unknown as AnyServerEnvelope;
    const action = toAction(frame);
    expect(action).toEqual({ type: 'reconnect_request', offer: 'o'.repeat(32), friend: { label: 'Sam' } });

    const asked = reduce(connected(), action!);
    expect(asked.reconnectFriend).toEqual({ label: 'Sam' });
    expect(reduce(asked, { type: 'reconnect_dismissed' }).reconnectFriend).toBeNull();
  });

  it('leaves a past partner request unnamed', () => {
    const asked = reduce(connected(), { type: 'reconnect_request', offer: 'o'.repeat(32) });
    expect(asked.reconnectOffer).toBe('o'.repeat(32));
    expect(asked.reconnectFriend).toBeNull();
  });
});
