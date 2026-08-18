/**
 * The typed face of the Redis layer.
 *
 * Every script reply becomes a discriminated union, so a caller cannot use a
 * match id from a result that does not have one, and cannot silently ignore an
 * ABORT by treating the reply as "probably fine". The Lua returns positional
 * arrays because that is what Redis speaks; nothing outside this file should
 * ever index into one.
 */
import type { Redis } from 'ioredis';

import type { Config, RateLimitedCommand } from '../config';
import type { SessionState } from '../protocol/types';
import type { RedisKeys } from './keys';
import { ScriptRunner, type ScriptReply } from './scripts';

/* -------------------------------------------------------------------------- */
/* Result types                                                               */
/* -------------------------------------------------------------------------- */

export interface SessionIdentity {
  sessionId: string;
  instanceId: string;
  /** Salted hash of the client IP. The raw address never reaches Redis. */
  ipHash: string;
  /** Salted hash of the browser's persistent token. */
  clientHash: string;
}

export type CreateSessionResult = { status: 'ok'; createdAtMs: number };

export type JoinQueueResult =
  | { status: 'ok'; waiting: number }
  | { status: 'already_searching'; waiting: number }
  | { status: 'already_matched'; matchId: string }
  | { status: 'session_gone' };

export type LeaveQueueResult =
  | { status: 'ok' }
  | { status: 'already_matched'; matchId: string }
  | { status: 'session_gone' };

export type TryMatchAbortReason = 'session_gone' | 'already_matched' | 'not_searching';

export type TryMatchResult =
  | {
      status: 'matched';
      matchId: string;
      partnerSessionId: string;
      /** Stale queue entries this attempt removed on its way past them. */
      cleaned: number;
      /** Candidates left in the queue because a block applies to this searcher. */
      blockedSkipped: number;
    }
  | { status: 'waiting'; cleaned: number; blockedSkipped: number; queueDepth: number }
  | { status: 'abort'; reason: TryMatchAbortReason };

export type EndMatchResult =
  | { status: 'ended'; a: string; b: string; segment: string }
  | { status: 'already_ended' };

export type CloseSessionResult = {
  /** `gone` means the row had already expired; the cleanup still ran. */
  status: 'closed' | 'gone';
  /** The match this session was in, for the caller to end. */
  matchId: string | null;
};

export type HeartbeatResult =
  | { status: 'ok'; state: SessionState | ''; matchId: string | null }
  | { status: 'session_gone' };

export type ResolvePartnerResult =
  | { status: 'ok'; matchId: string; partnerSessionId: string; partnerInstanceId: string }
  | { status: 'not_matched' }
  | { status: 'partner_gone'; matchId: string }
  | { status: 'duplicate'; matchId: string }
  | { status: 'dedupe_full'; matchId: string };

export type BlockPartnerResult =
  | {
      status: 'blocked';
      matchId: string;
      partnerSessionId: string;
      /** Dimensions actually written. 0 when the partner's session row is gone. */
      recorded: number;
      /** True when this call was the one that ended the match, and so owes the peer a notification (D6). */
      endedByUs: boolean;
    }
  | { status: 'not_matched' };

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  /** Tokens left after this request. Diagnostic only — never sent to a client. */
  tokens: number;
}

export interface ConnRateResult {
  allowed: boolean;
  count: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

export interface ConnSlotResult {
  allowed: boolean;
  /** Concurrent sessions this IP hash holds after the operation. */
  count: number;
}

export interface Survivor {
  sessionId: string;
  matchId: string;
}

export interface JanitorQueueResult {
  removed: number;
  remaining: number;
}

export interface JanitorMatchesResult {
  dropped: number;
  ended: number;
  survivors: Survivor[];
}

export interface JanitorSessionsResult {
  reaped: number;
  ended: number;
  survivors: Survivor[];
}

export interface PresenceCounts {
  online: number;
  conversations: number;
}

/* -------------------------------------------------------------------------- */
/* Reply parsing                                                              */
/* -------------------------------------------------------------------------- */

function str(reply: ScriptReply, index: number): string {
  const value = reply[index];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function num(reply: ScriptReply, index: number): number {
  const value = reply[index];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** `''` is how the Lua says "no value"; an array cannot carry a nil in the middle. */
function orNull(value: string): string | null {
  return value === '' ? null : value;
}

/** Read the trailing `sid, mid, sid, mid, ...` tail the janitor scripts return. */
function survivorsFrom(reply: ScriptReply, offset: number): Survivor[] {
  const survivors: Survivor[] = [];
  for (let i = offset; i + 1 < reply.length; i += 2) {
    const sessionId = str(reply, i);
    const matchId = str(reply, i + 1);
    if (sessionId !== '' && matchId !== '') survivors.push({ sessionId, matchId });
  }
  return survivors;
}

class UnexpectedScriptReplyError extends Error {
  constructor(script: string, status: string) {
    // The status is script-authored, never user content, so it is safe to name.
    super(`redis script ${script} returned an unhandled status: ${status}`);
    this.name = 'UnexpectedScriptReplyError';
  }
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

export class RedisStore {
  private readonly sessionTtl: number;
  private readonly matchTtl: number;

  constructor(
    private readonly client: Redis,
    private readonly runner: ScriptRunner,
    private readonly keys: RedisKeys,
    private readonly config: Config,
  ) {
    this.sessionTtl = config.ttl.sessionSeconds;
    this.matchTtl = config.ttl.matchSeconds;
  }

  /* --- session lifecycle -------------------------------------------------- */

  /** Preserves I1: the session is created in exactly one state. */
  async createSession(identity: SessionIdentity, segment: string): Promise<CreateSessionResult> {
    const reply = await this.runner.run(
      'createSession',
      [this.keys.session(identity.sessionId), this.keys.sessions()],
      [
        this.keys.prefix,
        identity.sessionId,
        identity.instanceId,
        segment,
        identity.ipHash,
        identity.clientHash,
        this.sessionTtl,
      ],
    );
    return { status: 'ok', createdAtMs: num(reply, 1) };
  }

  /** Preserves I7: only a live connection refreshes a session's TTLs. */
  async heartbeat(sessionId: string): Promise<HeartbeatResult> {
    const reply = await this.runner.run(
      'heartbeat',
      [this.keys.session(sessionId), this.keys.userMatch(sessionId)],
      [this.keys.prefix, sessionId, this.sessionTtl, this.matchTtl],
    );
    if (str(reply, 0) === 'SESSION_GONE') return { status: 'session_gone' };
    return {
      status: 'ok',
      state: str(reply, 1) as SessionState | '',
      matchId: orNull(str(reply, 2)),
    };
  }

  /**
   * Preserves I3 and I7. Returns the match id, if any, for the caller to end —
   * `endMatch` cleans both sides, so this deliberately does not.
   */
  async closeSession(sessionId: string, ipHash: string): Promise<CloseSessionResult> {
    const reply = await this.runner.run(
      'closeSession',
      [
        this.keys.session(sessionId),
        this.keys.sessions(),
        this.keys.userMatch(sessionId),
        this.keys.connSessions(ipHash),
      ],
      [this.keys.prefix, sessionId],
    );
    return {
      status: str(reply, 0) === 'GONE' ? 'gone' : 'closed',
      matchId: orNull(str(reply, 1)),
    };
  }

  /* --- matchmaking -------------------------------------------------------- */

  /** Preserves I3 and D4: enqueue happens before any scan. */
  async joinQueue(sessionId: string, segment: string): Promise<JoinQueueResult> {
    const reply = await this.runner.run(
      'joinQueue',
      [
        this.keys.session(sessionId),
        this.keys.userMatch(sessionId),
        this.keys.queue(segment),
        this.keys.segments(),
      ],
      [this.keys.prefix, sessionId, segment, this.sessionTtl],
    );
    const status = str(reply, 0);
    switch (status) {
      case 'OK':
        return { status: 'ok', waiting: num(reply, 1) };
      case 'ALREADY_SEARCHING':
        return { status: 'already_searching', waiting: num(reply, 1) };
      case 'ALREADY_MATCHED':
        return { status: 'already_matched', matchId: str(reply, 1) };
      case 'SESSION_GONE':
        return { status: 'session_gone' };
      default:
        throw new UnexpectedScriptReplyError('joinQueue', status);
    }
  }

  /** Preserves I3. Idempotent for a session that is already IDLE. */
  async leaveQueue(sessionId: string, segment: string): Promise<LeaveQueueResult> {
    const reply = await this.runner.run(
      'leaveQueue',
      [
        this.keys.session(sessionId),
        this.keys.userMatch(sessionId),
        this.keys.queue(segment),
      ],
      [this.keys.prefix, sessionId, this.sessionTtl],
    );
    const status = str(reply, 0);
    switch (status) {
      case 'OK':
        return { status: 'ok' };
      case 'ALREADY_MATCHED':
        return { status: 'already_matched', matchId: str(reply, 1) };
      case 'SESSION_GONE':
        return { status: 'session_gone' };
      default:
        throw new UnexpectedScriptReplyError('leaveQueue', status);
    }
  }

  /** Preserves I2, I3, I4, I5 and I12. */
  async tryMatch(sessionId: string, segment: string, matchId: string): Promise<TryMatchResult> {
    const reply = await this.runner.run(
      'tryMatch',
      [
        this.keys.queue(segment),
        this.keys.session(sessionId),
        this.keys.userMatch(sessionId),
        this.keys.matches(),
        this.keys.match(matchId),
      ],
      [
        this.keys.prefix,
        sessionId,
        segment,
        matchId,
        this.config.matchmaking.candidateSample,
        this.matchTtl,
        this.sessionTtl,
        this.config.blocks.ipDimensionEnabled ? '1' : '0',
        this.config.blocks.clientDimensionEnabled ? '1' : '0',
      ],
    );
    const status = str(reply, 0);
    switch (status) {
      case 'MATCHED':
        return {
          status: 'matched',
          matchId: str(reply, 1),
          partnerSessionId: str(reply, 2),
          cleaned: num(reply, 3),
          blockedSkipped: num(reply, 4),
        };
      case 'WAITING':
        return {
          status: 'waiting',
          cleaned: num(reply, 1),
          blockedSkipped: num(reply, 2),
          queueDepth: num(reply, 3),
        };
      case 'ABORT':
        return { status: 'abort', reason: abortReason(str(reply, 1)) };
      default:
        throw new UnexpectedScriptReplyError('tryMatch', status);
    }
  }

  /** Preserves I4, I5 and I6. The `ended` caller is the one that notifies the peer (D6). */
  async endMatch(matchId: string): Promise<EndMatchResult> {
    const reply = await this.runner.run(
      'endMatch',
      [this.keys.match(matchId)],
      [this.keys.prefix, matchId, this.sessionTtl],
    );
    if (str(reply, 0) === 'ALREADY_ENDED') return { status: 'already_ended' };
    return { status: 'ended', a: str(reply, 1), b: str(reply, 2), segment: str(reply, 3) };
  }

  /* --- message routing ---------------------------------------------------- */

  /** Preserves I6 and I14. */
  async resolvePartner(sessionId: string, clientMsgId: string): Promise<ResolvePartnerResult> {
    const reply = await this.runner.run(
      'resolvePartner',
      [this.keys.userMatch(sessionId)],
      [
        this.keys.prefix,
        sessionId,
        clientMsgId,
        this.config.limits.dedupeMaxEntries,
        this.matchTtl,
      ],
    );
    const status = str(reply, 0);
    switch (status) {
      case 'OK':
        return {
          status: 'ok',
          matchId: str(reply, 1),
          partnerSessionId: str(reply, 2),
          partnerInstanceId: str(reply, 3),
        };
      case 'NOT_MATCHED':
        return { status: 'not_matched' };
      case 'PARTNER_GONE':
        return { status: 'partner_gone', matchId: str(reply, 1) };
      case 'DUPLICATE':
        return { status: 'duplicate', matchId: str(reply, 1) };
      case 'DEDUPE_FULL':
        return { status: 'dedupe_full', matchId: str(reply, 1) };
      default:
        throw new UnexpectedScriptReplyError('resolvePartner', status);
    }
  }

  /* --- limits ------------------------------------------------------------- */

  async rateLimit(
    command: RateLimitedCommand,
    sessionId: string,
    cost = 1,
  ): Promise<RateLimitResult> {
    const limit = this.config.limits.rates[command];
    const reply = await this.runner.run(
      'rateLimit',
      [this.keys.rateLimit(command, sessionId)],
      [
        this.keys.prefix,
        limit.perSecond,
        limit.burst,
        this.config.limits.rateLimitTtlSeconds,
        cost,
      ],
    );
    return {
      allowed: num(reply, 0) === 1,
      retryAfterMs: num(reply, 1),
      tokens: num(reply, 2),
    };
  }

  async connectionRateLimit(ipHash: string): Promise<ConnRateResult> {
    const reply = await this.runner.run(
      'connRateLimit',
      [this.keys.connRate(ipHash)],
      [
        this.keys.prefix,
        this.config.limits.connRateLimit,
        this.config.limits.connRateWindowSeconds,
      ],
    );
    return {
      allowed: num(reply, 0) === 1,
      count: num(reply, 1),
      resetSeconds: num(reply, 2),
    };
  }

  /** Claims one concurrency slot for this IP hash (R8). */
  async acquireConnectionSlot(ipHash: string, sessionId: string): Promise<ConnSlotResult> {
    const reply = await this.runner.run(
      'connAcquire',
      [this.keys.connSessions(ipHash)],
      [
        this.keys.prefix,
        sessionId,
        this.config.limits.maxConnectionsPerIp,
        this.sessionTtl,
      ],
    );
    return { allowed: num(reply, 0) === 1, count: num(reply, 1) };
  }

  async releaseConnectionSlot(ipHash: string, sessionId: string): Promise<number> {
    const reply = await this.runner.run(
      'connRelease',
      [this.keys.connSessions(ipHash)],
      [this.keys.prefix, sessionId],
    );
    return num(reply, 0);
  }

  /* --- safety ------------------------------------------------------------- */

  /**
   * Blocks the current partner and ends the match in one script (D18).
   * Preserves I12 together with the two-directional check inside `tryMatch`,
   * and I4/I6 through the shared match teardown.
   *
   * `recorded` is how many dimensions were actually written. It can be 0 with a
   * successful block — a partner whose session row has already expired has no
   * hashes left to record — and the caller must not report protection that was
   * not stored.
   */
  async blockPartner(sessionId: string): Promise<BlockPartnerResult> {
    const reply = await this.runner.run(
      'blockPartner',
      [this.keys.userMatch(sessionId)],
      [
        this.keys.prefix,
        sessionId,
        this.config.blocks.ttlSeconds,
        this.config.blocks.ipDimensionEnabled ? '1' : '0',
        this.config.blocks.clientDimensionEnabled ? '1' : '0',
        this.sessionTtl,
      ],
    );
    if (str(reply, 0) === 'NOT_MATCHED') return { status: 'not_matched' };
    return {
      status: 'blocked',
      matchId: str(reply, 1),
      partnerSessionId: str(reply, 2),
      recorded: num(reply, 3),
      endedByUs: num(reply, 4) === 1,
    };
  }

  /* --- janitor ------------------------------------------------------------ */

  async janitorQueue(segment: string): Promise<JanitorQueueResult> {
    const reply = await this.runner.run(
      'janitorQueue',
      [this.keys.queue(segment)],
      [this.keys.prefix, this.config.janitor.batch],
    );
    return { removed: num(reply, 0), remaining: num(reply, 1) };
  }

  async janitorMatches(): Promise<JanitorMatchesResult> {
    const reply = await this.runner.run(
      'janitorMatches',
      [this.keys.matches()],
      [this.keys.prefix, this.config.janitor.batch, this.sessionTtl],
    );
    return {
      dropped: num(reply, 0),
      ended: num(reply, 1),
      survivors: survivorsFrom(reply, 2),
    };
  }

  async janitorSessions(): Promise<JanitorSessionsResult> {
    const reply = await this.runner.run(
      'janitorSessions',
      [this.keys.sessions()],
      [this.keys.prefix, this.config.janitor.batch, this.sessionTtl],
    );
    return {
      reaped: num(reply, 0),
      ended: num(reply, 1),
      survivors: survivorsFrom(reply, 2),
    };
  }

  async janitorInstances(): Promise<{ removed: number; remaining: number }> {
    const reply = await this.runner.run(
      'janitorInstances',
      [this.keys.instances()],
      [this.keys.prefix, this.config.janitor.batch],
    );
    return { removed: num(reply, 0), remaining: num(reply, 1) };
  }

  /**
   * Take the janitor lock. Only the holder scans, so N instances do not each
   * walk the same sets every interval.
   */
  async acquireJanitorLock(instanceId: string): Promise<boolean> {
    const result = await this.client.set(
      this.keys.janitorLock(),
      instanceId,
      'EX',
      this.config.timers.janitorLockTtlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async refreshInstanceBeacon(instanceId: string): Promise<void> {
    await this.runner.run(
      'instanceBeacon',
      [this.keys.instance(instanceId), this.keys.instances()],
      [this.keys.prefix, instanceId, this.config.ttl.instanceHeartbeatSeconds],
    );
  }

  /* --- reads -------------------------------------------------------------- */

  /**
   * Real cardinalities for the `presence` frame (D21).
   *
   * `online` counts session rows, not sockets, and `conversations` counts live
   * match records. Both lag by whatever the caller caches them for, which is
   * why the protocol marks them approximate rather than pretending otherwise.
   */
  async presenceCounts(): Promise<PresenceCounts> {
    const [online, conversations] = await Promise.all([
      this.client.scard(this.keys.sessions()),
      this.client.scard(this.keys.matches()),
    ]);
    return { online, conversations };
  }

  async queueDepth(segment: string): Promise<number> {
    return this.client.scard(this.keys.queue(segment));
  }

  /** The session row, or null. Reads never mutate state. */
  async readSession(sessionId: string): Promise<Record<string, string> | null> {
    const hash = await this.client.hgetall(this.keys.session(sessionId));
    return Object.keys(hash).length === 0 ? null : hash;
  }

  async readMatch(matchId: string): Promise<Record<string, string> | null> {
    const hash = await this.client.hgetall(this.keys.match(matchId));
    return Object.keys(hash).length === 0 ? null : hash;
  }

  async currentMatchId(sessionId: string): Promise<string | null> {
    return this.client.get(this.keys.userMatch(sessionId));
  }

  /* --- cross-instance events ---------------------------------------------- */

  /**
   * Publish to a session's channel. The channel name is the routing key, so
   * there is no routing table to go stale (D8). A publish with no subscriber is
   * a no-op by design: every event reports state already committed in Redis.
   */
  async publishToSession(sessionId: string, payload: string): Promise<number> {
    return this.client.publish(this.keys.sessionChannel(sessionId), payload);
  }
}

function abortReason(raw: string): TryMatchAbortReason {
  switch (raw) {
    case 'SESSION_GONE':
      return 'session_gone';
    case 'ALREADY_MATCHED':
      return 'already_matched';
    default:
      return 'not_searching';
  }
}
