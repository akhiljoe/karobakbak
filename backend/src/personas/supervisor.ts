/**
 * When a persona joins (D-AI-6, phase A3).
 *
 * ---------------------------------------------------------------------------
 * THE ONE GUARANTEE THIS OWES
 * ---------------------------------------------------------------------------
 * A persona must never take a conversation that a human was going to have with
 * another human. That is the whole justification for the feature — it exists to
 * fill an empty room, and a fill that empties the room instead is worse than
 * nothing, because it converts a real connection into a simulated one and
 * charges money for the privilege.
 *
 * So the rule is not "dispatch when the queue looks quiet". It is:
 *
 *   **dispatch only when exactly one searcher is waiting, that searcher is not
 *   one of ours, and they have waited longer than a human would tolerate.**
 *
 * Two searchers who are not personas will be paired by `tryMatch` on its next
 * pass. Adding a third party to that is not filling a gap; it is competing for
 * one.
 *
 * ---------------------------------------------------------------------------
 * THE RACE THIS CANNOT WIN, STATED HONESTLY
 * ---------------------------------------------------------------------------
 * Between deciding to dispatch and the persona's `join_queue` landing, a second
 * human can arrive. The queue then holds two humans and a persona, and
 * `tryMatch` may pair a human with the persona and leave the other waiting.
 *
 * That race cannot be closed from the client side, and closing it from the
 * server side would mean teaching `tryMatch` what a persona is — which is
 * exactly the coupling D-AI-6 exists to avoid, in the most race-tested code in
 * the repository.
 *
 * What is done instead is to make the window small and to leave when it is
 * missed: a persona that is still searching withdraws as soon as enough humans
 * are waiting to pair with each other. The honest statement of the guarantee is
 * therefore:
 *
 *   - **never dispatches** while humans are already available to each other
 *   - **withdraws promptly** if that becomes true while it is still queued
 *   - a narrow race remains, and it is counted rather than denied
 *     (`chat_persona_preempt_suspected_total`)
 *
 * ---------------------------------------------------------------------------
 * WHY COUNTING IS EXACT RATHER THAN ESTIMATED
 * ---------------------------------------------------------------------------
 * The queue contains personas too. Subtracting an *estimate* of how many are
 * ours would make the guarantee probabilistic, and in the wrong direction: an
 * undercount makes the queue look emptier than it is, which is precisely when a
 * bad dispatch happens.
 *
 * So the supervisor holds the session ids of its own live personas and removes
 * them by identity. The queue is small — it is the set of people currently
 * unmatched — so enumerating it costs nothing worth optimising.
 */

import type { Logger } from '../logger';
import { errorFields } from '../logger';
import type { PersonaControl } from './control';
import type { PersonaCharacter } from './types';

/**
 * The queue reads this needs.
 *
 * Narrow, for the same reason `ControlCache` is: it makes the interesting
 * failures testable without a Redis, and nothing here belongs to the chat hot
 * path.
 */
export interface QueueView {
  /** Session ids currently SEARCHING in a segment. */
  searching(segment: string): Promise<readonly string[]>;
  /** When a session entered the queue, in epoch ms, or null if it has left. */
  enqueuedAt(sessionId: string): Promise<number | null>;
}

/** One dispatched persona, as the supervisor sees it. */
export interface LivePersona {
  readonly characterId: string;
  /** Null until `connected` arrives. */
  sessionId: string | null;
  /** Whether it is currently in the queue rather than in a conversation. */
  searching: boolean;
  /** Ask it to leave the queue. */
  withdraw(): void;
  /** Close the socket. */
  stop(): void;
}

export interface FillPolicy {
  /**
   * How long a lone human waits before a persona is dispatched.
   *
   * Not a tuning knob so much as a product decision: too short and the service
   * is mostly bots, too long and the person has already closed the tab. It is
   * counted from `enqueuedAt`, which the server stamps.
   */
  readonly waitBeforeFillSeconds: number;
  /**
   * The most personas that may exist at once.
   *
   * **Must be below `MAX_CONNECTIONS_PER_IP`.** Every persona connects from the
   * same address, so the whole population shares one connection bucket; a cap
   * above that limit is a setting that looks applied and silently is not, with
   * the symptom being connections refused rather than an error anybody reads.
   * `assertCoherent` enforces the relationship.
   */
  readonly maxConcurrent: number;
  /** The most that may be running the same character at once. */
  readonly maxPerCharacter: number;
  /** Minimum gap between dispatches, so a burst cannot outrun the join limiter. */
  readonly minDispatchGapMs: number;
  readonly segment: string;
}

export type SkipReason =
  | 'disabled'
  | 'nobody_waiting'
  | 'humans_available'
  | 'not_waited_long_enough'
  | 'at_capacity'
  | 'character_at_capacity'
  | 'too_soon'
  | 'queue_unreadable';

export type TickOutcome =
  | { readonly action: 'dispatched'; readonly characterId: string }
  | { readonly action: 'withdrew'; readonly count: number }
  | { readonly action: 'skipped'; readonly reason: SkipReason };

export interface SupervisorOptions {
  readonly control: PersonaControl;
  readonly queue: QueueView;
  readonly logger: Logger;
  readonly policy: FillPolicy;
  readonly characters: readonly PersonaCharacter[];
  /** The provider name, for the per-provider control lever. */
  readonly provider: string;
  /** Starts one persona. Returns null if it could not be started. */
  readonly dispatch: (character: PersonaCharacter) => Promise<LivePersona | null>;
  readonly now?: () => number;
  /** Chooses which character to run next. Injected so tests are deterministic. */
  readonly choose?: (candidates: readonly PersonaCharacter[]) => PersonaCharacter;
}

/**
 * Decides, once per tick, whether to add a persona or remove one.
 *
 * Deliberately does one thing per tick. A supervisor that dispatched several at
 * once would outrun the join limiter — `join_queue` refills one token per five
 * seconds — and spend its budget being refused.
 */
export class PersonaSupervisor {
  private readonly live: LivePersona[] = [];
  private lastDispatchAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Personas currently alive, for metrics and for the cap. */
  liveCount(): number {
    return this.live.length;
  }

  /** Exposed for tests and for a clean shutdown. */
  livePersonas(): readonly LivePersona[] {
    return this.live;
  }

  async tick(): Promise<TickOutcome> {
    this.reap();

    // Withdrawal comes first. If humans have arrived who can pair with each
    // other, getting our personas out of their way matters more than anything
    // else this tick could do.
    const withdrawn = await this.withdrawIfCrowded();
    if (withdrawn > 0) return { action: 'withdrew', count: withdrawn };

    if (this.live.length >= this.options.policy.maxConcurrent) {
      return { action: 'skipped', reason: 'at_capacity' };
    }

    if (this.now() - this.lastDispatchAt < this.options.policy.minDispatchGapMs) {
      return { action: 'skipped', reason: 'too_soon' };
    }

    let waiting: readonly string[];
    try {
      waiting = await this.humansWaiting();
    } catch (err) {
      // An unreadable queue means an unknown number of humans, and dispatching
      // into that is exactly the case this whole class exists to prevent.
      this.options.logger.warn('persona supervisor could not read the queue', errorFields(err));
      return { action: 'skipped', reason: 'queue_unreadable' };
    }

    if (waiting.length === 0) return { action: 'skipped', reason: 'nobody_waiting' };

    // Two or more humans will find each other. This is the guarantee.
    if (waiting.length > 1) return { action: 'skipped', reason: 'humans_available' };

    const lone = waiting[0];
    if (lone === undefined) return { action: 'skipped', reason: 'nobody_waiting' };

    const since = await this.options.queue.enqueuedAt(lone);
    if (since === null) {
      // They left between the two reads. Nothing to fill.
      return { action: 'skipped', reason: 'nobody_waiting' };
    }

    const waitedMs = this.now() - since;
    if (waitedMs < this.options.policy.waitBeforeFillSeconds * 1000) {
      return { action: 'skipped', reason: 'not_waited_long_enough' };
    }

    const candidates = this.availableCharacters();
    if (candidates.length === 0) {
      return { action: 'skipped', reason: 'character_at_capacity' };
    }

    const character = (this.options.choose ?? pickFirst)(candidates);

    // The control plane is consulted last, so that a refusal is reported with
    // its own reason rather than being hidden behind "nobody waiting".
    const decision = await this.options.control.canJoin(
      character.id,
      this.options.provider,
      new Date(this.now()),
    );
    if (!decision.allowed) return { action: 'skipped', reason: 'disabled' };

    const persona = await this.options.dispatch(character);
    if (persona === null) return { action: 'skipped', reason: 'queue_unreadable' };

    this.live.push(persona);
    this.lastDispatchAt = this.now();
    return { action: 'dispatched', characterId: character.id };
  }

  /**
   * Pull searching personas out of the queue when humans can pair without them.
   *
   * This is the mitigation for the race the class comment describes. It cannot
   * prevent a bad pairing that has already happened, but it closes the window
   * within one tick instead of leaving a persona sitting in a queue where it is
   * now the wrong answer.
   */
  private async withdrawIfCrowded(): Promise<number> {
    const searching = this.live.filter((p) => p.searching);
    if (searching.length === 0) return 0;

    let humans: readonly string[];
    try {
      humans = await this.humansWaiting();
    } catch {
      // Unreadable. Leave them queued rather than tearing down on a guess: a
      // withdrawal costs a real person their match too.
      return 0;
    }

    if (humans.length < 2) return 0;

    for (const persona of searching) persona.withdraw();
    return searching.length;
  }

  /** Queue members that are not ours, by identity rather than by estimate. */
  private async humansWaiting(): Promise<readonly string[]> {
    const members = await this.options.queue.searching(this.options.policy.segment);
    const ours = new Set(
      this.live.map((p) => p.sessionId).filter((id): id is string => id !== null),
    );
    return members.filter((id) => !ours.has(id));
  }

  /** Characters not already at their per-character cap. */
  private availableCharacters(): readonly PersonaCharacter[] {
    const counts = new Map<string, number>();
    for (const p of this.live) {
      counts.set(p.characterId, (counts.get(p.characterId) ?? 0) + 1);
    }
    return this.options.characters.filter(
      (c) => (counts.get(c.id) ?? 0) < this.options.policy.maxPerCharacter,
    );
  }

  /** Drop personas whose sockets have gone. */
  private reap(): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const persona = this.live[i];
      if (persona !== undefined && persona.sessionId === null && !persona.searching) {
        this.live.splice(i, 1);
      }
    }
  }

  /** Stop every persona. Used on shutdown and by a hard disable. */
  stopAll(): number {
    const count = this.live.length;
    for (const persona of this.live) persona.stop();
    this.live.length = 0;
    return count;
  }
}

function pickFirst(candidates: readonly PersonaCharacter[]): PersonaCharacter {
  const first = candidates[0];
  if (first === undefined) throw new Error('pickFirst called with no candidates');
  return first;
}

/**
 * The coherence check that keeps the concurrency cap meaningful.
 *
 * Exported so `loadConfig`'s `assertCoherent` can call it, and so the reason
 * lives next to the rule rather than in a commit message.
 */
export function assertFillPolicyCoherent(
  policy: FillPolicy,
  maxConnectionsPerIp: number,
): void {
  if (policy.maxConcurrent >= maxConnectionsPerIp) {
    throw new Error(
      `PERSONA_MAX_CONCURRENT (${policy.maxConcurrent}) must be below ` +
        `MAX_CONNECTIONS_PER_IP (${maxConnectionsPerIp}): every persona connects from the ` +
        'same address, so they share one connection bucket. A cap at or above the ' +
        'connection limit is silently not applied — the symptom is refused connections, ' +
        'not an error anybody reads.',
    );
  }
  if (policy.maxPerCharacter > policy.maxConcurrent) {
    throw new Error(
      `PERSONA_MAX_PER_CHARACTER (${policy.maxPerCharacter}) exceeds ` +
        `PERSONA_MAX_CONCURRENT (${policy.maxConcurrent}), so it can never bind.`,
    );
  }
  if (policy.waitBeforeFillSeconds <= 0) {
    throw new Error(
      'PERSONA_WAIT_BEFORE_FILL_SECONDS must be positive: dispatching the instant somebody ' +
        'queues means a persona races every real match rather than filling a gap.',
    );
  }
}
