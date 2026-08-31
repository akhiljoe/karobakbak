/**
 * Configuration.
 *
 * Every environment-dependent value is read here, exactly once, and validated
 * eagerly so a misconfigured instance fails at startup instead of failing
 * unpredictably under load. `loadConfig` is a pure function of an environment
 * object: there is no module-level singleton, so tests can build a Config
 * without touching `process.env`.
 *
 * Every variable is documented in .env.example and README.md.
 */
import { RULE_IDS } from './moderation/rules';
import { MODEL_PRICES, PROVIDER_MODELS, PROVIDER_NAMES } from './personas/provider';
import type { ClientEventType } from './protocol/types';
import { newInstanceId } from './util/ids';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Commands that carry their own token bucket (R7, DESIGN.md §17).
 *
 * Derived from the protocol rather than listed by hand, so adding a client
 * event is a compile error until someone decides what rate it may be sent at.
 * `ping` is excluded deliberately: it is the liveness probe, it is already
 * bounded by the heartbeat interval, and limiting it would let an idle client
 * be reaped for keeping itself alive.
 */
export type RateLimitedCommand = Exclude<ClientEventType, 'ping'>;

/** Durability priority classes (D26). Assigned by the server, never by a client. */
export type RetentionPriority = 'p0' | 'p1' | 'p2' | 'p3';

/** Re-exported so `Config` can name it without importing the policy module. */
export type ConfigurableAction = 'flag' | 'withhold' | 'block';

/** A Redis token bucket: sustained refill per second, and bucket capacity. */
export interface RateLimit {
  readonly perSecond: number;
  readonly burst: number;
}

/** One Sentinel to ask "where is the primary right now?". */
export interface RedisSentinel {
  readonly host: string;
  readonly port: number;
}

export interface Config {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  readonly instanceId: string;

  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly wsPath: string;
    /** Empty array means "allow any Origin" (development only). */
    readonly allowedOrigins: readonly string[];
    /**
     * How many reverse proxies sit in front of this process.
     *
     * 0 means the peer address is the client. Anything above 0 reads the
     * client address out of `X-Forwarded-For`, counting from the **right**:
     * each trusted proxy appends the address it saw, so the rightmost entries
     * are the ones our own infrastructure wrote and the left of the header is
     * whatever the client claimed. Trusting the leftmost value — the common
     * mistake — lets any client pick its own rate-limit bucket and shed its
     * blocks by sending a header.
     */
    readonly trustProxyHops: number;
  };

  readonly redis: {
    /**
     * The direct address. Used when `sentinels` is empty, which is the default
     * and the single-node deployment.
     */
    readonly url: string;
    /**
     * Sentinel addresses. Non-empty means Sentinel mode: the client asks these
     * for the current primary instead of connecting to a fixed address, and
     * follows it when a promotion moves it (D13).
     */
    readonly sentinels: readonly RedisSentinel[];
    /** The primary's name as Sentinel knows it. Required in Sentinel mode. */
    readonly sentinelName: string;
    /** Password for the Redis nodes themselves. Empty means no AUTH. */
    readonly password: string;
    /** Password for the Sentinels, which is often not the nodes' password. */
    readonly sentinelPassword: string;
    readonly keyPrefix: string;
    readonly commandTimeoutMs: number;
  };

  readonly limits: {
    readonly maxMessageLength: number;
    readonly maxReportNoteLength: number;
    readonly maxFrameBytes: number;
    readonly rateLimitTtlSeconds: number;
    readonly maxConnections: number;
    readonly connRateLimit: number;
    readonly connRateWindowSeconds: number;
    readonly invalidMessageStrikes: number;
    readonly maxBufferedBytes: number;
    /** Concurrent connections from one salted IP hash, counted cluster-wide (R8). */
    readonly maxConnectionsPerIp: number;
    /** Cap on the per-match replay-protection set (D24). */
    readonly dedupeMaxEntries: number;
    /**
     * One bucket per state-changing command, so a cheap protocol command
     * cannot be abused to dodge the message limit (security §12, R7).
     */
    readonly rates: Readonly<Record<RateLimitedCommand, RateLimit>>;
  };

  readonly ttl: {
    readonly sessionSeconds: number;
    readonly matchSeconds: number;
    readonly instanceHeartbeatSeconds: number;
  };

  readonly timers: {
    readonly heartbeatIntervalMs: number;
    readonly clientTimeoutMs: number;
    readonly janitorIntervalMs: number;
    readonly janitorLockTtlSeconds: number;
    readonly shutdownTimeoutMs: number;
  };

  readonly matchmaking: {
    readonly candidateSample: number;
    readonly retryAttempts: number;
    /**
     * The only queue segment implemented. Segmentation is a reserved seam:
     * every key and every Lua script takes a segment, but filters are not
     * built (D23, R6).
     */
    readonly defaultSegment: string;
  };

  /**
   * Preference matching (§29, D44). A **preference**, never a filter: a
   * matching candidate is taken if one is in view and an ordinary match is
   * taken in the same pass if none is, so no seat is ever held and pool
   * throughput is unchanged.
   *
   * Ships off. The client's own `FILTERS_AVAILABLE` is this **and**
   * `PAYMENTS_ENABLED`, so neither half can be switched on alone.
   */
  readonly preference: {
    readonly enabled: boolean;
    /**
     * The one wider look taken when the ordinary sample held no match.
     *
     * Escalation rather than a sample sized from the pool's composition: the
     * queue is a set of session ids with no per-gender breakdown, so
     * composition would be a maintained counter, and a session hash reaching
     * its TTL removes a member with nothing to decrement it. A sample sized
     * from a counter that is quietly wrong is worse than a fixed one, because
     * it looks adaptive (§29.3).
     */
    readonly wideSample: number;
    /**
     * Between a match ending and rejoining *with* a preference.
     *
     * The targeting objection in D37 is about rate, not about matching: a
     * preference plus fast re-rolling is a scan, and `join_queue` at 12/min
     * bounds flooding rather than hunting.
     */
    readonly cooldownMs: number;
    /**
     * Preference-carrying searches per hour. Beyond it searches continue
     * **without** the preference — degraded to an ordinary match, never to an
     * error (§29.4).
     */
    readonly hourlyBudget: number;
  };

  readonly blocks: {
    readonly ttlSeconds: number;
    /** Coarse, evadable by VPN, can catch bystanders behind CGNAT (D18). */
    readonly ipDimensionEnabled: boolean;
    /** Precise but trivially rotated by clearing browser storage (D18). */
    readonly clientDimensionEnabled: boolean;
    /**
     * How long after a conversation ends a departed partner can still be
     * blocked.
     *
     * Blocking races teardown constantly: an abuser sends something and skips,
     * and the victim's block arrives after the match is already gone. Before
     * this window existed the block found no match, recorded nothing, and the
     * user was told nothing had gone wrong — believing they had blocked
     * somebody they had not.
     *
     * The cost is that each side's two salted hashes are held against the
     * other's session id for this long. That pairing was already implied by the
     * match row it replaces, and it expires on its own. Set to 0 to disable the
     * record entirely.
     */
    readonly lateBlockSeconds: number;
  };

  /**
   * The moderation console (§29, I11).
   *
   * It listens on its **own port**, not on the chat server's. The public edge
   * proxies one port and one path; a console route hanging off the same
   * listener would be one nginx misconfiguration away from the internet,
   * whereas a separate listener that is simply never published cannot be
   * reached by a routing mistake at all. Authentication is the second layer,
   * not the only one.
   */
  readonly admin: {
    /** Off by default. A deployment that does not moderate opens no port. */
    readonly enabled: boolean;
    readonly port: number;
    /**
     * Loopback by default, so the console is reachable through an SSH tunnel
     * and from nowhere else until someone deliberately widens it.
     */
    readonly host: string;
    /**
     * Absolute session lifetime, never extended on activity. A sliding window
     * keeps a stolen cookie alive exactly as long as it is being used, which
     * is the case it most needs to expire in.
     */
    readonly sessionTtlSeconds: number;
    /** Consecutive failures before an account locks. */
    readonly maxFailedAttempts: number;
    readonly lockoutSeconds: number;
    /**
     * Login attempts per address per minute, refused before any database work.
     *
     * The per-account lockout bounds guessing at one account; this bounds the
     * *cost* of guessing at many, since each attempt otherwise buys an scrypt
     * verification from the process.
     */
    readonly loginAttemptsPerMinute: number;
    /**
     * Origins allowed to call the console API. Separate from the chat
     * allowlist because they are different services on different ports, and
     * sharing one list would mean widening the chat's origins to reach the
     * console.
     */
    readonly allowedOrigins: readonly string[];
  };

  /**
   * Moderator-issued enforcement, checked at upgrade (I11).
   *
   * Separate from `blocks` because the two answer different questions. A block
   * asks "will these two be matched"; a ban asks "does this connection happen
   * at all". Sharing a TTL between them would tie a user-safety decision to a
   * moderation decision, and the right durations are not the same number.
   */
  /**
   * AI personas (`docs/AI-PERSONAS.md`).
   *
   * Off by default and off in the durable switch too: `persona_control` ships a
   * disabled global row, so enabling personas takes both a deployment setting
   * and a deliberate, audited act in the console. That is intentional for a
   * feature that spends money per message.
   */
  readonly personas: {
    readonly enabled: boolean;
    /** How long one lone searcher waits before a persona is dispatched. */
    readonly waitBeforeFillSeconds: number;
    /**
     * How long a persona waits for a reply before moving on to somebody else.
     *
     * Zero disables it. Nobody sits in front of a stranger who stopped answering
     * ten minutes ago, and a persona that does is holding a queue seat and one of
     * the connections the whole population shares.
     */
    readonly silenceTimeoutSeconds: number;
    /**
     * The most personas alive at once.
     *
     * Must stay below `limits.maxConnectionsPerIp`: every persona connects from the
     * same address and they share one connection bucket. See `assertCoherent`.
     */
    readonly maxConcurrent: number;
    readonly maxPerCharacter: number;
    /** Minimum gap between dispatches, so a burst cannot outrun the join limiter. */
    readonly minDispatchGapMs: number;
    /** How often the supervisor decides whether to add or remove one. */
    readonly tickIntervalMs: number;
    /** Local hours during which personas may run. Equal values mean always. */
    readonly activeStartHour: number;
    readonly activeEndHour: number;
    readonly utcOffsetMinutes: number;
    /** How long the Redis mirror of the control table is trusted. */
    readonly controlCacheTtlSeconds: number;

    /**
     * The monthly spend ceiling, in micro-cents (D-AI-7).
     *
     * Micro-cents because money is never a float here: one reply costs on the
     * order of 80 of them, and accumulating that in a double before comparing
     * against a ceiling is how a budget ends up wrong by a rounding error.
     * The default is roughly 20 US dollars.
     */
    readonly monthlyLimitMicroCents: number;
    /** Which vendor answers. A metric label and a control-plane subject. */
    readonly provider: string;
    /** Which model. Haiku is the tier the cost work settled on. */
    readonly model: string;
    /** Read from the environment; never logged, never in an error message. */
    readonly apiKey: string;
  };

  /**
   * Payments (Razorpay).
   *
   * Off by default, and off in a second place too: the frontend's
   * `PAYMENTS_ENABLED` is a compiled-in constant rather than an environment
   * variable, because turning payments on makes two published claims false —
   * the Terms say there is no payment provider, and the Privacy page says the
   * site makes no third-party requests from the browser. That is a commit with
   * document changes in it, not a deploy setting.
   *
   * This flag is the server half. Both must say yes, the same shape as
   * `PERSONAS_ENABLED` and the `persona_control` row.
   */
  readonly payments: {
    readonly enabled: boolean;
    /** Razorpay publishable key id. Sent to the browser; not a secret. */
    readonly keyId: string;
    /** Razorpay API secret. Never logged, never in an error message. */
    readonly keySecret: string;
    /**
     * The webhook signing secret. Distinct from the API secret — Razorpay
     * issues it per endpoint — and mixing them up produces a verifier that
     * rejects every delivery, which looks like "webhooks are broken" rather
     * than "the wrong secret is configured".
     */
    readonly webhookSecret: string;
    readonly currency: string;
    /** Order-creation attempts allowed per IP hash per window. */
    readonly createRateLimit: number;
    readonly createRateWindowSeconds: number;
    /**
     * Ceiling on a request body on either payment route.
     *
     * The webhook is unauthenticated until its signature is checked, and the
     * signature covers the body — so the whole body has to be buffered before
     * anything about the sender is known. That is a request to hold arbitrary
     * bytes from an anonymous caller, and the only thing that makes it safe is
     * this number.
     */
    readonly maxBodyBytes: number;
    /**
     * How long a payment record is kept, in days.
     *
     * Longer than anything else in the schema, because a financial record has a
     * statutory retention period rather than a chosen one. The default is seven
     * years, which is the common Indian bookkeeping figure; it is a placeholder
     * for a number counsel gives, and nothing sweeps these tables yet.
     */
    readonly recordRetentionDays: number;
  };

  readonly enforcement: {
    /**
     * When false, ban keys are neither read nor written and the upgrade path
     * keeps its previous shape. Present so a deployment can turn enforcement
     * off without the console having to be uninstalled — and so the check has
     * an off switch if it ever misfires at the edge.
     */
    readonly enabled: boolean;
    /** What the console offers as the default ban length. */
    readonly defaultBanSeconds: number;
    /**
     * Ceiling on any single ban. A permanent ban is deliberately not
     * expressible: an anonymous product has no appeals channel, so an
     * indefinite sanction against a hash nobody can identify is one that
     * nobody can ever lift on evidence. Long bans are re-issued, not eternal.
     */
    readonly maxBanSeconds: number;
    /**
     * How often each instance replays live sanctions from PostgreSQL into
     * Redis.
     *
     * Redis holds no persistence by design (D12), so a restart empties every
     * ban key. Without this pass a sanction lasts until the next Redis restart
     * and nothing reports that it has gone. Not leader-locked: the write is an
     * idempotent SET, so instances converge rather than contend, and a pass
     * that only the leader ran would leave the others' view stale.
     */
    readonly reloadIntervalMs: number;
  };

  /**
   * Session resumption (§28, reverses D7).
   *
   * A dropped socket keeps its seat for `graceSeconds` instead of ending the
   * conversation. The returning browser proves it is the same person with a
   * token issued at session creation; without one, a reconnect is a new session
   * exactly as before.
   */
  readonly resume: {
    /** 0 disables resumption entirely and restores the original D7 behaviour. */
    readonly graceSeconds: number;
  };

  readonly moderation: {
    readonly enabled: boolean;
    /**
     * What a rule match does by default. `flag` delivers and records a signal
     * (D20): local rules have a real false-positive rate, and refusing a
     * message somebody was allowed to send is far more visible than a flag a
     * moderator later ignores.
     */
    readonly defaultAction: ConfigurableAction;
    /** Rule ids that escalate to an outright block. Validated against RULE_IDS. */
    readonly hardBlockRules: readonly string[];
    /** Contact-exchange detection, as a group. */
    readonly detectContact: boolean;
    /** Case-insensitive terms an operator has banned outright. */
    readonly denyList: readonly string[];
  };

  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly connectTimeoutMs: number;
    readonly statementTimeoutMs: number;
    readonly ssl: boolean;
    /** Refuse to start in production on a connection that would not use TLS. */
    readonly requireSslInProduction: boolean;
  };

  readonly retention: {
    readonly enabled: boolean;
    readonly batchSize: number;
    /**
     * How many flush cycles a record may wait for a parent row another instance
     * has not written yet. Five at the default one-second interval is five
     * seconds, which is enormous next to the sub-millisecond gap this actually
     * covers, and still bounded.
     */
    readonly missingParentRetries: number;
    readonly flushIntervalMs: number;
    /**
     * Hard capacity per priority class. Deliberately NOT shared: a full P3
     * cannot consume P0's budget, so ordinary chat is always shed before
     * safety evidence (D26).
     */
    readonly queueMax: Readonly<Record<RetentionPriority, number>>;
    /**
     * The share of one class a single session may occupy. This is what stops
     * an attacker deliberately tripping a mild moderation rule to flood P1 and
     * evict other people's evidence (D26).
     */
    readonly sessionQuotaPct: number;
    readonly days: {
      readonly conversation: number;
      readonly reported: number;
      readonly report: number;
      readonly moderationEvent: number;
      readonly enforcement: number;
      readonly adminAudit: number;
    };
  };

  readonly breaker: {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    readonly cooldownMaxMs: number;
    readonly drainBatchesPerSec: number;
  };

  readonly spool: {
    readonly enabled: boolean;
    /**
     * Only `file`. `redis` is refused at startup rather than accepted and
     * ignored — see `spoolBackend` for why it is not implemented.
     */
    readonly backend: 'file';
    readonly dir: string;
    readonly maxBytes: number;
    readonly maxRecords: number;
    readonly maxAgeSeconds: number;
  };

  readonly deletion: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly batch: number;
  };

  readonly moderation_response: {
    /**
     * How long an untriaged report may wait before it is a problem.
     *
     * Exported as a metric so the alert compares against it rather than
     * repeating the number — a threshold copied into a rule file drifts out of
     * step with the configuration the moment somebody tunes one and not the
     * other.
     */
    readonly targetSeconds: number;
    /** How often the report queue is sampled. */
    readonly sampleIntervalMs: number;
  };

  readonly backup: {
    /**
     * Shared secret the backup job presents when it reports in.
     *
     * Empty disables the report endpoint entirely — the route does not exist
     * rather than existing and refusing, so a deployment that has not
     * configured backups has no extra surface at all.
     */
    readonly reportToken: string;
    /** Alert when no successful backup has been observed within this window. */
    readonly maxAgeSeconds: number;
  };

  readonly janitor: {
    readonly batch: number;
  };

  readonly presence: {
    readonly intervalMs: number;
  };

  readonly metrics: {
    readonly enabled: boolean;
    readonly path: string;
    readonly cacheMs: number;
  };

  readonly security: {
    readonly ipHashSalt: string;
  };
}

export type Env = Record<string, string | undefined>;

class ConfigError extends Error {
  constructor(message: string) {
    super(`invalid configuration: ${message}`);
    this.name = 'ConfigError';
  }
}

function str(env: Env, key: string, fallback: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function num(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalised = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
  throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(raw)}`);
}

function list(env: Env, key: string, fallback: string): string[] {
  return str(env, key, fallback)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * How the process reaches Redis: one address, or a Sentinel set to ask.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REFUSES RATHER THAN FALLS BACK
 * ---------------------------------------------------------------------------
 * Redis holds every piece of live matchmaking state, and `/ready` is derived
 * from its health and nothing else — so losing it takes every backend instance
 * out of the load balancer at once. D13 rules out Cluster (the Lua scripts
 * compute which keys they touch while running, so they cannot declare them the
 * way a Cluster router needs) and names replica failover as the answer instead.
 * This is that.
 *
 * Every bad combination below throws, and none of them defaults to a single
 * node. That is the entire safety property. A half-specified topology that
 * quietly connected to one address would look configured, pass every health
 * check, serve traffic correctly for months, and then take the site down in the
 * one event it was bought to survive — with the operator believing failover was
 * in place. There is no error message at that point, because nothing failed:
 * the client did exactly what it was told.
 */
function redisConfig(env: Env): Config['redis'] {
  const sentinels = redisSentinels(env);
  const sentinelName = str(env, 'REDIS_SENTINEL_NAME', '');
  const urlWasSet = (env.REDIS_URL ?? '').trim() !== '';

  if (sentinels.length > 0 && sentinelName === '') {
    throw new ConfigError(
      'REDIS_SENTINELS is set but REDIS_SENTINEL_NAME is empty. Sentinel is asked ' +
        'for a primary *by name*, so without it there is nothing to ask for — and ' +
        'defaulting to a direct connection here would silently give you the single ' +
        'node you were trying to stop depending on',
    );
  }

  if (sentinelName !== '' && sentinels.length === 0) {
    throw new ConfigError(
      'REDIS_SENTINEL_NAME is set but REDIS_SENTINELS is empty. A primary name with ' +
        'nothing to ask about it is not a topology',
    );
  }

  // Deliberately checked against what was *set*, not against the parsed value:
  // REDIS_URL has a default, so by the time it is a string the two are
  // indistinguishable. Refusing both together stops a stale REDIS_URL surviving
  // a migration to Sentinel and leaving it ambiguous which one is live.
  if (sentinels.length > 0 && urlWasSet) {
    throw new ConfigError(
      'REDIS_URL and REDIS_SENTINELS are mutually exclusive. Sentinel mode ignores ' +
        'a fixed address, so leaving both set means the file says one thing and the ' +
        'process does another — unset REDIS_URL',
    );
  }

  return {
    url: str(env, 'REDIS_URL', 'redis://localhost:6379'),
    sentinels,
    sentinelName,
    password: str(env, 'REDIS_PASSWORD', ''),
    sentinelPassword: str(env, 'REDIS_SENTINEL_PASSWORD', ''),
    keyPrefix: str(env, 'REDIS_KEY_PREFIX', 'chat'),
    commandTimeoutMs: int(env, 'REDIS_COMMAND_TIMEOUT_MS', 5000, 100, 60_000),
  };
}

/**
 * `host:port,host:port,...`, parsed here so a typo fails at startup.
 *
 * The port is required rather than defaulted to 26379. A Sentinel reached on
 * the wrong port is indistinguishable from one that is down, and a set that is
 * two-thirds reachable still forms a quorum and still fails over — so the
 * mistake would hide until the day the remaining Sentinel was the one that
 * needed to vote.
 */
function redisSentinels(env: Env): readonly RedisSentinel[] {
  return list(env, 'REDIS_SENTINELS', '').map((entry) => {
    const separator = entry.lastIndexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new ConfigError(
        `REDIS_SENTINELS entries must be host:port, got ${JSON.stringify(entry)}`,
      );
    }
    const host = entry.slice(0, separator).trim();
    const port = Number(entry.slice(separator + 1).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(
        `REDIS_SENTINELS entry ${JSON.stringify(entry)} has an invalid port; ` +
          'expected an integer between 1 and 65535',
      );
    }
    return { host, port };
  });
}

function logLevel(env: Env): LogLevel {
  const raw = str(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  throw new ConfigError(`LOG_LEVEL must be debug|info|warn|error, got ${JSON.stringify(raw)}`);
}

/**
 * Read one token bucket from `<PREFIX>_RATE_PER_SEC` and `<PREFIX>_BURST`.
 *
 * Rates are expressed per second even for the hourly limits, so every bucket
 * has one unit and the Lua refill arithmetic never has to know which command it
 * is refilling. `.env.example` carries the human-readable equivalent.
 */
function rateLimit(env: Env, prefix: string, perSecond: number, burst: number): RateLimit {
  return {
    perSecond: num(env, `${prefix}_RATE_PER_SEC`, perSecond, 0.0001, 10_000),
    burst: int(env, `${prefix}_BURST`, burst, 1, 100_000),
  };
}

/**
 * The salt shipped in this repository.
 *
 * Named rather than repeated, because it is compared in two places and a
 * typo in either would silently disable the check that matters.
 */
/**
 * Whether the two limits D44 depends on are actually enforced yet.
 *
 * ---------------------------------------------------------------------------
 * FLIP THIS IN THE COMMIT THAT BUILDS THEM, AND NOT BEFORE
 * ---------------------------------------------------------------------------
 * §29.4 records the cooldown and the hourly budget as **part of** the preference
 * decision rather than as later hardening, because they are what answers D37's
 * second objection: a preference is a preference, but a preference plus fast
 * re-rolling is a scanning tool aimed at whichever group is preferred for.
 *
 * They are configured — `PREFERENCE_COOLDOWN_MS` and `PREFERENCE_HOURLY_BUDGET`
 * both parse and both have defaults — and nothing reads them. Configuration that
 * looks applied and is not is the failure this repository keeps finding: it is
 * `SPOOL_BACKEND=redis` accepted and ignored (F-006), and it is a Sentinel
 * topology that quietly falls back to one node.
 *
 * `FILTERS_ENABLED` is one environment variable. Somebody with two weeks of data
 * in hand is exactly the person who would set it, and exactly the person who
 * would not remember that these two were never written. So the process refuses
 * to start instead of relying on them remembering.
 *
 * Deleting the check is not the way to satisfy it. Building the limits is.
 */
export const PREFERENCE_LIMITS_ENFORCED = false;

export const DEFAULT_IP_HASH_SALT = 'change-me-in-production';

/**
 * F-006: `redis` was accepted and then ignored.
 *
 * `SPOOL_BACKEND` took `file|redis`, exposed the answer on the config, and
 * startup built a `FileSpool` regardless. An operator choosing `redis` — most
 * likely to keep outage records off a local disk — got a plaintext file spool
 * anyway, which is a storage decision silently reversed.
 *
 * There is no Redis spool, and there is a reason not to build one on the way
 * past: a Redis-backed spool dies with a Redis restart, and Redis here runs
 * with persistence deliberately off (D12). It would be *less* durable than the
 * file it replaced while looking like an upgrade.
 *
 * So the value is refused rather than implemented. A configuration that cannot
 * be honoured should fail at startup, where somebody is watching.
 */
function spoolBackend(env: Env, key: string, fallback: 'file'): 'file' {
  const raw = str(env, key, fallback);
  if (raw === 'file') return raw;
  if (raw === 'redis') {
    throw new ConfigError(
      `${key}=redis is not implemented. The outage spool is bounded tolerance, ` +
        'not durable storage (D28), and a Redis-backed one would die with a ' +
        'Redis restart because persistence is off by design (D12) — less ' +
        'durable than the file it replaced. Use file.',
    );
  }
  throw new ConfigError(`${key} must be file, got ${JSON.stringify(raw)}`);
}

function moderationAction(env: Env, key: string, fallback: ConfigurableAction): ConfigurableAction {
  const raw = str(env, key, fallback);
  if (raw === 'flag' || raw === 'withhold' || raw === 'block') return raw;
  throw new ConfigError(`${key} must be flag|withhold|block, got ${JSON.stringify(raw)}`);
}

/**
 * Rule ids for the hard-block set, checked against the rules that exist.
 *
 * A typo here would silently disable a hard block an operator believed they
 * had configured, which is exactly the kind of failure that is only discovered
 * by the abuse it did not stop.
 */
function knownRules(env: Env, key: string): string[] {
  const ids = list(env, key, '');
  for (const id of ids) {
    if (!RULE_IDS.includes(id)) {
      throw new ConfigError(
        `${key} names an unknown rule ${JSON.stringify(id)}; known rules are ${RULE_IDS.join(', ')}`,
      );
    }
  }
  return ids;
}

/**
 * A queue segment name. It becomes part of a Redis key (`chat:queue:{segment}`),
 * so it is restricted to characters that cannot break the namespace apart the
 * way a `:` or a space would.
 */
function segment(env: Env, key: string, fallback: string): string {
  const value = str(env, key, fallback);
  if (!/^[a-z0-9_-]{1,32}$/.test(value)) {
    throw new ConfigError(
      `${key} must be 1-32 characters of [a-z0-9_-], got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function path(env: Env, key: string, fallback: string): string {
  const value = str(env, key, fallback);
  if (!value.startsWith('/')) {
    throw new ConfigError(`${key} must start with "/", got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Build a validated Config from an environment object.
 * Throws ConfigError on anything that would produce undefined behaviour later.
 */
export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = str(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const config: Config = {
    nodeEnv,
    isProduction,
    logLevel: logLevel(env),
    instanceId: newInstanceId(env.INSTANCE_ID),

    http: {
      host: str(env, 'BACKEND_HOST', '0.0.0.0'),
      // 0 is legal and means "bind any free port". It is how the socket tests
      // avoid fighting over a fixed one; the bound port is logged at startup
      // and reported by `listen()`.
      port: int(env, 'BACKEND_PORT', 8080, 0, 65535),
      wsPath: path(env, 'WS_PATH', '/ws'),
      allowedOrigins: list(env, 'ALLOWED_ORIGINS', ''),
      trustProxyHops: int(env, 'TRUST_PROXY_HOPS', 0, 0, 8),
    },

    redis: redisConfig(env),

    limits: {
      // 500, not 2000: security §11, and it quarters the retained-storage
      // footprint every message costs for the whole retention period (R3).
      maxMessageLength: int(env, 'MAX_MESSAGE_LENGTH', 500, 1, 100_000),
      maxReportNoteLength: int(env, 'MAX_REPORT_NOTE_LENGTH', 500, 1, 100_000),
      maxFrameBytes: int(env, 'MAX_FRAME_BYTES', 16_384, 1024, 10_485_760),
      rateLimitTtlSeconds: int(env, 'RATE_LIMIT_TTL_SECONDS', 3600, 5, 86_400),
      maxConnections: int(env, 'MAX_CONNECTIONS', 5000, 1, 1_000_000),
      connRateLimit: int(env, 'CONN_RATE_LIMIT', 60, 1, 1_000_000),
      connRateWindowSeconds: int(env, 'CONN_RATE_WINDOW_SECONDS', 60, 1, 86_400),
      invalidMessageStrikes: int(env, 'INVALID_MESSAGE_STRIKES', 10, 1, 10_000),
      maxBufferedBytes: int(env, 'MAX_BUFFERED_BYTES', 1_048_576, 4096, 268_435_456),
      maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 40, 1, 100_000),
      dedupeMaxEntries: int(env, 'DEDUPE_MAX_ENTRIES', 10_000, 16, 1_000_000),
      rates: {
        message: rateLimit(env, 'MESSAGE', 5, 10),
        typing: rateLimit(env, 'TYPING', 4, 8),
        join_queue: rateLimit(env, 'JOIN_QUEUE', 0.2, 5), //     12/min
        leave_queue: rateLimit(env, 'LEAVE_QUEUE', 0.333, 6), // 20/min
        leave_chat: rateLimit(env, 'LEAVE_CHAT', 0.333, 6), //   20/min
        // Naturally bounded by how many messages exist to react to, but not
        // by anything if a client re-reacts to the same one — so it is limited
        // like a command rather than trusted like a consequence.
        react: rateLimit(env, 'REACT', 1, 5), //                  60/min
        skip: rateLimit(env, 'SKIP', 0.333, 6), //               20/min
        report: rateLimit(env, 'REPORT', 0.00278, 3), //         10/hour
        block: rateLimit(env, 'BLOCK', 0.00556, 3), //           20/hour
      },
    },

    ttl: {
      sessionSeconds: int(env, 'SESSION_TTL_SECONDS', 120, 10, 86_400),
      matchSeconds: int(env, 'MATCH_TTL_SECONDS', 3600, 10, 604_800),
      instanceHeartbeatSeconds: int(env, 'INSTANCE_HEARTBEAT_TTL_SECONDS', 30, 5, 3600),
    },

    timers: {
      heartbeatIntervalMs: int(env, 'HEARTBEAT_INTERVAL_MS', 20_000, 1000, 3_600_000),
      clientTimeoutMs: int(env, 'CLIENT_TIMEOUT_MS', 60_000, 1000, 3_600_000),
      janitorIntervalMs: int(env, 'JANITOR_INTERVAL_MS', 15_000, 1000, 3_600_000),
      janitorLockTtlSeconds: int(env, 'JANITOR_LOCK_TTL_SECONDS', 30, 1, 3600),
      shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, 100, 300_000),
    },

    matchmaking: {
      candidateSample: int(env, 'MATCH_CANDIDATE_SAMPLE', 8, 1, 1000),
      retryAttempts: int(env, 'MATCH_RETRY_ATTEMPTS', 3, 1, 20),
      defaultSegment: segment(env, 'DEFAULT_QUEUE_SEGMENT', 'default'),
    },

    preference: {
      enabled: bool(env, 'FILTERS_ENABLED', false),
      wideSample: int(env, 'PREFERENCE_WIDE_SAMPLE', 32, 1, 1000),
      cooldownMs: int(env, 'PREFERENCE_COOLDOWN_MS', 10_000, 0, 600_000),
      hourlyBudget: int(env, 'PREFERENCE_HOURLY_BUDGET', 120, 1, 100_000),
    },

    blocks: {
      ttlSeconds: int(env, 'BLOCK_TTL_SECONDS', 2_592_000, 60, 31_536_000),
      ipDimensionEnabled: bool(env, 'BLOCK_DIMENSION_IP_ENABLED', true),
      clientDimensionEnabled: bool(env, 'BLOCK_DIMENSION_CLIENT_ENABLED', true),
      lateBlockSeconds: int(env, 'BLOCK_LATE_WINDOW_SECONDS', 120, 0, 3600),
    },

    personas: {
      enabled: bool(env, 'PERSONAS_ENABLED', false),
      waitBeforeFillSeconds: int(env, 'PERSONA_WAIT_BEFORE_FILL_SECONDS', 25, 1, 3600),
      silenceTimeoutSeconds: int(env, 'PERSONA_SILENCE_TIMEOUT_SECONDS', 120, 0, 3600),
      maxConcurrent: int(env, 'PERSONA_MAX_CONCURRENT', 8, 1, 1000),
      maxPerCharacter: int(env, 'PERSONA_MAX_PER_CHARACTER', 2, 1, 1000),
      minDispatchGapMs: int(env, 'PERSONA_MIN_DISPATCH_GAP_MS', 6000, 0, 600_000),
      tickIntervalMs: int(env, 'PERSONA_TICK_INTERVAL_MS', 3000, 500, 300_000),
      activeStartHour: int(env, 'PERSONA_ACTIVE_START_HOUR', 0, 0, 23),
      activeEndHour: int(env, 'PERSONA_ACTIVE_END_HOUR', 0, 0, 23),
      utcOffsetMinutes: int(env, 'PERSONA_UTC_OFFSET_MINUTES', 330, -720, 840),
      controlCacheTtlSeconds: int(env, 'PERSONA_CONTROL_CACHE_TTL_SECONDS', 20, 1, 3600),
      monthlyLimitMicroCents: int(
        env,
        'PERSONA_MONTHLY_LIMIT_MICRO_CENTS',
        200_000_000,
        1,
        1_000_000_000_000,
      ),
      provider: str(env, 'PERSONA_PROVIDER', 'anthropic'),
      model: str(env, 'PERSONA_MODEL', 'claude-haiku-4-5'),
      apiKey: str(env, 'PERSONA_API_KEY', ''),
    },

    payments: {
      enabled: bool(env, 'PAYMENTS_ENABLED', false),
      keyId: str(env, 'RAZORPAY_KEY_ID', ''),
      keySecret: str(env, 'RAZORPAY_KEY_SECRET', ''),
      webhookSecret: str(env, 'RAZORPAY_WEBHOOK_SECRET', ''),
      currency: str(env, 'PAYMENTS_CURRENCY', 'INR'),
      // 10 an hour. An order is a round trip to the payment provider and a row
      // in the database; nobody buying something honestly needs a eleventh
      // attempt in an hour, and a script does.
      createRateLimit: int(env, 'PAYMENTS_CREATE_RATE_LIMIT', 10, 1, 100_000),
      createRateWindowSeconds: int(env, 'PAYMENTS_CREATE_RATE_WINDOW_SECONDS', 3600, 1, 86_400),
      maxBodyBytes: int(env, 'PAYMENTS_MAX_BODY_BYTES', 65_536, 512, 1_048_576),
      recordRetentionDays: int(env, 'PAYMENT_RECORD_RETENTION_DAYS', 2555, 1, 10_950),
    },

    enforcement: {
      enabled: bool(env, 'ENFORCEMENT_ENABLED', true),
      defaultBanSeconds: int(env, 'ENFORCEMENT_DEFAULT_BAN_SECONDS', 2_592_000, 60, 31_536_000),
      maxBanSeconds: int(env, 'ENFORCEMENT_MAX_BAN_SECONDS', 31_536_000, 60, 31_536_000),
      reloadIntervalMs: int(env, 'ENFORCEMENT_RELOAD_INTERVAL_MS', 300_000, 30_000, 3_600_000),
    },

    admin: {
      enabled: bool(env, 'ADMIN_CONSOLE_ENABLED', false),
      port: int(env, 'ADMIN_CONSOLE_PORT', 8088, 0, 65535),
      host: str(env, 'ADMIN_CONSOLE_HOST', '127.0.0.1'),
      sessionTtlSeconds: int(env, 'ADMIN_SESSION_TTL_SECONDS', 43_200, 300, 604_800),
      maxFailedAttempts: int(env, 'ADMIN_MAX_FAILED_ATTEMPTS', 5, 1, 100),
      lockoutSeconds: int(env, 'ADMIN_LOCKOUT_SECONDS', 900, 30, 86_400),
      loginAttemptsPerMinute: int(env, 'ADMIN_LOGIN_ATTEMPTS_PER_MINUTE', 10, 1, 10_000),
      allowedOrigins: list(env, 'ADMIN_ALLOWED_ORIGINS', ''),
    },

    resume: {
      graceSeconds: int(env, 'RESUME_GRACE_SECONDS', 20, 0, 300),
    },

    moderation: {
      enabled: bool(env, 'MODERATION_ENABLED', true),
      defaultAction: moderationAction(env, 'MODERATION_DEFAULT_ACTION', 'flag'),
      hardBlockRules: knownRules(env, 'MODERATION_HARD_BLOCK_RULES'),
      detectContact: bool(env, 'MODERATION_DETECT_CONTACT', true),
      denyList: list(env, 'MODERATION_DENY_LIST', '').map((term) => term.toLowerCase()),
    },

    database: {
      url: str(env, 'DATABASE_URL', 'postgres://karobakbak:karobakbak@localhost:5432/karobakbak'),
      poolMax: int(env, 'DATABASE_POOL_MAX', 10, 1, 500),
      connectTimeoutMs: int(env, 'DATABASE_CONNECT_TIMEOUT_MS', 5000, 100, 120_000),
      statementTimeoutMs: int(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 10_000, 100, 600_000),
      ssl: bool(env, 'DATABASE_SSL', false),
      requireSslInProduction: bool(env, 'DATABASE_REQUIRE_SSL_IN_PRODUCTION', true),
    },

    retention: {
      enabled: bool(env, 'RETENTION_ENABLED', true),
      batchSize: int(env, 'RETENTION_BATCH_SIZE', 100, 1, 10_000),
      missingParentRetries: int(env, 'RETENTION_MISSING_PARENT_RETRIES', 5, 0, 100),
      flushIntervalMs: int(env, 'RETENTION_FLUSH_INTERVAL_MS', 1000, 10, 600_000),
      queueMax: {
        p0: int(env, 'RETENTION_QUEUE_MAX_P0', 2000, 1, 1_000_000),
        p1: int(env, 'RETENTION_QUEUE_MAX_P1', 5000, 1, 1_000_000),
        p2: int(env, 'RETENTION_QUEUE_MAX_P2', 5000, 1, 1_000_000),
        p3: int(env, 'RETENTION_QUEUE_MAX_P3', 20_000, 1, 1_000_000),
      },
      sessionQuotaPct: int(env, 'RETENTION_QUEUE_SESSION_QUOTA_PCT', 10, 1, 100),
      days: {
        conversation: int(env, 'CONVERSATION_RETENTION_DAYS', 30, 1, 3650),
        reported: int(env, 'REPORTED_RETENTION_DAYS', 90, 1, 3650),
        report: int(env, 'REPORT_RETENTION_DAYS', 90, 1, 3650),
        moderationEvent: int(env, 'MODERATION_EVENT_RETENTION_DAYS', 90, 1, 3650),
        enforcement: int(env, 'ENFORCEMENT_RETENTION_DAYS', 90, 1, 3650),
        adminAudit: int(env, 'ADMIN_AUDIT_RETENTION_DAYS', 365, 1, 3650),
      },
    },

    breaker: {
      failureThreshold: int(env, 'BREAKER_FAILURE_THRESHOLD', 5, 1, 1000),
      cooldownMs: int(env, 'BREAKER_COOLDOWN_MS', 5000, 10, 3_600_000),
      cooldownMaxMs: int(env, 'BREAKER_COOLDOWN_MAX_MS', 120_000, 10, 86_400_000),
      drainBatchesPerSec: num(env, 'BREAKER_DRAIN_BATCHES_PER_SEC', 5, 0.01, 10_000),
    },

    spool: {
      enabled: bool(env, 'SPOOL_ENABLED', true),
      backend: spoolBackend(env, 'SPOOL_BACKEND', 'file'),
      dir: str(env, 'SPOOL_DIR', '/var/lib/karobakbak/spool'),
      maxBytes: int(env, 'SPOOL_MAX_BYTES', 134_217_728, 1024, 68_719_476_736),
      maxRecords: int(env, 'SPOOL_MAX_RECORDS', 50_000, 1, 100_000_000),
      maxAgeSeconds: int(env, 'SPOOL_MAX_AGE_SECONDS', 86_400, 1, 31_536_000),
    },

    deletion: {
      enabled: bool(env, 'DELETION_WORKER_ENABLED', true),
      intervalMs: int(env, 'DELETION_INTERVAL_MS', 3_600_000, 1000, 86_400_000),
      batch: int(env, 'DELETION_BATCH', 500, 1, 100_000),
    },

    moderation_response: {
      targetSeconds: int(env, 'REPORT_RESPONSE_TARGET_SECONDS', 86_400, 60, 2_592_000),
      sampleIntervalMs: int(env, 'REPORT_QUEUE_SAMPLE_MS', 60_000, 5_000, 3_600_000),
    },

    backup: {
      reportToken: str(env, 'BACKUP_REPORT_TOKEN', ''),
      maxAgeSeconds: int(env, 'BACKUP_MAX_AGE_SECONDS', 93_600, 60, 2_592_000),
    },

    janitor: {
      batch: int(env, 'JANITOR_BATCH', 200, 1, 10_000),
    },

    presence: {
      intervalMs: int(env, 'PRESENCE_INTERVAL_MS', 15_000, 1000, 3_600_000),
    },

    metrics: {
      enabled: bool(env, 'METRICS_ENABLED', true),
      path: path(env, 'METRICS_PATH', '/metrics'),
      cacheMs: int(env, 'METRICS_CACHE_MS', 2000, 0, 60_000),
    },

    security: {
      ipHashSalt: str(env, 'IP_HASH_SALT', DEFAULT_IP_HASH_SALT),
    },
  };

  assertCoherent(config);
  return config;
}

/**
 * Cross-field checks. These catch configurations that parse fine individually
 * but interact badly — the failure modes are subtle (sessions expiring while
 * their owner is alive, frames rejected before length validation runs), so
 * they are worth failing fast on.
 */
function assertCoherent(config: Config): void {
  // R9 / security §6: an empty allowlist accepts a WebSocket upgrade from any
  // origin, which is cross-site request forgery against a chat session. It stays
  // legal in development, where the frontend's dev-server port moves around, and
  // is fatal the moment the process claims to be production.
  if (config.isProduction && config.http.allowedOrigins.length === 0) {
    throw new ConfigError(
      'ALLOWED_ORIGINS must list at least one origin when NODE_ENV=production; ' +
        'an empty allowlist accepts WebSocket upgrades from any site',
    );
  }

  // Every persona connects from the same address, so the whole population
  // shares one connection bucket. A concurrency cap at or above
  // MAX_CONNECTIONS_PER_IP is a setting that looks applied and silently is not:
  // the symptom is refused connections and a fill policy that sees only
  // failures, which reads as "personas are broken" rather than "the cap is
  // wrong". Same family as the heartbeat/TTL relationship below.
  if (config.personas.enabled) {
    if (config.personas.maxConcurrent >= config.limits.maxConnectionsPerIp) {
      throw new ConfigError(
        `PERSONA_MAX_CONCURRENT (${config.personas.maxConcurrent}) must be below ` +
          `MAX_CONNECTIONS_PER_IP (${config.limits.maxConnectionsPerIp}): every persona connects ` +
          'from the same address and they share one connection bucket',
      );
    }
    if (config.personas.maxPerCharacter > config.personas.maxConcurrent) {
      throw new ConfigError(
        `PERSONA_MAX_PER_CHARACTER (${config.personas.maxPerCharacter}) exceeds ` +
          `PERSONA_MAX_CONCURRENT (${config.personas.maxConcurrent}), so it can never bind`,
      );
    }

    // The provider, the model and the price are one decision in three
    // variables, and every way of getting them out of step fails quietly:
    //
    //  - an unknown provider name would silently keep whichever adapter the
    //    wiring happens to construct first;
    //  - a model with no row in MODEL_PRICES spends against a ceiling that
    //    cannot bind, because `safeCost` downgrades the throw to a log and a
    //    zero rather than failing a conversation somebody is having;
    //  - one vendor's model id against the other's key authenticates fine and
    //    then fails every single call, which the fallback turns into a month of
    //    scripted conversations with nothing saying why.
    //
    // All three are refused at boot instead. Only when a key is set: the
    // keyless scripted mode is supported and reaches no provider at all.
    if (config.personas.apiKey !== '') {
      const provider = config.personas.provider;
      if (!PROVIDER_NAMES.includes(provider)) {
        throw new ConfigError(
          `PERSONA_PROVIDER "${provider}" is not one of: ${PROVIDER_NAMES.join(', ')}`,
        );
      }

      const model = config.personas.model;
      if (MODEL_PRICES[model] === undefined) {
        throw new ConfigError(
          `PERSONA_MODEL "${model}" has no row in MODEL_PRICES, so its spend cannot be ` +
            'counted and PERSONA_MONTHLY_LIMIT_MICRO_CENTS would never bind. Add its ' +
            'published rates to MODEL_PRICES rather than letting it default',
        );
      }

      const offered = PROVIDER_MODELS[provider] ?? [];
      if (!offered.includes(model)) {
        throw new ConfigError(
          `PERSONA_MODEL "${model}" is not served by PERSONA_PROVIDER "${provider}". ` +
            `That provider offers: ${offered.join(', ')}`,
        );
      }
    }
  }

  // Payments. Every check here exists because the failure it prevents is
  // *silent* — a payment integration that is wrong does not throw, it takes
  // money and grants nothing, or grants something and takes nothing.
  if (config.payments.enabled) {
    // No credential has a default. The rejected prototype fell back to
    // 'dummy_webhook_secret' when the variable was unset, which means a deploy
    // that forgets it accepts webhooks signed with a string published in this
    // repository — anybody can then mint a `payment.captured` and grant
    // themselves premium. There is no development shortcut worth that.
    const missing = (
      [
        ['RAZORPAY_KEY_ID', config.payments.keyId],
        ['RAZORPAY_KEY_SECRET', config.payments.keySecret],
        ['RAZORPAY_WEBHOOK_SECRET', config.payments.webhookSecret],
      ] as const
    )
      .filter(([, value]) => value === '')
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new ConfigError(
        `PAYMENTS_ENABLED is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
          'empty. A payment credential has no safe default: a fallback secret means webhooks ' +
          'signed with a public string are accepted as genuine',
      );
    }

    // Payments write to PostgreSQL synchronously, and `index.ts` only builds a
    // database when retention is on. With it off, `payments` would be enabled
    // with nowhere to record an order — and the failure appears at the first
    // real purchase rather than at boot.
    if (!config.retention.enabled) {
      throw new ConfigError(
        'PAYMENTS_ENABLED requires RETENTION_ENABLED: the payment routes need the ' +
          'PostgreSQL pool, which is only constructed when retention is on',
      );
    }

    // A test key in production is the sharpest quiet failure in this whole
    // file. Everything works — the checkout opens, the webhook verifies, the
    // entitlement is granted — and no money moves, because the order was
    // created in Razorpay's test mode. Nothing surfaces it except a bank
    // statement, weeks later.
    if (config.isProduction && config.payments.keyId.startsWith('rzp_test_')) {
      throw new ConfigError(
        'RAZORPAY_KEY_ID is a test-mode key (rzp_test_) but NODE_ENV=production. ' +
          'Test mode grants entitlements and moves no money, and nothing at runtime reports it',
      );
    }
  }

  // The salt is the control that makes an IP hash non-reversible and
  // non-linkable outside the trusted boundary. A published default makes every
  // hash reproducible by anyone holding this repository, so a database, a
  // backup or an accidental disclosure becomes an offline dictionary attack
  // over the whole IPv4 space — which is small enough to enumerate.
  //
  // This used to be a warning, on the reasoning that the production compose
  // file already requires the variable. That is true and it is not enough: the
  // exposure is a deployment that does not use that compose file, which is
  // exactly what a first deploy under time pressure looks like. Warnings scroll
  // past; a refusal does not.
  if (config.isProduction && config.security.ipHashSalt === DEFAULT_IP_HASH_SALT) {
    throw new ConfigError(
      'IP_HASH_SALT is still the published default when NODE_ENV=production. ' +
        'It salts every IP and client-token hash, so leaving it means those ' +
        'hashes are reproducible by anyone with this source. Generate one: ' +
        'openssl rand -base64 32',
    );
  }

  // The whole point of the console having its own listener is that it is a
  // different port from the one the public edge proxies. Sharing one would put
  // the console's routes on the listener nginx forwards to, which is the
  // failure this separation exists to make impossible.
  if (config.admin.enabled && config.admin.port === config.http.port) {
    throw new ConfigError(
      `ADMIN_CONSOLE_PORT (${config.admin.port}) must differ from BACKEND_PORT: the console ` +
        'listener is separate precisely so the public edge cannot route to it',
    );
  }

  // The console authenticates with a cookie, so an empty origin allowlist is
  // cross-site request forgery against a moderator's live session — the same
  // argument as R9 for the chat, with a higher prize. Legal in development,
  // fatal the moment the process claims to be production.
  if (config.isProduction && config.admin.enabled && config.admin.allowedOrigins.length === 0) {
    throw new ConfigError(
      'ADMIN_ALLOWED_ORIGINS must list at least one origin when the console is enabled under ' +
        'NODE_ENV=production; an empty allowlist accepts credentialed requests from any site',
    );
  }

  // A default longer than the ceiling would mean the console's own default
  // action is one the console must refuse to carry out — an operator meeting a
  // validation error on the button they were told to press.
  if (config.enforcement.defaultBanSeconds > config.enforcement.maxBanSeconds) {
    throw new ConfigError(
      `ENFORCEMENT_DEFAULT_BAN_SECONDS (${config.enforcement.defaultBanSeconds}s) must not exceed ` +
        `ENFORCEMENT_MAX_BAN_SECONDS (${config.enforcement.maxBanSeconds}s)`,
    );
  }

  const heartbeatSeconds = config.timers.heartbeatIntervalMs / 1000;
  if (heartbeatSeconds >= config.ttl.sessionSeconds / 2) {
    throw new ConfigError(
      `HEARTBEAT_INTERVAL_MS (${config.timers.heartbeatIntervalMs}ms) must be less than half of ` +
        `SESSION_TTL_SECONDS (${config.ttl.sessionSeconds}s), otherwise live sessions expire`,
    );
  }

  // Worst case a UTF-16 character encodes to 4 UTF-8 bytes; add slack for the
  // JSON envelope so a legal maximum-length text field is never rejected as an
  // oversized frame. Report notes are user text on the same wire, so the bound
  // is taken over both fields rather than over messages alone.
  const longestTextField = Math.max(
    config.limits.maxMessageLength,
    config.limits.maxReportNoteLength,
  );
  const worstCaseTextBytes = longestTextField * 4 + 512;
  if (config.limits.maxFrameBytes < worstCaseTextBytes) {
    throw new ConfigError(
      `MAX_FRAME_BYTES (${config.limits.maxFrameBytes}) is too small for the longest allowed ` +
        `text field (${longestTextField} characters); needs at least ${worstCaseTextBytes}`,
    );
  }

  for (const [command, limit] of Object.entries(config.limits.rates)) {
    if (limit.burst < limit.perSecond) {
      throw new ConfigError(
        `${command} burst (${limit.burst}) must be >= its rate per second (${limit.perSecond}); ` +
          `a bucket smaller than one second of refill cannot sustain the configured rate`,
      );
    }

    // A bucket key that expires before it could have refilled hands the sender
    // a full bucket for free, which quietly turns "10 per hour" into "10 per
    // RATE_LIMIT_TTL_SECONDS". Expiry is only safe once the bucket would have
    // been full anyway.
    const secondsToRefill = limit.burst / limit.perSecond;
    if (config.limits.rateLimitTtlSeconds < secondsToRefill) {
      throw new ConfigError(
        `RATE_LIMIT_TTL_SECONDS (${config.limits.rateLimitTtlSeconds}) is shorter than the ` +
          `${Math.ceil(secondsToRefill)}s the ${command} bucket needs to refill; the limit ` +
          `would reset on expiry instead of being enforced`,
      );
    }
  }

  if (config.ttl.matchSeconds < config.ttl.sessionSeconds) {
    throw new ConfigError(
      `MATCH_TTL_SECONDS (${config.ttl.matchSeconds}) must be >= SESSION_TTL_SECONDS ` +
        `(${config.ttl.sessionSeconds}); a match must not outlive its participants' records`,
    );
  }

  if (config.timers.janitorLockTtlSeconds * 1000 < config.timers.janitorIntervalMs) {
    throw new ConfigError(
      `JANITOR_LOCK_TTL_SECONDS (${config.timers.janitorLockTtlSeconds}s) must cover ` +
        `JANITOR_INTERVAL_MS (${config.timers.janitorIntervalMs}ms)`,
    );
  }

  // Refuses the one combination that ships an unprotected preference: the
  // feature on, with the limits that bound its abuse not yet written. The
  // message names the constant to flip and the section that says why, because a
  // startup failure whose fix is unclear gets solved by deleting the check.
  //
  // Production only, exactly like the origin allowlist above. Turning the
  // preference on locally is how it is tested and how it will be evaluated
  // against two weeks of real numbers; shipping it to strangers with nothing
  // bounding the re-roll rate is the thing being prevented. `configWarnings`
  // carries the same message where it is legal, so it is visible rather than
  // silent.
  if (config.isProduction && config.preference.enabled && !PREFERENCE_LIMITS_ENFORCED) {
    throw new ConfigError(
      'FILTERS_ENABLED=true, but preference matching has no rate limits yet. ' +
        'PREFERENCE_COOLDOWN_MS and PREFERENCE_HOURLY_BUDGET are configured and ' +
        'nothing reads them, so a preference plus fast re-rolling is a scanning ' +
        'tool with nothing bounding it (DESIGN.md §29.4, D37). Build the two ' +
        'limits and set PREFERENCE_LIMITS_ENFORCED to true in the same commit.',
    );
  }

  // The wider look has to actually be wider. Set below the ordinary sample it
  // reads as configured and silently does the opposite of its name: the
  // escalation pass would consider *fewer* candidates than the one that just
  // failed, so a preference would get harder to satisfy the more the operator
  // "tuned" it. Equal is refused too — an escalation that changes nothing is a
  // second round trip through the pool for no reason (§29.3).
  if (config.preference.wideSample <= config.matchmaking.candidateSample) {
    throw new ConfigError(
      `PREFERENCE_WIDE_SAMPLE (${config.preference.wideSample}) must be greater than ` +
        `MATCH_CANDIDATE_SAMPLE (${config.matchmaking.candidateSample}); the escalation ` +
        'pass exists to look at more candidates than the pass that already missed',
    );
  }

  if (config.redis.keyPrefix.includes(' ') || config.redis.keyPrefix.includes(':')) {
    throw new ConfigError(
      `REDIS_KEY_PREFIX must not contain spaces or ":", got ${JSON.stringify(config.redis.keyPrefix)}`,
    );
  }
}

/** Startup warnings for configurations that are legal but unsafe in production. */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  // Production reaches this only via assertCoherent throwing first, so this
  // warning is always the development case.
  if (config.http.allowedOrigins.length === 0) {
    warnings.push(
      'ALLOWED_ORIGINS is empty: WebSocket upgrades from ANY origin are accepted. ' +
        'Set an explicit allowlist before exposing this service; it is a startup ' +
        'failure under NODE_ENV=production.',
    );
  }
  if (config.retention.enabled && config.backup.reportToken === '') {
    warnings.push(
      'BACKUP_REPORT_TOKEN is empty: the backup report endpoint is disabled, so ' +
        'nothing can tell this process a backup succeeded. `BackupsNeverObserved` ' +
        'will fire once the process has been up longer than BACKUP_MAX_AGE_SECONDS, ' +
        'which is correct — there is nothing to restore from.',
    );
  }
  if (config.preference.enabled && !PREFERENCE_LIMITS_ENFORCED) {
    warnings.push(
      'FILTERS_ENABLED is on and preference matching has no rate limits yet: ' +
        'PREFERENCE_COOLDOWN_MS and PREFERENCE_HOURLY_BUDGET are configured and ' +
        'nothing reads them. Fine for evaluating the feature; it is a startup ' +
        'failure under NODE_ENV=production (DESIGN.md §29.4).',
    );
  }
  if (config.isProduction && config.redis.sentinels.length === 0) {
    warnings.push(
      'REDIS_SENTINELS is empty: this process reaches one Redis at a fixed address, ' +
        'and every piece of live matchmaking state is in it. `/ready` is derived from ' +
        'its health alone, so losing it takes every backend out of the load balancer ' +
        'until somebody repoints REDIS_URL by hand. Legal, and the documented ' +
        'single-node deployment (D13) — but it is the one component whose failure is ' +
        'total.',
    );
  }
  if (config.redis.sentinels.length > 0 && config.redis.sentinels.length < 3) {
    warnings.push(
      `REDIS_SENTINELS lists ${config.redis.sentinels.length}: fewer than three cannot ` +
        'form a quorum that tolerates losing one. Two is the worst case — losing either ' +
        'leaves the other unable to reach a majority, so no failover happens and the ' +
        'topology performs worse than the single node it replaced.',
    );
  }
  if (!config.blocks.ipDimensionEnabled && !config.blocks.clientDimensionEnabled) {
    warnings.push(
      'BLOCK_DIMENSION_IP_ENABLED and BLOCK_DIMENSION_CLIENT_ENABLED are both false: ' +
        'the block button will end the match but record nothing, so a blocked stranger ' +
        'can be matched again immediately.',
    );
  }
  if (config.security.ipHashSalt === DEFAULT_IP_HASH_SALT) {
    // Production never reaches here — `assertCoherent` throws first — so this
    // is the development case, where the default is a convenience rather than
    // an exposure.
    warnings.push(
      'IP_HASH_SALT is the published default: every IP and client-token hash is ' +
        'reproducible from this source. Fine on a laptop, a startup failure in ' +
        'production.',
    );
  }
  return warnings;
}

export { ConfigError };
