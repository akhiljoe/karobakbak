/**
 * One attached WebSocket.
 *
 * Owns everything that is true of a *socket* rather than of a session: frame
 * parsing, the strike counter, backpressure, liveness. It never touches Redis
 * and never decides anything about matchmaking — it turns bytes into a
 * validated command and hands it on, then turns an outcome back into bytes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REFUSES TO DO
 * ---------------------------------------------------------------------------
 * It reads no identity from a frame. The session id, IP hash and client hash
 * were bound to the socket at upgrade time and are held here; nothing a client
 * sends can change them, and no inbound field is consulted for routing (rule 3).
 * The only client-supplied value that survives is the envelope `id`, echoed
 * back as a correlation token.
 */
import type { WebSocket } from 'ws';

import type { Config } from '../config';
import type { Logger } from '../logger';
import { encodeError, encodeFrame } from '../protocol/envelope';
import { parseClientFrame, type ValidatedCommand } from '../protocol/validate';
import {
  CLOSE_CODES,
  type ProtocolErrorCode,
  type ServerEnvelope,
  type ServerEventPayloads,
  type ServerEventType,
} from '../protocol/types';
import { serverFrame } from '../protocol/envelope';
import { nowMs } from '../util/time';
import type { Connection } from './registry';

export interface SocketConnectionDeps {
  socket: WebSocket;
  sessionId: string;
  ipHash: string;
  clientHash: string;
  /**
   * The country the CDN resolved for this socket, or null.
   *
   * Held per connection rather than per session because it is a property of
   * where the socket came from, and it is resolved once at the upgrade — the
   * one moment the request headers exist.
   */
  country: string | null;
  /** The signed-in account, resolved at the upgrade. Null on the anonymous path. */
  accountId?: string | null;
  config: Config;
  logger: Logger;
  /** Handle one validated command. Must not throw. */
  onCommand(command: ValidatedCommand, connection: SocketConnection): Promise<void>;
  /** Called exactly once, after the socket is gone. */
  onClose(connection: SocketConnection): Promise<void>;
  /**
   * Observers, for metrics.
   *
   * Callbacks rather than a registry, so this class keeps knowing nothing
   * about Prometheus: it reports what happened and the caller decides whether
   * anything counts it. All optional, and none may throw.
   */
  observe?: {
    /** A frame refused before it became a command. */
    frameRejected(reason: 'unreadable' | 'invalid' | 'oversized'): void;
    /** A transport-level error on this socket. */
    socketError(): void;
    /**
     * Application payload bytes over this socket, for the cost deck.
     *
     * **Not wire bytes.** This is the length of the frame this process handed
     * to or took from `ws`, before WebSocket framing, TLS and TCP headers, and
     * before any compression. Egress is billed on the wire, so this is a floor
     * on the bill rather than the bill — which is the useful direction to be
     * wrong in, and is stated on the metric so nobody reads it as exact.
     */
    bytes(direction: 'in' | 'out', count: number): void;
    /**
     * A declared profile refused during validation (F-038).
     *
     * Separate from `frameRejected` even though the same frame produces both,
     * because they answer different questions. `frameRejected('invalid')` is a
     * protocol-health number; this is a safety number, and pooling them meant
     * the count of people declaring an age below the minimum did not exist —
     * while a comment in the registry described it as a minor-safety input.
     */
    profileRefused(reason: 'age_below_minimum'): void;
  };
}

export class SocketConnection implements Connection {
  readonly sessionId: string;
  readonly ipHash: string;
  readonly clientHash: string;
  readonly country: string | null;

  /**
   * The signed-in account, or null for the anonymous path.
   *
   * Resolved at the upgrade from a presented credential and never from a frame
   * (rule 3): a client that could name its own account would be able to connect
   * itself to somebody it never spoke to.
   *
   * Null is the ordinary case and always will be — chatting never requires an
   * account, and the anonymous path must keep working while sign-in is down
   * (`010_accounts.sql`). Only `save_connection` reads it.
   */
  readonly accountId: string | null;

  private readonly socket: WebSocket;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly deps: SocketConnectionDeps;

  /** Malformed frames seen on this socket (§6.4, TOO_MANY_INVALID_MESSAGES). */
  private strikes = 0;
  private lastPongAt = nowMs();
  private closed = false;
  private cleanedUp = false;

  constructor(deps: SocketConnectionDeps) {
    this.deps = deps;
    this.socket = deps.socket;
    this.sessionId = deps.sessionId;
    this.country = deps.country;
    this.accountId = deps.accountId ?? null;
    this.ipHash = deps.ipHash;
    this.clientHash = deps.clientHash;
    this.config = deps.config;
    this.logger = deps.logger;

    this.socket.on('message', (data, isBinary) => {
      void this.handleFrame(data, isBinary);
    });
    this.socket.on('pong', () => {
      this.lastPongAt = nowMs();
    });
    this.socket.on('close', (code: number) => {
      // `ws` enforces `maxPayload` itself and closes with 1009 before this
      // process ever allocates the payload, so an oversized frame never
      // reaches `handleFrame` and cannot be counted there. The close code is
      // the only place it is observable.
      if (code === CLOSE_CODES.MESSAGE_TOO_BIG) {
        this.deps.observe?.frameRejected('oversized');
      }
      void this.cleanup();
    });
    this.socket.on('error', (err: Error) => {
      // A transport error is ordinary — a client vanishing mid-frame produces
      // one. It is logged at debug and handled by the same cleanup path as a
      // clean close, which is why that path has to be idempotent.
      this.logger.debug('socket error', { sessionId: this.sessionId, errName: err.name });
      this.deps.observe?.socketError();
      void this.cleanup();
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  /**
   * Write one already-encoded frame.
   *
   * Returns false rather than throwing when the socket cannot take it: the
   * caller is usually a transition that has already been committed to Redis,
   * and a failed write must not unwind it.
   */
  send(frame: string): boolean {
    if (!this.isOpen) return false;

    // Backpressure. A client that stops reading — a suspended tab, a dead
    // mobile radio — otherwise turns into unbounded server memory, and one
    // such client per instance is enough to matter.
    if (this.socket.bufferedAmount > this.config.limits.maxBufferedBytes) {
      this.logger.warn('closing a slow consumer', {
        sessionId: this.sessionId,
        bufferedBytes: this.socket.bufferedAmount,
      });
      this.close(CLOSE_CODES.TRY_AGAIN_LATER, 'slow consumer');
      return false;
    }

    this.socket.send(frame);
    // After the write, so a frame refused for backpressure is not counted as
    // egress that never left.
    this.deps.observe?.bytes('out', Buffer.byteLength(frame, 'utf8'));
    return true;
  }

  /** Build, encode and send a server frame. */
  sendEvent<T extends ServerEventType>(type: T, payload: ServerEventPayloads[T]): boolean {
    return this.send(encodeFrame(serverFrame(type, payload) as ServerEnvelope));
  }

  /**
   * Send an error frame. `message` is always a developer-authored constant —
   * never user content, never Redis state, never a stack trace.
   */
  sendError(code: ProtocolErrorCode, message: string): boolean {
    return this.send(encodeError(code, message));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      // Already dead at the transport level; the close handler still runs.
      this.socket.terminate();
    }
  }

  /** Drop the socket without a closing handshake. Used for a client that stopped answering. */
  terminate(): void {
    this.closed = true;
    this.socket.terminate();
  }

  /* --- liveness ----------------------------------------------------------- */

  /**
   * One tick of the liveness sweep. Returns false when the socket has been
   * given up on, so the caller can stop tracking it.
   *
   * The check is "has this client answered *recently*", not "did it answer the
   * last ping": a single dropped pong on a flaky mobile connection is not a
   * reason to end someone's conversation.
   */
  pingOrTimeout(now = nowMs()): boolean {
    if (!this.isOpen) return false;
    if (now - this.lastPongAt > this.config.timers.clientTimeoutMs) {
      this.logger.debug('client stopped answering pings', { sessionId: this.sessionId });
      this.terminate();
      return false;
    }
    this.socket.ping();
    return true;
  }

  /* --- inbound ------------------------------------------------------------ */

  private async handleFrame(data: unknown, isBinary: boolean): Promise<void> {
    const raw = toFrameData(data);
    /*
      Counted before validation, deliberately: a malformed frame still crossed
      the network and still cost bandwidth. Counting only accepted frames would
      understate ingress exactly when somebody is abusing the socket, which is
      when the number matters.

      Both branches, and that is not defensive typing. `ws` delivers a **Buffer**
      unless the socket was created with `{ binary: false }`, so the first
      version of this counted only the string case and reported ingress as a
      flat zero on a stack that was moving 133kB out. A counter that is present,
      plausible and permanently zero is the exact failure `metrics-wiring.test.ts`
      exists for, arriving through a route that test cannot see — it checks that
      something writes the metric, not that the write is reachable.
    */
    if (raw !== null) {
      this.deps.observe?.bytes(
        'in',
        typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength,
      );
    }
    if (raw === null) {
      this.deps.observe?.frameRejected('unreadable');
      this.strike('BAD_ENVELOPE', 'unreadable frame');
      return;
    }

    const parsed = parseClientFrame(raw, isBinary, {
      maxMessageLength: this.config.limits.maxMessageLength,
      maxReportNoteLength: this.config.limits.maxReportNoteLength,
    });

    if (!parsed.ok) {
      this.deps.observe?.frameRejected('invalid');
      // `validateProfile` runs inside `parseClientFrame`, so this is the only
      // place an age refusal is visible to anything that can count it. It is
      // still a protocol strike — ten of these disconnect the socket — and
      // that is deliberate and unchanged; what is new is that it is also
      // counted as the safety signal it is.
      if (parsed.code === 'AGE_BELOW_MINIMUM') {
        this.deps.observe?.profileRefused('age_below_minimum');
      }
      this.strike(parsed.code, parsed.message);
      return;
    }

    try {
      await this.deps.onCommand(parsed.command, this);
    } catch (err) {
      // The handler is supposed to absorb its own failures; if one escapes,
      // the socket survives it. The error is logged by name only — a command
      // can carry message text, and an interpolated error would carry it into
      // the log stream (I8).
      this.logger.error('command handler threw', {
        sessionId: this.sessionId,
        command: parsed.command.type,
        errName: err instanceof Error ? err.name : 'unknown',
      });
      this.sendError('INTERNAL_ERROR', 'the server could not complete that request');
    }
  }

  /**
   * Reject one frame and count it.
   *
   * Content-level rejections (an empty message, an over-long one) count too.
   * A client that cannot construct a valid frame is either broken or probing,
   * and either way the socket is not worth keeping open indefinitely — but the
   * limit is generous enough that a user hammering an over-length message does
   * not get disconnected for it before their client fixes itself.
   */
  private strike(code: ProtocolErrorCode, message: string): void {
    this.strikes += 1;
    this.sendError(code, message);

    if (this.strikes >= this.config.limits.invalidMessageStrikes) {
      this.sendError('TOO_MANY_INVALID_MESSAGES', 'too many invalid frames');
      this.logger.warn('closing a connection for repeated protocol violations', {
        sessionId: this.sessionId,
        strikes: this.strikes,
      });
      this.close(CLOSE_CODES.PROTOCOL_ABUSE, 'protocol abuse');
    }
  }

  /** Runs once, however the socket died (§13). */
  private async cleanup(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.closed = true;
    try {
      await this.deps.onClose(this);
    } catch (err) {
      // Nothing is awaiting this: it runs from a socket event, so a rejection
      // here has nowhere to go but the process's unhandled-rejection handler.
      this.logger.error('session close handler failed', {
        sessionId: this.sessionId,
        errName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}

/**
 * `ws` hands over a Buffer, an ArrayBuffer, or an array of Buffers depending on
 * how the frame arrived. Fragmented frames are the array case, and dropping
 * them would make large legal messages fail intermittently under packet loss.
 */
function toFrameData(data: unknown): Buffer | string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}
