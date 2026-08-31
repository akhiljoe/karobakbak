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
    expect(config.limits.maxMessageLength).toBe(500);
    expect(config.limits.maxReportNoteLength).toBe(500);
    expect(config.limits.rates.message).toEqual({ perSecond: 5, burst: 10 });
    expect(config.presence.intervalMs).toBe(15_000);
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
    expect(() => loadConfig(baseEnv({ BACKEND_PORT: '-1' }))).toThrow(/BACKEND_PORT/);
    expect(() => loadConfig(baseEnv({ BACKEND_PORT: '70000' }))).toThrow(/BACKEND_PORT/);
  });

  it('accepts port 0, which means "bind any free port"', () => {
    // Used by the socket tests so parallel runs do not fight over a fixed
    // port. The bound port is reported by listen() and logged at startup.
    expect(loadConfig(baseEnv({ BACKEND_PORT: '0' })).http.port).toBe(0);
  });

  it('does not trust proxy headers unless told how many proxies there are', () => {
    // Reading X-Forwarded-For with no proxy in front lets any client pick its
    // own rate-limit bucket and shed its blocks by sending a header.
    expect(loadConfig(baseEnv()).http.trustProxyHops).toBe(0);
    expect(loadConfig(baseEnv({ TRUST_PROXY_HOPS: '2' })).http.trustProxyHops).toBe(2);
    expect(() => loadConfig(baseEnv({ TRUST_PROXY_HOPS: '99' }))).toThrow(/TRUST_PROXY_HOPS/);
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
  it('rejects a default ban longer than the ban ceiling', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          ENFORCEMENT_DEFAULT_BAN_SECONDS: '2592000',
          ENFORCEMENT_MAX_BAN_SECONDS: '86400',
        }),
      ),
    ).toThrow(/ENFORCEMENT_DEFAULT_BAN_SECONDS/);
    // Equal is coherent: a deployment with exactly one legal ban length.
    expect(
      loadConfig(
        baseEnv({
          ENFORCEMENT_DEFAULT_BAN_SECONDS: '86400',
          ENFORCEMENT_MAX_BAN_SECONDS: '86400',
        }),
      ).enforcement.defaultBanSeconds,
    ).toBe(86400);
  });

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
    expect(() => loadConfig(baseEnv({ MESSAGE_RATE_PER_SEC: '20', MESSAGE_BURST: '5' }))).toThrow(
      /message burst/,
    );
  });

  it('rejects a rate-limit TTL that would reset a bucket before it refills', () => {
    // The hourly buckets are the ones this catches: a 120s TTL turns "10 per
    // hour" into "10 per two minutes", because expiry hands back a full bucket.
    expect(() => loadConfig(baseEnv({ RATE_LIMIT_TTL_SECONDS: '120' }))).toThrow(
      /RATE_LIMIT_TTL_SECONDS/,
    );
    // The default TTL covers every default bucket.
    expect(loadConfig(baseEnv()).limits.rateLimitTtlSeconds).toBe(3600);
  });

  it('rejects a frame limit that cannot carry a maximum-length report note', () => {
    // The bound is over every user-text field on the wire, not messages alone.
    expect(() =>
      loadConfig(baseEnv({ MAX_REPORT_NOTE_LENGTH: '4000', MAX_FRAME_BYTES: '8192' })),
    ).toThrow(/MAX_FRAME_BYTES/);
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

describe('loadConfig — per-command rate limits (R7)', () => {
  it('gives every state-changing command its own bucket', () => {
    const rates = loadConfig(baseEnv()).limits.rates;
    // Every client event except `ping` — a cheap protocol command must not be
    // a way around the message limit (security §12).
    expect(Object.keys(rates).sort()).toEqual([
      'block',
      'join_queue',
      'leave_chat',
      'leave_queue',
      'message',
      'report',
      'skip',
      'typing',
    ]);
    for (const limit of Object.values(rates)) {
      expect(limit.perSecond).toBeGreaterThan(0);
      expect(limit.burst).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the safety commands far stricter than chat', () => {
    const rates = loadConfig(baseEnv()).limits.rates;
    // 10/hour and 20/hour respectively (DESIGN.md §17): a report queue is a
    // human's time, and a block is a durable record.
    expect(rates.report.perSecond).toBeLessThan(rates.block.perSecond);
    expect(rates.block.perSecond).toBeLessThan(rates.skip.perSecond);
    expect(rates.skip.perSecond).toBeLessThan(rates.message.perSecond);
  });

  it('reads each bucket from its own environment variables', () => {
    const rates = loadConfig(
      baseEnv({ TYPING_RATE_PER_SEC: '1.5', TYPING_BURST: '3', REPORT_BURST: '1' }),
    ).limits.rates;
    expect(rates.typing).toEqual({ perSecond: 1.5, burst: 3 });
    expect(rates.report.burst).toBe(1);
    // Changing one bucket does not disturb another.
    expect(rates.message).toEqual({ perSecond: 5, burst: 10 });
  });

  it('rejects a nonsense rate rather than falling back to a default', () => {
    expect(() => loadConfig(baseEnv({ MESSAGE_RATE_PER_SEC: 'fast' }))).toThrow(
      /MESSAGE_RATE_PER_SEC/,
    );
    expect(() => loadConfig(baseEnv({ TYPING_BURST: '0' }))).toThrow(/TYPING_BURST/);
  });
});

describe('loadConfig — Redis layer settings', () => {
  it('applies the documented matchmaking and block defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config.matchmaking.defaultSegment).toBe('default');
    expect(config.limits.maxConnectionsPerIp).toBe(40);
    expect(config.limits.dedupeMaxEntries).toBe(10_000);
    expect(config.blocks).toEqual({
      ttlSeconds: 2_592_000,
      ipDimensionEnabled: true,
      clientDimensionEnabled: true,
      lateBlockSeconds: 120,
    });
  });

  it('rejects a segment name that would break the key namespace', () => {
    // The segment goes straight into chat:queue:{segment}; a ':' would put the
    // queue somewhere the janitor never looks.
    expect(() => loadConfig(baseEnv({ DEFAULT_QUEUE_SEGMENT: 'a:b' }))).toThrow(
      /DEFAULT_QUEUE_SEGMENT/,
    );
    expect(() => loadConfig(baseEnv({ DEFAULT_QUEUE_SEGMENT: 'has space' }))).toThrow(
      /DEFAULT_QUEUE_SEGMENT/,
    );
    expect(() => loadConfig(baseEnv({ DEFAULT_QUEUE_SEGMENT: 'UPPER' }))).toThrow(
      /DEFAULT_QUEUE_SEGMENT/,
    );
    expect(loadConfig(baseEnv({ DEFAULT_QUEUE_SEGMENT: 'en-gb_1' })).matchmaking.defaultSegment).toBe(
      'en-gb_1',
    );
  });

  it('lets each block dimension be disabled independently (D18)', () => {
    const noIp = loadConfig(baseEnv({ BLOCK_DIMENSION_IP_ENABLED: 'false' }));
    expect(noIp.blocks.ipDimensionEnabled).toBe(false);
    expect(noIp.blocks.clientDimensionEnabled).toBe(true);
  });

  it('warns when blocking is configured to record nothing', () => {
    const warnings = configWarnings(
      loadConfig(
        baseEnv({ BLOCK_DIMENSION_IP_ENABLED: 'false', BLOCK_DIMENSION_CLIENT_ENABLED: 'false' }),
      ),
    );
    // Legal, but it makes the block button end the match and nothing else.
    expect(warnings.join(' ')).toMatch(/BLOCK_DIMENSION/);
  });
});

/**
 * The topology the process will use to reach Redis (F-033, D13).
 *
 * Every case here is about the same hazard, and it is not a crash: it is a
 * configuration that *looks* like failover and silently is not. Redis holds all
 * live matchmaking state and `/ready` is derived from its health alone, so the
 * cost of getting this wrong is only ever paid on the day the primary dies —
 * long after anyone could connect the outage to the setting that caused it.
 *
 * So the rule is that every half-specified topology throws at startup. None of
 * them may fall back to a single node.
 */
describe('loadConfig — how Redis is reached (D13)', () => {
  it('defaults to one node at a fixed address', () => {
    const config = loadConfig(baseEnv());
    expect(config.redis.sentinels).toEqual([]);
    expect(config.redis.sentinelName).toBe('');
    expect(config.redis.url).toBe('redis://localhost:6379');
  });

  it('parses a sentinel set into hosts and ports', () => {
    const config = loadConfig(
      baseEnv({
        REDIS_URL: '',
        REDIS_SENTINELS: 'sentinel-a:26379, sentinel-b:26379 ,sentinel-c:26380',
        REDIS_SENTINEL_NAME: 'karobakbak',
      }),
    );
    expect(config.redis.sentinels).toEqual([
      { host: 'sentinel-a', port: 26379 },
      { host: 'sentinel-b', port: 26379 },
      { host: 'sentinel-c', port: 26380 },
    ]);
    expect(config.redis.sentinelName).toBe('karobakbak');
  });

  it('refuses sentinels without the primary name', () => {
    // The one that would be most tempting to default. Sentinel is asked for a
    // primary *by name*; without it there is nothing to ask, and quietly using
    // REDIS_URL instead hands back the single node the operator was trying to
    // stop depending on.
    expect(() =>
      loadConfig(baseEnv({ REDIS_URL: '', REDIS_SENTINELS: 'sentinel-a:26379' })),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(baseEnv({ REDIS_URL: '', REDIS_SENTINELS: 'sentinel-a:26379' })),
    ).toThrow(/REDIS_SENTINEL_NAME/);
  });

  it('refuses a primary name with no sentinels to ask', () => {
    expect(() =>
      loadConfig(baseEnv({ REDIS_URL: '', REDIS_SENTINEL_NAME: 'karobakbak' })),
    ).toThrow(/REDIS_SENTINELS/);
  });

  it('refuses a fixed address and a sentinel set together', () => {
    // Not pedantry: this is the shape a half-finished migration leaves behind,
    // and the file would then claim one topology while the process used the
    // other.
    expect(() =>
      loadConfig(
        baseEnv({
          REDIS_URL: 'redis://localhost:6379',
          REDIS_SENTINELS: 'sentinel-a:26379',
          REDIS_SENTINEL_NAME: 'karobakbak',
        }),
      ),
    ).toThrow(/mutually exclusive/);
  });

  it('refuses a sentinel address that is not host:port', () => {
    const bad = (value: string): (() => unknown) => () =>
      loadConfig(
        baseEnv({ REDIS_URL: '', REDIS_SENTINELS: value, REDIS_SENTINEL_NAME: 'karobakbak' }),
      );

    // A missing port is the interesting one. Defaulting it to 26379 would make
    // a typo reachable-looking, and a Sentinel on the wrong port is
    // indistinguishable from one that is down: the set still forms a quorum
    // without it, still fails over, and hides the mistake until the day that
    // Sentinel's vote was the one needed.
    expect(bad('sentinel-a')).toThrow(/host:port/);
    expect(bad('sentinel-a:')).toThrow(/host:port/);
    expect(bad(':26379')).toThrow(/host:port/);
    expect(bad('sentinel-a:notaport')).toThrow(/invalid port/);
    expect(bad('sentinel-a:0')).toThrow(/invalid port/);
    expect(bad('sentinel-a:70000')).toThrow(/invalid port/);
  });

  it('keeps the node and sentinel passwords apart', () => {
    // Different processes, routinely different credentials. Conflating them
    // authenticates against nothing and then fails at the first command, having
    // connected successfully.
    const config = loadConfig(
      baseEnv({
        REDIS_URL: '',
        REDIS_SENTINELS: 'sentinel-a:26379',
        REDIS_SENTINEL_NAME: 'karobakbak',
        REDIS_PASSWORD: 'node-secret',
        REDIS_SENTINEL_PASSWORD: 'sentinel-secret',
      }),
    );
    expect(config.redis.password).toBe('node-secret');
    expect(config.redis.sentinelPassword).toBe('sentinel-secret');
  });

  it('warns that a production single node is the one total failure', () => {
    const warnings = configWarnings(
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          IP_HASH_SALT: 'a-long-enough-production-salt-value',
          ALLOWED_ORIGINS: 'https://karobakbak.example',
        }),
      ),
    );
    // A warning and not a startup failure: one Redis is the documented
    // deployment (D13), so refusing to start would refuse the configuration the
    // service actually runs today.
    expect(warnings.join(' ')).toMatch(/REDIS_SENTINELS is empty/);
  });

  it('warns about a sentinel set too small to lose a member', () => {
    const warnings = configWarnings(
      loadConfig(
        baseEnv({
          REDIS_URL: '',
          REDIS_SENTINELS: 'sentinel-a:26379,sentinel-b:26379',
          REDIS_SENTINEL_NAME: 'karobakbak',
        }),
      ),
    );
    // Two is the worst case: losing either leaves the other short of a
    // majority, so nothing is promoted and the topology is worse than the
    // single node it replaced.
    expect(warnings.join(' ')).toMatch(/fewer than three/);
  });

  it('does not warn about a three-sentinel set', () => {
    const warnings = configWarnings(
      loadConfig(
        baseEnv({
          REDIS_URL: '',
          REDIS_SENTINELS: 'sentinel-a:26379,sentinel-b:26379,sentinel-c:26379',
          REDIS_SENTINEL_NAME: 'karobakbak',
        }),
      ),
    );
    expect(warnings.join(' ')).not.toMatch(/REDIS_SENTINELS/);
  });
});

/**
 * Preference matching (D44, §29). Off by default, and the wider look has to be
 * wider — a value below the ordinary sample reads as configured and silently
 * does the opposite of its name.
 */
describe('loadConfig — preference matching (D44)', () => {
  it('ships disabled, with the documented sample and limits', () => {
    const config = loadConfig(baseEnv());
    expect(config.preference).toEqual({
      enabled: false,
      wideSample: 32,
      cooldownMs: 10_000,
      hourlyBudget: 120,
    });
  });

  it('refuses to ship the preference in production without its rate limits', () => {
    // The pairing §29.4 records: the cooldown and the hourly budget are part of
    // D44, not later hardening, because they are what answers D37's targeting
    // objection. `FILTERS_ENABLED` is one environment variable, and the person
    // most likely to set it — somebody holding two weeks of data — is the least
    // likely to remember the limits were never written.
    const live = baseEnv({
      NODE_ENV: 'production',
      FILTERS_ENABLED: 'true',
      IP_HASH_SALT: 'a-long-enough-production-salt-value',
      ALLOWED_ORIGINS: 'https://karobakbak.example',
    });
    expect(() => loadConfig(live)).toThrow(ConfigError);
    expect(() => loadConfig(live)).toThrow(/PREFERENCE_LIMITS_ENFORCED/);
  });

  it('allows it outside production, and says so out loud', () => {
    // Turning it on locally is how the feature is exercised and how it will be
    // judged against real numbers. Legal, and never silent.
    const config = loadConfig(baseEnv({ FILTERS_ENABLED: 'true' }));
    expect(config.preference.enabled).toBe(true);
    expect(configWarnings(config).join(' ')).toMatch(/no rate limits yet/);
  });

  it('refuses a wide sample that is not wider than the ordinary one', () => {
    // Equal is refused too: an escalation that considers the same number of
    // candidates is a second pass through the pool for nothing.
    expect(() =>
      loadConfig(baseEnv({ MATCH_CANDIDATE_SAMPLE: '32', PREFERENCE_WIDE_SAMPLE: '32' })),
    ).toThrow(/PREFERENCE_WIDE_SAMPLE/);
    expect(() =>
      loadConfig(baseEnv({ MATCH_CANDIDATE_SAMPLE: '40', PREFERENCE_WIDE_SAMPLE: '32' })),
    ).toThrow(ConfigError);
    expect(
      loadConfig(baseEnv({ MATCH_CANDIDATE_SAMPLE: '8', PREFERENCE_WIDE_SAMPLE: '9' })).preference
        .wideSample,
    ).toBe(9);
  });
});

describe('loadConfig — moderation', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config.moderation).toEqual({
      enabled: true,
      // Flag, not withhold: local rules produce signals, not verdicts (D20).
      defaultAction: 'flag',
      hardBlockRules: [],
      detectContact: true,
      denyList: [],
    });
  });

  it('rejects an action that is not one of the three', () => {
    expect(() => loadConfig(baseEnv({ MODERATION_DEFAULT_ACTION: 'delete' }))).toThrow(
      /MODERATION_DEFAULT_ACTION/,
    );
    expect(() => loadConfig(baseEnv({ MODERATION_DEFAULT_ACTION: 'allow' }))).toThrow(
      /MODERATION_DEFAULT_ACTION/,
    );
  });

  it('refuses to start on a hard-block rule that does not exist', () => {
    // A typo here would silently disable a hard block an operator believed
    // they had configured - discovered only by the abuse it did not stop.
    expect(() => loadConfig(baseEnv({ MODERATION_HARD_BLOCK_RULES: 'crypto_adress' }))).toThrow(
      /unknown rule/,
    );
    expect(
      loadConfig(baseEnv({ MODERATION_HARD_BLOCK_RULES: 'crypto_address,invite_link' })).moderation
        .hardBlockRules,
    ).toEqual(['crypto_address', 'invite_link']);
  });

  it('lower-cases the deny list, because matching is case-insensitive', () => {
    expect(loadConfig(baseEnv({ MODERATION_DENY_LIST: 'BadWord, Other ' })).moderation.denyList).toEqual(
      ['badword', 'other'],
    );
  });
});

describe('loadConfig — origin allowlist (R9)', () => {
  it('refuses to start in production with an empty allowlist', () => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: '' }))).toThrow(
      /ALLOWED_ORIGINS/,
    );
    expect(() => loadConfig(baseEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: '  ,, ' }))).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  it('starts in production once at least one origin is listed', () => {
    const config = loadConfig(
      baseEnv({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://chat.example.com',
        // Production also refuses the published salt, so a config that starts
        // must set one. Asserted in its own test below.
        IP_HASH_SALT: 'a-real-secret',
      }),
    );
    expect(config.http.allowedOrigins).toEqual(['https://chat.example.com']);
  });

  it('refuses the published salt in production rather than warning about it', () => {
    // It salts every IP and client-token hash. Left at the default, those
    // hashes are reproducible by anyone holding this source — and IPv4 is
    // small enough to enumerate offline against a leaked database.
    //
    // This was a warning, on the reasoning that the production compose file
    // already requires the variable. The exposure is the deployment that does
    // not use that compose file, which is what a first deploy under pressure
    // looks like.
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://a.example' })),
    ).toThrow(/IP_HASH_SALT/);

    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          ALLOWED_ORIGINS: 'https://a.example',
          IP_HASH_SALT: 'a-real-secret',
        }),
      ),
    ).not.toThrow();
  });

  it('keeps the default usable outside production', () => {
    // A laptop is not an exposure, and threading a secret through every test
    // and dev command would be friction with no security value.
    expect(loadConfig(baseEnv()).security.ipHashSalt).toBe('change-me-in-production');
  });

  it('refuses a spool backend it cannot honour, instead of ignoring it', () => {
    // `redis` was accepted, exposed on the config, and then ignored — startup
    // built a file spool regardless. An operator choosing it to keep outage
    // records off local disk got a plaintext file anyway.
    expect(() => loadConfig(baseEnv({ SPOOL_BACKEND: 'redis' }))).toThrow(/not implemented/);
    expect(() => loadConfig(baseEnv({ SPOOL_BACKEND: 'nonsense' }))).toThrow(/must be file/);
    expect(loadConfig(baseEnv({ SPOOL_BACKEND: 'file' })).spool.backend).toBe('file');
  });

  it('still allows an empty allowlist outside production', () => {
    // The dev server's port moves around; this stays a warning there.
    expect(loadConfig(baseEnv({ ALLOWED_ORIGINS: '' })).http.allowedOrigins).toEqual([]);
  });
});

describe('configWarnings', () => {
  it('warns when any origin is accepted', () => {
    const warnings = configWarnings(loadConfig(baseEnv({ ALLOWED_ORIGINS: '' })));
    expect(warnings.join(' ')).toMatch(/ALLOWED_ORIGINS/);
  });

  it('warns about the default IP hash salt outside production', () => {
    // Production no longer reaches this: `assertCoherent` throws first. So the
    // warning is the development case, where the default is a convenience.
    const dev = configWarnings(loadConfig(baseEnv()));
    expect(dev.join(' ')).toMatch(/IP_HASH_SALT/);

    // Narrowed to the subject rather than asserting the whole list is empty:
    // this used to be `toEqual([])`, which made every unrelated warning added
    // later fail a test about the salt.
    const salted = configWarnings(
      loadConfig(baseEnv({ NODE_ENV: 'production', IP_HASH_SALT: 'a-real-secret' })),
    );
    expect(salted.join(' ')).not.toMatch(/IP_HASH_SALT/);
  });

  it('warns when nothing can report a backup', () => {
    // `BackupMonitor` reports `unknown` until something tells it otherwise, and
    // the report endpoint does not exist without a token — so an unconfigured
    // deployment has no way to ever leave that state.
    const silent = configWarnings(loadConfig(baseEnv()));
    expect(silent.join(' ')).toMatch(/BACKUP_REPORT_TOKEN/);

    const configured = configWarnings(
      loadConfig(baseEnv({ BACKUP_REPORT_TOKEN: 'a-shared-secret' })),
    );
    expect(configured.join(' ')).not.toMatch(/BACKUP_REPORT_TOKEN/);
  });
});

describe('persona provider, model and price (D-AI-10)', () => {
  // The three settings are one decision, and every way of getting them out of
  // step fails quietly at runtime rather than loudly at boot. All of these are
  // only policed once a key is set: the keyless scripted mode reaches no
  // provider at all and is a supported way to run.
  const withKey = (overrides: Env = {}): Env =>
    baseEnv({
      PERSONAS_ENABLED: 'true',
      PERSONA_API_KEY: 'sk-test',
      ...overrides,
    });

  it('accepts the Anthropic default pairing', () => {
    const config = loadConfig(withKey());
    expect(config.personas.provider).toBe('anthropic');
    expect(config.personas.model).toBe('claude-haiku-4-5');
  });

  it('accepts an OpenAI pairing', () => {
    const config = loadConfig(
      withKey({ PERSONA_PROVIDER: 'openai', PERSONA_MODEL: 'gpt-5-mini' }),
    );
    expect(config.personas.provider).toBe('openai');
    expect(config.personas.model).toBe('gpt-5-mini');
  });

  it('refuses a provider with no adapter', () => {
    expect(() => loadConfig(withKey({ PERSONA_PROVIDER: 'mistral' }))).toThrow(ConfigError);
  });

  it('refuses one vendor model against the other vendor key', () => {
    // This is the quiet one. An Anthropic model id with an OpenAI key
    // authenticates fine and then fails every single call, and the scripted
    // fallback turns that into weeks of unhelpful conversations with nothing
    // in the logs saying why.
    expect(() =>
      loadConfig(withKey({ PERSONA_PROVIDER: 'openai', PERSONA_MODEL: 'claude-haiku-4-5' })),
    ).toThrow(/is not served by/);

    expect(() =>
      loadConfig(withKey({ PERSONA_PROVIDER: 'anthropic', PERSONA_MODEL: 'gpt-5-mini' })),
    ).toThrow(/is not served by/);
  });

  it('refuses a model with no published price, because the ceiling could not bind', () => {
    // `safeCost` downgrades an unpriced model to a log line and a zero rather
    // than failing a conversation somebody is having, so an unpriced model
    // spends against a budget that never binds. Boot is the only place this
    // can be caught loudly.
    expect(() => loadConfig(withKey({ PERSONA_MODEL: 'gpt-9-imaginary' }))).toThrow(
      /MODEL_PRICES/,
    );
  });

  it('polices none of it without a key, because nothing reaches a provider', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          PERSONAS_ENABLED: 'true',
          PERSONA_PROVIDER: 'nonsense',
          PERSONA_MODEL: 'also-nonsense',
        }),
      ),
    ).not.toThrow();
  });

  it('polices none of it while personas are off', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          PERSONAS_ENABLED: 'false',
          PERSONA_API_KEY: 'sk-test',
          PERSONA_PROVIDER: 'nonsense',
        }),
      ),
    ).not.toThrow();
  });
});

describe('persona fill policy coherence (A3)', () => {
  it('refuses a concurrency cap at or above the per-IP connection limit', () => {
    // Every persona connects from the same address, so they share one
    // connection bucket. A cap at or above the limit is a setting that looks
    // applied and silently is not — the symptom is refused connections, which
    // reads as "personas are broken" rather than "the cap is wrong".
    expect(() =>
      loadConfig(
        baseEnv({
          PERSONAS_ENABLED: 'true',
          MAX_CONNECTIONS_PER_IP: '10',
          PERSONA_MAX_CONCURRENT: '10',
        }),
      ),
    ).toThrow(/must be below/);
  });

  it('accepts a concurrency cap below the connection limit', () => {
    const config = loadConfig(
      baseEnv({
        PERSONAS_ENABLED: 'true',
        MAX_CONNECTIONS_PER_IP: '10',
        PERSONA_MAX_CONCURRENT: '9',
      }),
    );
    expect(config.personas.maxConcurrent).toBe(9);
  });

  it('refuses a per-character cap that can never bind', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          PERSONAS_ENABLED: 'true',
          PERSONA_MAX_CONCURRENT: '3',
          PERSONA_MAX_PER_CHARACTER: '5',
        }),
      ),
    ).toThrow(/can never bind/);
  });

  it('does not police the relationship while personas are off', () => {
    // An incoherent setting on a disabled feature should not stop the process
    // starting; it becomes fatal the moment somebody turns personas on.
    expect(() =>
      loadConfig(
        baseEnv({
          PERSONAS_ENABLED: 'false',
          MAX_CONNECTIONS_PER_IP: '10',
          PERSONA_MAX_CONCURRENT: '50',
        }),
      ),
    ).not.toThrow();
  });

  it('ships disabled, because the feature spends money per message', () => {
    expect(loadConfig(baseEnv()).personas.enabled).toBe(false);
  });
});

describe('payments configuration', () => {
  const live = {
    PAYMENTS_ENABLED: 'true',
    RAZORPAY_KEY_ID: 'rzp_live_abc',
    RAZORPAY_KEY_SECRET: 'shh',
    RAZORPAY_WEBHOOK_SECRET: 'whsec',
  };

  it('ships disabled, and turning it on is a commit rather than a deploy', () => {
    const config = loadConfig(baseEnv());
    expect(config.payments.enabled).toBe(false);
    // No credential has a default, so an unconfigured process has nothing to
    // accidentally authenticate with.
    expect(config.payments.keyId).toBe('');
    expect(config.payments.keySecret).toBe('');
    expect(config.payments.webhookSecret).toBe('');
  });

  it('starts with credentials present', () => {
    expect(() => loadConfig(baseEnv(live))).not.toThrow();
  });

  /**
   * The check that matters most. A fallback webhook secret means a deployment
   * that forgot the variable accepts webhooks signed with a string published in
   * this repository, and the symptom is not an error — it is a stranger
   * granting themselves premium.
   */
  it('refuses to start with payments on and any credential missing', () => {
    for (const missing of [
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ] as const) {
      expect(() => loadConfig(baseEnv({ ...live, [missing]: '' }))).toThrow(ConfigError);
      expect(() => loadConfig(baseEnv({ ...live, [missing]: '' }))).toThrow(missing);
    }
  });

  it('refuses payments without the database they write to', () => {
    expect(() => loadConfig(baseEnv({ ...live, RETENTION_ENABLED: 'false' }))).toThrow(
      /RETENTION_ENABLED/,
    );
  });

  /**
   * Test mode grants entitlements and moves no money, and nothing at runtime
   * reports it. The bank statement is the first signal, weeks later.
   */
  it('refuses a test-mode key in production', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          ...live,
          NODE_ENV: 'production',
          RAZORPAY_KEY_ID: 'rzp_test_abc',
          IP_HASH_SALT: 'a-real-salt-value',
        }),
      ),
    ).toThrow(/test-mode/);
  });

  it('allows a test key outside production, which is where it belongs', () => {
    expect(() => loadConfig(baseEnv({ ...live, RAZORPAY_KEY_ID: 'rzp_test_abc' }))).not.toThrow();
  });

  it('does not police credentials while payments are off', () => {
    expect(() => loadConfig(baseEnv({ PAYMENTS_ENABLED: 'false' }))).not.toThrow();
  });
});
