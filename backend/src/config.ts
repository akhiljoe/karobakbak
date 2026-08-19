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
    readonly url: string;
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

  readonly blocks: {
    readonly ttlSeconds: number;
    /** Coarse, evadable by VPN, can catch bystanders behind CGNAT (D18). */
    readonly ipDimensionEnabled: boolean;
    /** Precise but trivially rotated by clearing browser storage (D18). */
    readonly clientDimensionEnabled: boolean;
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
    readonly backend: 'file' | 'redis';
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

  readonly backup: {
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

function spoolBackend(env: Env, key: string, fallback: 'file' | 'redis'): 'file' | 'redis' {
  const raw = str(env, key, fallback);
  if (raw === 'file' || raw === 'redis') return raw;
  throw new ConfigError(`${key} must be file|redis, got ${JSON.stringify(raw)}`);
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

    redis: {
      url: str(env, 'REDIS_URL', 'redis://localhost:6379'),
      keyPrefix: str(env, 'REDIS_KEY_PREFIX', 'chat'),
      commandTimeoutMs: int(env, 'REDIS_COMMAND_TIMEOUT_MS', 5000, 100, 60_000),
    },

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

    blocks: {
      ttlSeconds: int(env, 'BLOCK_TTL_SECONDS', 2_592_000, 60, 31_536_000),
      ipDimensionEnabled: bool(env, 'BLOCK_DIMENSION_IP_ENABLED', true),
      clientDimensionEnabled: bool(env, 'BLOCK_DIMENSION_CLIENT_ENABLED', true),
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

    backup: {
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
      ipHashSalt: str(env, 'IP_HASH_SALT', 'change-me-in-production'),
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
  if (!config.blocks.ipDimensionEnabled && !config.blocks.clientDimensionEnabled) {
    warnings.push(
      'BLOCK_DIMENSION_IP_ENABLED and BLOCK_DIMENSION_CLIENT_ENABLED are both false: ' +
        'the block button will end the match but record nothing, so a blocked stranger ' +
        'can be matched again immediately.',
    );
  }
  if (config.isProduction && config.security.ipHashSalt === 'change-me-in-production') {
    warnings.push(
      'IP_HASH_SALT is still the default value in production: per-IP rate-limit keys are ' +
        'predictable. Set a secret salt.',
    );
  }
  return warnings;
}

export { ConfigError };
