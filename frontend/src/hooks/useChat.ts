/**
 * The WebSocket client.
 *
 * Owns the socket and nothing else: every frame becomes an action, and the
 * reducer in `state/machine.ts` decides what the screen says. That split is
 * what lets the interesting behaviour be tested without a browser.
 *
 * ---------------------------------------------------------------------------
 * RECONNECTING STARTS A NEW SESSION
 * ---------------------------------------------------------------------------
 * There is no resumption (D7). A dropped connection means the conversation is
 * over, not paused, and this client does not pretend otherwise — it reconnects
 * with backoff and lands on a fresh session. Anything else would need a
 * resumption token, which is a thing to steal.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import {
  BASE_PROTOCOL,
  PROTOCOL_VERSION,
  RESUME_PROTOCOL_PREFIX,
  type AnyServerEnvelope,
  type ClientEventType,
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

/** Client correlation token, and the server's per-match dedupe key (D24). */
function newClientMessageId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface ChatApi {
  readonly state: ChatState;
  start(profile?: Profile): void;
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
        const delay = backoff[Math.min(attemptRef.current, backoff.length - 1)] ?? 10_000;
        attemptRef.current += 1;
        reconnectRef.current = window.setTimeout(connect, delay);
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
    (profile?: Profile) => {
      const payload = profile === undefined ? {} : { profile };
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
    if (sendCommand('leave_chat')) dispatch({ type: 'user_left' });
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
