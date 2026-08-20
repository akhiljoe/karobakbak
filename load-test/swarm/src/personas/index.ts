/**
 * The persona registry and the mix profiles.
 *
 * A profile is a weighted population, not a list: bots are drawn from it with
 * the run's own seeded stream, so `realistic` at 5,000 bots has the same shape
 * as `realistic` at 500 and the same *composition* every time for a given seed.
 *
 * Weights are relative, not percentages. Percentages force every edit to touch
 * every other line to keep a sum at 100, which is how a mix silently stops
 * meaning what its comment says.
 */
import type { Persona } from '../bot';
import {
  chatterbox,
  finisher,
  longHauler,
  lurker,
  polyglot,
  rapidTurnTaker,
  regular,
  talker,
  verbose,
} from './talkers';
import { grazer, hyperSkipper, instantRejoiner, leaver, queueFlapper } from './skippers';
import {
  backgrounded,
  cookieLoser,
  networkFlapper,
  rageQuitter,
  settingsBrowser,
  tabCloser,
} from './lifecycle';
import {
  blockSkipAttacker,
  burstAndWait,
  contactHarvester,
  copyPasteSpammer,
  denyListHitter,
  flooder,
  harasser,
  linkDropper,
  multiMatchSpammer,
  mutatingSpammer,
  reportSpammer,
  slowSpammer,
  templateRotator,
} from './abusers';
import {
  blockRacer,
  blocker,
  grudgeHolder,
  massBlocker,
  mutualBlocker,
  repeatedReporter,
  reportRacer,
  reporter,
  reporterReconnect,
} from './moderators';

export const PERSONAS: readonly Persona[] = [
  talker,
  longHauler,
  lurker,
  polyglot,
  verbose,
  rapidTurnTaker,
  chatterbox,
  finisher,
  regular,
  grazer,
  hyperSkipper,
  leaver,
  queueFlapper,
  instantRejoiner,
  tabCloser,
  rageQuitter,
  backgrounded,
  settingsBrowser,
  networkFlapper,
  cookieLoser,
  copyPasteSpammer,
  mutatingSpammer,
  linkDropper,
  contactHarvester,
  denyListHitter,
  flooder,
  harasser,
  slowSpammer,
  burstAndWait,
  multiMatchSpammer,
  templateRotator,
  reportSpammer,
  blockSkipAttacker,
  reporter,
  blocker,
  grudgeHolder,
  massBlocker,
  reportRacer,
  blockRacer,
  mutualBlocker,
  reporterReconnect,
  repeatedReporter,
];

const BY_SCENARIO = new Map(PERSONAS.map((persona) => [persona.scenario, persona]));

export function personaFor(scenario: string): Persona {
  const persona = BY_SCENARIO.get(scenario);
  if (!persona) throw new Error(`no persona implements scenario ${scenario}`);
  return persona;
}

export interface MixEntry {
  readonly scenario: string;
  readonly weight: number;
}

export type ProfileName = 'realistic' | 'adversarial' | 'capacity' | 'lifecycle' | 'tiny';

/**
 * `realistic` — the default, and the only profile whose latency numbers are
 * worth quoting. Talkers dominate, skippers are a large minority, and the
 * lifecycle personas are present in the proportion a real population produces
 * them rather than in the proportion that makes them easy to observe.
 */
const REALISTIC: readonly MixEntry[] = [
  { scenario: 'N1', weight: 26 },
  { scenario: 'N3', weight: 8 },
  { scenario: 'N6', weight: 6 },
  { scenario: 'N7', weight: 4 },
  { scenario: 'N8', weight: 6 },
  { scenario: 'N10', weight: 5 },
  { scenario: 'N2', weight: 3 },
  { scenario: 'N4', weight: 2 },
  { scenario: 'N5', weight: 1 },
  { scenario: 'S1', weight: 14 },
  { scenario: 'S2', weight: 7 },
  { scenario: 'S4', weight: 4 },
  { scenario: 'S5', weight: 2 },
  { scenario: 'S7', weight: 2 },
  { scenario: 'L1', weight: 4 },
  { scenario: 'L2', weight: 2 },
  { scenario: 'L4', weight: 1 },
  { scenario: 'L6', weight: 2 },
  { scenario: 'L9', weight: 1 },
  // A small adversarial fraction even here. A "realistic" population with no
  // spam in it is not realistic, and the M personas need something to react to
  // or their reports and blocks measure nothing.
  { scenario: 'A1', weight: 1 },
  { scenario: 'A3', weight: 1 },
  { scenario: 'A7', weight: 1 },
  { scenario: 'M1', weight: 2 },
  { scenario: 'M2', weight: 1 },
];

/**
 * `adversarial` — the safety profile.
 *
 * A third of the population is abusive and a further eighth reacts to it. Match
 * latency will be worse than `realistic` and that is correct rather than a
 * regression: a large fraction of this population skips within seconds, so the
 * queue churns constantly.
 *
 * The talkers are not decoration. Without a benign majority there is nobody for
 * the spammers to spam, no control group for the precision numbers, and every
 * conversation in the run is between two bots that were both trying to leave.
 */
const ADVERSARIAL: readonly MixEntry[] = [
  { scenario: 'N1', weight: 18 },
  { scenario: 'N3', weight: 4 },
  { scenario: 'N8', weight: 3 },
  { scenario: 'S1', weight: 12 },
  { scenario: 'S2', weight: 5 },

  // Pattern adversaries: invisible to the rule engine, detectable only across
  // conversations. These are the ones the spam oracle is really about.
  { scenario: 'A1', weight: 6 },
  { scenario: 'A2', weight: 5 },
  { scenario: 'A8', weight: 3 },
  { scenario: 'A10', weight: 4 },
  { scenario: 'A11', weight: 4 },

  // Payload adversaries: the rule engine should see every one of these.
  { scenario: 'A3', weight: 4 },
  { scenario: 'A4', weight: 3 },
  { scenario: 'A5', weight: 2 },

  // Limit and teardown abuse.
  { scenario: 'A6', weight: 2 },
  { scenario: 'A9', weight: 2 },
  { scenario: 'A7', weight: 4 },
  { scenario: 'A12', weight: 2 },
  { scenario: 'A13', weight: 2 },

  // The live response, which is the only enforcement that exists today.
  { scenario: 'M1', weight: 5 },
  { scenario: 'M2', weight: 4 },
  { scenario: 'M3', weight: 3 },
  { scenario: 'M4', weight: 2 },
  { scenario: 'M5', weight: 1 },
  { scenario: 'M6', weight: 1 },
  { scenario: 'M7', weight: 2 },
  { scenario: 'M8', weight: 1 },
  { scenario: 'M9', weight: 1 },
];

/**
 * `capacity` — talkers and grazers only.
 *
 * Nothing here disconnects unexpectedly or sits idle, so the numbers describe
 * throughput rather than a mixture of throughput and recovery. That is a
 * narrower measurement, and it is the right one when the question is "how many
 * conversations can this hold".
 */
const CAPACITY: readonly MixEntry[] = [
  { scenario: 'N1', weight: 45 },
  { scenario: 'N6', weight: 15 },
  { scenario: 'N7', weight: 5 },
  { scenario: 'S1', weight: 25 },
  { scenario: 'S2', weight: 10 },
];

/**
 * `lifecycle` — connection churn with just enough conversation to notice when
 * cleanup goes wrong. For chasing leaked sessions and orphaned queue entries.
 */
const LIFECYCLE: readonly MixEntry[] = [
  { scenario: 'L1', weight: 20 },
  { scenario: 'L2', weight: 20 },
  { scenario: 'L4', weight: 10 },
  { scenario: 'L6', weight: 10 },
  { scenario: 'L9', weight: 20 },
  { scenario: 'L10', weight: 10 },
  { scenario: 'N1', weight: 10 },
];

/**
 * `tiny` — S9, and it is meant to be run with two or three bots.
 *
 * Nearly every matchmaking bug worth having is masked by a large population,
 * because `SRANDMEMBER` almost always finds a clean candidate and the empty-ish
 * queue path is never taken. This profile is that path, continuously.
 */
const TINY: readonly MixEntry[] = [
  { scenario: 'S1', weight: 1 },
  { scenario: 'N1', weight: 1 },
];

export const PROFILES: Record<ProfileName, readonly MixEntry[]> = {
  realistic: REALISTIC,
  adversarial: ADVERSARIAL,
  capacity: CAPACITY,
  lifecycle: LIFECYCLE,
  tiny: TINY,
};

export function isProfileName(value: string): value is ProfileName {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

/**
 * Expand a weighted mix into one scenario per bot.
 *
 * Deterministic and proportional: the population is built by repeating each
 * scenario in proportion to its weight and then shuffling with the run's
 * stream, rather than by sampling independently. Sampling would give a
 * different composition every run and make two runs incomparable for reasons
 * that have nothing to do with the change being tested.
 */
export function expandMix(
  mix: readonly MixEntry[],
  count: number,
  rng: import('../rng').Rng,
): string[] {
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) throw new Error('mix has no weight');

  const population: string[] = [];
  for (const entry of mix) {
    const share = Math.floor((entry.weight / total) * count);
    for (let i = 0; i < share; i += 1) population.push(entry.scenario);
  }
  // Rounding leaves a remainder; hand it to the heaviest entries in order, so
  // a small run still contains the scenarios that dominate a large one.
  const ordered = [...mix].sort((a, b) => b.weight - a.weight);
  let index = 0;
  while (population.length < count) {
    const entry = ordered[index % ordered.length];
    if (!entry) break;
    population.push(entry.scenario);
    index += 1;
  }

  // Fisher-Yates with the run's stream: the shuffle decides which bot index
  // gets which persona, and therefore which synthetic address it has.
  for (let i = population.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const a = population[i];
    const b = population[j];
    if (a === undefined || b === undefined) continue;
    population[i] = b;
    population[j] = a;
  }

  return population;
}
