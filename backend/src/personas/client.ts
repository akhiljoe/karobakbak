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
  type ServerFeatures,
  type ServerLimits,
} from '../protocol/types';
import { humanCadence, openingBrevity, splitIntoBubbles } from './cadence';
import type { Cadence } from './cadence';
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

/**
 * How long a persona waits for an answer before moving on.
 *
 * Long enough that somebody typing a considered reply, or reading something
 * else for a minute, is not abandoned mid-thought. Short enough that a persona
 * is not sitting in a conversation that ended twenty minutes ago, holding a
 * queue seat and one of the connections the whole population shares.
 */
const DEFAULT_SILENCE_TIMEOUT_MS = 120_000;

/**
 * Identical messages in a row before a persona decides this is not a person.
 *
 * Deliberately crude, and deliberately not a model call: judging whether the
 * other party is a bot is not worth paying for on every turn, and the only
 * signal cheap enough to be worth acting on is the one a person would notice
 * too — the same words arriving again and again.
 *
 * Three rather than two, because a person genuinely does repeat themselves once
 * when they think a message did not send.
 */
const REPEATS_BEFORE_MOVING_ON = 3;

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/** Why a persona left a conversation of its own accord. A metric label. */
export type MoveOnReason = 'silence' | 'repetition';

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
   * How long the persona spends reading, typing and pausing between bubbles.
   *
   * Not politeness. A reply that arrives faster than a human could read the
   * message is the clearest tell available, and one that arrives whole with no
   * typing indicator is the second — every real client on this server sends
   * `typing` while composing. Injected so tests pin the intervals.
   */
  readonly cadence?: Cadence;
  /**
   * How long to wait for a reply before moving on to somebody else.
   *
   * Zero disables it, which is what the teardown tests run against. Nobody
   * sits in front of a stranger who stopped answering ten minutes ago; a
   * persona that does is holding a queue seat and a connection for nothing.
   */
  readonly silenceTimeoutMs?: number;
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
  | { readonly kind: 'moved_on'; readonly reason: MoveOnReason }
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
  private features: ServerFeatures | null = null;
  private buckets = new Map<string, Bucket>();
  private sentThisConversation = 0;
  private pendingReply: (() => void) | null = null;
  private closedReason: number | null = null;
  private messageCounter = 0;
  private typingActive = false;
  private silenceTimer: (() => void) | null = null;
  private lastIncoming: string | null = null;
  private repeatCount = 0;

  /**
   * Which `speak` run is the current one.
   *
   * A reply is now several waits long — read, type, send, pause, type, send —
   * and a partner can leave during any of them. Bumping this abandons the run
   * in progress at its next checkpoint, which is stronger than cancelling one
   * timer: cancelling the timer a run is sitting on would let it wake and carry
   * straight on to the next bubble.
   */
  private speakGeneration = 0;

  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly cadence: Cadence;
  private readonly silenceTimeoutMs: number;

  constructor(private readonly options: PersonaClientOptions) {
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
    this.cadence = options.cadence ?? humanCadence();
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
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
    this.clearSilenceTimer();
    this.resetRepetition();
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
    this.sentThisConversation = 0;
    this.clearSilenceTimer();
    this.resetRepetition();
    this.state = 'searching';
    return true;
  }

  close(): void {
    this.clearSilenceTimer();
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
        this.features = payload.features;
        this.state = 'idle';
        this.emit({ kind: 'connected', sessionId: payload.sessionId });
        return;
      }

      case 'matched': {
        const payload = envelope.payload as MatchedPayload;
        this.state = 'matched';
        this.sentThisConversation = 0;
        this.resetRepetition();
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

        // They answered, so the clock stops. It is restarted when this persona
        // next finishes speaking, never here — otherwise a persona that chose
        // to stay quiet would keep the conversation alive forever.
        this.clearSilenceTimer();

        if (this.countRepetition(text)) {
          this.moveOn('repetition');
          return;
        }

        await this.speak(text);
        return;
      }

      case 'partner_reconnecting': {
        // The conversation has NOT ended. Nothing sent now is delivered and
        // nothing is buffered (D43), so the only correct behaviour is to wait.
        // The silence clock stops too: a partner whose socket dropped has not
        // gone quiet on us, and timing them out during their grace window would
        // end a conversation the server is still holding open for them.
        this.state = 'partner_away';
        this.clearSilenceTimer();
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
        this.clearSilenceTimer();
        this.resetRepetition();
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
   * Produce and deliver one reply the way a person delivers one.
   *
   * ---------------------------------------------------------------------------
   * THE SHAPE OF A TURN
   * ---------------------------------------------------------------------------
   *   read  ->  [typing on ... typing off, send]  ->  gap  ->  [again]
   *
   * The reading pause runs **concurrently with generation**, not after it. A
   * person starts reading the moment the message lands; waiting for the model
   * first and then pretending to read would add the model's latency on top of a
   * delay that is already long enough, and the stranger would watch nothing
   * happen for the whole of it.
   *
   * The typing indicator is on for exactly the interval the persona is
   * "writing" each bubble and off the rest of the time — including between
   * bubbles, because somebody who has just sent a line is not typing during the
   * beat before the next one.
   *
   * Every wait is a checkpoint. A partner can leave during any of them, and a
   * run that wakes into a conversation that has ended must send nothing: the
   * frame would either be refused or land in whatever conversation holds that
   * session id now.
   */
  private async speak(incoming: string | undefined): Promise<void> {
    const generation = this.speakGeneration + 1;
    this.speakGeneration = generation;

    const turn: VoiceTurn = {
      character: this.options.character,
      sent: this.sentThisConversation,
      ...(incoming === undefined ? {} : { incoming }),
    };

    if (this.options.voice.shouldLeave?.(turn) === true) {
      this.leaveChat();
      return;
    }

    /** Still the current run, and still in a conversation to send into. */
    const live = (): boolean =>
      this.speakGeneration === generation && this.state === 'matched';

    // Reading and thinking happen while the reply is being produced, not after.
    const [, text] = await Promise.all([
      this.sleep(this.cadence.readingPauseMs(incoming)),
      Promise.resolve(this.options.voice.reply(turn)),
    ]);

    if (!live()) return;
    if (text === null || text.trim() === '') return;

    // Short at the start, whatever the voice produced. A stranger who opens
    // with a paragraph is one you stop reading.
    const shaped = openingBrevity(text, this.sentThisConversation);
    const bubbles = splitIntoBubbles(shaped, this.limits?.maxMessageLength);
    if (bubbles.length === 0) return;

    let delivered = 0;

    for (let i = 0; i < bubbles.length; i += 1) {
      const bubble = bubbles[i];
      if (bubble === undefined) continue;

      if (!live()) break;
      this.setTyping(true);
      await this.sleep(this.cadence.typingPauseMs(bubble));

      if (!live()) break;
      // Off *before* the message, so the indicator never outlives the thing it
      // announced — a stranger left watching "typing…" after the message landed
      // is the same tell in the other direction.
      this.setTyping(false);
      this.send('message', { text: bubble, type: 'text' });
      delivered += 1;
      this.emit({ kind: 'sent', length: bubble.length });

      if (i < bubbles.length - 1) {
        await this.sleep(this.cadence.bubbleGapMs());
      }
    }

    this.setTyping(false);

    // One turn, however many bubbles carried it. The voice asks "how far into
    // this conversation am I", and the honest answer counts exchanges: counting
    // frames would make a persona that writes in bursts leave sooner than one
    // that writes in paragraphs, for no reason a person would have.
    if (delivered > 0) this.sentThisConversation += 1;

    // The ball is in their court now, so the clock starts. Only when something
    // was actually said — arming it after a turn this persona chose to sit out
    // would time out a conversation nobody was waiting on.
    if (delivered > 0) this.armSilenceTimer();
  }

  /**
   * Start waiting for an answer.
   *
   * The one place a persona decides something without being told to by a frame.
   * It is time-based, so the voice cannot own it: a voice is only ever asked
   * about a message that arrived, and this is about one that did not.
   */
  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    if (this.silenceTimeoutMs <= 0) return;

    const cancel = this.schedule(() => {
      this.silenceTimer = null;
      if (this.state !== 'matched') return;
      this.moveOn('silence');
    }, this.silenceTimeoutMs);

    this.silenceTimer = cancel;
  }

  private clearSilenceTimer(): void {
    this.silenceTimer?.();
    this.silenceTimer = null;
  }

  /**
   * Leave, and look for somebody else.
   *
   * `skip` rather than `leave_chat`: it ends the match and re-enters the queue
   * in a single frame the server already understands, which is exactly what a
   * person pressing "next" does. `leave_chat` would end the conversation and
   * leave the persona sitting idle, holding a connection and talking to nobody
   * until the supervisor happened to stop it.
   */
  private moveOn(reason: MoveOnReason): void {
    this.clearSilenceTimer();
    this.cancelPendingReply();
    this.setTyping(false);
    this.resetRepetition();
    // Emitted before the frame, so the conversation is closed out even if the
    // local rate-limit mirror refuses the skip.
    this.emit({ kind: 'moved_on', reason });
    this.skip();
  }

  /**
   * Count identical messages in a row, and say whether that is now too many.
   *
   * Whitespace and case are ignored, because a bot that varies neither is still
   * a bot and a person who does is still saying the same thing.
   */
  private countRepetition(text: string): boolean {
    const normalised = text.trim().toLowerCase();
    if (normalised === '') return false;

    if (normalised === this.lastIncoming) {
      this.repeatCount += 1;
    } else {
      this.lastIncoming = normalised;
      this.repeatCount = 1;
    }

    return this.repeatCount >= REPEATS_BEFORE_MOVING_ON;
  }

  private resetRepetition(): void {
    this.lastIncoming = null;
    this.repeatCount = 0;
  }

  /**
   * Wait, cancellably.
   *
   * Resolving on cancel rather than rejecting keeps `speak` free of a rejection
   * path that would have to be swallowed at each of its await points; the
   * generation check after every wait is what decides whether to carry on.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = this.schedule(() => {
        this.pendingReply = null;
        resolve();
      }, ms);

      this.pendingReply = () => {
        cancel();
        this.pendingReply = null;
        resolve();
      };
    });
  }

  /**
   * Announce, or stop announcing, that this persona is writing.
   *
   * Idempotent, because the transitions are driven from several places and a
   * repeated `typing: true` would spend a token from a bucket the server
   * publishes precisely so that clients can avoid being limited. Skipped
   * entirely when the server says the feature is off — being refused costs a
   * round trip and tells the persona nothing it did not already know.
   */
  private setTyping(active: boolean): void {
    if (this.typingActive === active) return;
    if (this.features !== null && !this.features.typing) return;
    if (active && this.state !== 'matched') return;
    this.typingActive = active;
    this.send('typing', { active });
  }

  /**
   * Abandon whatever this persona was in the middle of saying.
   *
   * Bumps the generation as well as cancelling the wait, because a cancelled
   * wait *resolves* — and a run that resolved out of its reading pause would
   * otherwise walk straight on into sending its first bubble.
   */
  private cancelPendingReply(): void {
    this.speakGeneration += 1;
    // No frame: the match is over, or the partner is not there to see it. The
    // flag is cleared so the next conversation starts from a known state.
    this.typingActive = false;
    this.pendingReply?.();
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
