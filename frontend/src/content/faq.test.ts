/**
 * The FAQ.
 *
 * `FaqPage` draws the questions by looking each one up by heading, and a
 * heading that no longer matches is a **silent** failure: the question stops
 * rendering and nothing says so. Every assertion here exists because the
 * failure it catches is invisible on the page.
 *
 * The two factual assertions at the bottom are the ones that matter most. Both
 * correct a claim in `docs/rewrite-wording/FAQs`, and a later transcription
 * pass that "restored" the draft would reintroduce a published statement that
 * contradicts the Terms or the code. They fail loudly instead.
 */
import { describe, expect, it } from 'vitest';

import { FAQ, FAQ_GROUPS, FAQ_OPEN_BY_DEFAULT, FAQ_VERDICT_FIRST } from './faq';

const headings = FAQ.sections.map((section) => section.heading);

describe('the FAQ', () => {
  it('groups every question exactly once', () => {
    const grouped = FAQ_GROUPS.flatMap((group) => group.questions);
    // Sorted rather than compared in order: the groups deliberately reorder the
    // draft, so what must hold is that the two sets match, not the sequence.
    expect([...grouped].sort()).toEqual([...headings].sort());
  });

  it('names no question that does not exist', () => {
    // The silent one. A renamed heading leaves the group pointing at nothing
    // and the question simply disappears from the page.
    for (const group of FAQ_GROUPS) {
      for (const question of group.questions) {
        expect([group.label, question, headings.includes(question)]).toEqual([
          group.label,
          question,
          true,
        ]);
      }
    }
  });

  it('opens exactly the two questions the design opens, and both exist', () => {
    expect(FAQ_OPEN_BY_DEFAULT).toHaveLength(2);
    for (const question of FAQ_OPEN_BY_DEFAULT) {
      expect([question, headings.includes(question)]).toEqual([question, true]);
    }
  });

  it('marks verdict-first answers that exist and actually have a short verdict', () => {
    for (const question of FAQ_VERDICT_FIRST) {
      expect([question, headings.includes(question)]).toEqual([question, true]);
      const section = FAQ.sections.find((s) => s.heading === question);
      const verdict = section?.body[0] ?? '';
      // The treatment sets this line at 21-23px. A long paragraph rendered that
      // large is not a verdict, it is shouting.
      expect([question, verdict.length < 120]).toEqual([question, true]);
    }
  });

  it('gives every question at least one paragraph', () => {
    for (const section of FAQ.sections) {
      expect([section.heading, section.body.length > 0]).toEqual([section.heading, true]);
      for (const paragraph of section.body) {
        expect(paragraph.trim()).not.toBe('');
      }
    }
  });

  it('accents exactly one group', () => {
    expect(FAQ_GROUPS.filter((group) => group.accent === true)).toHaveLength(1);
  });

  /*
   * ---------------------------------------------------------------------------
   * The two corrections
   * ---------------------------------------------------------------------------
   */

  it('never denies that automated accounts exist', () => {
    // Terms §3a discloses them and commits to never denying them. The draft
    // answers this question "No. karobakbak does not use bots", which would be
    // a published document denying something the service does.
    const answer = JSON.stringify(
      FAQ.sections.find((s) => s.heading === 'Am I talking to a bot?'),
    ).toLowerCase();
    expect(answer).toContain('automated account');
    expect(answer).not.toContain('does not use bots');
  });

  it('says the partner is shown a country, rather than claiming no location is shared', () => {
    // `server.ts` resolves the country from the connection at the upgrade and
    // puts it on the profile the partner sees. The draft answers "No".
    const section = FAQ.sections.find((s) => s.heading === 'Is my location shared with strangers?');
    const answer = JSON.stringify(section).toLowerCase();
    expect(answer).toContain('country');
    // The correction is that the first line is not a flat denial.
    expect((section?.body[0] ?? '').toLowerCase()).not.toBe('no.');
  });
});
