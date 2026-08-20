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
import type { Profile, SessionState } from '../protocol/types';
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

export type ResumeSessionResult =
  | {
      status: 'resumed';
      sessionId: string;
      matchId: string | null;
      state: SessionState;
      ipHash: string;
      clientHash: string;
    }
  /** No such token, or the session it named is gone. */
  | { status: 'no_session' }
  /** The session is still attached: a live conversation is not transferable. */
  | { status: 'not_detached' };

export type CloseSessionResult = {
  /**
   * `gone` means the row had already expired; the cleanup still ran.
   *
   * `detached` means the socket dropped mid-conversation and the seat is being
   * held: the match is **not** ended, the row stays with the grace window as
   * its TTL, and the caller must tell the partner someone is reconnecting
   * rather than that they left.
   */
  status: 'closed' | 'gone' | 'detached';
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

export type ResolveRouteResult =
  | { status: 'ok'; matchId: string; partnerSessionId: string; partnerInstanceId: string }
  | { status: 'partner_gone'; matchId: string }
  | { status: 'not_matched' };

export type BlockPartnerResult =
  | {
      status: 'blocked';
      matchId: string;
      partnerSessionId: string;
      /** Dimensions actually written. 0 when the partner's session row is gone. */
      recorded: number;
      /** True when this call was the one that ended the match, and so owes the peer a notification (D6). */
      endedByUs: boolean;
      /** The blocked party's salted hashes, for the database row. Empty when their session had expired. */
      blockedIpHash: string;
      blockedClientHash: string;
    }
  | { status: 'not_matched' };

/** Which identity dimension a sanction was written against (D18). */
export type EnforcementDimension = 'ip' | 'client';

/**
 * The upgrade path's answer to "may this connection exist".
 *
 * `dimension` is carried so the refusal can be counted by dimension without
 * the hash itself ever reaching a metric label — a hash is still an identifier
 * (I8), and a per-hash label would additionally be unbounded cardinality.
 */
export type BanCheck =
  | { banned: false }
  | { banned: true; dimension: EnforcementDimension; enforcementId: string };

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

/**
 * Rebuild a profile from three raw hash fields.
 *
 * Returns null when nothing was declared, so "no profile" and "a profile of
 * three nulls" are the same value downstream rather than two shapes a renderer
 * has to handle. An unparseable age is dropped rather than shown: the field is
 * written by this process from a validated integer, so a bad value means
 * corruption, and a corrupt age displayed to a stranger is worse than none.
 */
function profileFromFields(raw: unknown): Profile | null {
  if (!Array.isArray(raw)) return null;
  const [name, country, age, gender] = raw as (string | null)[];
  const parsedAge = typeof age === 'string' ? Number.parseInt(age, 10) : Number.NaN;
  const profile: Profile = {
    name: typeof name === 'string' && name.length > 0 ? name : null,
    country: typeof country === 'string' && country.length > 0 ? country : null,
    age: Number.isInteger(parsedAge) ? parsedAge : null,
    gender: typeof gender === 'string' && gender.length > 0 ? gender : null,
  };
  if (
    profile.name === null &&
    profile.country === null &&
    profile.age === null &&
    profile.gender === null
  ) {
    return null;
  }
  return profile;
}

export class RedisStore {
  private readonly sessionTtl: number;
  /**
   * How long a departed partner stays blockable after the match ends.
   *
   * Zero disables the record entirely, and the teardown then behaves exactly as
   * it did before this existed.
   */
  private readonly lateBlockTtl: number;
  /** Seconds a dropped socket keeps its seat. 0 restores the old behaviour. */
  private readonly resumeGraceSeconds: number;
  private readonly matchTtl: number;

  constructor(
    private readonly client: Redis,
    private readonly runner: ScriptRunner,
    private readonly keys: RedisKeys,
    private readonly config: Config,
  ) {
    this.sessionTtl = config.ttl.sessionSeconds;
    this.matchTtl = config.ttl.matchSeconds;
    this.lateBlockTtl = config.blocks.lateBlockSeconds;
    this.resumeGraceSeconds = config.resume.graceSeconds;
  }

  /* --- session lifecycle -------------------------------------------------- */

  /** Preserves I1: the session is created in exactly one state. */
  async createSession(
    identity: SessionIdentity,
    segment: string,
    resumeHash = '',
  ): Promise<CreateSessionResult> {
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
        resumeHash,
      ],
    );
    return { status: 'ok', createdAtMs: num(reply, 1) };
  }

  /**
   * Redeem a resume token, re-attaching its session to this instance.
   *
   * The caller passes the hash of the token the client presented and the hash
   * of the replacement it will be given. Rotation is not optional: a token that
   * survived one resume would still work after the person it belongs to has
   * reconnected, which is the difference between a single-use credential and a
   * standing one.
   */
  async resumeSession(
    presentedHash: string,
    replacementHash: string,
    instanceId: string,
  ): Promise<ResumeSessionResult> {
    const reply = await this.runner.run(
      'resumeSession',
      [this.keys.resume(presentedHash)],
      [this.keys.prefix, presentedHash, replacementHash, instanceId, this.sessionTtl],
    );
    const status = str(reply, 0);
    if (status === 'NO_SESSION') return { status: 'no_session' };
    if (status === 'NOT_DETACHED') return { status: 'not_detached' };
    return {
      status: 'resumed',
      sessionId: str(reply, 1),
      matchId: orNull(str(reply, 2)),
      state: (str(reply, 3) || 'IDLE') as SessionState,
      ipHash: str(reply, 4),
      clientHash: str(reply, 5),
    };
  }

  /** Store both display identities on the match, so a resume can restore them. */
  async saveMatchIdentities(matchId: string, identityA: string, identityB: string): Promise<void> {
    await this.client.hset(this.keys.match(matchId), 'identA', identityA, 'identB', identityB);
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
  async closeSession(
    sessionId: string,
    ipHash: string,
    holdSeat = true,
  ): Promise<CloseSessionResult> {
    const reply = await this.runner.run(
      'closeSession',
      [
        this.keys.session(sessionId),
        this.keys.sessions(),
        this.keys.userMatch(sessionId),
        this.keys.connSessions(ipHash),
      ],
      [this.keys.prefix, sessionId, holdSeat ? this.resumeGraceSeconds : 0],
    );
    const status = str(reply, 0);
    return {
      status: status === 'GONE' ? 'gone' : status === 'DETACHED' ? 'detached' : 'closed',
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
      [this.keys.prefix, matchId, this.sessionTtl, this.lateBlockTtl],
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

  /**
   * Resolve the recipient without consuming a dedupe id.
   *
   * For advisory traffic only. A typing indicator has no replay to protect
   * against, and routing it through `resolvePartner` would burn a message id
   * per keystroke and let a client exhaust its own dedupe set by typing.
   */
  async resolveRoute(sessionId: string): Promise<ResolveRouteResult> {
    const reply = await this.runner.run(
      'resolveRoute',
      [this.keys.userMatch(sessionId)],
      [this.keys.prefix, sessionId],
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
      case 'PARTNER_GONE':
        return { status: 'partner_gone', matchId: str(reply, 1) };
      case 'NOT_MATCHED':
        return { status: 'not_matched' };
      default:
        throw new UnexpectedScriptReplyError('resolveRoute', status);
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
        this.lateBlockTtl,
      ],
    );
    if (str(reply, 0) === 'NOT_MATCHED') return { status: 'not_matched' };
    return {
      status: 'blocked',
      matchId: str(reply, 1),
      partnerSessionId: str(reply, 2),
      recorded: num(reply, 3),
      endedByUs: num(reply, 4) === 1,
      blockedIpHash: str(reply, 5),
      blockedClientHash: str(reply, 6),
    };
  }

  /* --- declared profile --------------------------------------------------- */

  /**
   * Store what a session chose to declare about itself, on the session hash.
   *
   * Plain `HSET`/`HDEL` rather than Lua, and that is not an exception to the
   * rule: a profile is display data, not matchmaking state. Nothing branches on
   * it, no invariant spans it, and two instances writing it cannot interleave
   * into an inconsistent state because only the session's own connection ever
   * writes it.
   *
   * A null field is **deleted**, not written as an empty string. `join_queue`
   * carries the whole profile every time, so a field the client stopped sending
   * has to disappear — otherwise clearing a name would leave the old one on the
   * hash and the partner would be shown something the user thought they had
   * removed.
   */
  async setProfile(sessionId: string, profile: Profile): Promise<void> {
    const key = this.keys.session(sessionId);
    const set: string[] = [];
    const clear: string[] = [];

    if (profile.name !== null) set.push('pName', profile.name);
    else clear.push('pName');
    if (profile.country !== null) set.push('pCountry', profile.country);
    else clear.push('pCountry');
    if (profile.age !== null) set.push('pAge', String(profile.age));
    else clear.push('pAge');
    if (profile.gender !== null) set.push('pGender', profile.gender);
    else clear.push('pGender');

    const pipeline = this.client.pipeline();
    if (set.length > 0) pipeline.hset(key, ...set);
    if (clear.length > 0) pipeline.hdel(key, ...clear);
    await pipeline.exec();
  }

  /**
   * Read both sides' declared profiles when a match forms.
   *
   * Deliberately *beside* `tryMatch` rather than inside it. The match script is
   * the most race-tested code in the system and its return shape is parsed
   * positionally; widening it to carry six display fields would mean
   * re-verifying every matchmaking race to ship a nickname. This runs once per
   * conversation, never on the message path.
   *
   * A session whose hash has expired between the match and this read yields a
   * null profile, which renders as the generated nickname — degraded, not
   * wrong. `tryMatch` has just refreshed both TTLs, so the window is small.
   */
  async readProfiles(
    sessionA: string,
    sessionB: string,
  ): Promise<{ a: Profile | null; b: Profile | null }> {
    const fields = ['pName', 'pCountry', 'pAge', 'pGender'] as const;
    const results = await this.client
      .pipeline()
      .hmget(this.keys.session(sessionA), ...fields)
      .hmget(this.keys.session(sessionB), ...fields)
      .exec();

    return {
      a: profileFromFields(results?.[0]?.[1]),
      b: profileFromFields(results?.[1]?.[1]),
    };
  }

  /* --- enforcement -------------------------------------------------------- */

  /**
   * Whether either of a connection's two identity hashes is under a ban (I11).
   *
   * Plain commands rather than a Lua script, deliberately, and this is not an
   * exception to the rule in `CLAUDE.md`. That rule exists for *state
   * transitions*, which must not interleave across instances. This is a read of
   * two independent keys that mutates nothing; there is no invariant spanning
   * them and no write to lose. `MGET` keeps it to one round trip on the
   * connection path, where a second one would be paid by every user.
   *
   * A ban racing a connection is settled by whichever reaches Redis first, and
   * that is correct rather than merely tolerable: a session opened microseconds
   * before the ban landed is one the janitor and the TTL will reap anyway, and
   * the ban still refuses every later reconnection.
   */
  async checkBan(ipHash: string, clientHash: string): Promise<BanCheck> {
    if (!this.config.enforcement.enabled) return { banned: false };
    const [byIp, byClient] = await this.client.mget(
      this.keys.ban(ipHash),
      this.keys.ban(clientHash),
    );
    // IP first only because it is the coarser of the two; either alone refuses.
    if (typeof byIp === 'string') return { banned: true, dimension: 'ip', enforcementId: byIp };
    if (typeof byClient === 'string') {
      return { banned: true, dimension: 'client', enforcementId: byClient };
    }
    return { banned: false };
  }

  /**
   * Write a ban key for one subject hash.
   *
   * The value is the `enforcement.enforcement_id` that caused it, so a refusal
   * observed in production can be traced to the row that ordered it and to the
   * `admin_audit` row that justifies it. Without that link a ban is an
   * unexplained outage for the person on the other end of it.
   *
   * Idempotent: re-issuing the same ban resets the TTL and overwrites with the
   * newer enforcement id, which is what a moderator extending a sanction means.
   */
  async applyBan(subjectKey: string, enforcementId: string, ttlSeconds: number): Promise<void> {
    if (!this.config.enforcement.enabled) return;
    await this.client.set(this.keys.ban(subjectKey), enforcementId, 'EX', ttlSeconds);
  }

  /**
   * Lift a ban. Returns whether a key was actually removed, so the caller can
   * tell a revocation from a no-op instead of reporting success either way —
   * a ban that expired on its own and one that never existed are different
   * facts to an operator reading an audit trail.
   */
  async revokeBan(subjectKey: string): Promise<boolean> {
    return (await this.client.del(this.keys.ban(subjectKey))) > 0;
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
      [this.keys.prefix, this.config.janitor.batch, this.sessionTtl, this.lateBlockTtl],
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
      [this.keys.prefix, this.config.janitor.batch, this.sessionTtl, this.lateBlockTtl],
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

  /**
   * Take the deletion lock. A separate key from the janitor's: the two do
   * unrelated work at very different intervals, and one lock would make the
   * slower of them starve the other.
   */
  async acquireDeletionLock(instanceId: string): Promise<boolean> {
    const result = await this.client.set(
      this.keys.deletionLock(),
      instanceId,
      'EX',
      Math.max(60, Math.ceil(this.config.deletion.intervalMs / 1000)),
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
