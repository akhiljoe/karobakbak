/**
 * The WebSocket client.
 *
 * Owns the socket and nothing else: every frame becomes an action, and the
 * reducer in `state/machine.ts` decides what the screen says. That split is
 * what lets the interesting behaviour be tested without a browser.
 *
 * ---------------------------------------------------------------------------
 * RECONNECTING RESUMES THE SESSION
 * ---------------------------------------------------------------------------
 * A dropped connection is a pause, not an ending (§28, D42 — which reverses
 * D7). The server holds the seat for `RESUME_GRACE_SECONDS`, and this client
 * offers its resume token on the handshake so the conversation comes back with
 * the socket. A resume that fails is not an error: it opens a fresh session,
 * which is exactly what every connection used to do.
 *
 * The token is a bearer credential — whoever holds it can reclaim the
 * conversation — so it lives in `sessionStorage`, is replaced on every
 * redemption, and dies with the tab. See `resume.ts`.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import {
  BASE_PROTOCOL,
  PROTOCOL_VERSION,
  RESUME_PROTOCOL_PREFIX,
  type AnyServerEnvelope,
  type ClientEventType,
  type MatchPreferences,
  type Profile,
  type ReportCategory,
} from '../protocol/types';
import { clientConfig } from '../config';
import { loadResumeToken, saveResumeToken } from '../resume';
import { initialState, reduce, type Action, type ChatState } from '../state/machine';

function socketUrl(): string {
  const configured = clientConfig.wsUrl;
  if (configured.length > 0) return configured;
  // Derived from the page origin, which is what the nginx container and the
  // Vite dev proxy both serve — and what keeps the block-token cookie
  // same-site.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Spread a reconnect over its backoff window instead of firing on the tick.
 *
 * The events that drop a socket here are not per-user — a deploy, a restart, a
 * load-balancer change — so without this every client dropped by one of them
 * retries in lockstep, at the same offsets, for ever, since the last entry in
 * the table repeats. A server that is still coming up would get the entire
 * population at once, fail, and get it again ten seconds later. Per-IP limits
 * are no defence, because the herd is spread across every IP there is.
 *
 * Half the delay is fixed and half is random, so a client still backs off
 * monotonically — full jitter can pick a shorter wait on a later attempt, which
 * reads as a client that never settles.
 */
function withJitter(baseMs: number): number {
  return baseMs / 2 + Math.random() * (baseMs / 2);
}

/** Client correlation token, and the server's per-match dedupe key (D24). */
function newClientMessageId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface ChatApi {
  readonly state: ChatState;
  start(profile?: Profile, preferences?: MatchPreferences): void;
  stop(): void;
  skip(): void;
  /** End the conversation (or the search) and return to the landing screen. */
  leave(): void;
  block(): void;
  report(category: ReportCategory, note?: string): void;
  send(text: string): void;
  typing(active: boolean): void;
  dismissNotice(): void;
}

export function useChat(): ChatApi {
  const [state, dispatch] = useReducer(reduce, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedByUsRef = useRef(false);
  const reconnectRef = useRef<number | null>(null);
  const typingSentRef = useRef(false);
  const typingTimerRef = useRef<number | null>(null);

  const url = useMemo(socketUrl, []);

  const sendCommand = useCallback(
    (type: ClientEventType, payload: Record<string, unknown> = {}, id?: string): boolean => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      const envelope: Record<string, unknown> = { type, version: PROTOCOL_VERSION, payload };
      if (id !== undefined) envelope.id = id;
      socket.send(JSON.stringify(envelope));
      return true;
    },
    [],
  );

  /* --- the socket --------------------------------------------------------- */

  useEffect(() => {
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      // The resume token rides on the handshake as a subprotocol (§28): the
      // only value a browser can attach to a WebSocket handshake, and unlike a
      // query string it does not land in an access log. `kbb.v1` is offered
      // beside it so the server has something harmless to echo back.
      const token = loadResumeToken();
      const socket =
        token === null
          ? new WebSocket(url, [BASE_PROTOCOL])
          : new WebSocket(url, [BASE_PROTOCOL, `${RESUME_PROTOCOL_PREFIX}${token}`]);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        attemptRef.current = 0;
        dispatch({ type: 'socket_open' });
      });

      socket.addEventListener('message', (event) => {
        // A frame that does not parse is dropped, never thrown on: this handler
        // runs for every message and must survive anything that arrives.
        let frame: AnyServerEnvelope;
        try {
          frame = JSON.parse(String(event.data)) as AnyServerEnvelope;
        } catch {
          return;
        }
        const action = toAction(frame);
        if (action) dispatch(action);
      });

      socket.addEventListener('close', (event) => {
        socketRef.current = null;
        if (disposed || closedByUsRef.current) return;
        dispatch({ type: 'socket_closed', code: event.code });

        const backoff = clientConfig.timings.reconnectBackoffMs;
        const base = backoff[Math.min(attemptRef.current, backoff.length - 1)] ?? 10_000;
        attemptRef.current += 1;
        reconnectRef.current = window.setTimeout(connect, withJitter(base));
      });

      // 'error' is always followed by 'close', which is where reconnection
      // lives. Handling it here as well would double every backoff.
      socket.addEventListener('error', () => undefined);
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close(1000, 'leaving');
      socketRef.current = null;
    };
  }, [url]);

  /**
   * Persist whatever the reducer decided the token is.
   *
   * The write lives here rather than in `reduce`, which is documented as pure
   * and which React may invoke more than once for the same action. It ran
   * inside the reducer before, above the guard that discards a stale frame —
   * so a late `partner_left` for a finished match cleared the token belonging
   * to the conversation the user was in. Running after the reducer has decided
   * whether an action applies is the ordering that bug needed.
   */
  useEffect(() => {
    saveResumeToken(state.resumeToken ?? '');
  }, [state.resumeToken]);

  /* --- typing ------------------------------------------------------------- */

  const stopTyping = useCallback(() => {
    if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    if (!typingSentRef.current) return;
    typingSentRef.current = false;
    sendCommand('typing', { active: false });
  }, [sendCommand]);

  const typing = useCallback(
    (active: boolean) => {
      if (!state.features.typing) return;
      if (!active) {
        stopTyping();
        return;
      }
      // Sent once per burst and withdrawn on a timer, rather than per
      // keystroke: the server hands the client a `typingPerSecond` limit
      // precisely so it can throttle itself instead of discovering the bucket.
      if (!typingSentRef.current) {
        typingSentRef.current = true;
        sendCommand('typing', { active: true });
      }
      if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(stopTyping, clientConfig.timings.typingIdleMs);
    },
    [sendCommand, state.features.typing, stopTyping],
  );

  /* --- actions ------------------------------------------------------------ */

  /**
   * Enter the queue, carrying whatever this person chose to declare.
   *
   * The profile rides on the join rather than being set once on connect,
   * because joining is the moment matchmaking starts — and it is re-sent every
   * time, because the server keeps nothing between sessions. Sending it means
   * a cleared field is genuinely cleared: there is no partial update to leave
   * a stale value behind.
   */
  const start = useCallback(
    (profile?: Profile, preferences?: MatchPreferences) => {
      const payload: { profile?: Profile; preference?: MatchPreferences } = {};
      if (profile !== undefined) payload.profile = profile;
      // Sent whole, like the profile and for the same reason: a dimension the
      // user cleared has to reach the server as cleared, because there is no
      // partial update and a stale one would keep steering matches.
      if (preferences !== undefined) payload.preference = preferences;
      if (sendCommand('join_queue', payload)) dispatch({ type: 'user_searching' });
    },
    [sendCommand],
  );

  const stop = useCallback(() => {
    sendCommand('leave_queue');
  }, [sendCommand]);

  const skip = useCallback(() => {
    stopTyping();
    if (sendCommand('skip')) dispatch({ type: 'user_skipped' });
  }, [sendCommand, stopTyping]);

  const leave = useCallback(() => {
    stopTyping();
    // Deliberately not `skip` + `leave_queue`: `skip` re-enters the queue and
    // can be matched again before the second frame is read, so the user would
    // land in a new conversation instead of on the landing screen. `leave_chat`
    // ends the match and stops, in one server-side transition.
    if (sendCommand('leave_chat')) {
      dispatch({ type: 'user_left' });
      return;
    }

    // The socket is down. Since a conversation now stays on screen through a
    // reconnect (§28), this is reachable: the back button and the home button
    // are both live during the grace window, and before this they simply did
    // nothing there — a control that ignores a deliberate press is worse than
    // one that is absent.
    //
    // So leave locally. The token goes with it, because reconnecting would
    // otherwise resume straight back into the conversation this person just
    // chose to walk out of. Nothing is told to the server and nothing needs to
    // be: the session's TTL and the janitor end an abandoned match anyway, and
    // the partner sees the same "they left" they would have seen regardless.
    // Leaving offline drops the token directly: there is no server round trip
    // to produce a state change, so nothing else would clear it.
    saveResumeToken('');
    dispatch({ type: 'user_left' });
  }, [sendCommand, stopTyping]);

  const block = useCallback(() => {
    stopTyping();
    if (sendCommand('block')) dispatch({ type: 'user_blocked' });
  }, [sendCommand, stopTyping]);

  const report = useCallback(
    (category: ReportCategory, note?: string) => {
      const payload: Record<string, unknown> = { category };
      if (note && note.trim().length > 0) payload.note = note.trim();
      sendCommand('report', payload);
    },
    [sendCommand],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      stopTyping();

      // The id is generated here and is required on `message` (D24). Resending
      // the identical frame is the retry story: the server refuses the repeat
      // rather than delivering it twice.
      const id = newClientMessageId();
      const at = new Date().toISOString();
      dispatch({ type: 'send_pending', id, text: trimmed, at });
      sendCommand('message', { text: trimmed }, id);
    },
    [sendCommand, stopTyping],
  );

  const dismissNotice = useCallback(() => dispatch({ type: 'dismiss_notice' }), []);

  return { state, start, stop, skip, leave, block, report, send, typing, dismissNotice };
}

/**
 * Map a server frame to an action.
 *
 * Returns null for anything unrecognised — a newer server during a rolling
 * deploy, most likely. Dropping it costs one UI update; throwing would break
 * every frame after it.
 */
export function toAction(frame: AnyServerEnvelope): Action | null {
  switch (frame.type) {
    case 'connected':
      return { type: 'connected', payload: frame.payload };
    case 'queue_status':
      return { type: 'queue_status', payload: frame.payload };
    case 'presence':
      return { type: 'presence', payload: frame.payload };
    case 'matched':
      return { type: 'matched', payload: frame.payload };
    case 'message':
      return { type: 'message', payload: frame.payload };
    case 'message_ack':
      return { type: 'message_ack', payload: frame.payload };
    case 'partner_typing':
      return { type: 'partner_typing', payload: frame.payload };
    case 'partner_reconnecting':
      return {
        type: 'partner_reconnecting',
        matchId: frame.payload.matchId,
        until: frame.payload.until,
      };
    case 'partner_returned':
      return { type: 'partner_returned', matchId: frame.payload.matchId };
    case 'partner_skipped':
    case 'partner_disconnected':
      // The same outcome for the user, and deliberately indistinguishable from
      // a block (security §32).
      return { type: 'partner_left', matchId: frame.payload.matchId };
    case 'report_ack':
      return { type: 'report_ack' };
    case 'error':
      return { type: 'server_error', payload: frame.payload };
    case 'server_shutdown':
      return { type: 'server_shutdown' };
    case 'pong':
      return null;
    default:
      return null;
  }
}
