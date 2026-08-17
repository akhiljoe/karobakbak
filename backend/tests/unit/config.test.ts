import { ConfigError, configWarnings, loadConfig, type Env } from '../../src/config';

/** A minimal environment that satisfies every cross-field constraint. */
function baseEnv(overrides: Env = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    INSTANCE_ID: 'i_test',
    REDIS_URL: 'redis://localhost:6379',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config.http.port).toBe(8080);
    expect(config.http.wsPath).toBe('/ws');
    expect(config.redis.keyPrefix).toBe('chat');
    expect(config.limits.maxMessageLength).toBe(2000);
    expect(config.limits.messageRatePerSec).toBe(5);
    expect(config.limits.messageBurst).toBe(10);
    expect(config.ttl.sessionSeconds).toBe(120);
    expect(config.matchmaking.candidateSample).toBe(8);
    expect(config.metrics.enabled).toBe(true);
  });

  it('uses the configured instance id verbatim and generates one otherwise', () => {
    expect(loadConfig(baseEnv()).instanceId).toBe('i_test');
    const generated = loadConfig(baseEnv({ INSTANCE_ID: '' })).instanceId;
    expect(generated).toMatch(/^i_/);
    expect(generated).not.toBe('i_test');
  });

  it('parses an origin allowlist and tolerates padding', () => {
    const config = loadConfig(
      baseEnv({ ALLOWED_ORIGINS: ' http://a.test , http://b.test ,, http://c.test ' }),
    );
    expect(config.http.allowedOrigins).toEqual([
      'http://a.test',
      'http://b.test',
      'http://c.test',
    ]);
  });

  it('parses booleans in every documented spelling', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadConfig(baseEnv({ METRICS_ENABLED: truthy })).metrics.enabled).toBe(true);
    }
    for (const falsy of ['0', 'false', 'No', 'off']) {
      expect(loadConfig(baseEnv({ METRICS_ENABLED: falsy })).metrics.enabled).toBe(false);
    }
    expect(() => loadConfig(baseEnv({ METRICS_ENABLED: 'maybe' }))).toThrow(ConfigError);
  });

  it('rejects non-integer, out-of-range and nonsense numbers', () => {
    expect(() => loadConfig(baseEnv({ BACKEND_PORT: 'eighty' }))).toThrow(/BACKEND_PORT/);
    expect(() => loadConfig(baseEnv({ BACKEND_PORT: '1.5' }))).toThrow(/BACKEND_PORT/);
    expect(() => loadConfig(baseEnv({ BACKEND_PORT: '0' }))).toThrow(/BACKEND_PORT/);
    expect(() => loadConfig(baseEnv({ BACKEND_PORT: '70000' }))).toThrow(/BACKEND_PORT/);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig(baseEnv({ LOG_LEVEL: 'verbose' }))).toThrow(/LOG_LEVEL/);
  });

  it('requires paths to be absolute', () => {
    expect(() => loadConfig(baseEnv({ WS_PATH: 'ws' }))).toThrow(/WS_PATH/);
    expect(() => loadConfig(baseEnv({ METRICS_PATH: 'metrics' }))).toThrow(/METRICS_PATH/);
  });
});

describe('loadConfig — cross-field coherence', () => {
  it('rejects a heartbeat that cannot keep a session alive', () => {
    expect(() =>
      loadConfig(baseEnv({ SESSION_TTL_SECONDS: '30', HEARTBEAT_INTERVAL_MS: '20000' })),
    ).toThrow(/HEARTBEAT_INTERVAL_MS/);
    // Half the TTL is the boundary and is itself rejected; a third is fine.
    expect(() =>
      loadConfig(baseEnv({ SESSION_TTL_SECONDS: '60', HEARTBEAT_INTERVAL_MS: '30000' })),
    ).toThrow(/HEARTBEAT_INTERVAL_MS/);
    expect(
      loadConfig(baseEnv({ SESSION_TTL_SECONDS: '60', HEARTBEAT_INTERVAL_MS: '20000' })).timers
        .heartbeatIntervalMs,
    ).toBe(20000);
  });

  it('rejects a frame limit that cannot carry a maximum-length message', () => {
    expect(() =>
      loadConfig(baseEnv({ MAX_MESSAGE_LENGTH: '2000', MAX_FRAME_BYTES: '4096' })),
    ).toThrow(/MAX_FRAME_BYTES/);
    expect(
      loadConfig(baseEnv({ MAX_MESSAGE_LENGTH: '2000', MAX_FRAME_BYTES: '8512' })).limits
        .maxFrameBytes,
    ).toBe(8512);
  });

  it('rejects a burst smaller than one second of refill', () => {
    expect(() =>
      loadConfig(baseEnv({ MESSAGE_RATE_PER_SEC: '20', MESSAGE_BURST: '5' })),
    ).toThrow(/MESSAGE_BURST/);
  });

  it('rejects a match TTL shorter than the session TTL', () => {
    expect(() =>
      loadConfig(baseEnv({ SESSION_TTL_SECONDS: '600', MATCH_TTL_SECONDS: '60' })),
    ).toThrow(/MATCH_TTL_SECONDS/);
  });

  it('rejects a janitor lock that expires before the next pass', () => {
    expect(() =>
      loadConfig(baseEnv({ JANITOR_INTERVAL_MS: '60000', JANITOR_LOCK_TTL_SECONDS: '10' })),
    ).toThrow(/JANITOR_LOCK_TTL_SECONDS/);
  });

  it('rejects a key prefix that would corrupt the namespace', () => {
    expect(() => loadConfig(baseEnv({ REDIS_KEY_PREFIX: 'chat:v2' }))).toThrow(/REDIS_KEY_PREFIX/);
    expect(() => loadConfig(baseEnv({ REDIS_KEY_PREFIX: 'my chat' }))).toThrow(/REDIS_KEY_PREFIX/);
  });
});

describe('configWarnings', () => {
  it('warns when any origin is accepted', () => {
    const warnings = configWarnings(loadConfig(baseEnv({ ALLOWED_ORIGINS: '' })));
    expect(warnings.join(' ')).toMatch(/ALLOWED_ORIGINS/);
  });

  it('warns about the default IP hash salt only in production', () => {
    const dev = configWarnings(loadConfig(baseEnv()));
    expect(dev.join(' ')).not.toMatch(/IP_HASH_SALT/);

    const prod = configWarnings(loadConfig(baseEnv({ NODE_ENV: 'production' })));
    expect(prod.join(' ')).toMatch(/IP_HASH_SALT/);

    const salted = configWarnings(
      loadConfig(baseEnv({ NODE_ENV: 'production', IP_HASH_SALT: 'a-real-secret' })),
    );
    expect(salted).toEqual([]);
  });
});
