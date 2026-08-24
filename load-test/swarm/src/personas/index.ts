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
  lateBlocker,
  massBlocker,
  mutualBlocker,
  repeatedReporter,
  reportRacer,
  reporter,
  reporterReconnect,
} from './moderators';
import { gapTalker, lateReturner, refresher, tokenReplayer } from './resume';
import { bannedReturner } from './enforcement';
import { anonymous, nameAdvertiser, profileChurner, underageDeclarer } from './declaring';

export const PERSONAS: readonly Persona[] = [
  bannedReturner,
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
  lateBlocker,
  refresher,
  gapTalker,
  lateReturner,
  tokenReplayer,
  anonymous,
  underageDeclarer,
  nameAdvertiser,
  profileChurner,
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

export type ProfileName =
  | 'realistic'
  | 'adversarial'
  | 'capacity'
  | 'lifecycle'
  | 'human'
  | 'tiny';

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
  { scenario: 'L3', weight: 4 },
  { scenario: 'L4', weight: 1 },
  { scenario: 'L6', weight: 2 },
  { scenario: 'L9', weight: 1 },
  { scenario: 'L13', weight: 2 },
  { scenario: 'L14', weight: 1 },
  // The declared-profile group. G1 carries real weight because "told us
  // nothing" is the most common profile there is, and a population where
  // everyone declares something would never exercise the null path that every
  // renderer has to handle.
  { scenario: 'G1', weight: 6 },
  { scenario: 'G4', weight: 2 },
  { scenario: 'G2', weight: 1 },
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

  // Enforcement at the door. Weighted so a modest run still contains one:
  // `expandMix` floors each share, so weight 2 against this mix's total of ~112
  // produced *zero* A14 bots at 40 bots, and the scenario silently did not run.
  // The oracle reports that as SKIP rather than PASS, which is what caught it —
  // but a safety scenario that vanishes from small runs is the same trap as a
  // persona group that stops producing events.
  //
  // Still small relative to the population: enough banned identities for the
  // refusal to be unambiguous, few enough that a ban leaking onto everybody
  // else reads as a difference rather than as the whole run.
  { scenario: 'A14', weight: 5 },

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
  // The block that arrives after the conversation ended (D38). Adversarial
  // rather than realistic: it needs partners who leave abruptly, and this is
  // the profile full of them.
  { scenario: 'M10', weight: 3 },
  // A name is a label on a person rather than one utterance, so it is refused
  // rather than flagged (D35). The advertisers belong with the other payload
  // adversaries.
  { scenario: 'G3', weight: 2 },
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
  { scenario: 'L1', weight: 15 },
  { scenario: 'L2', weight: 15 },
  { scenario: 'L3', weight: 15 },
  { scenario: 'L4', weight: 8 },
  { scenario: 'L6', weight: 8 },
  { scenario: 'L9', weight: 15 },
  { scenario: 'L10', weight: 8 },
  { scenario: 'L13', weight: 8 },
  { scenario: 'L14', weight: 5 },
  { scenario: 'L15', weight: 3 },
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

/**
 * `human` — the mix to run when a person is in the swarm.
 *
 * Not a softer `realistic`; a *differently shaped* one. Somebody sitting at
 * http://localhost:8090 talking to the population has a sample size of one
 * conversation at a time, so the proportions that make a five-thousand-bot run
 * statistically honest make a human's ten minutes mostly disappointing: they
 * meet a hyper-skipper, then a lurker, then somebody who rage-quits, and form
 * the impression that the product does not work.
 *
 * So the talkers dominate, the personas that answer promptly are the ones with
 * weight, and the abusive fraction is small but **not zero** — a person testing
 * this needs to meet somebody worth blocking, or Block, Report and the whole
 * safety half of the UI go untried. The declared profiles are here in force for
 * the same reason: the header, the country, the age are what a person actually
 * looks at, and they are the newest thing in the client.
 *
 * Numbers from a `human` run are not capacity numbers and should not be quoted
 * as any. It is a mix for driving the product, not for measuring it.
 */
const HUMAN: readonly MixEntry[] = [
  // Talkers, and the ones that reply quickly rather than after 90 seconds.
  { scenario: 'N1', weight: 30 },
  { scenario: 'N6', weight: 10 },
  { scenario: 'N7', weight: 4 },
  { scenario: 'N10', weight: 6 },
  { scenario: 'N4', weight: 4 },
  { scenario: 'N3', weight: 3 },
  // Enough churn that "skip and talk to somebody else" finds somebody else
  // immediately, which is the loop a person is there to feel.
  { scenario: 'S1', weight: 12 },
  { scenario: 'S2', weight: 4 },
  { scenario: 'S4', weight: 2 },
  // Declared profiles, heavily: this is what a person sees first.
  { scenario: 'G4', weight: 6 },
  { scenario: 'G1', weight: 5 },
  // Something to block and something to report, at a rate where a person will
  // meet one within a few conversations but not every conversation.
  { scenario: 'A1', weight: 2 },
  { scenario: 'A3', weight: 2 },
  { scenario: 'A7', weight: 1 },
  { scenario: 'M1', weight: 2 },
  { scenario: 'M2', weight: 2 },
  // Someone whose connection drops mid-sentence, so the reconnecting banner and
  // the disabled composer are seen by a human rather than only by an oracle.
  { scenario: 'L3', weight: 4 },
  { scenario: 'L1', weight: 2 },
];

export const PROFILES: Record<ProfileName, readonly MixEntry[]> = {
  realistic: REALISTIC,
  adversarial: ADVERSARIAL,
  capacity: CAPACITY,
  lifecycle: LIFECYCLE,
  human: HUMAN,
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
