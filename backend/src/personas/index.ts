/**
 * Loading the persona population.
 *
 * The population is validated once, at load, and a failure throws. There is no
 * degraded mode worth running: a character with no opinions produces a persona
 * that agrees with everything, and a country with no name pool produces a
 * crash at match time instead of at startup. Both are better as a refusal to
 * start.
 *
 * `loadCharacters` is a function rather than a module-level side effect, for
 * the same reason `loadConfig(env)` is: tests build their own populations, and
 * a module that validates at import time cannot be tested for the failure
 * cases it is supposed to catch.
 */

import { MAX_DECLARED_AGE, MIN_DECLARED_AGE } from '../protocol/types';
import { CHARACTERS } from './characters';
import { compareAll, describeFailures } from './differentiation';
import { assertNamePools } from './names';
import { declaredCountries } from './surface';
import { assertValidCharacter } from './types';
import type { PersonaCharacter } from './types';

export interface LoadOptions {
  /**
   * Whether to run the interchangeability check.
   *
   * On in tests, off in production. The check is O(n²) over the population and
   * its answer cannot change between a test run and a deploy — the characters
   * are source files. Paying for it at every process start would be paying for
   * a question already answered in CI.
   */
  readonly checkDifferentiation?: boolean;
}

/**
 * Validate and return the population.
 *
 * @throws if any character is structurally invalid, declares a country with no
 * name pool, or — when asked — is close to interchangeable with another.
 */
export function loadCharacters(
  characters: readonly PersonaCharacter[] = CHARACTERS,
  options: LoadOptions = {},
): readonly PersonaCharacter[] {
  if (characters.length === 0) {
    throw new Error('persona population is empty');
  }

  const seen = new Set<string>();
  for (const character of characters) {
    if (seen.has(character.id)) {
      throw new Error(`persona ${character.id}: duplicate id`);
    }
    seen.add(character.id);
    assertValidCharacter(character, MIN_DECLARED_AGE, MAX_DECLARED_AGE);
  }

  assertNamePools(declaredCountries(characters));

  if (options.checkDifferentiation === true) {
    const report = describeFailures(compareAll(characters));
    if (report !== '') throw new Error(report);
  }

  return characters;
}

export { CHARACTERS, CHARACTERS_BY_ID } from './characters';
export { compareAll, comparePair, describeFailures, DIFFERENTIATION } from './differentiation';
export { NAME_POOLS, poolFor } from './names';
export { Rng, randomSeed } from './rng';
export { declaredCountries, generateSurface } from './surface';
export { PersonaClient } from './client';
export { humanCadence, splitIntoBubbles } from './cadence';
export type { Cadence } from './cadence';
export type {
  PersonaClientEvent,
  PersonaClientOptions,
  PersonaClientState,
  PersonaVoice,
  VoiceTurn,
} from './client';
export { PersonaSupervisor, assertFillPolicyCoherent } from './supervisor';
export type {
  FillPolicy,
  LivePersona,
  QueueView,
  SkipReason,
  SupervisorOptions,
  TickOutcome,
} from './supervisor';
export { redisQueueView } from './queue-view';
export type { QueueReader } from './queue-view';
export {
  MODEL_PRICES,
  NO_USAGE,
  PROVIDER_MODELS,
  PROVIDER_NAMES,
  costOf,
  formatMicroCents,
  priceFor,
} from './provider';
export type {
  ModelPrice,
  ModelProvider,
  ProviderMessage,
  ProviderReply,
  ProviderRequest,
  ProviderStop,
  ProviderUsage,
} from './provider';
export { AnthropicProvider } from './provider-anthropic';
export type { AnthropicProviderOptions } from './provider-anthropic';
export { OpenAIProvider } from './provider-openai';
export type { OpenAIProviderOptions } from './provider-openai';
export { PersonaBudget } from './budget';
export type { BudgetCheck, BudgetState, PersonaBudgetOptions } from './budget';
export { modelVoice } from './voice-model';
export {
  CRISIS_REPLY,
  challengesIdentity,
  configureGuardTerms,
  deniesBeingAutomated,
  GuardTermsError,
  guardVoice,
  isRomantic,
  looksLikeCrisis,
  looksLikeMinor,
  looksSexual,
  parseGuardTerms,
  solicitsPersonalInfo,
  statesMinorAge,
} from './guard';
export type { GuardEvents, GuardOptions, GuardTermsFile, LimitId, LimitTrip } from './guard';
export type { ModelVoiceOptions, SpendEvent } from './voice-model';
export { scriptedVoice } from './voice-scripted';
export type { ScriptedVoiceOptions } from './voice-scripted';
export {
  ALWAYS_ACTIVE,
  CONTROL_MODES,
  CONTROL_SCOPES,
  PersonaControl,
  withinHours,
} from './control';
export type {
  ActiveHours,
  ControlCache,
  ControlDecision,
  ControlMode,
  ControlRow,
  ControlScope,
  PersonaControlOptions,
  RefusalReason,
} from './control';
export * from './types';
