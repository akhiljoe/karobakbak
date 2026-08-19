/**
 * Session and match lifecycle.
 *
 * Everything a connected user can do to matchmaking state lives here: open,
 * join, leave, skip, block, heartbeat, close. The WebSocket server (phase 4)
 * parses frames and writes them back; this module decides what happens, and it
 * does so without touching a socket, so it is testable against a fake store and
 * cannot grow transport assumptions.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF EVERY OPERATION
 * ---------------------------------------------------------------------------
 *   1. one Lua script commits the transition,
 *   2. the peer is notified, if the script says this caller is the one that
 *      owes them a notification,
 *   3. an outcome is returned for the caller to turn into a frame.
 *
 * Step 2 is deliberately after step 1 and deliberately cannot fail the
 * operation. The transition is already committed; a dropped notification costs
 * one stale UI label, and the client's next action re-reads authoritative
 * state (§11). Rolling back a committed match because a publish failed would
 * turn a cosmetic failure into a real one.
 */
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Identity } from '../protocol/types';
import type {
  BlockPartnerResult,
  CloseSessionResult,
  ConnRateResult,
  ConnSlotResult,
  CreateSessionResult,
  EndMatchResult,
  HeartbeatResult,
  JoinQueueResult,
  LeaveQueueResult,
  SessionIdentity,
  TryMatchResult,
} from '../redis/store';
import type { RetentionSink } from '../storage/sink';
import { newMatchId, newMessageId, newSessionId } from '../util/ids';
import { nowIso } from '../util/time';
import type { DeliveryRoute, EventDispatcher } from './dispatch';
import { newIdentityPair } from './identity';
import type { Connection, ConnectionRegistry } from './registry';

/**
 * The part of `RedisStore` the lifecycle uses.
 *
 * Named as an interface rather than taking `RedisStore` directly so the unit
 * tests can supply a fake that fails in ways a real Redis makes expensive to
 * arrange — a match that ends between two calls, a session that vanishes
 * mid-operation.
 */
export interface LifecycleStore {
  createSession(identity: SessionIdentity, segment: string): Promise<CreateSessionResult>;
  heartbeat(sessionId: string): Promise<HeartbeatResult>;
  closeSession(sessionId: string, ipHash: string): Promise<CloseSessionResult>;
  joinQueue(sessionId: string, segment: string): Promise<JoinQueueResult>;
  leaveQueue(sessionId: string, segment: string): Promise<LeaveQueueResult>;
  tryMatch(sessionId: string, segment: string, matchId: string): Promise<TryMatchResult>;
  endMatch(matchId: string): Promise<EndMatchResult>;
  blockPartner(sessionId: string): Promise<BlockPartnerResult>;
  connectionRateLimit(ipHash: string): Promise<ConnRateResult>;
  acquireConnectionSlot(ipHash: string, sessionId: string): Promise<ConnSlotResult>;
  queueDepth(segment: string): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

export type OpenOutcome =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'too_many_connections'; count: number };

export interface MatchedOutcome {
  kind: 'matched';
  matchId: string;
  startedAt: string;
  partnerSessionId: string;
  /** This caller's identity for the match. */
  you: Identity;
  /** The partner's identity, as this caller should display it. */
  partner: Identity;
  /** How the partner was told. Diagnostic; both routes are normal (D9). */
  partnerRoute: DeliveryRoute;
}

export type SearchOutcome =
  | MatchedOutcome
  | { kind: 'searching'; waiting: number }
  /**
   * A peer matched this session while it was scanning. Nothing to send: the
   * `matched` frame is already inbound from the instance that won (§10.1).
   */
  | { kind: 'matched_elsewhere' }
  /** No longer searching — a concurrent transition moved it out of the queue. */
  | { kind: 'idle' }
  | { kind: 'session_gone' };

export type LeaveOutcome =
  | { kind: 'idle' }
  | { kind: 'already_matched'; matchId: string }
  | { kind: 'session_gone' };

export type LeaveChatOutcome =
  | { kind: 'left' }
  /** Was not in a conversation. Idempotent, so this is a success, not a fault. */
  | { kind: 'idle' }
  | { kind: 'session_gone' };

export type BlockOutcome =
  | {
      kind: 'blocked';
      matchId: string;
      /**
       * Dimensions actually recorded. Zero is possible and is not an error: a
       * partner whose session already expired has no hashes left to store.
       */
      recorded: number;
    }
  | { kind: 'not_matched' }
  | { kind: 'session_gone' };

export type HeartbeatOutcome =
  | { kind: 'ok'; matchId: string | null }
  | { kind: 'session_gone' };

export interface CloseOutcome {
  /** The match this session was in, if ending it fell to this call. */
  endedMatchId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export class SessionLifecycle {
  private readonly segment: string;

  constructor(
    private readonly store: LifecycleStore,
    private readonly dispatcher: EventDispatcher,
    private readonly registry: ConnectionRegistry,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly retention: RetentionSink,
  ) {
    this.segment = config.matchmaking.defaultSegment;
  }

  /**
   * Admit a connection and create its session row.
   *
   * The two connection limits are different questions and both are asked: the
   * attempt rate bounds how fast one address may churn connections, the
   * concurrency cap bounds how many it may hold at once (R8). A session that
   * fails the concurrency check is closed again immediately rather than left
   * as a row nobody owns.
   *
   * `beforeCreate` runs after the session id exists but **before** the row does.
   * That ordering is required, not incidental: the caller subscribes to the
   * session's event channel there, so there is no window in which a session is
   * matchable but its instance is not listening (§11). Getting it the other way
   * round loses the `matched` event of exactly the users who were quickest.
   */
  async open(
    ipHash: string,
    clientHash: string,
    beforeCreate?: (sessionId: string) => Promise<void>,
  ): Promise<OpenOutcome> {
    const rate = await this.store.connectionRateLimit(ipHash);
    if (!rate.allowed) {
      return { kind: 'rate_limited', retryAfterSeconds: rate.resetSeconds };
    }

    const sessionId = newSessionId();
    if (beforeCreate) await beforeCreate(sessionId);

    await this.store.createSession(
      { sessionId, instanceId: this.config.instanceId, ipHash, clientHash },
      this.segment,
    );

    const slot = await this.store.acquireConnectionSlot(ipHash, sessionId);
    if (!slot.allowed) {
      // Roll back rather than leaking a session row that no socket will ever
      // heartbeat. The TTL would eventually clear it, but "eventually" is a
      // window in which it is a matchable ghost.
      await this.store.closeSession(sessionId, ipHash);
      return { kind: 'too_many_connections', count: slot.count };
    }

    return { kind: 'opened', sessionId };
  }

  /** Preserves I3 and D4: the caller is queued before anything scans. */
  async joinQueue(sessionId: string): Promise<SearchOutcome> {
    const joined = await this.store.joinQueue(sessionId, this.segment);
    switch (joined.status) {
      case 'session_gone':
        return { kind: 'session_gone' };
      case 'already_matched':
        return { kind: 'matched_elsewhere' };
      case 'ok':
      case 'already_searching':
        return this.search(sessionId);
      default: {
        const exhaustive: never = joined;
        void exhaustive;
        return { kind: 'idle' };
      }
    }
  }

  /** Idempotent: an already-idle session is not an error (§5). */
  async leaveQueue(sessionId: string): Promise<LeaveOutcome> {
    const left = await this.store.leaveQueue(sessionId, this.segment);
    switch (left.status) {
      case 'ok':
        return { kind: 'idle' };
      case 'already_matched':
        return { kind: 'already_matched', matchId: left.matchId };
      case 'session_gone':
        return { kind: 'session_gone' };
      default: {
        const exhaustive: never = left;
        void exhaustive;
        return { kind: 'idle' };
      }
    }
  }

  /**
   * End the current match and search again (§12).
   *
   * From IDLE or SEARCHING a skip is a no-op that reports the current state:
   * the user asked for "next stranger" and is already looking for one, so
   * treating it as an error would turn an impatient double-tap into a visible
   * failure. The heartbeat that reads the state also refreshes the TTLs, which
   * is exactly what a session doing something deserves.
   */
  async skip(sessionId: string): Promise<SearchOutcome> {
    const state = await this.store.heartbeat(sessionId);
    if (state.status === 'session_gone') return { kind: 'session_gone' };

    if (state.matchId === null) {
      if (state.state === 'SEARCHING') {
        return { kind: 'searching', waiting: await this.store.queueDepth(this.segment) };
      }
      return { kind: 'idle' };
    }

    await this.endMatchAndNotify(sessionId, state.matchId, 'partner_skipped');
    return this.joinQueue(sessionId);
  }

  /**
   * End the current match and stop, without searching again.
   *
   * The counterpart to `skip`, and the difference is deliberate: `skip` calls
   * `joinQueue` and can re-match before the caller's next frame is even read,
   * so a client trying to leave with `skip` + `leave_queue` loses the race
   * whenever somebody is waiting. This is the same reasoning that already puts
   * `block` in IDLE rather than back in the queue — a user who says stop is not
   * asking for the next stranger.
   *
   * Also removes the session from the queue, so leaving while SEARCHING does
   * what it says too. Idempotent: leaving when idle is a no-op that reports
   * IDLE (rule 4).
   *
   * The partner is told `partner_skipped`, exactly as for a skip or a block. A
   * distinct "they left rather than skipped" signal would be a behavioural
   * detail about another user that nothing needs (security §32).
   */
  async leaveChat(sessionId: string): Promise<LeaveChatOutcome> {
    const state = await this.store.heartbeat(sessionId);
    if (state.status === 'session_gone') return { kind: 'session_gone' };

    if (state.matchId !== null) {
      await this.endMatchAndNotify(sessionId, state.matchId, 'partner_skipped');
      // `endMatch` already reset both sessions to IDLE and pulled them from the
      // queue, so there is nothing left to undo here.
      return { kind: 'left' };
    }

    // Not matched. Leaving still means "stop looking", so a session that was
    // SEARCHING comes out of the queue.
    if (state.state === 'SEARCHING') {
      const result = await this.store.leaveQueue(sessionId, this.segment);
      if (result.status === 'session_gone') return { kind: 'session_gone' };
      return { kind: 'left' };
    }

    return { kind: 'idle' };
  }

  /**
   * Block the current partner (D18) and end the match.
   *
   * The blocker returns to IDLE rather than back into the queue: someone who
   * just blocked a stranger has said something about wanting to stop, and
   * dropping them straight into another conversation reads as the product
   * ignoring them.
   *
   * The partner is told `partner_skipped`, identical to an ordinary skip. A
   * distinct "you were blocked" signal would tell an abuser exactly which
   * behaviour got them blocked, and by whom (security §32).
   */
  async block(sessionId: string, blocker: { ipHash: string; clientHash: string }): Promise<BlockOutcome> {
    const result = await this.store.blockPartner(sessionId);
    if (result.status === 'not_matched') return { kind: 'not_matched' };

    if (result.endedByUs) {
      await this.notify(result.partnerSessionId, {
        event: 'partner_skipped',
        matchId: result.matchId,
      });
    }

    // One row per dimension actually written in Redis, so the database record
    // and the matchmaking filter cannot disagree about what was blocked.
    if (result.recorded > 0) {
      const expiresAt = new Date(Date.now() + this.config.blocks.ttlSeconds * 1000).toISOString();
      for (const dimension of ['ip', 'client'] as const) {
        const enabled =
          dimension === 'ip'
            ? this.config.blocks.ipDimensionEnabled
            : this.config.blocks.clientDimensionEnabled;
        if (!enabled) continue;
        const blockerKey = dimension === 'ip' ? blocker.ipHash : blocker.clientHash;
        const blockedKey =
          dimension === 'ip' ? result.blockedIpHash : result.blockedClientHash;
        if (blockedKey === '') continue;
        this.retention.enqueue({
          kind: 'block',
          blockId: newMessageId(),
          blockerKey,
          blockedKey,
          dimension,
          conversationId: result.matchId,
          createdAt: nowIso(),
          expiresAt,
        });
      }
    }

    if (result.recorded === 0) {
      // Both dimensions can be disabled by configuration, and a partner whose
      // session expired has no hashes to record. Neither is an error, but the
      // difference between "blocked" and "match ended" is worth knowing when
      // reading logs after a complaint.
      this.logger.info('block recorded no dimensions', {
        sessionId,
        matchId: result.matchId,
      });
    }

    return { kind: 'blocked', matchId: result.matchId, recorded: result.recorded };
  }

  /** Refresh every TTL this session depends on (I7). */
  async heartbeat(sessionId: string): Promise<HeartbeatOutcome> {
    const result = await this.store.heartbeat(sessionId);
    if (result.status === 'session_gone') return { kind: 'session_gone' };
    return { kind: 'ok', matchId: result.matchId };
  }

  /**
   * Tear down a session (§13). Safe to call twice, from both the close and the
   * error handler, and safe to call for a session whose row already expired.
   */
  async close(sessionId: string, ipHash: string, connection?: Connection): Promise<CloseOutcome> {
    this.registry.remove(sessionId, connection);

    const closed = await this.store.closeSession(sessionId, ipHash);
    if (closed.matchId === null) return { endedMatchId: null };

    const ended = await this.endMatchAndNotify(
      sessionId,
      closed.matchId,
      'partner_disconnected',
    );
    return { endedMatchId: ended ? closed.matchId : null };
  }

  /* --- internals ---------------------------------------------------------- */

  /**
   * Try to pair, retrying only when the attempt learned something that makes a
   * second look worthwhile.
   *
   * A retry is pointless when the queue was genuinely empty — resampling an
   * empty set finds the same nothing. It is worth it when this attempt cleaned
   * stale entries out of its sample, or skipped candidates blocked relative to
   * this searcher, because in both cases a fresh random sample can contain
   * someone the first one did not (D3).
   */
  private async search(sessionId: string): Promise<SearchOutcome> {
    let waiting = 0;
    for (let attempt = 0; attempt < this.config.matchmaking.retryAttempts; attempt += 1) {
      const result = await this.store.tryMatch(sessionId, this.segment, newMatchId());

      if (result.status === 'matched') {
        return this.announceMatch(sessionId, result.matchId, result.partnerSessionId);
      }

      if (result.status === 'abort') {
        if (result.reason === 'already_matched') return { kind: 'matched_elsewhere' };
        if (result.reason === 'session_gone') return { kind: 'session_gone' };
        return { kind: 'idle' };
      }

      waiting = result.queueDepth;
      if (result.cleaned === 0 && result.blockedSkipped === 0) break;
    }
    return { kind: 'searching', waiting };
  }

  /**
   * Generate the pair of per-match identities and tell the partner.
   *
   * Both identities are created here, by the instance that won the match, and
   * shipped to the partner in the event. Neither side derives them, so nothing
   * about an identity is a function of a session id — anything stable across
   * matches would be a correlation handle (§24.3).
   */
  private async announceMatch(
    sessionId: string,
    matchId: string,
    partnerSessionId: string,
  ): Promise<MatchedOutcome> {
    const startedAt = nowIso();
    const identities = newIdentityPair();

    // The conversation row is P0: the server generated it, and every message
    // and report that follows carries a foreign key into it.
    this.retention.enqueue({
      kind: 'conversation_started',
      conversationId: matchId,
      sessionA: sessionId,
      sessionB: partnerSessionId,
      segment: this.segment,
      startedAt,
    });

    const partnerRoute = await this.notify(partnerSessionId, {
      event: 'matched',
      matchId,
      startedAt,
      // Swapped: the partner's "you" is this caller's "partner".
      you: identities.partner,
      partner: identities.you,
    });

    return {
      kind: 'matched',
      matchId,
      startedAt,
      partnerSessionId,
      you: identities.you,
      partner: identities.partner,
      partnerRoute,
    };
  }

  /**
   * End a match and notify the peer, if this caller is the one that ended it.
   *
   * Only the caller whose `endMatch` returned `ended` notifies (D6). A losing
   * caller must stay silent: the peer would otherwise be told twice that the
   * conversation ended, once per racing side.
   */
  private async endMatchAndNotify(
    sessionId: string,
    matchId: string,
    event: 'partner_skipped' | 'partner_disconnected',
  ): Promise<boolean> {
    const ended = await this.store.endMatch(matchId);
    if (ended.status !== 'ended') return false;

    // Written once, by the caller that won the termination race (D6).
    this.retention.enqueue({
      kind: 'conversation_ended',
      conversationId: matchId,
      endedAt: nowIso(),
      endReason: event === 'partner_skipped' ? 'skip' : 'disconnect',
    });

    const peer = ended.a === sessionId ? ended.b : ended.a;
    if (peer === '' || peer === sessionId) return true;

    await this.notify(peer, { event, matchId });
    return true;
  }

  /** Deliver an event, never letting a delivery failure escape into the transition. */
  private async notify(
    sessionId: string,
    event: Parameters<EventDispatcher['toSession']>[1],
  ): Promise<DeliveryRoute> {
    return this.dispatcher.toSession(sessionId, event, nowIso());
  }
}
