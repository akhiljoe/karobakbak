/**
 * The things bots say.
 *
 * One utterance per line, plain text, drawn with each bot's own seeded stream.
 * Comments (`#`) and blank lines are ignored so a file can explain itself.
 *
 * ---------------------------------------------------------------------------
 * THE LINT, WHICH IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * A corpus of small talk is supposed to be moderation-neutral: it is the
 * control group against which flagged traffic is measured. One line reading
 * "add me on insta" in `smalltalk.txt` fires the `social_handle` rule for a
 * few hundred bots, and every precision number in the final report is then an
 * artefact of a typo rather than a fact about the system.
 *
 * So the benign corpora are checked against the *real* rule set — imported
 * from the backend, not reimplemented here — and a match refuses the run. The
 * adversarial corpora are checked the other way: a line in `links.txt` that
 * fires nothing is a line that is not doing its job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moderationView } from '../../../backend/src/moderation/normalise';
import { RULES } from '../../../backend/src/moderation/rules';

/**
 * Files whose lines must fire no rule.
 *
 * `names.txt` is in here for a stronger reason than the rest. A declared name
 * is **refused** when any rule fires (D35) rather than flagged and delivered,
 * so a single bad line would stop every bot that draws it from ever joining the
 * queue — a hole in the population that no oracle is looking for, because the
 * bots involved connect perfectly and then do nothing.
 */
export const BENIGN_FILES = [
  'openers.txt',
  'smalltalk.txt',
  'replies.txt',
  'questions.txt',
  'farewells.txt',
  'unicode.txt',
  'names.txt',
] as const;

/** Files whose lines must fire at least one rule. */
export const ADVERSARIAL_FILES = ['links.txt', 'contact.txt'] as const;

/**
 * Files with no expectation either way.
 *
 * `spam.txt` and `hostile.txt` are neutral because repetition and tone, not
 * content, are what they test — a rule engine is supposed to find nothing in
 * them. `denylist.txt` is neutral for a different reason: whether its lines
 * fire depends on the deployment's `MODERATION_DENY_LIST`, so asserting either
 * way here would encode one configuration as the truth.
 */
export const NEUTRAL_FILES = ['spam.txt', 'hostile.txt', 'denylist.txt'] as const;

export type CorpusFile =
  | (typeof BENIGN_FILES)[number]
  | (typeof ADVERSARIAL_FILES)[number]
  | (typeof NEUTRAL_FILES)[number];

export interface Corpus {
  lines(file: CorpusFile): readonly string[];
}

export interface CorpusLintFinding {
  file: string;
  line: number;
  /** Rule ids that fired. Rule ids are safe to print; the line itself is not printed. */
  flags: readonly string[];
  expectation: 'benign' | 'adversarial';
}

function parse(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Rule options matching the server's shipped defaults, so the lint agrees with production. */
const LINT_OPTIONS = { detectContact: true, denyList: [] as readonly string[] };

function firedRules(text: string): string[] {
  const view = moderationView(text);
  return RULES.filter((rule) => rule.test(view, LINT_OPTIONS)).map((rule) => rule.id);
}

export function loadCorpus(directory: string): { corpus: Corpus; findings: CorpusLintFinding[] } {
  const files = new Map<string, readonly string[]>();
  const findings: CorpusLintFinding[] = [];

  const read = (name: string): readonly string[] => {
    const lines = parse(readFileSync(join(directory, name), 'utf8'));
    if (lines.length === 0) throw new Error(`corpus file ${name} has no usable lines`);
    files.set(name, lines);
    return lines;
  };

  for (const name of BENIGN_FILES) {
    read(name).forEach((line, index) => {
      const flags = firedRules(line);
      if (flags.length > 0) {
        findings.push({ file: name, line: index + 1, flags, expectation: 'benign' });
      }
    });
  }

  for (const name of ADVERSARIAL_FILES) {
    read(name).forEach((line, index) => {
      const flags = firedRules(line);
      if (flags.length === 0) {
        findings.push({ file: name, line: index + 1, flags, expectation: 'adversarial' });
      }
    });
  }

  for (const name of NEUTRAL_FILES) read(name);

  const corpus: Corpus = {
    lines(file) {
      const lines = files.get(file);
      if (!lines) throw new Error(`corpus file ${file} was never loaded`);
      return lines;
    },
  };

  return { corpus, findings };
}

/**
 * Every benign line, for the log-leak oracle.
 *
 * These are the strings that must never appear in a backend log line. Short
 * ones are excluded: a two-character utterance would match inside a session id
 * and turn the oracle into a coin flip.
 */
export function leakProbes(corpus: Corpus, minLength = 12): string[] {
  const probes: string[] = [];
  for (const name of BENIGN_FILES) {
    for (const line of corpus.lines(name)) {
      if (line.length >= minLength) probes.push(line);
    }
  }
  return probes;
}
