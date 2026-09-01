#!/usr/bin/env node
/**
 * Verify that every staged policy patch in `docs/policies/PENDING-*.md` can
 * still be applied.
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
 * This check is a no-op once a pending file is deleted, which is what applying
 * it involves. It is not a check that survives the feature.
 *
 * Each staged patch is one entry in `PATCHES` below. The list is expected to be
 * empty most of the time; it has two entries only because payments and personas
 * were both drafted ahead of being switched on.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policyDir = join(root, 'docs', 'policies');

/**
 * Each anchor is a fragment that must appear verbatim in a live document,
 * because the pending file tells a future reader to replace or insert near it.
 * Keep the text short enough to survive reflowing but specific enough to be
 * unambiguous.
 */
const PERSONA_ANCHORS = [
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
const PERSONA_BLOCKS = [
  '## 1. Terms — new section 3a',
  '## 2. Terms §8',
  '## 3. Privacy — "What we collect"',
  '## 4. Privacy — "Who can see your conversations"',
  '## 5. Privacy — "Other companies"',
  '## 6. Minor safety §3',
  '## 7. Minor safety §6',
];

/**
 * The payment patch.
 *
 * Two of these anchors are the sentences that stop being true when payments are
 * switched on, which is the whole reason the patch is staged rather than
 * applied. If one of them disappears from the published policy without this
 * file being updated, the flip loses the correction it needs.
 *
 * Both third-party anchors were re-worded once already, by sign-in (§32, D48).
 * The claim used to be about "the site" and is now about "our pages", because
 * signing in deliberately sends the browser to another origin — so the sentence
 * payments narrow is no longer quite the sentence that was written. That is the
 * guard working: the wording moved, this file failed, and the staged patch was
 * rebased in the same commit rather than discovered to be stale years later.
 */
const PAYMENT_ANCHORS = [
  // --- privacy-policy.md ---
  ['privacy-policy.md', 'make no requests to any third party', 'the claim that must narrow'],
  ['privacy-policy.md', 'One cookie, nothing loaded from a third party into your browser, no analytics,', 'the cookie note that gains the payment-form exception'],
  ['privacy-policy.md', '## Other companies', 'the processor list heading'],
  ['privacy-policy.md', '**One, and only for conversations with an automated account.**', 'the count that becomes two'],
  ['privacy-policy.md', '- Our pages make **no requests to any third party** from your browser — no', 'the bullet that narrows'],
  ['privacy-policy.md', 'There is no payment provider, because nothing is for sale.', 'the bullet that is deleted outright'],
  ['privacy-policy.md', '### What we deliberately do not collect', 'insertion point for the new "If you pay for something" subsection'],

  // --- terms-of-service.md ---
  ['terms-of-service.md', '## 15. Paying for things', 'the section that is replaced'],
  ['terms-of-service.md', 'The service is free. There is nothing to buy, no subscription, and we take no', 'the sentence that stops being true'],
  ['terms-of-service.md', 'use a **merchant of record** rather than a bare payment processor. The', 'the unresolved question the patch deliberately does not answer'],
  ['terms-of-service.md', '## 7. What you send, and what is ours', 'recorded as deliberately unchanged'],
];

const PAYMENT_BLOCKS = [
  '## 1. Privacy — "What we deliberately do not collect"',
  '## 2. Privacy — the cookie note',
  '## 3. Privacy — "Other companies"',
  '## 4. Privacy — the "everything else is still none" list',
  '## 5. Privacy — a new subsection under "What we collect"',
  '## 6. Terms — §15 "Paying for things"',
  '## 7. Terms — §7 "What you send, and what is ours"',
];

const PATCHES = [
  { file: 'PENDING-AI-PERSONAS.md', anchors: PERSONA_ANCHORS, blocks: PERSONA_BLOCKS },
  { file: 'PENDING-PAYMENTS.md', anchors: PAYMENT_ANCHORS, blocks: PAYMENT_BLOCKS },
];

/**
 * A staged patch that names a template variable must not leave it unexplained.
 * Plausible-looking false detail in a legal document is worse than an obvious
 * gap, and the note is what stops the next reader filling one in from memory.
 */
const VARIABLE_NOTE = 'is a template variable on purpose';

const cache = new Map();
const read = (name) => {
  if (!cache.has(name)) cache.set(name, readFileSync(join(policyDir, name), 'utf8'));
  return cache.get(name);
};

const failures = [];
let checkedPatches = 0;
let checkedAnchors = 0;
let checkedBlocks = 0;

for (const patch of PATCHES) {
  const path = join(policyDir, patch.file);
  if (!existsSync(path)) continue;
  checkedPatches += 1;
  const pending = readFileSync(path, 'utf8');

  for (const [file, needle, why] of patch.anchors) {
    checkedAnchors += 1;
    if (!read(file).includes(needle)) {
      failures.push(
        `${file}: anchor no longer present — ${why}\n` +
          `    expected to find: ${JSON.stringify(needle)}\n` +
          `    ${patch.file} refers to this text. Update it in this commit.`,
      );
    }
  }

  for (const block of patch.blocks) {
    checkedBlocks += 1;
    if (!pending.includes(block)) {
      failures.push(`${patch.file}: missing block "${block}"`);
    }
  }

  for (const variable of pending.match(/\{\{[A-Z_]+\}\}/g) ?? []) {
    if (!pending.includes(VARIABLE_NOTE)) {
      failures.push(
        `${patch.file}: ${variable} used with no note explaining why it stays a variable`,
      );
      break;
    }
  }
}

if (checkedPatches === 0) {
  console.log('verify-pending-policy: no pending policy file; nothing to check.');
  process.exit(0);
}

if (failures.length > 0) {
  console.error('verify-pending-policy: FAILED\n');
  for (const f of failures) console.error('  - ' + f + '\n');
  console.error(
    `${failures.length} problem(s). A staged policy patch no longer matches the\n` +
      'documents it patches. Fix the pending file, do not delete the anchor.',
  );
  process.exit(1);
}

console.log(
  `verify-pending-policy: OK (${checkedPatches} patch(es), ` +
    `${checkedAnchors} anchors, ${checkedBlocks} blocks)`,
);
