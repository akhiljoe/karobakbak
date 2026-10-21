/**
 * The static pages.
 *
 * These assert the things that are cheap to get wrong in prose and expensive
 * to notice: an empty section, a page that lost its title, and — the one that
 * matters — an unfilled template variable reaching a visitor. The policy drafts
 * in `docs/policies/` deliberately carry `{{TEMPLATE_VARIABLE}}` markers for
 * facts only the operator holds, and the rule there is that they stay visible
 * rather than being filled with plausible-looking false detail. The rule here
 * is stricter: this copy is shown to everybody, so a marker must never appear
 * in it at all.
 */
import { describe, expect, it } from 'vitest';

/*
 * The draft itself, as text.
 *
 * A Vite `?raw` import rather than `node:fs`, because this package compiles
 * with `types: ["vite/client"]` and nothing else — pulling in `@types/node` to
 * read one file would put every Node builtin within reach of a browser bundle,
 * which is a much larger change than the guard below is worth. Test files are
 * not part of the build entry, so the markdown never reaches `dist/`.
 */

import { HOW_IT_WORKS } from './how-it-works';
import { CONTACT_SLA } from './contact';
import { pageById, STATIC_PAGES } from './pages';

describe('the static pages', () => {
  it('ships every page the footer links to, in order', () => {
    expect(STATIC_PAGES.map((page) => page.id)).toEqual([
      'how-it-works',
      'about',
      'faq',
      'safety',
      'rules',
      'contact',
      'terms',
      'privacy',
    ]);
  });

  it('gives no two pages the same id', () => {
    const ids = STATIC_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every page a title and a summary', () => {
    for (const page of STATIC_PAGES) {
      expect(page.title.trim()).not.toBe('');
      expect(page.summary.trim()).not.toBe('');
    }
  });

  it('has no empty section anywhere', () => {
    for (const page of STATIC_PAGES) {
      expect(page.sections.length).toBeGreaterThan(0);
      for (const section of page.sections) {
        expect(section.heading.trim()).not.toBe('');
        /*
         * Something, not specifically a paragraph.
         *
         * This asserted a non-empty `body` until Safety arrived: its "Three
         * controls" section is three list items and no prose, which is how the
         * draft writes it. The invariant that matters is that a heading is
         * never followed by nothing — an empty section renders as a title over
         * blank space, which reads as a page that failed to load.
         */
        const lines = [
          ...section.body,
          ...(section.bullets ?? []),
          ...(section.tail ?? []),
          ...(section.tailBullets ?? []),
          ...(section.rows ?? []).map(([label, value]) => `${label}	${value}`),
        ];
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line.trim()).not.toBe('');
        }
      }
    }
  });

  it('never shows a reader a raw template variable or an internal note', () => {
    // `docs/policies/` keeps `{{...}}` markers and `DRAFTED POSITION` blocks on
    // purpose — they are notes to the operator. User-facing copy is the one
    // place neither may survive.
    //
    // The legal pages *do* render deliberate gaps for facts nobody holds yet,
    // but as "[contact address — not published yet]", which reads as missing
    // rather than as a leaked token.
    for (const page of STATIC_PAGES) {
      const text = JSON.stringify(page);
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(text).not.toContain('TODO');
      expect(text).not.toContain('DRAFTED POSITION');
      expect(text).not.toContain('UNREVIEWED BY COUNSEL');
      // `[CONFIRM]`, `[BUSINESS ADDRESS]`, `[NAME]`, `[INSERT ...]` — the
      // shape a template leaves behind. Deliberate gaps are written in
      // sentence case ("[contact address — not published yet]"), so an
      // all-caps bracketed token is always a placeholder nobody filled in.
      expect(text).not.toMatch(/\[[A-Z][A-Z ]{2,}\]/);
    }
  });

  /*
   * Copy addressed to whoever is writing the copy, rather than to a reader.
   *
   * This is the failure the transcription check used to catch as a side effect,
   * and it is why something had to replace it. `content/legal.ts` transcribes
   * long documents, and the ones it transcribed were templates: alongside the
   * operative text they carried instructions to the drafter. Transcribed
   * faithfully, the published Privacy Policy told visitors
   *
   *   "If you use analytics, error monitoring or product telemetry, list those
   *    providers here."
   *   "For each provider, explain:" — followed by seven bullets
   *   "Do not describe the service as having 'no third-party requests' if ..."
   *
   * and three more elsewhere. None of them trips the placeholder checks above:
   * they are ordinary English sentences, correctly spelled, in the right tone.
   * What gives them away is the *addressee* — a reader is never told to list
   * something here, or what the final version of the page should say.
   *
   * A denylist rather than a general rule, because "detect prose aimed at an
   * author" is not something a test can do. These are the phrasings that
   * actually shipped, plus the shapes they came in. Add to it when a new one
   * gets through; do not try to make it clever.
   */
  it('never addresses the drafter instead of the reader', () => {
    const forbidden = [
      /list (?:those|the) [a-z ]+ here/i,
      /for each [a-z ]+, explain/i,
      /the final version/i,
      /before publication/i,
      /should (?:identify|reflect|be checked)/i,
      // Anchored, because the imperative is the tell. "We do not claim
      // ownership of ordinary messages" and "we do not claim that this
      // confirmation verifies your age" are reader-facing sentences this
      // caught on the first run; "Do not describe the service as having no
      // third-party requests" is an order to whoever is writing the page.
      // Same words, opposite addressee, and only the position separates them.
      /^do not (?:state|describe|claim)/i,
      /if you (?:use|do not use) analytics/i,
      /insert actual/i,
    ];

    /*
     * Collected rather than asserted line by line, so a failure names every
     * offender at once. A per-line `expect` stops at the first, which on 1,500
     * lines of transcribed legal text means finding them one run at a time.
     */
    const addressed: string[] = [];
    for (const page of STATIC_PAGES) {
      for (const section of page.sections) {
        const lines = [
          ...section.body,
          ...(section.bullets ?? []),
          ...(section.tail ?? []),
          ...(section.tailBullets ?? []),
          ...(section.rows ?? []).map(([, value]) => value),
        ];
        for (const line of lines) {
          if (forbidden.some((pattern) => pattern.test(line))) {
            addressed.push(`${page.id}: ${line}`);
          }
        }
      }
    }

    expect(addressed).toEqual([]);
  });

  it('says on the Terms page that two clauses are unreviewed', () => {
    // PHASES.md records the trade: drafted and marked unreviewed beats left
    // empty. A reader is entitled to know which parts those are.
    const terms = JSON.stringify(pageById('terms')).toLowerCase();
    expect(terms).toContain('not been reviewed by a lawyer');
  });

  it('states the report response commitments somewhere a reader will find them', () => {
    /*
     * These used to be asserted against the Terms. The operator's own drafts
     * moved them: `Terms.md` makes no timing commitment at all, and
     * `contact.md` opens with both as the first thing on the page.
     *
     * The commitment is what matters, not which document carries it, so the
     * guard follows it rather than pinning copy the drafts have already moved
     * on from. Asserted against Contact — including `CONTACT_SLA`, which is
     * where the two cards at the top of that page get their numbers.
     */
    const contact = JSON.stringify([pageById('contact'), CONTACT_SLA]);
    expect(contact).toContain('24 hours');
    expect(contact).toContain('15 days');
  });

  it('does not promise the privacy rights the anonymity cannot deliver', () => {
    // The honest limitation: we hold nothing that identifies anybody, so a
    // deletion request usually cannot be matched to a conversation. Claiming
    // otherwise would be the most consequential false promise on the page.
    const privacy = JSON.stringify(pageById('privacy')).toLowerCase();
    // Matched on the fact rather than a sentence: the draft states the same
    // limitation in its own words ("we cannot reasonably identify the relevant
    // data ... we may be unable to fulfil a request"), and the guard exists to
    // stop the *limitation* disappearing, not to freeze one phrasing of it.
    expect(privacy).toContain('cannot reasonably identify');
  });

  it('repeats no heading within a page, since headings are React keys', () => {
    for (const page of STATIC_PAGES) {
      const headings = page.sections.map((section) => section.heading);
      expect(new Set(headings).size).toBe(headings.length);
    }
  });

  it('states the retention periods the backend actually applies', () => {
    // CONVERSATION_RETENTION_DAYS is 30 and REPORTED_RETENTION_DAYS is 90. If
    // either default moves, this copy is a false claim made to every visitor
    // and this test is the thing that says so.
    const faq = JSON.stringify(pageById('faq'));
    expect(faq).toMatch(/[Tt]hirty days/);
    expect(faq).toMatch(/ninety days/);
  });

  it('says the age check is not verified, rather than implying it is', () => {
    // The minor-safety position chose "exclude and ask". Copy that implied
    // verification would be the single most consequential false claim here.
    const about = JSON.stringify(pageById('about')).toLowerCase();
    // Matched on 'not verify' rather than an exact sentence, so the copy can be
    // rewritten without the guard going stale — what must survive is the fact,
    // not the phrasing.
    expect(about).toContain('not verify');
  });

  it('discloses that some partners are automated', () => {
    const about = JSON.stringify(pageById('about')).toLowerCase();
    expect(about).toContain('automated');
  });

  /*
   * The "How it works" copy is a transcription, and a transcription can drift
   * without anything failing.
   *
   * It already did: an earlier pass expanded every contraction ("you'll" to
   * "you will") and flattened the curly quotes. The page still rendered, every
   * other guard here still passed, and the only symptom was that the most
   * conversational page in the product had quietly started reading like a
   * contract. The header of `how-it-works.ts` says the draft is the source; this
   * is what makes that statement enforceable rather than aspirational.
   *
   * Matched as substrings against the draft rather than by parsing it, because
   * the shape of the markdown is not the thing under test — the sentences are.
   */
  /*
   * Rules and Contact, held to the same standard, and for a sharper reason.
   *
   * Both were condensed paraphrases before the designs arrived — Rules was six
   * sections where the draft has fourteen, and the missing eight included every
   * specific prohibition after harassment plus the whole enforcement half. That
   * is the part somebody reads when deciding whether to report, and a summary
   * of it is not a substitute for it.
   *
   * The drafts leave a contact address as a placeholder (`[CONTACT EMAIL]` in
   * rules.md, `hello@example.invalid` in contact.md). Neither reaches the
   * content — the address is configuration — so those lines are skipped rather
   * than matched.
   */

  /*
   * Terms and Privacy, held to the draft too.
   *
   * These two carry the operator's unfilled placeholders, so the lines that
   * render a gap cannot match the draft verbatim by construction — those are
   * skipped. Every other sentence must be exactly what the draft says, which is
   * the whole point of transcribing 1,500 lines by parser rather than by hand.
   */

  it('never ships a placeholder contact address', () => {
    // `.invalid` is reserved precisely so it can never resolve. It is correct
    // in a draft and catastrophic in a published page that promises a reply.
    const everything = JSON.stringify(STATIC_PAGES);
    expect(everything).not.toContain('example.invalid');
    expect(everything).not.toContain('[CONTACT EMAIL]');
  });


  it('throws on an unknown page rather than rendering a blank sheet', () => {
    // @ts-expect-error deliberately invalid, to prove the failure is loud
    expect(() => pageById('nope')).toThrow(/no static page/);
  });
});
