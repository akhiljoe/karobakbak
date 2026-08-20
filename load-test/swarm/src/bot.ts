/**
 * One simulated person.
 *
 * The bot owns the socket, the protocol, the session state and the ledger
 * writes. It owns no behaviour: what to say, when to skip and when to leave
 * comes from a `Persona`, which is handed events and given a small API to act
 * on. That split is what lets forty scenarios share one carefully written
 * protocol client instead of forty half-written ones.
 *
 * ---------------------------------------------------------------------------
 * THE LOCAL RATE-LIMIT MIRROR
 * ---------------------------------------------------------------------------
 * The server's buckets are small and deliberate — `skip` refills at a third of
 * a token per second. A persona that skips whenever it feels like it will
 * spend a run being refused, and the run will have measured the token bucket
 * rather than the product.
 *
 * So the bot keeps a mirror of the server's buckets, filled from the limits in
 * `connected` where the server publishes them, and a persona asks `canSend`
 * before acting. The mirror is advisory and intentionally slightly pessimistic:
 * it prevents *accidental* throttling without preventing deliberate throttling,
 * because the personas that exist to trip a limiter simply bypass it.
 *
 * A `RATE_LIMITED` error is therefore a fact about the run, not a harness bug,
 * and it is recorded either way.
 */
import { WebSocket, type RawData } from 'ws';
import type {
  AnyServerEnvelope,
  ClientEventType,
  ConnectedPayload,
  IncomingMessagePayload,
  MatchedPayload,
  MessageAckPayload,
  ReportCategory,
  ServerLimits,
  SessionState,
} from '../../../backend/src/protocol/types';
import { moderationView } from '../../../backend/src/moderation/normalise';
import { campaignView } from './campaign';
import { contentHash, type Ledger, type LedgerEvent } from './ledger';
import { CLIENT_TOKEN_COOKIE, readClientToken } from './identity';
import type { Rng } from './rng';
import type { Corpus } from './corpus';

/* -------------------------------------------------------------------------- */
/* Persona interface                                                          */
/* -------------------------------------------------------------------------- */

export interface Persona {
  /** Scenario id from `docs/LOADTEST-SCENARIOS.md`, e.g. `N1`. */
  readonly scenario: string;
  readonly label: string;
  /**
   * Ground truth, declared before the run rather than inferred after it.
   *
   * A detection question only has an answer if the answer key exists first.
   * `spammer` marks a bot whose behaviour a serial-spam detector should catch;
   * `abusive` marks one that should attract reports; `benign` is stated
   * explicitly rather than left implicit, because "everything unlabelled is
   * innocent" is the assumption that turns a false positive into a silent one.
   */
  readonly labels?: readonly string[];
  /** The socket is up and the server has published its limits. */
  onConnected?(bot: Bot): void;
  onMatched?(bot: Bot, payload: MatchedPayload): void;
  onPartnerMessage?(bot: Bot, payload: IncomingMessagePayload): void;
  onAck?(bot: Bot, payload: MessageAckPayload): void;
  /** The partner skipped, disconnected, or the match otherwise ended. */
  onPartnerGone?(bot: Bot, reason: 'skipped' | 'disconnected'): void;
  /** A protocol error arrived. The bot has already recorded it. */
  onError?(bot: Bot, code: string, retryable: boolean): void;
  /** The socket closed. A persona may ask the bot to reconnect. */
  onClosed?(bot: Bot, code: number): void;
}

export interface BotSpec {
  readonly index: number;
  readonly id: string;
  readonly scenario: string;
  /** The address this bot claims through `X-Forwarded-For`. */
  readonly address: string;
  /** Ground-truth label, used by the spam oracles. Empty for ordinary bots. */
  readonly labels: readonly string[];
}

export interface BotDeps {
  readonly url: string;
  readonly origin: string;
  readonly rng: Rng;
  readonly corpus: Corpus;
  readonly ledger: Ledger;
  readonly persona: Persona;
  /** Called when the bot has stopped for good, so the worker can count down. */
  readonly onFinished: (bot: Bot) => void;
}

/* -------------------------------------------------------------------------- */
/* Token bucket mirror                                                        */
/* -------------------------------------------------------------------------- */

class Bucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  /** Take one token if there is one. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until a token is available. 0 when one already is. */
  waitMs(): number {
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
  }
}

/**
 * The server's own defaults, used until `connected` says otherwise. Only the
 * commands whose limits the server does not publish need to be guessed; the
 * message and typing rates come from the wire.
 */
const UNPUBLISHED_LIMITS: Record<string, { perSecond: number; burst: number }> = {
  join_queue: { perSecond: 0.2, burst: 5 },
  leave_queue: { perSecond: 0.333, burst: 6 },
  leave_chat: { perSecond: 0.333, burst: 6 },
  skip: { perSecond: 0.333, burst: 6 },
  report: { perSecond: 0.00278, burst: 3 },
  block: { perSecond: 0.00556, burst: 3 },
};

/* -------------------------------------------------------------------------- */
/* Bot                                                                        */
/* -------------------------------------------------------------------------- */

export class Bot {
  readonly spec: BotSpec;
  readonly rng: Rng;
  readonly corpus: Corpus;
  readonly persona: Persona;

  /** Server-authoritative as far as this bot can observe it. */
  state: SessionState = 'IDLE';
  matchId: string | null = null;
  sessionId: string | null = null;
  limits: ServerLimits | null = null;

  /** Messages this bot has sent inside the current match. */
  turnsSent = 0;
  /** Messages the partner has sent inside the current match. */
  turnsReceived = 0;
  /** When the current match started, for think-time and duration decisions. */
  matchedAt = 0;

  private socket: WebSocket | null = null;
  private clientToken: string | null = null;
  private readonly deps: BotDeps;
  private readonly buckets = new Map<string, Bucket>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /**
   * Messages sent and not yet acked, by correlation id.
   *
   * **Deliberately not cleared when a match ends.** An ack can legitimately
   * arrive after this bot has skipped: the server accepted and delivered the
   * message, and the teardown raced the acknowledgement. Clearing here loses
   * the hash, the ack is recorded without one, and the pair oracle then reports
   * that the partner "received a message the sender was never acked for" — a
   * delivery bug that is entirely the harness forgetting what it sent.
   *
   * Trimmed by age instead, so a long-lived bot cannot grow this without bound.
   */
  private readonly pending = new Map<string, { at: number; hash: string }>();
  private readonly memo = new Map<string, number>();
  /** Lifetime markers, unlike `memo` which is cleared at every match boundary. */
  private readonly flags = new Set<string>();
  private seq = 0;
  private queuedAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  private finished = false;
  /** Set by `stopHard` so the close handler knows a reset was deliberate. */
  private hardStop = false;
  /** Set by `goSilent`: every outbound frame is dropped from here on. */
  private silent = false;
  /**
   * A block waiting for the server's answer.
   *
   * `block` has no acknowledgement of its own: success arrives as a
   * `queue_status` putting this session in IDLE, and failure as a `NOT_MATCHED`
   * error. Neither carries a correlation id, so the two are attributed to the
   * most recent block within a short window — which is sound because a bot
   * issues at most one block per conversation and the window is far longer than
   * any round trip this server produces.
   */
  private pendingBlock: { matchId: string; at: number } | null = null;

  constructor(spec: BotSpec, deps: BotDeps) {
    this.spec = spec;
    this.deps = deps;
    this.rng = deps.rng;
    this.corpus = deps.corpus;
    this.persona = deps.persona;
    for (const [command, limit] of Object.entries(UNPUBLISHED_LIMITS)) {
      this.buckets.set(command, new Bucket(limit.perSecond, limit.burst));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  connect(): void {
    if (this.stopped) return;
    // A reconnect is a new socket and a new session; whatever made the old one
    // go quiet does not follow it.
    this.silent = false;
    this.record({ type: 'connect_attempt' });

    const headers: Record<string, string> = {
      // Counting from the right with two trusted hops, nginx appends the real
      // peer and the backend selects this entry. See identity.ts.
      'X-Forwarded-For': this.spec.address,
      Origin: this.deps.origin,
    };
    if (this.clientToken) {
      headers['Cookie'] = `${CLIENT_TOKEN_COOKIE}=${this.clientToken}`;
    }

    const socket = new WebSocket(this.deps.url, { headers, handshakeTimeout: 20_000 });
    this.socket = socket;

    socket.on('upgrade', (response) => {
      const token = readClientToken(response.headers['set-cookie']);
      if (token) this.clientToken = token;
    });

    socket.on('unexpected-response', (_request, response) => {
      this.record({ type: 'connect_refused', code: response.statusCode ?? 0 });
      response.resume();
      this.socket = null;
      this.finish();
    });

    socket.on('message', (raw) => this.onFrame(raw));

    socket.on('error', () => {
      // Transport errors always precede a `close`; the close handler owns the
      // bookkeeping so an error and a close cannot both finish the bot.
    });

    socket.on('close', (code) => {
      this.socket = null;
      this.clearTimers();
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.state = 'IDLE';
      this.matchId = null;
      this.record({ type: 'closed', code, reason: this.hardStop ? 'harness_stop' : 'server' });
      this.hardStop = false;
      if (this.stopped) {
        this.finish();
        return;
      }
      this.persona.onClosed?.(this, code);
      // A persona that did not ask to reconnect is done.
      if (!this.socket) this.finish();
    });
  }

  /** Close cleanly, the way a browser tab does. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000);
    } else {
      this.finish();
    }
  }

  /**
   * Destroy the socket without a close frame — a rage quit, a dead phone, a
   * killed process. The server must recover through TTL and the janitor rather
   * than through a close handler, which is the whole point of L2.
   */
  stopHard(): void {
    this.stopped = true;
    this.hardStop = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.terminate();
    } else {
      this.finish();
    }
  }

  /**
   * Drop the socket and open a new one, keeping the cookie and the address.
   *
   * `hard` destroys the socket without a close frame — the server has to
   * *notice*, through the heartbeat and the TTL, rather than being told. That
   * is a different code path from a clean close and it is the one that decides
   * how long a partner waits, so both are available and personas choose.
   */
  reconnect(afterMs: number, mode: 'hard' | 'clean' = 'hard'): void {
    if (this.stopped) return;
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.state = 'IDLE';
    this.matchId = null;
    if (socket) {
      if (mode === 'clean' && socket.readyState === WebSocket.OPEN) socket.close(1000);
      else socket.terminate();
    }
    // Timers were cleared above, so this one is registered afterwards on
    // purpose: it is the only thing that must survive the teardown.
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) this.connect();
    }, afterMs);
    this.timers.add(timer);
  }

  /**
   * Stop sending anything at all, including pings, while leaving the socket
   * open — a phone in a pocket, a laptop lid closed.
   *
   * The session must then expire at its TTL. Nothing else in the harness
   * exercises that path, because every other bot keeps its heartbeat alive.
   */
  goSilent(): void {
    this.clearTimers();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.silent = true;
  }

  /**
   * Discard the block token, so the next connection is a new client identity
   * on that dimension while keeping the same address on the other.
   */
  forgetClientToken(): void {
    this.clientToken = null;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.onFinished(this);
  }

  /* ---------------------------------------------------------------------- */
  /* Timers — owned here so a state change cannot leave one running          */
  /* ---------------------------------------------------------------------- */

  after(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      try {
        fn();
      } catch (error) {
        this.record({
          type: 'harness_error',
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  cancel(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * A number decided once per match and remembered for its duration — "how
   * many turns will I stay for", "am I in the mood to talk".
   *
   * Personas are event handlers with no place to keep state, and recomputing a
   * conversation's length on every inbound message produces a bot that never
   * reaches its own ending. Cleared when the match ends, so the next
   * conversation gets its own draw.
   */
  matchMemo(key: string, compute: () => number): number {
    const existing = this.memo.get(key);
    if (existing !== undefined) return existing;
    const value = compute();
    this.memo.set(key, value);
    return value;
  }

  /**
   * A once-per-lifetime marker, surviving matches and reconnects.
   *
   * The counterpart to `matchMemo`. Some behaviour must happen once per person
   * rather than once per conversation — probing a limit, losing a cookie — and
   * the difference is not cosmetic: a probe repeated every match accumulates
   * protocol strikes and gets the bot disconnected as an abuser, which is the
   * server behaving correctly and the persona being wrong.
   */
  flag(name: string): boolean {
    return this.flags.has(name);
  }

  setFlag(name: string): void {
    this.flags.add(name);
  }

  /** Whether the local mirror believes this command would be accepted. */
  canSend(command: ClientEventType): boolean {
    const bucket = this.buckets.get(command);
    return bucket ? bucket.waitMs() === 0 : true;
  }

  /** Milliseconds a persona should wait before retrying a command. */
  waitFor(command: ClientEventType): number {
    return this.buckets.get(command)?.waitMs() ?? 0;
  }

  joinQueue(): void {
    if (!this.spend('join_queue')) return;
    this.queuedAt = Date.now();
    this.state = 'SEARCHING';
    this.send('join_queue', {});
    this.record({ type: 'queued' });
  }

  leaveQueue(): void {
    if (!this.spend('leave_queue')) return;
    this.state = 'IDLE';
    this.send('leave_queue', {});
    this.record({ type: 'left_queue' });
  }

  /**
   * `force` bypasses the local bucket mirror, not the server's.
   *
   * The mirror exists so an ordinary persona is never throttled by accident.
   * The A group's whole purpose is to find out what happens at and past the
   * limit, so those personas opt out of the mirror and take the server's answer
   * — which is the measurement.
   */
  skip(options: { force?: boolean } = {}): void {
    if (!options.force && !this.spend('skip')) return;
    const previous = this.matchId;
    this.endMatchLocally();
    this.queuedAt = Date.now();
    this.state = 'SEARCHING';
    this.send('skip', {});
    this.record({ type: 'skipped', matchId: previous ?? undefined });
  }

  leaveChat(): void {
    if (!this.spend('leave_chat')) return;
    const previous = this.matchId;
    this.endMatchLocally();
    this.state = 'IDLE';
    this.send('leave_chat', {});
    this.record({ type: 'left_chat', matchId: previous ?? undefined });
  }

  block(options: { force?: boolean } = {}): void {
    if (!options.force && !this.spend('block')) return;
    const previous = this.matchId;
    this.endMatchLocally();
    this.state = 'IDLE';
    this.send('block', {});
    this.record({ type: 'blocked', matchId: previous ?? undefined });
    if (previous) this.pendingBlock = { matchId: previous, at: Date.now() };
  }

  report(category: ReportCategory, note?: string, options: { force?: boolean } = {}): void {
    if (!options.force && !this.spend('report')) return;
    this.send('report', note === undefined ? { category } : { category, note });
    this.record({ type: 'reported', matchId: this.matchId ?? undefined, reason: category });
  }

  typing(active: boolean): void {
    if (!this.spend('typing')) return;
    this.send('typing', { active });
  }

  ping(): void {
    this.send('ping', {});
  }

  /**
   * Send one message. Returns the correlation id, or null when the local
   * mirror refused — a persona that wants to flood past the limit calls
   * `sendRaw` instead.
   */
  say(text: string): string | null {
    if (!this.spend('message')) return null;
    return this.sendMessage(text);
  }

  /** Send a message ignoring the local mirror. For the personas that mean it. */
  sayRegardless(text: string): string {
    return this.sendMessage(text);
  }

  private sendMessage(text: string): string {
    // The server trims before it stores and delivers (`validate.ts`), so a bot
    // that sends padded text hashes something the partner can never receive,
    // and the pair-reconstruction oracle reports a delivery bug that is
    // entirely the harness's own. Trimming here makes the sender's hash and the
    // receiver's hash comparable by construction; the harness_error makes the
    // persona that needed it loud rather than silently corrected.
    const trimmed = text.trim();
    if (trimmed !== text) {
      this.record({ type: 'harness_error', reason: 'untrimmed_message_text' });
    }
    const cid = `c${this.spec.index.toString(36)}_${(this.seq += 1).toString(36)}`;
    const hash = contentHash(trimmed);
    // The same text as the moderation pipeline sees it. Two hashes rather than
    // one is the entire point of the A2/A11 scenarios: an exact hash groups a
    // copy-paste campaign and nothing else, while the normalised view survives
    // the cheapest evasions there are. The gap between what the two detect is
    // the finding, and it cannot be measured with only one of them.
    const nhash = contentHash(moderationView(trimmed));
    const chash = contentHash(campaignView(trimmed));
    this.pending.set(cid, { at: Date.now(), hash });
    this.record({
      type: 'sent',
      matchId: this.matchId ?? undefined,
      cid,
      hash,
      nhash,
      chash,
      chars: [...trimmed].length,
      seq: this.seq,
    });
    this.sendEnvelope('message', { text: trimmed }, cid);
    return cid;
  }

  /* ---------------------------------------------------------------------- */
  /* Wire                                                                   */
  /* ---------------------------------------------------------------------- */

  private spend(command: string): boolean {
    const bucket = this.buckets.get(command);
    if (!bucket) return true;
    return bucket.take();
  }

  private send(type: ClientEventType, payload: unknown): void {
    this.sendEnvelope(type, payload, undefined);
  }

  private sendEnvelope(type: ClientEventType, payload: unknown, id: string | undefined): void {
    const socket = this.socket;
    if (this.silent) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const frame =
      id === undefined
        ? { type, version: 1, payload }
        : { type, version: 1, id, payload };
    socket.send(JSON.stringify(frame));
  }

  private onFrame(raw: RawData): void {
    let frame: AnyServerEnvelope;
    try {
      frame = JSON.parse(raw.toString()) as AnyServerEnvelope;
    } catch {
      this.record({ type: 'harness_error', reason: 'server_sent_bad_json' });
      return;
    }

    switch (frame.type) {
      case 'connected':
        this.onConnected(frame.payload);
        break;

      case 'matched':
        this.onMatched(frame.payload);
        break;

      case 'message':
        this.onIncoming(frame.payload);
        break;

      case 'message_ack':
        this.onAck(frame.payload);
        break;

      case 'partner_skipped':
        this.onPartnerGone('skipped');
        break;

      case 'partner_disconnected':
        this.onPartnerGone('disconnected');
        break;

      case 'error': {
        const { code, retryable } = frame.payload;
        this.record({ type: 'protocol_error', code, matchId: this.matchId ?? undefined });
        // A refused message will never be acked, so its correlation is dead
        // weight — but which one was refused is not on the wire, and guessing
        // would be worse than waiting for `trimPending` to age it out.
        this.expirePendingBlock();
        if (this.pendingBlock !== null && (code === 'NOT_MATCHED' || code === 'RATE_LIMITED')) {
          // Two ways a block writes nothing, and both were learnt from runs:
          //
          //   NOT_MATCHED  — the match was gone before the block reached the
          //                  script. A13 produces this by racing a skip against
          //                  its own block; a real client produces it by hitting
          //                  Block as the partner leaves.
          //   RATE_LIMITED — the block bucket is 3 burst, 20/hour. A bot that
          //                  blocks several partners in a row is refused, and
          //                  the refusal is the whole record of the attempt.
          //
          // Either way no block exists, so the pair may legitimately meet again
          // and the durability check must not count it.
          this.record({ type: 'block_refused', matchId: this.pendingBlock.matchId, code });
          this.pendingBlock = null;
        }
        if (code === 'NOT_MATCHED' || code === 'SESSION_GONE' || code === 'ALREADY_MATCHED') {
          // The server's view and this bot's view have diverged. The server is
          // authoritative, so the bot's view is the one that is wrong.
          this.endMatchLocally();
          if (code === 'SESSION_GONE') {
            this.state = 'IDLE';
            // The session is gone; nothing outstanding can be acknowledged now.
            this.pending.clear();
          }
        }
        this.persona.onError?.(this, code, retryable);
        break;
      }

      case 'queue_status':
        this.state = frame.payload.state;
        this.expirePendingBlock();
        if (this.pendingBlock !== null && frame.payload.state === 'IDLE') {
          // A block puts the blocker in IDLE rather than back in the queue
          // (§5), so this is the server confirming it recorded one.
          this.record({ type: 'block_confirmed', matchId: this.pendingBlock.matchId });
          this.pendingBlock = null;
        }
        break;

      case 'server_shutdown':
        // Drain, then come back the way a browser would.
        this.reconnect(this.rng.int(200, 2_000));
        break;

      case 'presence':
      case 'partner_typing':
      case 'pong':
      case 'report_ack':
        break;

      default:
        // A newer server may send a frame this harness has not learnt. Not an
        // error, and deliberately not a failure: the run continues.
        break;
    }
  }

  private onConnected(payload: ConnectedPayload): void {
    this.sessionId = payload.sessionId;
    this.limits = payload.limits;
    // The server publishes these two, so the mirror stops guessing them.
    this.buckets.set('message', new Bucket(payload.limits.messagesPerSecond, payload.limits.burst));
    this.buckets.set(
      'typing',
      new Bucket(payload.limits.typingPerSecond, Math.max(2, Math.ceil(payload.limits.typingPerSecond * 2))),
    );
    this.record({ type: 'connected', sessionId: payload.sessionId });

    // A session TTL is refreshed by traffic; a quiet bot must ping or it is
    // reaped mid-conversation and the run blames matchmaking for it.
    this.heartbeat = setInterval(() => this.ping(), 25_000);
    this.heartbeat.unref();

    this.persona.onConnected?.(this);
  }

  private onMatched(payload: MatchedPayload): void {
    this.state = 'MATCHED';
    this.matchId = payload.matchId;
    this.matchedAt = Date.now();
    this.turnsSent = 0;
    this.turnsReceived = 0;
    this.memo.clear();
    this.trimPending();
    this.record({
      type: 'matched',
      matchId: payload.matchId,
      ms: this.queuedAt > 0 ? Date.now() - this.queuedAt : undefined,
    });
    this.persona.onMatched?.(this, payload);
  }

  private onIncoming(payload: IncomingMessagePayload): void {
    this.turnsReceived += 1;
    this.record({
      type: 'received',
      matchId: payload.matchId,
      messageId: payload.messageId,
      hash: contentHash(payload.text),
      nhash: contentHash(moderationView(payload.text)),
      chars: [...payload.text].length,
      seq: this.turnsReceived,
    });
    this.persona.onPartnerMessage?.(this, payload);
  }

  private onAck(payload: MessageAckPayload): void {
    const cid = payload.clientMsgId;
    const sent = cid === null ? undefined : this.pending.get(cid);
    if (cid !== null) this.pending.delete(cid);
    if (sent) this.turnsSent += 1;
    this.record({
      type: 'ack',
      matchId: payload.matchId,
      cid: cid ?? undefined,
      messageId: payload.messageId,
      hash: sent?.hash,
      delivered: payload.delivered,
      route: payload.route,
      ms: sent ? Date.now() - sent.at : undefined,
    });
    this.persona.onAck?.(this, payload);
  }

  private onPartnerGone(reason: 'skipped' | 'disconnected'): void {
    const previous = this.matchId;
    this.endMatchLocally();
    this.state = 'IDLE';
    this.record({ type: 'partner_gone', matchId: previous ?? undefined, reason });
    this.persona.onPartnerGone?.(this, reason);
  }

  private endMatchLocally(): void {
    this.matchId = null;
    this.memo.clear();
    this.clearTimers();
  }

  /**
   * Drop correlations old enough that no ack can still be coming.
   *
   * Two minutes is far beyond any ack this server produces — the p99 in a
   * loaded run is tens of milliseconds — so nothing that could still arrive is
   * discarded, and a bot that talks for an hour does not accumulate a map of
   * every message it ever sent.
   */
  private expirePendingBlock(): void {
    if (this.pendingBlock === null) return;
    if (Date.now() - this.pendingBlock.at > 5_000) this.pendingBlock = null;
  }

  private trimPending(): void {
    this.expirePendingBlock();
    const cutoff = Date.now() - 120_000;
    for (const [cid, entry] of this.pending) {
      if (entry.at < cutoff) this.pending.delete(cid);
    }
  }

  /* ---------------------------------------------------------------------- */

  record(event: Omit<LedgerEvent, 't' | 'bot' | 'scenario'>): void {
    this.deps.ledger.record({
      t: Date.now(),
      bot: this.spec.id,
      scenario: this.spec.scenario,
      ...event,
    });
  }
}
