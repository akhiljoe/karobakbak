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
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) {
          expect(paragraph.trim()).not.toBe('');
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
    }
  });

  it('says on the Terms page that two clauses are unreviewed', () => {
    // PHASES.md records the trade: drafted and marked unreviewed beats left
    // empty. A reader is entitled to know which parts those are.
    const terms = JSON.stringify(pageById('terms')).toLowerCase();
    expect(terms).toContain('not been reviewed by a lawyer');
  });

  it('states the report response commitments the Terms make', () => {
    const terms = JSON.stringify(pageById('terms'));
    expect(terms).toContain('24 hours');
    expect(terms).toContain('15 days');
  });

  it('does not promise the privacy rights the anonymity cannot deliver', () => {
    // The honest limitation: we hold nothing that identifies anybody, so a
    // deletion request usually cannot be matched to a conversation. Claiming
    // otherwise would be the most consequential false promise on the page.
    const privacy = JSON.stringify(pageById('privacy')).toLowerCase();
    expect(privacy).toContain('cannot find');
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
    // `minor-safety-policy.md` §3 chose "exclude and ask". Copy that implied
    // verification would be the single most consequential false claim here.
    const about = JSON.stringify(pageById('about')).toLowerCase();
    expect(about).toContain('do not verify');
  });

  it('discloses that some partners are automated', () => {
    const about = JSON.stringify(pageById('about')).toLowerCase();
    expect(about).toContain('automated');
  });

  it('throws on an unknown page rather than rendering a blank sheet', () => {
    // @ts-expect-error deliberately invalid, to prove the failure is loud
    expect(() => pageById('nope')).toThrow(/no static page/);
  });
});
