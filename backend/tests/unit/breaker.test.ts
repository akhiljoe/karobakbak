/**
 * The database circuit breaker and the paced drain (D25).
 *
 * Time is passed in rather than slept through: every transition here is a
 * function of elapsed milliseconds, and a test that waited for them would be
 * slow and flaky for no extra confidence.
 */
import { silentLogger } from '../helpers/fakes';
import { loadConfig, type Config, type Env } from '../../src/config';
import { BREAKER_STATE_CODE, CircuitBreaker, DrainPacer } from '../../src/storage/breaker';

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

function breaker(overrides: Env = {}) {
  const transitions: string[] = [];
  const instance = new CircuitBreaker(config(overrides), silentLogger(), (to) =>
    transitions.push(to),
  );
  return { instance, transitions };
}

describe('opening', () => {
  it('starts closed and lets writes through', () => {
    const { instance } = breaker();
    expect(instance.current).toBe('CLOSED');
    expect(instance.canAttempt(0)).toBe(true);
  });

  it('does not open on a single failure', () => {
    // One deadlock or one statement timeout must not divert an otherwise
    // healthy system to the spool.
    const { instance } = breaker({ BREAKER_FAILURE_THRESHOLD: '3' });
    instance.recordFailure(0);
    instance.recordFailure(0);
    expect(instance.current).toBe('CLOSED');
    expect(instance.canAttempt(0)).toBe(true);
  });

  it('opens on the configured number of consecutive failures', () => {
    const { instance, transitions } = breaker({ BREAKER_FAILURE_THRESHOLD: '3' });
    for (let i = 0; i < 3; i += 1) instance.recordFailure(0);
    expect(instance.current).toBe('OPEN');
    expect(transitions).toEqual(['OPEN']);
  });

  it('resets the count on any success', () => {
    const { instance } = breaker({ BREAKER_FAILURE_THRESHOLD: '3' });
    instance.recordFailure(0);
    instance.recordFailure(0);
    instance.recordSuccess();
    instance.recordFailure(0);
    // Consecutive, not cumulative: intermittent failures on a working database
    // must not eventually add up to an outage.
    expect(instance.current).toBe('CLOSED');
  });

  it('attempts nothing at all while open', () => {
    const { instance } = breaker({ BREAKER_FAILURE_THRESHOLD: '1', BREAKER_COOLDOWN_MS: '5000' });
    instance.recordFailure(1000);
    // The point of OPEN is not failing faster, it is not consuming a
    // connection, a timeout and a slice of latency budget per attempt.
    expect(instance.canAttempt(1100)).toBe(false);
    expect(instance.canAttempt(5999)).toBe(false);
  });
});

describe('recovering', () => {
  it('allows exactly one probe once the cooldown elapses', () => {
    const { instance, transitions } = breaker({
      BREAKER_FAILURE_THRESHOLD: '1',
      BREAKER_COOLDOWN_MS: '1000',
    });
    instance.recordFailure(0);

    expect(instance.canAttempt(1000)).toBe(true);
    expect(instance.current).toBe('HALF_OPEN');
    // A second concurrent batch would turn the probe into the very load the
    // cooldown exists to withhold.
    expect(instance.canAttempt(1001)).toBe(false);
    expect(transitions).toEqual(['OPEN', 'HALF_OPEN']);
  });

  it('closes when the probe succeeds', () => {
    const { instance, transitions } = breaker({
      BREAKER_FAILURE_THRESHOLD: '1',
      BREAKER_COOLDOWN_MS: '1000',
    });
    instance.recordFailure(0);
    instance.canAttempt(1000);
    instance.recordSuccess();

    expect(instance.current).toBe('CLOSED');
    expect(transitions).toEqual(['OPEN', 'HALF_OPEN', 'CLOSED']);
  });

  it('backs off exponentially when the probe fails, up to the cap', () => {
    const { instance } = breaker({
      BREAKER_FAILURE_THRESHOLD: '1',
      BREAKER_COOLDOWN_MS: '1000',
      BREAKER_COOLDOWN_MAX_MS: '4000',
    });
    instance.recordFailure(0);
    expect(instance.snapshot().cooldownMs).toBe(1000);

    instance.canAttempt(1000);
    instance.recordFailure(1000);
    expect(instance.snapshot().cooldownMs).toBe(2000);

    instance.canAttempt(3000);
    instance.recordFailure(3000);
    expect(instance.snapshot().cooldownMs).toBe(4000);

    // Capped: a long outage must not back off to an hour and leave recovery
    // waiting long after the database returned.
    instance.canAttempt(7000);
    instance.recordFailure(7000);
    expect(instance.snapshot().cooldownMs).toBe(4000);
  });

  it('resets the backoff after a recovery, so the next outage starts short', () => {
    const { instance } = breaker({
      BREAKER_FAILURE_THRESHOLD: '1',
      BREAKER_COOLDOWN_MS: '1000',
      BREAKER_COOLDOWN_MAX_MS: '8000',
    });
    instance.recordFailure(0);
    instance.canAttempt(1000);
    instance.recordFailure(1000);
    expect(instance.snapshot().cooldownMs).toBe(2000);

    instance.canAttempt(3000);
    instance.recordSuccess();
    instance.recordFailure(4000);
    expect(instance.snapshot().cooldownMs).toBe(1000);
  });

  it('reports the state as the documented gauge value', () => {
    // 0 closed, 1 half-open, 2 open (§18).
    expect(BREAKER_STATE_CODE).toEqual({ CLOSED: 0, HALF_OPEN: 1, OPEN: 2 });
  });
});

describe('the paced drain', () => {
  it('allows one batch immediately and then paces', () => {
    const pacer = new DrainPacer(2, 0); // two batches per second
    expect(pacer.tryConsume(0)).toBe(true);
    // Replaying a backlog at full speed the instant a database returns is how
    // an outage repeats itself.
    expect(pacer.tryConsume(0)).toBe(false);
    expect(pacer.tryConsume(499)).toBe(false);
    expect(pacer.tryConsume(500)).toBe(true);
  });

  it('does not bank capacity while idle', () => {
    const pacer = new DrainPacer(5, 0);
    pacer.tryConsume(0);
    // Ten seconds of idleness would be fifty tokens if they accumulated, and
    // the drain would then burst exactly as hard as it must not.
    expect(pacer.tryConsume(10_000)).toBe(true);
    expect(pacer.tryConsume(10_000)).toBe(false);
  });

  it('reports how long the caller must wait', () => {
    const pacer = new DrainPacer(1, 0);
    pacer.tryConsume(0);
    expect(pacer.waitMs()).toBeGreaterThan(0);
    pacer.tryConsume(1000);
    expect(pacer.waitMs()).toBeGreaterThan(0);
  });
});
