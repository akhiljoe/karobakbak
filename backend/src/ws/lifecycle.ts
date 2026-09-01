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
import type { Identity, MatchedPayload, MatchPreferences, Profile } from '../protocol/types';
import type {
  ResumeSessionResult,
  BlockPartnerResult,
  CloseSessionResult,
  ConnRateResult,
  ConnSlotResult,
  CreateSessionResult,
  EndMatchResult,
  HeartbeatResult,
  JoinQueueResult,
  LeaveQueueResult,
  SaveIdentitiesResult,
  SessionIdentity,
  TryMatchResult,
} from '../redis/store';
import type { RetentionSink } from '../storage/sink';
import { hashResumeToken, newMatchId, newMessageId, newResumeToken, newSessionId } from '../util/ids';
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
  createSession(
    identity: SessionIdentity,
    segment: string,
    resumeHash?: string,
  ): Promise<CreateSessionResult>;
  heartbeat(sessionId: string): Promise<HeartbeatResult>;
  closeSession(sessionId: string, ipHash: string, holdSeat?: boolean): Promise<CloseSessionResult>;
  joinQueue(sessionId: string, segment: string): Promise<JoinQueueResult>;
  setProfile(sessionId: string, profile: Profile): Promise<void>;
  setPreferences(sessionId: string, preferences: MatchPreferences): Promise<void>;
  setIntent(sessionId: string, intent: string | null): Promise<void>;
  resumeSession(
    presentedHash: string,
    replacementHash: string,
    instanceId: string,
  ): Promise<ResumeSessionResult>;
  readMatch(matchId: string): Promise<Record<string, string> | null>;
  saveMatchIdentities(
    matchId: string,
    identityA: string,
    identityB: string,
  ): Promise<SaveIdentitiesResult>;
  readProfiles(a: string, b: string): Promise<{ a: Profile | null; b: Profile | null }>;
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
  | { kind: 'opened'; sessionId: string; resumeToken: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'too_many_connections'; count: number };

export type ResumeOutcome =
  | {
      kind: 'resumed';
      sessionId: string;
      /** The conversation still in progress, if there was one. */
      matchId: string | null;
      /** The replacement token; the presented one is now spent. */
      resumeToken: string;
      ipHash: string;
      clientHash: string;
    }
  | { kind: 'too_many_connections'; count: number }
  /** No such token, an expired window, or a session that is still attached. */
  | { kind: 'no_session' };

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

/**
 * What the matchmaker did, for whoever is counting.
 *
 * A callback pair rather than a metrics registry, so this class keeps its
 * dependencies to Redis, the dispatcher and the retention sink. Neither may
 * throw.
 */
export interface MatchmakingObserver {
  /** One `tryMatch` invocation, whatever came back. */
  attempt(): void;
  /** An attempt that aborted rather than reporting a queue state. */
  aborted(reason: 'already_matched' | 'session_gone' | 'unknown'): void;
  /**
   * A conversation ended, and how long it lasted.
   *
   * Reported by the caller that won the termination race, so exactly once per
   * conversation (D6) — the same caller that writes the `conversation_ended`
   * retention row, for the same reason.
   *
   * `seconds` is null when the match row carried no start time, which the
   * caller must render as "not recorded" rather than as a duration of zero. A
   * fabricated zero would sit in the fastest bucket and read as the strongest
   * possible signal that the product is failing.
   */
  conversationEnded(reason: 'skip' | 'disconnect', seconds: number | null): void;
  /**
   * A user declared (or declined) a gender on an explicit join.
   *
   * Explicit only. An internal re-search after a skip carries no profile
   * because nothing about the declaration changed, and counting those would
   * measure how often people skip rather than how often people declare — with
   * the heaviest skippers weighted highest.
   */
  profileDeclared(gender: string): void;
}

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
  private readonly resumeEnabled: boolean;

  constructor(
    private readonly store: LifecycleStore,
    private readonly dispatcher: EventDispatcher,
    private readonly registry: ConnectionRegistry,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly retention: RetentionSink,
    /** Optional, and last, so every existing construction site is unchanged. */
    private readonly observer?: MatchmakingObserver,
  ) {
    this.segment = config.matchmaking.defaultSegment;
    this.resumeEnabled = config.resume.graceSeconds > 0;
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

    // Issued here and hashed before storage: Redis holds only the hash, so a
    // read of it does not hand somebody a way into a live conversation.
    const resumeToken = this.resumeEnabled ? newResumeToken() : '';
    await this.store.createSession(
      { sessionId, instanceId: this.config.instanceId, ipHash, clientHash },
      this.segment,
      resumeToken === '' ? '' : hashResumeToken(resumeToken),
    );

    const slot = await this.store.acquireConnectionSlot(ipHash, sessionId);
    if (!slot.allowed) {
      // Roll back rather than leaking a session row that no socket will ever
      // heartbeat. The TTL would eventually clear it, but "eventually" is a
      // window in which it is a matchable ghost.
      await this.store.closeSession(sessionId, ipHash);
      return { kind: 'too_many_connections', count: slot.count };
    }

    return { kind: 'opened', sessionId, resumeToken };
  }

  /**
   * Reclaim a detached session with the token it was issued.
   *
   * Returns `no_session` for anything that does not resolve to a session held
   * open for exactly this token — an expired window, an unknown token, a
   * session that was reaped. The caller then opens a fresh session, which is
   * the pre-§28 behaviour and the right fallback: a failed resume must never be
   * an error page, it is simply a new conversation.
   */
  async resume(
    token: string,
    beforeAttach?: (sessionId: string) => Promise<void>,
  ): Promise<ResumeOutcome> {
    if (!this.resumeEnabled || token === '') return { kind: 'no_session' };

    const replacement = newResumeToken();
    const result = await this.store.resumeSession(
      hashResumeToken(token),
      hashResumeToken(replacement),
      this.config.instanceId,
    );
    if (result.status !== 'resumed') return { kind: 'no_session' };

    // Subscribed before the caller can be told it worked, so no event published
    // to this session can arrive before this instance is listening (§11).
    if (beforeAttach) await beforeAttach(result.sessionId);

    // The slot was released when the socket dropped, so it has to be taken
    // again — a resumed session is a live connection like any other, and not
    // counting it would let one address hold unlimited seats by reconnecting.
    const slot = await this.store.acquireConnectionSlot(result.ipHash, result.sessionId);
    if (!slot.allowed) return { kind: 'too_many_connections', count: slot.count };

    return {
      kind: 'resumed',
      sessionId: result.sessionId,
      matchId: result.matchId,
      resumeToken: replacement,
      ipHash: result.ipHash,
      clientHash: result.clientHash,
    };
  }

  /**
   * Rebuild the `matched` frame for a session that just came back.
   *
   * The identities are read from the match rather than regenerated: they were
   * shipped in the original event and are not a function of anything, so a
   * fresh draw would show the returning user a different stranger name for the
   * same conversation and make the transcript read as two people.
   */
  async restoreMatch(sessionId: string, matchId: string): Promise<MatchedPayload | null> {
    const match = await this.store.readMatch(matchId);
    if (!match) return null;
    const mine = match.a === sessionId;
    const partnerSessionId = mine ? match.b : match.a;
    if (partnerSessionId === undefined || partnerSessionId === '') return null;

    const you = parseIdentity(mine ? match.identA : match.identB);
    const partner = parseIdentity(mine ? match.identB : match.identA);
    if (!you || !partner) return null;

    return {
      matchId,
      startedAt: new Date(Number(match.createdAt ?? 0)).toISOString(),
      you,
      partner,
    };
  }

  /** Tell the partner the stranger is back, so their composer re-enables. */
  async announceReturn(sessionId: string, matchId: string): Promise<void> {
    const match = await this.store.readMatch(matchId);
    if (!match) return;
    const partnerSessionId = match.a === sessionId ? match.b : match.a;
    if (!partnerSessionId) return;
    await this.notify(partnerSessionId, { event: 'partner_returned', matchId });
  }

  /** Preserves I3 and D4: the caller is queued before anything scans. */
  async joinQueue(
    sessionId: string,
    profile?: Profile,
    preferences?: MatchPreferences,
    intent?: string | null,
  ): Promise<SearchOutcome> {
    // Written before the queue is joined, so a session can never be matched in
    // the window between entering the queue and its profile landing — the
    // partner would be shown a stale declaration or none at all.
    //
    // The preference has the same ordering requirement for a different reason:
    // queued first and it could be matched by its own ordinary rules before the
    // thing it is paying for has landed.
    if (profile !== undefined) {
      await this.store.setProfile(sessionId, profile);
      this.observer?.profileDeclared(profile.gender ?? 'none');
    }
    if (preferences !== undefined) await this.store.setPreferences(sessionId, preferences);
    // Same ordering requirement as the two above, and the reason is the one
    // that bit the preference: a session queued before its intent lands is
    // matched by ordinary rules, and the user's one selector did nothing on the
    // attempt they were watching.
    if (intent !== undefined) await this.store.setIntent(sessionId, intent);
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
  async block(
    sessionId: string,
    blocker: { ipHash: string; clientHash: string; accountId?: string | null },
  ): Promise<BlockOutcome> {
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
          // Recorded only when the blocker was signed in. It is what lets them
          // find this block again from another network — both key hashes
          // change and an account id does not — and it is the blocker's alone.
          blockerAccountId: blocker.accountId ?? null,
          // Null, not the empty string, when the match had already ended: the
          // column is a nullable foreign key, and '' is neither a conversation
          // nor an honest "there wasn't one".
          conversationId: result.matchId === '' ? null : result.matchId,
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

    if (result.matchId === '') {
      // The partner had already gone. Worth its own line: this is the case that
      // silently recorded nothing before the late window existed, so a count of
      // it is how anyone would notice the window being too short.
      this.logger.info('blocked a partner who had already left', { sessionId });
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
  async close(
    sessionId: string,
    ipHash: string,
    connection?: Connection,
    options: { holdSeat?: boolean } = {},
  ): Promise<CloseOutcome> {
    this.registry.remove(sessionId, connection);

    // A deliberate shutdown is not a network blip. Holding seats through one
    // would leave every partner waiting out a grace window for somebody whose
    // server is going away, so drain tears down and releases them.
    const closed = await this.store.closeSession(sessionId, ipHash, options.holdSeat !== false);
    if (closed.matchId === null) return { endedMatchId: null };

    // The seat is being held (§28). The conversation is untouched, so the only
    // thing to do is tell the partner what is happening — told "they left", a
    // person moves on; told "they are reconnecting", they wait, and most of the
    // time the conversation resumes.
    if (closed.status === 'detached') {
      const until = new Date(Date.now() + this.config.resume.graceSeconds * 1000).toISOString();
      const match = await this.store.readMatch(closed.matchId);
      const partnerSessionId =
        match === null ? null : match.a === sessionId ? match.b : match.a;
      if (partnerSessionId !== null && partnerSessionId !== undefined && partnerSessionId !== '') {
        await this.notify(partnerSessionId, {
          event: 'partner_reconnecting',
          matchId: closed.matchId,
          until,
        });
      }
      return { endedMatchId: null };
    }

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
      this.observer?.attempt();
      const result = await this.store.tryMatch(sessionId, this.segment, newMatchId());

      if (result.status === 'matched') {
        return this.announceMatch(sessionId, result.matchId, result.partnerSessionId);
      }

      if (result.status === 'abort') {
        // An abort is the attempt failing, not the queue being empty: the
        // session was already matched, or it is gone. A run of these is a
        // different problem from a quiet queue, which is why they are counted
        // apart from `chat_matchmaking_latency_seconds` having no samples.
        if (result.reason === 'already_matched') {
          this.observer?.aborted('already_matched');
          return { kind: 'matched_elsewhere' };
        }
        if (result.reason === 'session_gone') {
          this.observer?.aborted('session_gone');
          return { kind: 'session_gone' };
        }
        this.observer?.aborted('unknown');
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
  ): Promise<MatchedOutcome | { kind: 'idle' }> {
    const startedAt = nowIso();
    // Read beside the match rather than out of the caller's hand: this instance
    // won the match, but either side may have joined through a different
    // connection, so Redis is the only place that knows both declarations.
    const profiles = await this.store.readProfiles(sessionId, partnerSessionId);
    const identities = newIdentityPair({ you: profiles.a, partner: profiles.b });

    // The conversation row is P0: the server generated it, and every message
    // and report that follows carries a foreign key into it.
    this.retention.enqueue({
      kind: 'conversation_started',
      conversationId: matchId,
      sessionA: sessionId,
      sessionB: partnerSessionId,
      segment: this.segment,
      startedAt,
      // Stamped now, because the declaration lives on the session and the
      // session is long gone by the time anyone investigates a report about it.
      profileA: profiles.a,
      profileB: profiles.b,
    });

    // Stored on the match so a reconnection can restore exactly these names
    // rather than drawing new ones for a conversation already in progress.
    //
    // After the retention row, deliberately. The match existed, so a
    // `conversation_started` for it is accurate — and whoever ended it has
    // already enqueued a `conversation_ended` carrying the same id, which the
    // writer would otherwise hold back for ever waiting for a parent that was
    // never written.
    const saved = await this.store.saveMatchIdentities(
      matchId,
      JSON.stringify(identities.you),
      JSON.stringify(identities.partner),
    );

    if (saved.status === 'match_gone') {
      // The conversation ended between being made and being described. Nobody
      // is told they matched: the partner has already had whatever ending
      // event the side that left produced, and announcing a match into a
      // conversation that is over would put a live-looking transcript on a
      // screen whose very next command comes back NOT_MATCHED.
      //
      // Reported as idle rather than retried. There is nothing to retry: the
      // match is gone, and the searcher's own next action re-enters the queue.
      this.logger.debug('a match ended before its identities were written', { matchId });
      return { kind: 'idle' };
    }

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

    const reason = event === 'partner_skipped' ? 'skip' : 'disconnect';

    // Written once, by the caller that won the termination race (D6).
    this.retention.enqueue({
      kind: 'conversation_ended',
      conversationId: matchId,
      endedAt: nowIso(),
      endReason: reason,
    });

    // Measured from the match row's own timestamp rather than from anything
    // this process remembers: the conversation may have been created by a
    // different instance, so only Redis knows when it started.
    this.observer?.conversationEnded(
      reason,
      ended.createdAtMs > 0 ? (Date.now() - ended.createdAtMs) / 1000 : null,
    );

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

/**
 * Read an identity back off the match hash.
 *
 * Returns null for anything unparseable rather than throwing: a match written
 * by an older build has no identities stored, and that must degrade to "cannot
 * restore, start fresh" instead of failing a reconnection.
 */
function parseIdentity(raw: string | undefined): Identity | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.nickname !== 'string' || typeof value.colour !== 'string') return null;
    return {
      nickname: value.nickname,
      colour: value.colour,
      profile: (value.profile ?? null) as Identity['profile'],
    };
  } catch {
    return null;
  }
}
