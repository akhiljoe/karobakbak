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
import { newInstanceId } from './util/ids';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
  };

  readonly redis: {
    readonly url: string;
    readonly keyPrefix: string;
    readonly commandTimeoutMs: number;
  };

  readonly limits: {
    readonly maxMessageLength: number;
    readonly messageRatePerSec: number;
    readonly messageBurst: number;
    readonly maxFrameBytes: number;
    readonly rateLimitTtlSeconds: number;
    readonly maxConnections: number;
    readonly connRateLimit: number;
    readonly connRateWindowSeconds: number;
    readonly invalidMessageStrikes: number;
    readonly maxBufferedBytes: number;
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
  };

  readonly janitor: {
    readonly batch: number;
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
      port: int(env, 'BACKEND_PORT', 8080, 1, 65535),
      wsPath: path(env, 'WS_PATH', '/ws'),
      allowedOrigins: list(env, 'ALLOWED_ORIGINS', ''),
    },

    redis: {
      url: str(env, 'REDIS_URL', 'redis://localhost:6379'),
      keyPrefix: str(env, 'REDIS_KEY_PREFIX', 'chat'),
      commandTimeoutMs: int(env, 'REDIS_COMMAND_TIMEOUT_MS', 5000, 100, 60_000),
    },

    limits: {
      maxMessageLength: int(env, 'MAX_MESSAGE_LENGTH', 2000, 1, 100_000),
      messageRatePerSec: num(env, 'MESSAGE_RATE_PER_SEC', 5, 0.1, 1000),
      messageBurst: int(env, 'MESSAGE_BURST', 10, 1, 10_000),
      maxFrameBytes: int(env, 'MAX_FRAME_BYTES', 16_384, 1024, 10_485_760),
      rateLimitTtlSeconds: int(env, 'RATE_LIMIT_TTL_SECONDS', 120, 5, 86_400),
      maxConnections: int(env, 'MAX_CONNECTIONS', 5000, 1, 1_000_000),
      connRateLimit: int(env, 'CONN_RATE_LIMIT', 60, 1, 1_000_000),
      connRateWindowSeconds: int(env, 'CONN_RATE_WINDOW_SECONDS', 60, 1, 86_400),
      invalidMessageStrikes: int(env, 'INVALID_MESSAGE_STRIKES', 10, 1, 10_000),
      maxBufferedBytes: int(env, 'MAX_BUFFERED_BYTES', 1_048_576, 4096, 268_435_456),
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
    },

    janitor: {
      batch: int(env, 'JANITOR_BATCH', 200, 1, 10_000),
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
  const heartbeatSeconds = config.timers.heartbeatIntervalMs / 1000;
  if (heartbeatSeconds >= config.ttl.sessionSeconds / 2) {
    throw new ConfigError(
      `HEARTBEAT_INTERVAL_MS (${config.timers.heartbeatIntervalMs}ms) must be less than half of ` +
        `SESSION_TTL_SECONDS (${config.ttl.sessionSeconds}s), otherwise live sessions expire`,
    );
  }

  // Worst case a UTF-16 character encodes to 4 UTF-8 bytes; add slack for the
  // JSON envelope so a legal maximum-length message is never rejected as an
  // oversized frame.
  const worstCaseMessageBytes = config.limits.maxMessageLength * 4 + 512;
  if (config.limits.maxFrameBytes < worstCaseMessageBytes) {
    throw new ConfigError(
      `MAX_FRAME_BYTES (${config.limits.maxFrameBytes}) is too small for MAX_MESSAGE_LENGTH ` +
        `(${config.limits.maxMessageLength}); needs at least ${worstCaseMessageBytes}`,
    );
  }

  if (config.limits.messageBurst < config.limits.messageRatePerSec) {
    throw new ConfigError(
      `MESSAGE_BURST (${config.limits.messageBurst}) must be >= MESSAGE_RATE_PER_SEC ` +
        `(${config.limits.messageRatePerSec}); a bucket smaller than one second of refill ` +
        `cannot sustain the configured rate`,
    );
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
  if (config.http.allowedOrigins.length === 0) {
    warnings.push(
      'ALLOWED_ORIGINS is empty: WebSocket upgrades from ANY origin are accepted. ' +
        'Set an explicit allowlist before exposing this service.',
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
