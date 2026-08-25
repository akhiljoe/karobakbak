#!/usr/bin/env node
/**
 * Verify that `docs/policies/PENDING-AI-PERSONAS.md` can still be applied.
 *
 * WHY THIS EXISTS
 * The pending file holds exact replacement text for sections of three published
 * policy documents, staged until phase A2 of `docs/AI-PERSONAS.md` ships. A
 * staged patch rots silently: somebody edits a sentence in the privacy policy,
 * and months later the "replace this paragraph" instruction refers to a
 * paragraph that no longer exists. The person applying it then either skips the
 * edit or reconstructs it from memory, and the published document ends up
 * describing a system that is not the one running — which is the specific
 * failure this policy set has already had once.
 *
 * So every anchor is asserted here. Editing a policy document in a way that
 * moves an anchor fails the build, and the fix is to update the pending file in
 * the same commit.
 *
 * This check is a no-op once the pending file is deleted, which is what
 * applying it involves. It is not a check that survives the feature.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PENDING = join(root, 'docs', 'policies', 'PENDING-AI-PERSONAS.md');

/**
 * Each anchor is a fragment that must appear verbatim in a live document,
 * because the pending file tells a future reader to replace or insert near it.
 * Keep the text short enough to survive reflowing but specific enough to be
 * unambiguous.
 */
const ANCHORS = [
  // --- terms-of-service.md ---
  ['terms-of-service.md', '## 3. What we keep, briefly', 'insertion point for the new §3a'],
  ['terms-of-service.md', '## 4. What you may not do', '§3a must land before §4'],
  ['terms-of-service.md', '## 8. The other person is a stranger', '§8 is replaced wholesale'],
  ['terms-of-service.md', 'screen anyone in advance, or know who anyone is', 'the claim §8 must narrow to "our users"'],
  ['terms-of-service.md', 'What another user sends is theirs, not ours.', 'the ownership bullet that splits'],

  // --- privacy-policy.md ---
  ['privacy-policy.md', '### Your messages', 'insertion point for the model-provider subsection'],
  ['privacy-policy.md', '### A scrambled version of your IP address', 'the subsection it must land before'],
  ['privacy-policy.md', '**This service is run by one person**, and that person, only when a', 'the paragraph that is replaced'],
  ['privacy-policy.md', 'browsing, no search across conversations, and no way to pull up a random', 'the no-browsing bullet that is replaced'],
  ['privacy-policy.md', '**Every single access is logged before the content is retrieved**', 'bullet kept, and load-bearing once browsing is open'],
  ['privacy-policy.md', 'Those logs are kept for a year.', 'bullet kept, and load-bearing once browsing is open'],
  ['privacy-policy.md', '## Other companies', 'the processor list heading'],
  ['privacy-policy.md', '**There are none.** As it stands today:', 'the claim that stops being true'],

  // --- minor-safety-policy.md ---
  ['minor-safety-policy.md', '| Any jurisdiction is added with an explicit age-assurance duty', '§3 trigger table gains a row'],
  ['minor-safety-policy.md', '| The declared profile becomes filterable', '§6 trigger table gains a row'],
  ['minor-safety-policy.md', 'launch without automated grooming detection', '§6 position the new paragraph follows'],
];

/** Sections the pending file must still describe; a dropped block is a silent gap. */
const REQUIRED_BLOCKS = [
  '## 1. Terms — new section 3a',
  '## 2. Terms §8',
  '## 3. Privacy — "What we collect"',
  '## 4. Privacy — "Who can see your conversations"',
  '## 5. Privacy — "Other companies"',
  '## 6. Minor safety §3',
  '## 7. Minor safety §6',
];

if (!existsSync(PENDING)) {
  console.log('verify-pending-policy: no pending policy file; nothing to check.');
  process.exit(0);
}

const pending = readFileSync(PENDING, 'utf8');
const cache = new Map();
const read = (name) => {
  if (!cache.has(name)) {
    cache.set(name, readFileSync(join(root, 'docs', 'policies', name), 'utf8'));
  }
  return cache.get(name);
};

const failures = [];

for (const [file, needle, why] of ANCHORS) {
  if (!read(file).includes(needle)) {
    failures.push(
      `${file}: anchor no longer present — ${why}\n` +
        `    expected to find: ${JSON.stringify(needle)}\n` +
        `    PENDING-AI-PERSONAS.md refers to this text. Update it in this commit.`,
    );
  }
}

for (const block of REQUIRED_BLOCKS) {
  if (!pending.includes(block)) {
    failures.push(`PENDING-AI-PERSONAS.md: missing block "${block}"`);
  }
}

// A staged patch that names a template variable must not leave it unexplained.
if (pending.includes('{{MODEL_PROVIDER}}') && !pending.includes('is a template variable on purpose')) {
  failures.push('PENDING-AI-PERSONAS.md: {{MODEL_PROVIDER}} used with no note explaining why it stays a variable');
}

if (failures.length > 0) {
  console.error('verify-pending-policy: FAILED\n');
  for (const f of failures) console.error('  - ' + f + '\n');
  console.error(
    `${failures.length} problem(s). The staged policy patch no longer matches the\n` +
      'documents it patches. Fix the pending file, do not delete the anchor.',
  );
  process.exit(1);
}

console.log(
  `verify-pending-policy: OK (${ANCHORS.length} anchors, ${REQUIRED_BLOCKS.length} blocks)`,
);
