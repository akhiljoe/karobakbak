/**
 * One persona, as a WebSocket client (D-AI-6).
 *
 * ---------------------------------------------------------------------------
 * WHY A CLIENT AND NOT A BRANCH IN MATCHMAKING
 * ---------------------------------------------------------------------------
 * A persona opens a real socket, joins a real queue and is matched by the
 * ordinary path. There is no AI branch in `tryMatch`, no new Lua, and no
 * "virtual peer" concept anywhere in the server.
 *
 * The reason is not elegance. `tryMatch` is the most race-tested code in this
 * repository and its reply is parsed positionally; widening it means
 * re-verifying every matchmaking race for a feature that has not shipped. As a
 * client, a persona inherits every invariant for free — server authority,
 * blocks, bans, rate limits, moderation, retention — and if this whole
 * subsystem dies, chat is unaffected. That is D16's principle applied to a
 * second dependency.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `load-test/swarm/src/bot.ts`
 * ---------------------------------------------------------------------------
 * The plan said "built on bot.ts", and that was wrong about the file while
 * right about the approach. `bot.ts` is 1,266 lines and imports `Ledger`,
 * `Corpus` and `campaignView`. Importing it here would make the load test a
 * production dependency and put chaos-injection code on the path a real user
 * talks to.
 *
 * What is taken from it is the behaviour it learned the expensive way:
 *
 *  - **Mirror the server's rate limits locally.** Some are published in
 *    `connected`; the ones that matter most are not. `join_queue` refills one
 *    token per five seconds with a burst of five, and a client that ignores
 *    that spends its life being refused.
 *  - **`partner_reconnecting` is not a goodbye.** The conversation has not
 *    ended, nothing sent now is delivered, and nothing is buffered (D43). The
 *    correct response is to wait, exactly as the real client's disabled
 *    composer makes a person wait.
 *  - **Never assume frame order.** `matched` can arrive before the `join_queue`
 *    ack is processed, and a partner can leave between two of your own frames.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not decide what to say. Replies come from a `PersonaVoice`, which in
 * A2 is scripted and in A4 becomes the model. Keeping the socket and the speech
 * apart is what lets A5 put the safety limits between them — a limit that lives
 * inside the thing generating text is a limit the thing generating text can
 * talk its way around.
 */

import { WebSocket, type RawData } from 'ws';
import {
  BASE_PROTOCOL,
  PROTOCOL_VERSION,
  type AnyServerEnvelope,
  type ClientEnvelope,
  type ClientEventType,
  type ConnectedPayload,
  type IncomingMessagePayload,
  type MatchedPayload,
  type Profile,
  type ServerLimits,
} from '../protocol/types';
import type { PersonaCharacter } from './types';

/* -------------------------------------------------------------------------- */
/* What the persona says                                                      */
/* -------------------------------------------------------------------------- */

export interface VoiceTurn {
  /** What the partner just said. Absent when opening the conversation. */
  readonly incoming?: string;
  readonly character: PersonaCharacter;
  /** How many messages this persona has already sent in this conversation. */
  readonly sent: number;
}

/**
 * The source of replies.
 *
 * A2 ships a scripted implementation and A4 replaces it with the model. The
 * seam is deliberate: everything in this file is about sockets and none of it
 * is about language, so the two can be tested and reasoned about separately.
 *
 * Returning `null` means "say nothing" — a real person often does, and a client
 * that must produce a reply to every message is a client that reads as a bot.
 */
export interface PersonaVoice {
  /** A reply, or null to stay quiet. */
  reply(turn: VoiceTurn): Promise<string | null> | string | null;
  /** Whether to end the conversation now. */
  shouldLeave?(turn: VoiceTurn): boolean;
}

/* -------------------------------------------------------------------------- */
/* Local rate-limit mirror                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The limits the server enforces but does not publish in `connected`.
 *
 * Copied from what the swarm measured against the running server rather than
 * from the config, because the config is not what a client can see. If the
 * server's limits change, this drifts silently and the symptom is a persona
 * that is refused rather than one that crashes — which is why
 * `chat_persona_fill_suppressed_total` exists to make it visible.
 */
const UNPUBLISHED_LIMITS: Readonly<Record<string, { perSecond: number; burst: number }>> = {
  join_queue: { perSecond: 0.2, burst: 5 },
  leave_queue: { perSecond: 0.333, burst: 6 },
  leave_chat: { perSecond: 0.333, burst: 6 },
  skip: { perSecond: 0.333, burst: 6 },
};

/** One token bucket, mirroring the server's. Deliberately slightly pessimistic. */
class Bucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, (now - this.last) / 1000);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export type PersonaClientState =
  | 'connecting'
  | 'idle'
  | 'searching'
  | 'matched'
  | 'partner_away'
  | 'closed';

export interface PersonaClientOptions {
  readonly url: string;
  readonly origin: string;
  readonly character: PersonaCharacter;
  /** Generated per conversation (D-AI-3) and re-declared on every join. */
  readonly profile: Profile;
  readonly voice: PersonaVoice;
  /** Injected so tests do not sleep. */
  readonly now?: () => number;
  /** Injected so tests do not wait. Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Delay before a reply, so a persona does not answer in 8ms.
   *
   * Not politeness — a reply that arrives faster than a human could read the
   * message is the single clearest tell available, and it costs nothing to fix.
   */
  readonly replyDelayMs?: (text: string) => number;
  readonly onEvent?: (event: PersonaClientEvent) => void;
}

export type PersonaClientEvent =
  | { readonly kind: 'connected'; readonly sessionId: string }
  | { readonly kind: 'matched'; readonly matchId: string }
  | { readonly kind: 'sent'; readonly length: number }
  | { readonly kind: 'received'; readonly length: number }
  | { readonly kind: 'partner_away' }
  | { readonly kind: 'partner_back' }
  | { readonly kind: 'partner_gone'; readonly reason: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'closed'; readonly code: number };

/**
 * A persona's socket.
 *
 * Deliberately has no reconnect loop. A dropped persona is not worth resuming:
 * the surface is regenerated per conversation anyway (D-AI-3), so "the same
 * persona coming back" is not a thing that exists. The supervisor in A3 decides
 * whether to dispatch another one, which keeps the decision in the place that
 * knows about budgets and caps.
 */
export class PersonaClient {
  private socket: WebSocket | null = null;
  private state: PersonaClientState = 'connecting';
  private sessionId: string | null = null;
  private limits: ServerLimits | null = null;
  private buckets = new Map<string, Bucket>();
  private sentThisConversation = 0;
  private pendingReply: (() => void) | null = null;
  private closedReason: number | null = null;
  private messageCounter = 0;

  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly replyDelayMs: (text: string) => number;

  constructor(private readonly options: PersonaClientOptions) {
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
    this.replyDelayMs = options.replyDelayMs ?? defaultReplyDelay;
  }

  currentState(): PersonaClientState {
    return this.state;
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Open the socket. Resolves once `connected` has arrived. */
  connect(socket?: WebSocket): Promise<void> {
    const ws =
      socket ??
      new WebSocket(this.options.url, [BASE_PROTOCOL], { origin: this.options.origin });
    this.socket = ws;

    return new Promise((resolve, reject) => {
      const onConnected = (event: PersonaClientEvent): void => {
        if (event.kind === 'connected') resolve();
      };
      this.extraListener = onConnected;

      ws.on('message', (data: RawData) => {
        this.onFrame(data);
      });
      ws.on('close', (code: number) => {
        this.state = 'closed';
        this.closedReason = code;
        this.emit({ kind: 'closed', code });
      });
      ws.on('error', (err: Error) => {
        this.state = 'closed';
        reject(err);
      });
    });
  }

  private extraListener: ((event: PersonaClientEvent) => void) | null = null;

  /**
   * Enter the queue.
   *
   * The profile rides on the join, which is the whole of D-AI-3's cheapness:
   * a persona declares its generated surface through the same field a real user
   * uses, and the server keeps nothing between sessions (D34).
   */
  joinQueue(): boolean {
    if (!this.allow('join_queue')) return false;
    this.sentThisConversation = 0;
    this.send('join_queue', { profile: this.options.profile });
    this.state = 'searching';
    return true;
  }

  /** Leave the current conversation without searching again. */
  leaveChat(): boolean {
    if (!this.allow('leave_chat')) return false;
    this.send('leave_chat', {});
    this.state = 'idle';
    return true;
  }

  skip(): boolean {
    if (!this.allow('skip')) return false;
    this.send('skip', {});
    this.state = 'searching';
    return true;
  }

  close(): void {
    this.cancelPendingReply();
    this.socket?.close(1000);
    this.state = 'closed';
  }

  /** Exposed for tests: feed a frame as if it arrived on the socket. */
  onFrame(data: RawData | string): void {
    let envelope: AnyServerEnvelope;
    try {
      const raw = typeof data === 'string' ? data : data.toString();
      envelope = JSON.parse(raw) as AnyServerEnvelope;
    } catch {
      // A frame we cannot parse is the server's problem or a proxy's. There is
      // nothing useful to do and nothing safe to log — the payload may contain
      // message content (I8).
      return;
    }
    void this.handle(envelope);
  }

  private async handle(envelope: AnyServerEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'connected': {
        const payload = envelope.payload as ConnectedPayload;
        this.sessionId = payload.sessionId;
        this.limits = payload.limits;
        this.state = 'idle';
        this.emit({ kind: 'connected', sessionId: payload.sessionId });
        return;
      }

      case 'matched': {
        const payload = envelope.payload as MatchedPayload;
        this.state = 'matched';
        this.sentThisConversation = 0;
        this.emit({ kind: 'matched', matchId: payload.matchId });
        // Opening line. A persona that waits for the stranger to speak first is
        // realistic but produces a lot of dead matches, so it opens.
        await this.speak(undefined);
        return;
      }

      case 'message': {
        const payload = envelope.payload as IncomingMessagePayload;
        const text = typeof payload.text === 'string' ? payload.text : '';
        this.emit({ kind: 'received', length: text.length });
        // Only reply while genuinely matched. A message can arrive after a
        // teardown began, and answering it would send into a match that is over.
        if (this.state !== 'matched') return;
        await this.speak(text);
        return;
      }

      case 'partner_reconnecting': {
        // The conversation has NOT ended. Nothing sent now is delivered and
        // nothing is buffered (D43), so the only correct behaviour is to wait.
        this.state = 'partner_away';
        this.cancelPendingReply();
        this.emit({ kind: 'partner_away' });
        return;
      }

      case 'partner_returned': {
        this.state = 'matched';
        this.emit({ kind: 'partner_back' });
        return;
      }

      case 'partner_skipped':
      case 'partner_disconnected': {
        this.state = 'idle';
        this.cancelPendingReply();
        this.emit({ kind: 'partner_gone', reason: envelope.type });
        return;
      }

      case 'error': {
        const payload = envelope.payload as { code?: string };
        this.emit({ kind: 'refused', code: payload.code ?? 'UNKNOWN' });
        return;
      }

      default:
        // Every other server event — queue_status, presence, typing acks,
        // message_ack — is either informational or handled by the supervisor.
        return;
    }
  }

  /**
   * Produce and send one reply, after a human-plausible pause.
   *
   * The pause is cancellable, because a partner can leave or drop during it and
   * sending afterwards would either fail or land in the wrong conversation.
   */
  private async speak(incoming: string | undefined): Promise<void> {
    const turn: VoiceTurn = {
      character: this.options.character,
      sent: this.sentThisConversation,
      ...(incoming === undefined ? {} : { incoming }),
    };

    if (this.options.voice.shouldLeave?.(turn) === true) {
      this.leaveChat();
      return;
    }

    const text = await this.options.voice.reply(turn);
    if (text === null || text.trim() === '') return;

    const capped = this.capToServerLimit(text);

    await new Promise<void>((resolve) => {
      const cancel = this.schedule(() => {
        this.pendingReply = null;
        // Re-check: the pause is where a partner leaves.
        if (this.state === 'matched') {
          this.send('message', { text: capped, type: 'text' });
          this.sentThisConversation += 1;
          this.emit({ kind: 'sent', length: capped.length });
        }
        resolve();
      }, this.replyDelayMs(capped));

      this.pendingReply = () => {
        cancel();
        this.pendingReply = null;
        resolve();
      };
    });
  }

  private cancelPendingReply(): void {
    this.pendingReply?.();
  }

  /**
   * Never send more than the server accepts.
   *
   * Being refused for length is a wasted round trip and, worse, a wasted model
   * call — the text has already been paid for by the time it is rejected.
   */
  private capToServerLimit(text: string): string {
    const max = this.limits?.maxMessageLength;
    if (max === undefined || text.length <= max) return text;
    return text.slice(0, max);
  }

  private allow(command: ClientEventType): boolean {
    const spec = UNPUBLISHED_LIMITS[command];
    if (spec === undefined) return true;

    let bucket = this.buckets.get(command);
    if (bucket === undefined) {
      bucket = new Bucket(spec.perSecond, spec.burst, this.now());
      this.buckets.set(command, bucket);
    }
    return bucket.take(this.now());
  }

  /**
   * Serialise and write one frame.
   *
   * `message` carries an envelope `id` and nothing else does. It is the replay
   * token the server deduplicates on per match (D24), and the server refuses a
   * `message` without one — a refusal that costs a round trip and, once A4 is
   * behind this seam, a model call already paid for.
   *
   * It is the only client-supplied field that survives: the server echoes it
   * back in `message_ack.clientMsgId` and reads identity, routing and ordering
   * from its own state.
   */
  private send<T extends ClientEventType>(type: T, payload: unknown): void {
    const envelope: ClientEnvelope = {
      type,
      version: PROTOCOL_VERSION,
      payload,
    } as ClientEnvelope;

    if (type === 'message') envelope.id = this.nextClientMessageId();

    this.socket?.send(JSON.stringify(envelope));
  }

  /**
   * A correlation token matching `CLIENT_ID_PATTERN`.
   *
   * Counter plus randomness: the counter keeps ids distinct within one socket
   * even if two are minted in the same millisecond, and the random suffix keeps
   * them distinct across the population, since every persona starts its counter
   * at zero.
   */
  private nextClientMessageId(): string {
    this.messageCounter += 1;
    const suffix = Math.floor(Math.random() * 0xffffff).toString(36);
    return `p${this.messageCounter}-${suffix}`;
  }

  private emit(event: PersonaClientEvent): void {
    this.options.onEvent?.(event);
    this.extraListener?.(event);
  }

  /** Exposed for tests: what the socket has been closed with, if anything. */
  closeCode(): number | null {
    return this.closedReason;
  }
}

/**
 * How long to wait before replying.
 *
 * Roughly reading time plus typing time, floored so a one-word answer is not
 * instant and capped so a long one does not stall the conversation. The numbers
 * are not precise about human behaviour and do not need to be — the failure
 * being avoided is a reply in 8ms, which no pause in this range resembles.
 */
export function defaultReplyDelay(text: string): number {
  const typingMs = text.length * 45;
  return Math.min(9000, Math.max(1200, 600 + typingMs));
}
