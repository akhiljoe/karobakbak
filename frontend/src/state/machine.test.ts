/**
 * The UI state machine. Pure, so every interesting decision this client makes
 * is testable without a browser, a socket or a render.
 */
import { describe, expect, it } from 'vitest';

import { canSend, initialState, reduce, type ChatState } from './machine';
import { messageKindFor } from '../components/MessageList';
import { toAction } from '../hooks/useChat';
import type { AnyServerEnvelope, ServerFeatures } from '../protocol/types';

const FEATURES: ServerFeatures = { typing: true, presence: true, report: true, block: true };

const LIMITS = {
  maxMessageLength: 500,
  maxReportNoteLength: 500,
  messagesPerSecond: 5,
  burst: 10,
  typingPerSecond: 4,
  maxFrameBytes: 16384,
};

const YOU = { nickname: 'Quiet Heron', colour: '#2DD4BF' };
const PARTNER = { nickname: 'Amber Fox', colour: '#7C5CFF' };

function connected(state = initialState): ChatState {
  return reduce(state, {
    type: 'connected',
    payload: {
      sessionId: 's_abc',
      protocolVersion: 1,
      serverTime: '2026-08-19T10:00:00.000Z',
      limits: LIMITS,
      features: FEATURES,
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
        delivered: true,
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
        delivered: false,
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
        delivered: true,
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

  it('says a dropped connection ends the conversation, not pauses it', () => {
    const state = reduce(matched(), { type: 'socket_closed', code: 1006 });
    // There is no session resumption (D7).
    expect(state.screen).toBe('disconnected');
    expect(state.sessionId).toBeNull();
    expect(state.matchId).toBeNull();
    expect(state.messages).toEqual([]);
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
