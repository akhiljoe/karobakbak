/**
 * The persona kill switch (D-AI-9).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Four levers, and the first three live here:
 *
 *   global    — the panic switch
 *   character — one persona behaving badly, without losing the rest
 *   provider  — a vendor outage, a price change, or a refusal storm
 *   hours     — a schedule, and the one that is `Config` rather than state
 *
 * ---------------------------------------------------------------------------
 * DRAIN, NOT KILL
 * ---------------------------------------------------------------------------
 * Disabling stops new personas joining and lets conversations already running
 * finish. Cutting a live conversation mid-sentence is indistinguishable from a
 * bug to the person on the other end, and it destroys exactly the experience
 * the feature exists to create.
 *
 * The distinction already exists in this codebase: the WebSocket close handler
 * passes `holdSeat: !draining` for the same reason, because a shutdown is not a
 * blip. `mode: 'hard'` exists for when cutting *is* the point.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED, AND WHAT THAT ACTUALLY MEANS
 * ---------------------------------------------------------------------------
 * If the control state cannot be read, no persona joins.
 *
 * This is the opposite of the usual instinct and matches D30's reasoning about
 * the ban check: failing open would mean an infrastructure wobble silently
 * re-enables a feature that spends money per message, and nobody finds out
 * until the invoice. A persona failing to join costs one conversation that
 * would have been with a bot.
 *
 * "Read successfully and found no row" is a **different** condition and means
 * enabled. Conflating the two would require writing a row per character just to
 * say nothing is wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY POSTGRES IS THE TRUTH
 * ---------------------------------------------------------------------------
 * Redis persistence is off (D12). A switch living only there returns to its
 * compiled-in default on restart — so personas either turn themselves back on
 * after being turned off, or stay off after being turned on. Both are
 * discovered late. `reconcile()` replays the table, exactly as
 * `reapplyActiveBans` replays sanctions and for the same reason.
 */

import type { Logger } from '../logger';
import { dbErrorFields, errorFields } from '../logger';
import type { Database } from '../storage/pool';

/**
 * The three Redis commands this needs, and nothing else.
 *
 * Narrower than `RedisClients['command']` on purpose. The switch is read on a
 * path that must keep working when Redis is unhealthy, so depending on the full
 * client would drag in reconnection behaviour that has nothing to do with the
 * question being asked — and it makes the failure cases here testable without
 * standing up a server, which is the difference between them being tested and
 * being assumed.
 */
export interface ControlCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export const CONTROL_SCOPES = ['global', 'character', 'provider'] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];

export const CONTROL_MODES = ['drain', 'hard'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/** Why a persona was refused. A metric label, so the set stays closed and small. */
export type RefusalReason =
  | 'global_disabled'
  | 'character_disabled'
  | 'provider_disabled'
  | 'outside_hours'
  | 'unreadable';

export interface ControlDecision {
  readonly allowed: boolean;
  /** Absent when allowed. */
  readonly reason?: RefusalReason;
  /**
   * Whether a conversation already running should also stop.
   *
   * False for a `drain` disable — the point of draining is that live
   * conversations finish. True only for `hard`.
   */
  readonly stopExisting: boolean;
}

const ALLOWED: ControlDecision = { allowed: true, stopExisting: false };

export interface ControlRow {
  readonly scope: ControlScope;
  readonly subject: string;
  readonly enabled: boolean;
  readonly mode: ControlMode;
  readonly updatedBy: string;
  readonly reason: string | null;
}

/**
 * When personas may run at all.
 *
 * A schedule rather than a switch, so it is configuration. Half-open —
 * `[startHour, endHour)` — and expressed in whole hours because the point is
 * "roughly when people are awake here", not a cron expression.
 *
 * `startHour === endHour` means always, which is the natural reading of an
 * empty window and avoids a separate "enabled" flag for the schedule itself.
 */
export interface ActiveHours {
  readonly startHour: number;
  readonly endHour: number;
  /** Minutes to add to UTC. India is 330. */
  readonly utcOffsetMinutes: number;
}

export const ALWAYS_ACTIVE: ActiveHours = { startHour: 0, endHour: 0, utcOffsetMinutes: 0 };

/**
 * Is `now` inside the window?
 *
 * Handles a window that wraps midnight, which is the common case for a chat
 * product: 20:00 to 02:00 is a perfectly ordinary thing to want and the naive
 * comparison gets it exactly backwards.
 */
export function withinHours(hours: ActiveHours, now: Date): boolean {
  if (hours.startHour === hours.endHour) return true;

  const local = new Date(now.getTime() + hours.utcOffsetMinutes * 60_000);
  const hour = local.getUTCHours();

  return hours.startHour < hours.endHour
    ? hour >= hours.startHour && hour < hours.endHour
    : hour >= hours.startHour || hour < hours.endHour;
}

export interface PersonaControlOptions {
  readonly db: Database;
  readonly redis: ControlCache;
  readonly logger: Logger;
  /** `chat:persona:control` by default; injected so tests can isolate. */
  readonly cacheKey: string;
  /** How long the Redis mirror is trusted before it is refreshed. */
  readonly cacheTtlSeconds: number;
  readonly hours: ActiveHours;
}

/**
 * Reads and writes the switch.
 *
 * Reads go to Redis, fall back to PostgreSQL, and refuse if both fail. Writes
 * go to PostgreSQL and invalidate the mirror, never the other way round.
 */
export class PersonaControl {
  private readonly db: Database;
  private readonly redis: ControlCache;
  private readonly logger: Logger;
  private readonly cacheKey: string;
  private readonly cacheTtlSeconds: number;
  private readonly hours: ActiveHours;

  constructor(options: PersonaControlOptions) {
    this.db = options.db;
    this.redis = options.redis;
    this.logger = options.logger;
    this.cacheKey = options.cacheKey;
    this.cacheTtlSeconds = options.cacheTtlSeconds;
    this.hours = options.hours;
  }

  /**
   * May a persona of this character, on this provider, join a queue right now?
   *
   * Checked before a socket is opened, so a refusal costs nothing.
   */
  async canJoin(characterId: string, provider: string, now = new Date()): Promise<ControlDecision> {
    const rows = await this.read();
    if (rows === null) {
      // Neither store answered. Refuse: see the fail-closed note above.
      return { allowed: false, reason: 'unreadable', stopExisting: false };
    }

    const global = rows.get(key('global', ''));
    if (global !== undefined && !global.enabled) {
      return refusal('global_disabled', global.mode);
    }

    const character = rows.get(key('character', characterId));
    if (character !== undefined && !character.enabled) {
      return refusal('character_disabled', character.mode);
    }

    const vendor = rows.get(key('provider', provider));
    if (vendor !== undefined && !vendor.enabled) {
      return refusal('provider_disabled', vendor.mode);
    }

    // The schedule is checked last so that an explicit disable is always the
    // reported reason. "Outside hours" when somebody has also pulled the global
    // switch would send whoever is debugging to the wrong place.
    if (!withinHours(this.hours, now)) {
      return { allowed: false, reason: 'outside_hours', stopExisting: false };
    }

    return ALLOWED;
  }

  /**
   * Should a conversation that is already running carry on?
   *
   * Separate from `canJoin` because that is the whole of the drain/hard
   * distinction. Note it does **not** consult the schedule: a conversation that
   * began inside the window finishes outside it. Ending a chat because the
   * clock struck ten would be the mid-sentence cut this design exists to avoid.
   */
  async shouldContinue(characterId: string, provider: string): Promise<boolean> {
    const rows = await this.read();
    if (rows === null) {
      // Unreadable state stops new joins but does not tear down live
      // conversations: the failure is ours and the cost of guessing wrong here
      // lands on somebody mid-sentence.
      return true;
    }

    for (const row of [
      rows.get(key('global', '')),
      rows.get(key('character', characterId)),
      rows.get(key('provider', provider)),
    ]) {
      if (row !== undefined && !row.enabled && row.mode === 'hard') return false;
    }
    return true;
  }

  /**
   * Flip a switch.
   *
   * PostgreSQL first, then invalidate the mirror. The reverse order would leave
   * a window where the cache says one thing and the durable record says
   * another, and a reconciler pass would silently undo the change.
   */
  async set(row: ControlRow): Promise<void> {
    await this.db.query(
      `insert into persona_control (scope, subject, enabled, mode, updated_by, reason, updated_at)
            values ($1, $2, $3, $4, $5, $6, now())
       on conflict (scope, subject) do update
              set enabled = excluded.enabled,
                  mode = excluded.mode,
                  updated_by = excluded.updated_by,
                  reason = excluded.reason,
                  updated_at = now()`,
      [row.scope, row.subject, row.enabled, row.mode, row.updatedBy, row.reason],
    );

    // Best-effort. A failure here costs at most `cacheTtlSeconds` of staleness,
    // and the reconciler closes it regardless.
    try {
      await this.redis.del(this.cacheKey);
    } catch (err) {
      this.logger.warn('persona control cache invalidation failed', errorFields(err));
    }
  }

  /**
   * Replay PostgreSQL into Redis.
   *
   * Called at startup and on an interval. Deliberately not leader-locked, for
   * the same reason `reapplyActiveBans` is not (D31): the work is idempotent,
   * tiny, and an instance that skipped it would be the one instance serving
   * stale state.
   *
   * @returns rows written, or -1 if the database could not be read.
   */
  async reconcile(): Promise<number> {
    let rows: readonly ControlRow[];
    try {
      rows = await this.fromDatabase();
    } catch (err) {
      this.logger.error('persona control reconcile failed to read', dbErrorFields(err));
      return -1;
    }

    try {
      await this.writeCache(rows);
    } catch (err) {
      this.logger.warn('persona control reconcile failed to write cache', errorFields(err));
      return -1;
    }

    return rows.length;
  }

  /** Every switch, for the console. */
  async list(): Promise<readonly ControlRow[]> {
    return this.fromDatabase();
  }

  /**
   * Redis, then PostgreSQL, then null.
   *
   * Null means "could not be determined", which the callers treat very
   * differently from an empty map.
   */
  private async read(): Promise<Map<string, ControlRow> | null> {
    try {
      const cached = await this.redis.get(this.cacheKey);
      if (cached !== null) return decode(cached);
    } catch (err) {
      this.logger.warn('persona control cache read failed', errorFields(err));
    }

    try {
      const rows = await this.fromDatabase();
      // Repopulate opportunistically; a failure is not worth failing the read.
      try {
        await this.writeCache(rows);
      } catch {
        // The warn above already covers the interesting case.
      }
      return index(rows);
    } catch (err) {
      this.logger.error('persona control read failed in both stores', dbErrorFields(err));
      return null;
    }
  }

  private async fromDatabase(): Promise<readonly ControlRow[]> {
    const { rows } = await this.db.query<{
      scope: string;
      subject: string;
      enabled: boolean;
      mode: string;
      updated_by: string;
      reason: string | null;
    }>('select scope, subject, enabled, mode, updated_by, reason from persona_control');

    return rows.map((r) => ({
      scope: r.scope as ControlScope,
      subject: r.subject,
      enabled: r.enabled,
      mode: r.mode as ControlMode,
      updatedBy: r.updated_by,
      reason: r.reason,
    }));
  }

  private async writeCache(rows: readonly ControlRow[]): Promise<void> {
    await this.redis.set(this.cacheKey, encode(rows), 'EX', this.cacheTtlSeconds);
  }
}

/** Composite map key. Scope and subject are both constrained, so `|` is safe. */
function key(scope: ControlScope, subject: string): string {
  return `${scope}|${subject}`;
}

function refusal(reason: RefusalReason, mode: ControlMode): ControlDecision {
  return { allowed: false, reason, stopExisting: mode === 'hard' };
}

function index(rows: readonly ControlRow[]): Map<string, ControlRow> {
  const map = new Map<string, ControlRow>();
  for (const row of rows) map.set(key(row.scope, row.subject), row);
  return map;
}

/**
 * The cache payload.
 *
 * JSON rather than a Redis hash: the whole set is read and written together,
 * it is a handful of rows, and a single string makes the TTL cover the entire
 * snapshot rather than each field separately. A half-expired hash would be a
 * control state that never existed.
 */
function encode(rows: readonly ControlRow[]): string {
  return JSON.stringify(rows);
}

function decode(payload: string): Map<string, ControlRow> {
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed)) throw new Error('persona control cache is not an array');
  return index(parsed as readonly ControlRow[]);
}
