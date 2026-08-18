/**
 * The janitor (§10.11–§10.13).
 *
 * ---------------------------------------------------------------------------
 * THE RECOVERY NET, NOT THE MECHANISM
 * ---------------------------------------------------------------------------
 * Every transition cleans up after itself. This exists for the cases where no
 * transition ever ran: a SIGKILLed instance whose sockets closed without a
 * handler, a session whose row expired while its queue entry did not, a match
 * whose participant vanished. TTLs cover most of it; the janitor covers what a
 * TTL cannot, which is anything that needs a *decision* — ending a match and
 * telling the survivor.
 *
 * It is deliberately unhurried. Nothing here is on a user's critical path, and
 * everything it does is idempotent, so a pass that is skipped, repeated or run
 * by a different instance costs nothing.
 *
 * ---------------------------------------------------------------------------
 * ONE INSTANCE PER PASS
 * ---------------------------------------------------------------------------
 * Leader-locked through Redis. The scripts are safe to run concurrently — they
 * are single Lua invocations — but N instances scanning the same sets every
 * interval is N times the load for the same result.
 *
 * The instance beacon is refreshed by **every** instance, not just the leader:
 * it is how the others know this one is alive, and a beacon that only the
 * leader refreshed would make every follower look crashed.
 */
import type { Config } from '../config';
import type { Logger } from '../logger';
import type {
  JanitorMatchesResult,
  JanitorQueueResult,
  JanitorSessionsResult,
  Survivor,
} from '../redis/store';
import { nowIso } from '../util/time';
import type { EventDispatcher } from './dispatch';

/** The part of the store the janitor uses. */
export interface JanitorStore {
  acquireJanitorLock(instanceId: string): Promise<boolean>;
  refreshInstanceBeacon(instanceId: string): Promise<void>;
  janitorQueue(segment: string): Promise<JanitorQueueResult>;
  janitorMatches(): Promise<JanitorMatchesResult>;
  janitorSessions(): Promise<JanitorSessionsResult>;
  janitorInstances(): Promise<{ removed: number; remaining: number }>;
  queueDepth(segment: string): Promise<number>;
  presenceCounts(): Promise<{ online: number; conversations: number }>;
}

export interface JanitorPass {
  /** False when another instance held the lock. The beacon is still refreshed. */
  ran: boolean;
  queueRemoved: number;
  matchesDropped: number;
  matchesEnded: number;
  sessionsReaped: number;
  instancesRemoved: number;
  survivorsNotified: number;
}

const IDLE_PASS: JanitorPass = {
  ran: false,
  queueRemoved: 0,
  matchesDropped: 0,
  matchesEnded: 0,
  sessionsReaped: 0,
  instancesRemoved: 0,
  survivorsNotified: 0,
};

export class Janitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly store: JanitorStore,
    private readonly dispatcher: EventDispatcher,
    /** Called with fresh cluster counts each pass, for the gauges. */
    private readonly onCounts?: (counts: {
      online: number;
      conversations: number;
      queueDepth: number;
    }) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass();
    }, this.config.timers.janitorIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Never throws: a Redis blip during a sweep is not a reason to take
   * down a process, and the next pass retries whatever this one missed.
   */
  async runPass(): Promise<JanitorPass> {
    if (this.running) return { ...IDLE_PASS };
    this.running = true;
    try {
      // Before the lock, and regardless of whether this instance wins it.
      await this.store.refreshInstanceBeacon(this.config.instanceId);

      if (!(await this.store.acquireJanitorLock(this.config.instanceId))) {
        return { ...IDLE_PASS };
      }

      const segment = this.config.matchmaking.defaultSegment;
      const queue = await this.store.janitorQueue(segment);
      const matches = await this.store.janitorMatches();
      const sessions = await this.store.janitorSessions();
      const instances = await this.store.janitorInstances();

      // A survivor learns its conversation ended from the same event a live
      // partner's disconnect would have produced. The janitor reaped the other
      // side; from this user's point of view the stranger simply left.
      const survivors = [...matches.survivors, ...sessions.survivors];
      const notified = await this.notify(survivors);

      if (this.onCounts) {
        const counts = await this.store.presenceCounts();
        this.onCounts({ ...counts, queueDepth: queue.remaining });
      }

      const pass: JanitorPass = {
        ran: true,
        queueRemoved: queue.removed,
        matchesDropped: matches.dropped,
        matchesEnded: matches.ended,
        sessionsReaped: sessions.reaped,
        instancesRemoved: instances.removed,
        survivorsNotified: notified,
      };

      if (
        pass.queueRemoved + pass.matchesDropped + pass.matchesEnded + pass.sessionsReaped >
        0
      ) {
        this.logger.info('janitor pass cleaned up stale state', { ...pass });
      }
      return pass;
    } catch (err) {
      this.logger.warn('janitor pass failed', {
        errName: err instanceof Error ? err.name : 'unknown',
      });
      return { ...IDLE_PASS, ran: true };
    } finally {
      this.running = false;
    }
  }

  private async notify(survivors: readonly Survivor[]): Promise<number> {
    let notified = 0;
    for (const survivor of survivors) {
      const route = await this.dispatcher.toSession(
        survivor.sessionId,
        { event: 'partner_disconnected', matchId: survivor.matchId },
        nowIso(),
      );
      if (route !== 'dropped') notified += 1;
    }
    return notified;
  }
}
