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
import type { MatchPreferences, Profile, SessionState } from '../protocol/types';
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

/**
 * What the preference did on one attempt (D44, §29.6).
 *
 * Reported on both outcomes because the interesting question is not only "did
 * the buyer get their preference" but "how hard did we have to look" — the
 * number that decides whether the sample size is right, and the one nobody has
 * because this service has never recorded what its pool is made of.
 */
export interface PreferenceOutcome {
  /**
   * How much of what was asked for the chosen candidate satisfied: gender 4,
   * country 2, intent 1, so 0 is an ordinary match and 7 is all three.
   *
   * The three are not all the same kind of thing and the number does not say
   * which contributed. Gender and country are premium preferences; intent is
   * free and symmetric (D45). A score of 1 is therefore an ordinary user
   * getting the one dimension everybody has, not a paying one getting almost
   * nothing — read it beside `chat_matches_preferred_total` rather than alone.
   *
   * A number rather than a flag because the interesting question at three
   * dimensions is not "did it work" but "how much of it worked". A population
   * scoring 4 has a preference that only ever matches on gender, which is the
   * signal that the other two are too rare to be worth offering.
   */
  score: number;
  /** True when anything at all was preferred — `score > 0`. */
  preferred: boolean;
  /** The ordinary sample held nothing at all, so the wider look was taken. */
  widened: boolean;
}

function preferenceOutcome(score: number, widened: number): PreferenceOutcome {
  return { score, preferred: score > 0, widened: widened === 1 };
}

export type TryMatchResult =
  | {
      status: 'matched';
      matchId: string;
      partnerSessionId: string;
      /** Stale queue entries this attempt removed on its way past them. */
      cleaned: number;
      /** Candidates left in the queue because a block applies to this searcher. */
      blockedSkipped: number;
      preference: PreferenceOutcome;
    }
  | {
      status: 'waiting';
      cleaned: number;
      blockedSkipped: number;
      queueDepth: number;
      preference: PreferenceOutcome;
    }
  | { status: 'abort'; reason: TryMatchAbortReason };

/**
 * Whether the identity write landed.
 *
 * `match_gone` is not an error: the conversation ended between being created
 * and being described, which races do. The caller's job is to stop rather than
 * to retry — there is nothing to write it to.
 */
export type SaveIdentitiesResult = { status: 'ok' } | { status: 'match_gone' };

export type EndMatchResult =
  | {
      status: 'ended';
      a: string;
      b: string;
      segment: string;
      /**
       * When the conversation started, so the caller can measure how long it
       * lasted. Zero when the match row predates this field or carried no
       * timestamp — the caller must treat zero as "unknown" and record nothing,
       * rather than reporting a duration measured from the epoch.
       */
      createdAtMs: number;
    }
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

export type SaveConnectionResult =
  | { status: 'made'; matchId: string; accountLo: string; accountHi: string }
  | { status: 'already'; matchId: string }
  | { status: 'pending'; matchId: string }
  | { status: 'withdrawn'; matchId: string }
  | { status: 'self'; matchId: string }
  | { status: 'not_matched' };

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
  /**
   * The matches this pass ended.
   *
   * Not just how many: the caller writes a `conversation_ended` retention row
   * for each, and a count cannot say which conversation to write it against.
   */
  endedMatchIds: string[];
}

export interface JanitorSessionsResult {
  reaped: number;
  ended: number;
  survivors: Survivor[];
  /** The matches this pass ended. See `JanitorMatchesResult`. */
  endedMatchIds: string[];
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
/**
 * Survivors from a nested list of flat `(sessionId, matchId)` pairs.
 *
 * The janitor replies used to run survivors to the end of the reply, which
 * meant nothing else could ever be appended — the parser had no way to know
 * where one list stopped. They are nested now, so the ended match ids sit
 * beside them without either having to be counted.
 */
function survivorsFromList(value: ScriptReply[number] | undefined): Survivor[] {
  const survivors: Survivor[] = [];
  if (!Array.isArray(value)) return survivors;
  for (let i = 0; i + 1 < value.length; i += 2) {
    const sessionId = str(value, i);
    const matchId = str(value, i + 1);
    if (sessionId !== '' && matchId !== '') survivors.push({ sessionId, matchId });
  }
  return survivors;
}

/** A nested list of plain strings, ignoring anything that is not one. */
function stringsFrom(value: ScriptReply[number] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = str(value, i);
    if (item !== '') out.push(item);
  }
  return out;
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
 * A stored nickname, or null for anything that is not a non-empty string.
 *
 * An empty string is treated as absent rather than shown: it would render as a
 * blank label with no way for either side to refer to the other, which is worse
 * than the fresh name the caller draws instead.
 */
function nickFromReply(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

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

  /**
   * Store both display identities on the match, so a resume can restore them.
   *
   * Reports whether the match was still there. It is written by a script and
   * not by a bare `HSET` because an `HSET` recreates a deleted key — see the
   * note on the script for what that leaves behind and why nothing collects it.
   */
  async saveMatchIdentities(
    matchId: string,
    identityA: string,
    identityB: string,
  ): Promise<SaveIdentitiesResult> {
    const reply = await this.runner.run(
      'saveMatchIdentities',
      [this.keys.match(matchId)],
      [this.keys.prefix, identityA, identityB],
    );
    return str(reply, 0) === 'OK' ? { status: 'ok' } : { status: 'match_gone' };
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

  /**
   * Preserves I2, I3, I4, I5 and I12.
   *
   * `preferGenders` is a **preference and never a filter** (D44): if nobody in
   * view matches it, this returns an ordinary match on the same pass. An empty
   * list is the ordinary path and costs nothing — the script skips both the
   * membership test and the wider sample.
   *
   * The list is comma-wrapped here rather than in Lua so the script's test can
   * be a plain substring find with no pattern semantics: `,male,` must not be
   * found inside `,female,`.
   */
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
        this.config.preference.enabled ? '1' : '0',
        this.config.preference.wideSample,
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
          preference: preferenceOutcome(num(reply, 5), num(reply, 6)),
        };
      case 'WAITING':
        return {
          status: 'waiting',
          cleaned: num(reply, 1),
          blockedSkipped: num(reply, 2),
          queueDepth: num(reply, 3),
          preference: preferenceOutcome(num(reply, 4), num(reply, 5)),
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
    return {
      status: 'ended',
      a: str(reply, 1),
      b: str(reply, 2),
      segment: str(reply, 3),
      createdAtMs: num(reply, 4),
    };
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

  /**
   * Record one side's consent to save the other (D47, §31).
   *
   * The reply carries both account ids on the completing call, because the
   * script had both in hand and reading them back from two session hashes would
   * open a window in which one expires between the agreement and the lookup of
   * who agreed.
   *
   * `made` is returned to exactly one of the two callers — the second to press
   * — so the caller can announce the connection once. A repeat of that press
   * comes back as `already`, which is success without a second announcement.
   */
  async saveConnection(
    sessionId: string,
    accountId: string,
    active: boolean,
  ): Promise<SaveConnectionResult> {
    const reply = await this.runner.run(
      'saveConnection',
      [this.keys.userMatch(sessionId)],
      [
        this.keys.prefix,
        sessionId,
        accountId,
        active ? '1' : '0',
        String(this.matchTtl),
      ],
    );
    const status = str(reply, 0);
    switch (status) {
      case 'MADE':
        return {
          status: 'made',
          matchId: str(reply, 1),
          accountLo: str(reply, 2),
          accountHi: str(reply, 3),
        };
      case 'AGAIN':
        return { status: 'already', matchId: str(reply, 1) };
      case 'PENDING':
        return { status: 'pending', matchId: str(reply, 1) };
      case 'WITHDRAWN':
        return { status: 'withdrawn', matchId: str(reply, 1) };
      // One account on both sides of a conversation. Reported rather than
      // silently treated as pending, so the two tabs it actually means are
      // distinguishable from a partner who has not pressed anything.
      case 'SELF':
        return { status: 'self', matchId: str(reply, 1) };
      case 'NOT_MATCHED':
        return { status: 'not_matched' };
      default:
        throw new UnexpectedScriptReplyError('saveConnection', status);
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

  /**
   * Fixed-window limit on order creation from one IP hash.
   *
   * Reuses the connection-rate script, which is a plain windowed counter and
   * carries no assumption about what it is counting. A second script would be
   * the same eight lines of Lua with a different name, and every Lua script
   * here is something that has to be race-tested.
   *
   * Keyed on the address rather than the account, and that is the point: the
   * expensive case is an unauthenticated caller making this process talk to the
   * payment provider in a loop, and an unauthenticated caller has no account to
   * key on.
   */
  async paymentRateLimit(ipHash: string): Promise<ConnRateResult> {
    const reply = await this.runner.run(
      'connRateLimit',
      [this.keys.paymentRate(ipHash)],
      [
        this.keys.prefix,
        this.config.payments.createRateLimit,
        this.config.payments.createRateWindowSeconds,
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
   * Store what a session is looking for, on the session hash beside its profile.
   *
   * Comma-wrapped here rather than in Lua so the script's membership test can be
   * a plain substring find with no pattern semantics: `,male,` must not be found
   * inside `,female,`.
   *
   * Written whole and cleared field by field, the same rule the profile follows:
   * a join carries the entire preference, so a dimension the client stopped
   * sending has to disappear rather than linger and keep steering matches the
   * user thought they had stopped asking for.
   *
   * Refused entirely while the feature is off, so a session queued before an
   * operator switched it on carries nothing. The script checks the flag too —
   * one guard is where the data comes from, the other is what reads it.
   */
  async setPreferences(sessionId: string, preferences: MatchPreferences): Promise<void> {
    const key = this.keys.session(sessionId);
    const set: string[] = [];
    const clear: string[] = [];

    const put = (field: string, values: readonly string[]): void => {
      if (this.config.preference.enabled && values.length > 0) {
        set.push(field, `,${values.join(',')},`);
      } else {
        clear.push(field);
      }
    };
    put('prefG', preferences.genders);
    put('prefC', preferences.countries);

    const pipeline = this.client.pipeline();
    if (set.length > 0) pipeline.hset(key, ...set);
    if (clear.length > 0) pipeline.hdel(key, ...clear);
    await pipeline.exec();
  }

  /**
   * Store what a session is here for (D45, §30).
   *
   * A single value, written whole, cleared when declined — the same
   * session-scoped rule the profile and the preference follow (D34).
   *
   * Separate from `setPreferences` because it is **not gated on
   * `preference.enabled`**. Intent is symmetric and ships to everybody, while
   * the premium dimensions are asymmetric and do not. Folding the two together
   * would have put a free feature behind a paid flag with nothing in the types
   * to notice, which is precisely the shape of failure this codebase keeps
   * finding: configured, healthy, silently doing nothing.
   */
  async setIntent(sessionId: string, intent: string | null): Promise<void> {
    const key = this.keys.session(sessionId);
    if (intent === null) await this.client.hdel(key, 'intent');
    else await this.client.hset(key, 'intent', intent);
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
    // The field list is the entire path from the session hash to a partner's
    // screen, and it is exhaustive rather than a projection of something wider.
    // `intent` is deliberately not in it (D45, §30.1): a value that is never
    // read here can never be displayed, which is a stronger guarantee than a
    // renderer remembering to omit it.
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

  /**
   * Pin the display nickname to the session.
   *
   * A plain `HSET`, for the same reason `setAccount` below is one: a fact about
   * one connection, written once by that connection, that no matchmaking
   * transition branches on. It is written immediately after `createSession`
   * rather than inside its Lua because nothing races for it — no other instance
   * has heard of this session yet.
   *
   * Being on the session hash is what scopes it: the hash is the session, so
   * the nickname lives exactly as long as one and needs nothing to clean it up.
   * A resume re-attaches the same hash, so reconnecting inside the grace window
   * keeps the name, which is the same continuity the resume exists to provide.
   */
  async setNickname(sessionId: string, nickname: string): Promise<void> {
    await this.client.hset(this.keys.session(sessionId), 'nick', nickname);
  }

  /**
   * Both sides' nicknames, for the match about to be announced.
   *
   * Deliberately its own method and its own pipeline rather than another field
   * on `readProfiles`. That field list is exhaustive on purpose — a value never
   * read there can never reach a stranger's screen — and widening it for an
   * unrelated value is how that guarantee stops being one. This is off the
   * message path, on the same branch as the profile read, so the second round
   * trip costs a match nothing anybody can perceive.
   *
   * Null for a session whose hash has expired, or one created before nicknames
   * were stored. The caller draws a fresh name for it.
   */
  async readNicknames(
    sessionA: string,
    sessionB: string,
  ): Promise<{ a: string | null; b: string | null }> {
    const results = await this.client
      .pipeline()
      .hget(this.keys.session(sessionA), 'nick')
      .hget(this.keys.session(sessionB), 'nick')
      .exec();

    return { a: nickFromReply(results?.[0]?.[1]), b: nickFromReply(results?.[1]?.[1]) };
  }

  /**
   * Record which account a session is signed in as.
   *
   * A plain `HSET`, and that is not an exception to the Lua rule. That rule is
   * about *state transitions*, which must not interleave across instances. This
   * is a fact about one connection, written once by the connection itself, that
   * nothing in matchmaking branches on — the same category as the declared
   * profile, and written the same way.
   *
   * It exists so the other side of a conversation can be offered a presence
   * token. Nothing reads it to decide a match, and it must stay out of
   * `readProfiles`, whose field list is exhaustive precisely so that a value
   * never read there can never reach a stranger's screen.
   */
  async setAccount(sessionId: string, accountId: string): Promise<void> {
    await this.client.hset(this.keys.session(sessionId), 'account', accountId);
  }

  /**
   * Move a session into a different queue segment.
   *
   * A plain `HSET`, like the account and the profile beside it: the segment is
   * written by the session's own connection and no transition branches on it
   * mid-flight — the scripts take it as an argument, so what matters is that
   * the argument is right when they are called, not that the write is atomic
   * with them.
   *
   * The seam has existed since day one (R6, D23) with only `default` in it.
   * This is the first thing to use it, and it uses it for the reason it was
   * kept: a private lane means `tryMatch` pairs two people without a new
   * script, so every guard it already applies — blocks in both directions,
   * bans, preferences — applies here for free. Duplicating those into a
   * bespoke pairing script is the version of this feature that gets somebody
   * matched with a person they blocked.
   */
  async setSegment(sessionId: string, segment: string): Promise<void> {
    await this.client.hset(this.keys.session(sessionId), 'segment', segment);
  }

  /** Which queue a session is in. Falls back to the default. */
  async readSegment(sessionId: string, fallback: string): Promise<string> {
    const value = await this.client.hget(this.keys.session(sessionId), 'segment');
    return typeof value === 'string' && value !== '' ? value : fallback;
  }

  /** Both sides' block keys, for a pair that is not in a conversation. */
  async readBlockKeys(
    sessionA: string,
    sessionB: string,
  ): Promise<{
    a: { ipHash: string; clientHash: string } | null;
    b: { ipHash: string; clientHash: string } | null;
  }> {
    const fields = ['ipHash', 'clientHash'] as const;
    const results = await this.client
      .pipeline()
      .hmget(this.keys.session(sessionA), ...fields)
      .hmget(this.keys.session(sessionB), ...fields)
      .exec();
    const read = (i: number): { ipHash: string; clientHash: string } | null => {
      const row = results?.[i]?.[1] as (string | null)[] | undefined;
      const ipHash = row?.[0] ?? '';
      const clientHash = row?.[1] ?? '';
      // A session that has expired has no hashes, and blocking nothing is not
      // an error — it is the person already being gone.
      return ipHash === '' && clientHash === '' ? null : { ipHash, clientHash };
    };
    return { a: read(0), b: read(1) };
  }

  /**
   * Block a pair who are not in a conversation together.
   *
   * Plain `SADD`s, and that is not an exception to the Lua rule. `blockPartner`
   * is a script because it *ends a match* as well — a state transition that
   * must not interleave. This ends nothing: it writes the same two sets that
   * script writes, for two sessions that were never matched here, and
   * `tryMatch` reads them the same way afterwards.
   *
   * Both dimensions and one direction: the block belongs to the person pressing
   * it. `tryMatch` already checks both directions, so writing one is enough for
   * neither to reach the other (D18).
   */
  async blockPair(
    mine: { ipHash: string; clientHash: string },
    theirs: { ipHash: string; clientHash: string },
    ttlSeconds: number,
  ): Promise<Array<{ dimension: 'ip' | 'client'; blockerKey: string; blockedKey: string }>> {
    const written: Array<{ dimension: 'ip' | 'client'; blockerKey: string; blockedKey: string }> = [];
    const pipeline = this.client.pipeline();
    const pairs = [
      { dimension: 'ip' as const, blockerKey: mine.ipHash, blockedKey: theirs.ipHash },
      { dimension: 'client' as const, blockerKey: mine.clientHash, blockedKey: theirs.clientHash },
    ];
    for (const pair of pairs) {
      if (pair.blockerKey === '' || pair.blockedKey === '') continue;
      pipeline.sadd(this.keys.blocks(pair.blockerKey), pair.blockedKey);
      pipeline.expire(this.keys.blocks(pair.blockerKey), ttlSeconds);
      written.push(pair);
    }
    if (written.length > 0) await pipeline.exec();
    return written;
  }

  /** Each side's account, or null where that side is signed out. */
  async readAccounts(
    sessionA: string,
    sessionB: string,
  ): Promise<{ a: string | null; b: string | null }> {
    const results = await this.client
      .pipeline()
      .hget(this.keys.session(sessionA), 'account')
      .hget(this.keys.session(sessionB), 'account')
      .exec();
    const read = (i: number): string | null => {
      const value = results?.[i]?.[1];
      return typeof value === 'string' && value !== '' ? value : null;
    };
    return { a: read(0), b: read(1) };
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
      survivors: survivorsFromList(reply[2]),
      endedMatchIds: stringsFrom(reply[3]),
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
      survivors: survivorsFromList(reply[2]),
      endedMatchIds: stringsFrom(reply[3]),
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
   * What the waiting pool is made of, by declared gender (§29.6).
   *
   * The denominator for every preference number. A fallback rate is unreadable
   * without it: "the preference missed 40% of the time" means something very
   * different in a pool that is 5% preferred than in one that is 40%.
   *
   * Bounded by `cap` and sampled above it, because this runs on a timer and the
   * cost is one read per waiting session. At launch volumes the cap is never
   * reached, so the answer is exact; past it this becomes a sample of the pool,
   * which is what the caller must label it as rather than reporting an estimate
   * as a census (D21 is the same rule about a different number).
   *
   * Sessions that declared nothing are counted under `none` rather than
   * dropped. They are part of the pool and a preference can never match them,
   * so leaving them out would make the preferred share look larger than it is.
   */
  async queueComposition(segment: string, cap = 500): Promise<Record<string, number>> {
    const members: string[] = await this.client.srandmember(this.keys.queue(segment), cap);
    const counts: Record<string, number> = {};
    if (members.length === 0) return counts;

    const pipeline = this.client.pipeline();
    for (const sid of members) pipeline.hget(this.keys.session(sid), 'pGender');
    const replies = await pipeline.exec();

    for (const entry of replies ?? []) {
      const [err, value] = entry as [Error | null, string | null];
      // A session that vanished between the sample and the read is not an
      // error and is not a gender: it is simply no longer in the pool.
      if (err) continue;
      const gender = value === null || value === '' ? 'none' : value;
      counts[gender] = (counts[gender] ?? 0) + 1;
    }
    return counts;
  }


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
