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
import {
  BASE_PROTOCOL,
  RESUME_PROTOCOL_PREFIX,
  type AnyServerEnvelope,
  type ClientEventType,
  type ConnectedPayload,
  type IncomingMessagePayload,
  type MatchedPayload,
  type MessageAckPayload,
  type PartnerReconnectingPayload,
  type Profile,
  type ReportCategory,
  type ServerLimits,
  type SessionState,
} from '../../../backend/src/protocol/types';
import { moderationView } from '../../../backend/src/moderation/normalise';
import { campaignView } from './campaign';
import { isEmptyProfile, profileHash } from './declared';
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
  /**
   * The partner's socket dropped and the server is holding their seat (§28).
   *
   * The conversation has **not** ended. Nothing this bot sends now is delivered
   * and nothing is buffered (D43), so a persona's correct response is to wait,
   * exactly as the client's disabled composer makes a person wait.
   */
  onPartnerAway?(bot: Bot, payload: PartnerReconnectingPayload): void;
  /** The partner made it back inside the window; the conversation carries on. */
  onPartnerBack?(bot: Bot): void;
  /**
   * This bot's own reconnect reclaimed the session, and the conversation it was
   * in came back with it. `payload` is the same `matched` shape as the original.
   */
  onResumed?(bot: Bot, payload: MatchedPayload): void;
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
  /**
   * What this bot declares about itself on every `join_queue` (§26).
   *
   * On the spec rather than drawn per join, because the server keeps nothing
   * between sessions: the *client* is the thing that remembers, so a bot that
   * re-declared something different after every reconnect would be modelling a
   * browser with amnesia rather than the one that ships.
   */
  readonly profile: Profile;
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
/**
 * Consecutive refused upgrades before a bot gives up for good.
 *
 * With the backoff in `onRefused` this is roughly two minutes of trying, which
 * covers a container restart and a rolling deploy. Beyond that the stack is not
 * coming back on its own, and a run that keeps retrying is a run that hides a
 * dead environment behind a ledger full of noise.
 */
const MAX_CONNECT_FAILURES = 10;

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

  /**
   * Come back after a socket this bot did not close.
   *
   * Set for chaos runs only. See the close handler for why it is not the
   * default even though it is what a browser does.
   */
  reconnectOnDrop = false;

  /** Server-authoritative as far as this bot can observe it. */
  state: SessionState = 'IDLE';
  matchId: string | null = null;
  sessionId: string | null = null;
  limits: ServerLimits | null = null;

  /**
   * The last match this bot was in, kept after it ends.
   *
   * A block can now arrive after the conversation is over and still be recorded
   * (D38, `chat:last_partner`), so the harness needs a name for the
   * conversation a late block refers to — `matchId` is already null by then.
   */
  lastMatchId: string | null = null;

  /**
   * The partner's socket has dropped and the server is holding their seat.
   *
   * Not the same as "gone". While this is true the conversation is intact but
   * nothing sent reaches anybody and nothing is buffered (D43), so `speak`
   * refuses to send and the persona waits.
   */
  partnerAway = false;

  /** What this bot tells strangers about itself. Re-sent on every join. */
  declared: Profile;

  /** How long the server says a dropped socket keeps its seat. 0 means off. */
  resumeGraceSeconds = 0;

  /** Messages this bot has sent inside the current match. */
  turnsSent = 0;
  /** Messages the partner has sent inside the current match. */
  turnsReceived = 0;
  /** When the current match started, for think-time and duration decisions. */
  matchedAt = 0;

  private socket: WebSocket | null = null;
  private clientToken: string | null = null;
  /**
   * The single-use credential for reclaiming this session (§28).
   *
   * A bearer credential, held in memory only and replaced on every redemption,
   * which mirrors where the browser keeps it: `sessionStorage`, so it dies with
   * the tab. A persona modelling a *new* tab calls `forgetResumeToken`, and
   * that difference is the whole of what separates L1 from L3.
   */
  private resumeToken: string | null = null;
  /**
   * A token value captured before a redemption, so it can be presented again
   * afterwards.
   *
   * The credential is rotated on every successful resume, and "a captured token
   * works once" is a claim with no other way to test it: the bot has to keep the
   * old value and offer it after the new one has replaced it.
   */
  private stashedResumeToken: string | null = null;
  /** Whether the next `connect()` should present a token, and which one. */
  private resumeNext: false | 'current' | 'stashed' = false;
  /** Set for one connection when a token was actually presented. */
  private resumeAttempted = false;
  /** Consecutive refused upgrades. Reset by a successful `connected`. */
  private connectFailures = 0;
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
  private readonly pending = new Map<
    string,
    { at: number; hash: string; matchId: string | null; away: boolean }
  >();
  private readonly memo = new Map<string, number>();
  /** Lifetime markers, unlike `memo` which is cleared at every match boundary. */
  private readonly flags = new Set<string>();
  private seq = 0;
  private queuedAt = 0;
  /**
   * The country this bot's *connection* claims, via `CF-IPCountry`.
   *
   * Null when the header was never sent. The server reads country from the
   * connection rather than from the declaration (`c043479`), so this is the
   * country every profile of this bot's comes back with, whatever it declared.
   */
  private connectionCountry: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  private finished = false;
  /** Set by `stopHard` so the close handler knows a reset was deliberate. */
  private hardStop = false;
  /**
   * The pending "come back" from `reconnect`, held **outside** `timers`.
   *
   * ---------------------------------------------------------------------------
   * THE BUG THIS FIELD EXISTS TO FIX
   * ---------------------------------------------------------------------------
   * `reconnect` tears the socket down and schedules the new connection. The
   * teardown makes `ws` emit `close` on a later tick, and the close handler
   * calls `clearTimers()` — which used to cancel the reconnect that had just
   * been scheduled, because it lived in the same set as every other timer.
   *
   * The effect was silent and total: **no bot in this harness had ever
   * reconnected.** Every run's `connect_attempt` count equalled its bot count
   * exactly, which reads as "nothing went wrong" rather than as "five personas
   * are dead". L1, L2, L9 and L10 dropped their sockets and simply stopped.
   *
   * It mattered less when a dropped socket ended the conversation: the partner
   * was told, re-queued, and the population kept moving. Under §28 the seat is
   * *held* for somebody who is never coming back, so the same bug now stalls
   * the whole run — which is how it was finally noticed.
   */
  private reconnectTimer: NodeJS.Timeout | null = null;
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
    this.declared = spec.profile;
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

    /*
      The country this bot will be seen as being in (F-037).

      `c043479` made country come from the connection rather than from what the
      client sends: `server.ts` builds the join profile as
      `{ ...command.profile, country: connection.country }`, so a declared
      country is discarded and `clientCountry()` reads `CF-IPCountry` instead.
      nginx forwards that header, and `TRUST_PROXY_HOPS` is above zero here, so
      this is the only way a bot can be in a country at all.

      Without it every bot that declared a country — 48% of them — was echoed a
      null and the profile oracle read it as the server failing to echo a
      declaration. That is what turned the swarm red on 2026-08-26 and kept it
      red: the last green run predates that commit by two days.

      Sending the header rather than dropping country out of the hash, because
      dropping it would make a genuine country-crossing bug invisible — and
      country is one of the two fields a moderator reads first.
    */
    if (this.declared.country !== null) {
      headers['CF-IPCountry'] = this.declared.country;
    }
    /*
      Remembered, because the server's echo is judged against it (F-037).

      The header is set from whatever this bot was carrying **at connect time**,
      and a persona may declare something different afterwards — G1 overwrites
      `declared` with nothing in `onConnected`, after this runs. From then on the
      bot declares no country and the server fills one in from the connection, so
      "what I sent" and "what I should be echoed" are two different profiles and
      only this field tells them apart.
    */
    this.connectionCountry = this.declared.country;
    if (this.clientToken) {
      headers['Cookie'] = `${CLIENT_TOKEN_COOKIE}=${this.clientToken}`;
    }

    // The base protocol is offered on **every** connection, not only resuming
    // ones, and it is not optional. `ws` refuses a handshake where the client
    // offered subprotocols and the server selected none, and the server only
    // ever selects `kbb.v1` — it deliberately never echoes the resume entry,
    // because doing so would repeat a bearer token in the response headers.
    // Offering the resume entry alone therefore fails the upgrade outright.
    const offered =
      this.resumeNext === 'stashed'
        ? this.stashedResumeToken
        : this.resumeNext === 'current'
          ? this.resumeToken
          : null;
    const protocols =
      offered === null
        ? [BASE_PROTOCOL]
        : [`${RESUME_PROTOCOL_PREFIX}${offered}`, BASE_PROTOCOL];
    const presentingResume = offered !== null;
    this.resumeNext = false;

    const socket = new WebSocket(this.deps.url, protocols, { headers, handshakeTimeout: 20_000 });
    this.socket = socket;
    this.resumeAttempted = presentingResume;
    if (presentingResume) this.record({ type: 'resume_offered' });

    socket.on('upgrade', (response) => {
      const token = readClientToken(response.headers['set-cookie']);
      if (token) this.clientToken = token;
    });

    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      this.socket = null;
      this.onRefused(status);
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
      this.abandonPendingAcks();
      this.state = 'IDLE';
      if (this.matchId !== null) this.lastMatchId = this.matchId;
      this.matchId = null;
      this.partnerAway = false;
      this.record({ type: 'closed', code, reason: this.hardStop ? 'harness_stop' : 'server' });
      this.hardStop = false;
      if (this.stopped) {
        this.finish();
        return;
      }
      this.persona.onClosed?.(this, code);

      // A persona that did not ask to reconnect is done. A reconnect already
      // scheduled counts: it lives outside `timers` precisely so this handler
      // cannot cancel it, so it must not be read as "nothing is coming" either.
      if (this.socket || this.reconnectTimer !== null) return;

      // Unless the socket died on its own, in which case a browser would come
      // back and so should this.
      //
      // Off by default, because for every other scenario here a close is
      // *scripted* -- the persona asked for it and knows what it wants to
      // happen next -- and reconnecting behind its back would put bots into
      // states their oracles do not expect.
      //
      // C2 is the case where nothing scripted the close. Killing a backend
      // drops every socket it held at once, and without this the bots on it
      // are finished permanently: the first C2 run ended with 282 of 586
      // connections, which reads exactly like a product that will not let
      // clients back in. It was the harness all along. The real frontend
      // reconnects after an unexpected drop -- that is the whole of section 28
      // -- so a harness that does not cannot measure recovery at all.
      if (this.reconnectOnDrop && !this.hardStop) {
        // Spread, so several hundred bots losing a host together return as a
        // stream rather than as one thundering herd against the survivor. The
        // resume token is offered: this is a dropped socket, which is precisely
        // what the grace window exists for.
        this.reconnect(this.rng.int(500, 6_000), 'hard', { resume: true });
        return;
      }

      this.finish();
    });
  }

  /** Close cleanly, the way a browser tab does. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.cancelReconnect();
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
    this.cancelReconnect();
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
   *
   * `resume` decides whether the new socket presents the token this bot holds
   * (§28). It defaults to **false**, which is not an oversight: a reconnect
   * that resumes and a reconnect that starts fresh are two different scenarios,
   * the fresh one is what every L persona was written and verified against, and
   * silently converting them all would delete that coverage while looking like
   * an upgrade. Personas that model a page refresh ask for `resume` explicitly.
   *
   * `'stashed'` presents the value captured by `stashResumeToken` instead of
   * the current one — a token that has already been redeemed, which the server
   * must refuse into a fresh session.
   */
  reconnect(
    afterMs: number,
    mode: 'hard' | 'clean' = 'hard',
    options: { resume?: boolean | 'stashed' } = {},
  ): void {
    if (this.stopped) return;
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.resumeNext =
      options.resume === 'stashed'
        ? this.stashedResumeToken !== null
          ? 'stashed'
          : false
        : options.resume === true && this.resumeToken !== null
          ? 'current'
          : false;
    this.abandonPendingAcks();
    this.state = 'IDLE';
    if (this.matchId !== null) this.lastMatchId = this.matchId;
    this.matchId = null;
    this.partnerAway = false;
    if (socket) {
      if (mode === 'clean' && socket.readyState === WebSocket.OPEN) socket.close(1000);
      else socket.terminate();
    }
    // Deliberately not in `timers`: the close this teardown is about to produce
    // runs `clearTimers()`, and this is the one timer that must survive it.
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, afterMs);
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

  /**
   * A refused upgrade: decide whether this bot comes back.
   *
   * ---------------------------------------------------------------------------
   * WHY A REFUSAL USED TO BE FATAL, AND WHY THAT WAS WRONG
   * ---------------------------------------------------------------------------
   * This used to call `finish()` unconditionally: one refusal and the bot was
   * gone for the rest of the run. It looked harmless because refusals were
   * rare — until a backend restart mid-run, where nginx answers **502** for as
   * long as it has no upstream. Every bot reconnecting into that window died,
   * and 244 of 400 never came back. The run kept reporting "400 connected",
   * because the progress count read a session id that outlived its socket.
   *
   * Same family as the reconnect-timer bug: a transient condition silently and
   * permanently shrinks the population, and a smaller population passes every
   * oracle. It also makes the whole C group unrunnable — pausing or restarting
   * a backend is the *point* of those scenarios, and the harness would lose most
   * of its bots each time.
   *
   * So a refusal that a real client would retry is retried, with backoff, and a
   * refusal that means "you are not welcome" is not:
   *
   *   403  banned, or an origin that is not allowed. Terminal, and correct: a
   *        banned client that kept hammering would be the bug.
   *   429  rate limited or too many connections. This is the *expected* answer
   *        to L7's thundering herd, and a real client backs off and returns.
   *   502  no upstream — the edge is up and the backend is not.
   *   503  draining, or a session could not be opened.
   *
   * The attempt cap exists so a stack that is genuinely down ends the run
   * rather than filling the ledger with retries for ten minutes.
   */
  private onRefused(status: number): void {
    const retryable = status === 429 || status === 502 || status === 503 || status === 0;
    this.connectFailures += 1;
    if (!retryable || this.connectFailures > MAX_CONNECT_FAILURES || this.stopped) {
      this.record({
        type: 'connect_refused',
        code: status,
        reason: retryable ? 'gave_up' : 'terminal',
      });
      this.finish();
      return;
    }
    // Exponential with jitter, capped. The jitter matters more than the curve:
    // four hundred bots refused by the same restart would otherwise return in
    // one synchronised wave and refuse each other on the connection limiter.
    const backoff = Math.min(15_000, 400 * 2 ** (this.connectFailures - 1));
    const delay = backoff + this.rng.int(0, Math.floor(backoff / 2));
    this.record({ type: 'connect_refused', code: status, reason: 'retrying', ms: delay });
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  /** True while this bot has an open socket. Not "has ever had a session". */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Throw away the resume credential — a closed tab rather than a dropped
   * socket. The seat the server is holding is then never claimed, and the
   * conversation ends when the grace window does.
   */
  forgetResumeToken(): void {
    this.resumeToken = null;
    this.stashedResumeToken = null;
    this.resumeNext = false;
  }

  /** Whether this bot could resume if it reconnected right now. */
  canResume(): boolean {
    return this.resumeToken !== null && this.resumeGraceSeconds > 0;
  }

  /**
   * Keep the current resume token so it can be presented again after it has
   * been redeemed and rotated away. See `stashedResumeToken`.
   */
  stashResumeToken(): void {
    this.stashedResumeToken = this.resumeToken;
  }

  /** Whether a captured token is available to replay. */
  hasStashedToken(): boolean {
    return this.stashedResumeToken !== null;
  }

  /**
   * Give up on acks for messages that were in flight when the socket died.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS RECORDED RATHER THAN QUIETLY DROPPED
   * ---------------------------------------------------------------------------
   * A message can be accepted, delivered to the partner, and acked into a
   * socket that is already gone. The partner records `received`; this bot never
   * records `ack`. The pair oracle then sees a receiver holding a message the
   * sender was never acked for — which is its definition of a delivery bug, and
   * it is entirely an artefact of the socket dying at the wrong moment.
   *
   * It has always been possible; §28 makes it matter, because the conversation
   * now *survives* the drop and the mismatch lands inside a live match instead
   * of one that was ending anyway.
   *
   * So the correlation is written out as `ack_lost`, in send order, carrying
   * the hash. The oracle treats those as "may have been delivered": present for
   * ordering, tolerated if absent. That costs a little strictness in exactly one
   * window — a handful of messages per dropped socket — and the alternative is
   * a red run every time a phone changes network.
   */
  private abandonPendingAcks(): void {
    if (this.pending.size === 0) return;
    for (const [cid, entry] of this.pending) {
      this.record({
        type: 'ack_lost',
        matchId: entry.matchId ?? undefined,
        cid,
        hash: entry.hash,
      });
    }
    this.pending.clear();
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

  /**
   * Cancel every timer this bot owns **except** a pending reconnect.
   *
   * The exception is the whole point — see `reconnectTimer`. Anything that
   * genuinely means "this bot is finished" calls `cancelReconnect` as well.
   */
  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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

  /**
   * Enter matchmaking, carrying whatever this bot declares about itself.
   *
   * The profile rides on **every** join because the server keeps nothing
   * between sessions and there is no partial update: a join without a field
   * clears it. `override` exists for the personas that deliberately declare
   * something the server must refuse; it does not change what the bot declares
   * from then on, so one probe cannot leave a bot permanently unable to queue.
   */
  joinQueue(override?: Profile): void {
    // A resumed connection lands in `onConnected` already in a conversation,
    // and almost every persona joins the queue from there. Refusing here rather
    // than in each of them keeps a resume from spending a join token and asking
    // the server to queue a session it has already matched.
    if (this.state === 'MATCHED') return;
    if (!this.spend('join_queue')) return;
    const profile = override ?? this.declared;
    this.queuedAt = Date.now();
    this.state = 'SEARCHING';
    // An empty declaration is sent as an omitted field rather than four nulls.
    // Both normalise to the same thing server-side, and omitting it is what the
    // browser does for a user who declared nothing.
    this.send('join_queue', isEmptyProfile(profile) ? {} : { profile });
    /*
      Hashed as the server will build it, not as it was sent (F-037).

      `server.ts` builds the join profile as
      `{ ...command.profile, country: connection.country }`, so a declared
      country is discarded and the connection's is used — including when nothing
      was declared at all, which is how an anonymous bot gets echoed a
      country-only profile it never sent. Hashing what was sent made that read
      as "the server did not echo the profile this bot declared", every time,
      for every bot whose declaration and connection disagreed. Deterministic
      per bot, which is what made it look like a product bug for a week.

      Modelling the rule rather than dropping country out of the hash: dropping
      it would make a genuine country-crossing bug invisible, and country is one
      of the two fields a moderator reads first.
    */
    this.record({
      type: 'queued',
      hash: profileHash({ ...profile, country: this.connectionCountry as Profile['country'] }),
    });
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

  /**
   * Block the current partner — or the one who just left.
   *
   * A block after the conversation ended is now recorded against the departed
   * partner for `BLOCK_LATE_WINDOW_SECONDS` (D38), so `lastMatchId` is used
   * when there is no live match. That is not a fallback for tidiness: the
   * confirmation for a late block looks identical to a live one (a
   * `queue_status` in IDLE), and correlating it to nothing would leave every
   * late block counted as an unconfirmed intent and quietly excluded from the
   * durability check that exists to prove blocks work.
   */
  block(options: { force?: boolean } = {}): void {
    if (!options.force && !this.spend('block')) return;
    const previous = this.matchId ?? this.lastMatchId;
    const late = this.matchId === null;
    this.endMatchLocally();
    this.state = 'IDLE';
    this.send('block', {});
    this.record({
      type: 'blocked',
      matchId: previous ?? undefined,
      ...(late ? { reason: 'late' } : {}),
    });
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
    // Whether the partner's seat was being held at the moment this was handed
    // to the socket. It decides how the ack may be read — see `onAck`.
    this.pending.set(cid, { at: Date.now(), hash, matchId: this.matchId, away: this.partnerAway });
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

      case 'partner_reconnecting': {
        // The conversation is intact and the seat is held (§28). Nothing sent
        // now is delivered and nothing is buffered (D43), so the bot stops
        // talking rather than shouting into the gap — which is exactly what
        // the client's disabled composer makes a person do.
        this.partnerAway = true;
        this.record({ type: 'partner_away', matchId: frame.payload.matchId });
        this.persona.onPartnerAway?.(this, frame.payload);
        break;
      }

      case 'partner_returned': {
        this.partnerAway = false;
        this.record({ type: 'partner_back', matchId: frame.payload.matchId });
        this.persona.onPartnerBack?.(this);
        break;
      }

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
        if (code === 'AGE_BELOW_MINIMUM' || code === 'VALIDATION_FAILED') {
          // A refused join leaves this bot believing it is SEARCHING while the
          // server never queued it — a bot that sits out the rest of the run
          // looking perfectly healthy. Both refusals a declared profile can
          // produce arrive this way (D35, and the age floor), so the optimistic
          // state is rolled back and the persona is told.
          if (this.state === 'SEARCHING') this.state = 'IDLE';
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
    // Held in memory only, replaced on every redemption. Empty when the server
    // has resumption switched off (`RESUME_GRACE_SECONDS=0`), which restores
    // the pre-§28 behaviour and is a supported configuration, not a dead path.
    this.resumeToken = payload.resumeToken === '' ? null : payload.resumeToken;
    this.resumeGraceSeconds = payload.resumeGraceSeconds;
    this.connectFailures = 0;
    this.record({ type: 'connected', sessionId: payload.sessionId });

    // A session TTL is refreshed by traffic; a quiet bot must ping or it is
    // reaped mid-conversation and the run blames matchmaking for it.
    this.heartbeat = setInterval(() => this.ping(), 25_000);
    this.heartbeat.unref();

    // The conversation came back with the session. `connected.resumed` carries
    // the same payload the original `matched` did, so the bot restores from it
    // and the persona picks the conversation up rather than being told about a
    // new one — the whole point of §28 is that this is the *same* conversation.
    const resumed = payload.resumed;
    if (resumed !== undefined) {
      this.state = 'MATCHED';
      this.matchId = resumed.matchId;
      this.lastMatchId = resumed.matchId;
      this.partnerAway = false;
      // Not reset: `matchedAt` is when the conversation started, and a persona
      // deciding "have I been here long enough to leave" must not have its
      // clock rewound by a network blip. `turnsSent`/`turnsReceived` survive
      // for the same reason — this is one conversation, not two.
      this.record({ type: 'resumed', matchId: resumed.matchId });
      this.persona.onResumed?.(this, resumed);
    } else if (this.resumeAttempted) {
      // A token was presented and the window had closed, or the session was
      // still attached. Either way this is a *fresh* session, which is the
      // designed fallback and never an error.
      this.record({ type: 'resume_expired', sessionId: payload.sessionId });
    }
    this.resumeAttempted = false;

    this.persona.onConnected?.(this);
  }

  private onMatched(payload: MatchedPayload): void {
    this.state = 'MATCHED';
    this.matchId = payload.matchId;
    this.lastMatchId = payload.matchId;
    this.partnerAway = false;
    this.matchedAt = Date.now();
    this.turnsSent = 0;
    this.turnsReceived = 0;
    this.memo.clear();
    this.trimPending();
    this.record({
      type: 'matched',
      matchId: payload.matchId,
      ms: this.queuedAt > 0 ? Date.now() - this.queuedAt : undefined,
      // Both sides of the declaration, hashed. The partner's is what this bot
      // was shown; `you` is what the server made of what this bot declared.
      // The two together let an oracle prove a profile survived the round trip
      // without the ledger ever holding a name.
      theirProfile: profileHash(payload.partner.profile),
      myProfile: profileHash(payload.you.profile),
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
      ackStatus: payload.status,
      route: payload.route,
      ms: sent ? Date.now() - sent.at : undefined,
      // The server now says this itself. It used to answer `delivered: true`
      // for a message routed at a session with no socket — the moderation
      // verdict wearing the name of an outcome — so this harness inferred the
      // truth from its own view of when the partner was away, with 500ms of
      // lead tolerance because a bot learns of a dropped partner a round trip
      // late.
      //
      // `undelivered` is authoritative and needs no tolerance: it comes from
      // the side that actually tried to deliver. The local inference stays as
      // a second opinion, because a bot that saw its partner leave and got
      // `routed` anyway is worth flagging rather than trusting.
      ...(payload.status === 'undelivered' || sent?.away === true
        ? { unconfirmed: true }
        : {}),
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
    // `lastMatchId` survives on purpose: a block can arrive after the
    // conversation ended and must still name the conversation it refers to
    // (D38).
    if (this.matchId !== null) this.lastMatchId = this.matchId;
    this.matchId = null;
    this.partnerAway = false;
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
