/**
 * The database circuit breaker (D25).
 *
 * ```
 * CLOSED ──[ N consecutive failures ]──► OPEN
 *   ▲                                     │
 *   │                             [ cooldown elapses ]
 *   │                                     ▼
 *   └──[ probe succeeds ]──── HALF_OPEN ──┘
 *                              │
 *                       [ probe fails ] → OPEN, longer cooldown
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHY OPEN MEANS "DO NOT TRY"
 * ---------------------------------------------------------------------------
 * The point of OPEN is not to fail faster; it is to stop *attempting*. A dead
 * database that is still being written to consumes a connection, a timeout and
 * a slice of the latency budget per attempt, and those are the resources the
 * chat path needs to stay unaffected. While OPEN, records go straight to the
 * spool without touching the pool.
 *
 * ---------------------------------------------------------------------------
 * WHY RECOVERY IS PACED
 * ---------------------------------------------------------------------------
 * A backlog replayed at full speed the instant the database returns is the
 * classic way an outage repeats itself: the recovery load is exactly the load
 * that could not be served. Draining runs through a token bucket, highest
 * priority class first.
 *
 * A single failure never opens the circuit. `failureThreshold` *consecutive*
 * failures do, so one deadlock or one statement timeout does not divert an
 * otherwise healthy system to the spool.
 */
import type { Config } from '../config';
import type { Logger } from '../logger';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** 0/1/2, as the `chat_db_breaker_state` gauge reports it (§18). */
export const BREAKER_STATE_CODE: Record<BreakerState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly cooldownMs: number;
  readonly openedAtMs: number | null;
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private cooldownMs: number;
  /** Set while a HALF_OPEN probe is in flight, so only one is ever attempted. */
  private probing = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly onTransition?: (to: BreakerState) => void,
  ) {
    this.cooldownMs = config.breaker.cooldownMs;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      cooldownMs: this.cooldownMs,
      openedAtMs: this.openedAtMs,
    };
  }

  get current(): BreakerState {
    return this.state;
  }

  /**
   * Whether a write may be attempted now.
   *
   * Also performs the OPEN → HALF_OPEN transition, because "is the cooldown
   * over" is only ever asked at the moment somebody wants to write; a timer
   * would be a second source of truth for the same question.
   */
  canAttempt(nowMs = Date.now()): boolean {
    if (this.state === 'CLOSED') return true;

    if (this.state === 'OPEN') {
      if (this.openedAtMs !== null && nowMs - this.openedAtMs >= this.cooldownMs) {
        this.transition('HALF_OPEN');
        this.probing = true;
        return true;
      }
      return false;
    }

    // HALF_OPEN: exactly one probe at a time. A second concurrent batch would
    // turn the probe into the very load the cooldown exists to withhold.
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.probing = false;
    this.consecutiveFailures = 0;
    if (this.state !== 'CLOSED') {
      // Reset the backoff: the next outage starts from the short cooldown, not
      // from wherever the last one climbed to.
      this.cooldownMs = this.config.breaker.cooldownMs;
      this.openedAtMs = null;
      this.transition('CLOSED');
    }
  }

  recordFailure(nowMs = Date.now()): void {
    this.probing = false;
    this.consecutiveFailures += 1;

    if (this.state === 'HALF_OPEN') {
      // The probe failed. Back off further before spending another one.
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.config.breaker.cooldownMaxMs);
      this.openedAtMs = nowMs;
      this.transition('OPEN');
      return;
    }

    if (this.state === 'CLOSED' && this.consecutiveFailures >= this.config.breaker.failureThreshold) {
      this.openedAtMs = nowMs;
      this.transition('OPEN');
    }
  }

  private transition(to: BreakerState): void {
    if (this.state === to) return;
    this.state = to;
    this.logger.warn('database circuit breaker changed state', {
      breakerState: to,
      consecutiveFailures: this.consecutiveFailures,
      cooldownMs: this.cooldownMs,
    });
    this.onTransition?.(to);
  }
}

/**
 * The paced drain (`BREAKER_DRAIN_BATCHES_PER_SEC`).
 *
 * A token bucket rather than a fixed sleep: a fixed delay between batches gives
 * a rate that depends on how long each batch takes, which is precisely the
 * variable that is unstable while a database is recovering.
 */
export class DrainPacer {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSec: number,
    nowMs = Date.now(),
  ) {
    this.tokens = 1;
    this.lastRefillMs = nowMs;
  }

  /** Whether another batch may go now. */
  tryConsume(nowMs = Date.now()): boolean {
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(1, this.tokens + elapsedSec * this.ratePerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until the next batch is allowed. */
  waitMs(): number {
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }
}
