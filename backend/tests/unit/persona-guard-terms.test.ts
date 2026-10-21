/**
 * Operator-supplied guard terms (`PERSONA_GUARD_TERMS_FILE`).
 *
 * The property that matters is the asymmetry: a file can add to a detection
 * list and never take from it, and a file can replace the reply wording but
 * never with a reply that denies being automated.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  challengesIdentity,
  configureGuardTerms,
  GuardTermsError,
  looksLikeCrisis,
  looksLikeMinor,
  looksSexual,
  parseGuardTerms,
} from '../../src/personas/guard';

afterEach(() => configureGuardTerms(null));

describe('parseGuardTerms', () => {
  it('accepts an empty object', () => {
    expect(() => parseGuardTerms('{}')).not.toThrow();
  });

  it('refuses invalid JSON rather than running on nothing', () => {
    expect(() => parseGuardTerms('{nope')).toThrow(GuardTermsError);
  });

  it('refuses an unknown key, so a typo is not silently ignored', () => {
    expect(() => parseGuardTerms('{"sexuall": ["x"]}')).toThrow(GuardTermsError);
  });

  it('refuses a list that is not all strings', () => {
    expect(() => parseGuardTerms('{"crisis": ["ok", 3]}')).toThrow(GuardTermsError);
    expect(() => parseGuardTerms('{"crisis": "not a list"}')).toThrow(GuardTermsError);
  });

  it('refuses a top-level array', () => {
    expect(() => parseGuardTerms('["sexual"]')).toThrow(GuardTermsError);
  });
});

describe('configureGuardTerms', () => {
  it('adds operator detection terms to the built-in ones', () => {
    expect(looksSexual('zqxwv tonight?')).toBe(false);
    configureGuardTerms(parseGuardTerms('{"sexual": ["zqxwv"]}'));
    expect(looksSexual('zqxwv tonight?')).toBe(true);
    // The built-in floor is untouched.
    expect(looksSexual('send nudes')).toBe(true);
  });

  it('cannot shorten a built-in list with an empty one', () => {
    configureGuardTerms(parseGuardTerms('{"minorPhrases": [], "identityChallenge": []}'));
    expect(looksLikeMinor('i am still in school')).toBe(true);
    expect(challengesIdentity('are you a bot')).toBe(true);
  });

  it('normalises operator terms the way the text is normalised', () => {
    expect(looksLikeCrisis('honestly im done with everything')).toBe(false);
    configureGuardTerms(parseGuardTerms('{"crisis": ["  I\'m Done With Everything "]}'));
    expect(looksLikeCrisis('honestly im done with everything')).toBe(true);
    expect(looksLikeCrisis("Honestly I'm DONE with everything")).toBe(true);
  });

  it('refuses a configured deflection that denies being automated', () => {
    expect(() =>
      configureGuardTerms(parseGuardTerms('{"identityDeflections": ["lol no im human"]}')),
    ).toThrow(GuardTermsError);
  });

  it('checks replies against the extended denial list too', () => {
    expect(() =>
      configureGuardTerms(
        parseGuardTerms('{"identityDenial": ["flesh and blood"], "sexualDeclines": ["flesh and blood, no"]}'),
      ),
    ).toThrow(GuardTermsError);
  });

  it('restores the built-in terms on null', () => {
    configureGuardTerms(parseGuardTerms('{"sexual": ["zqxwv"]}'));
    configureGuardTerms(null);
    expect(looksSexual('zqxwv')).toBe(false);
  });
});

describe('the shipped example file', () => {
  it('parses and applies, so the documented shape stays the real one', () => {
    const json = readFileSync(join(__dirname, '../../../ops/personas/guard-terms.example.json'), 'utf8');
    expect(() => configureGuardTerms(parseGuardTerms(json))).not.toThrow();
  });
});
