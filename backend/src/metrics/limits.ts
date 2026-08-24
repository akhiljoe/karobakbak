/**
 * The limits this process is running with, published as metrics.
 *
 * Its own module, and not part of `registry.ts`, for a reason worth keeping:
 * `metrics-wiring.test.ts` reads a metric written only inside the file that
 * declares it as dead, because that is exactly what ten genuinely dead metrics
 * looked like. Config gauges set during construction would have been
 * indistinguishable from them.
 *
 * These are configuration rather than measurement, so they are set once at
 * startup instead of sampled. Their whole purpose is that an alert can say
 * `chat_spool_records / chat_spool_max_records > 0.8` and stay correct under
 * any settings — where a threshold copied into a rule file is correct only
 * until somebody tunes one of the two and not the other. `SpoolNearCapacity`
 * fired at a hardcoded 40000, which is 80% of the *default* ceiling and
 * unreachable on a deployment that lowered it.
 */
import type { Config } from '../config';
import type { Metrics } from './registry';

export function publishLimits(metrics: Metrics, config: Config): void {
  metrics.spoolMaxRecords.set(config.spool.maxRecords);
  metrics.spoolMaxBytes.set(config.spool.maxBytes);
  metrics.backupMaxAge.set(config.backup.maxAgeSeconds);
}
