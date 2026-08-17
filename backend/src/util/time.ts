/**
 * Time helpers.
 *
 * All timestamps that reach a client are generated here, on the server.
 * Client-supplied timestamps are ignored by the protocol.
 */

/** Wall-clock milliseconds since the epoch. Used for Redis TTL bookkeeping. */
export function nowMs(): number {
  return Date.now();
}

/** ISO-8601 UTC, the only timestamp format on the wire. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 UTC for a specific epoch-milliseconds value. */
export function isoFrom(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Monotonic-ish high resolution clock for latency measurement.
 * Unaffected by wall-clock adjustments, so histograms stay sane across NTP
 * steps. Returns milliseconds as a float.
 */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

/** Seconds elapsed since a `monotonicMs()` reading — the unit Prometheus wants. */
export function secondsSince(startMonotonicMs: number): number {
  return (monotonicMs() - startMonotonicMs) / 1000;
}

/** Promise-based delay used by retry loops and shutdown sequencing. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
