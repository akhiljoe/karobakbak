/**
 * The footer: the things somebody looks up once.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LISTS THE HEADER'S SECONDARY SET AND NOT "WHATEVER THE HEADER LACKS"
 * ---------------------------------------------------------------------------
 * This used to render `STATIC_PAGES` filtered by `navPaths()` — every page the
 * header could not reach. That was correct exactly until the header grew a menu
 * containing Rules, Contact, Terms and Privacy, at which point the filter
 * matched every page and **the footer rendered an empty `<nav>` on every screen
 * in the product**. Nothing failed; there was simply no footer any more, which
 * is the worst shape a bug can take in navigation.
 *
 * A derived list that silently empties when its source grows is the wrong
 * relationship. The footer now names what it shows: the same secondary set the
 * header keeps behind its menu button. The two are meant to agree — a reader at
 * the foot of a long page should not have to find a menu to reach the Rules —
 * and `secondaryNav()` is the one list they both read.
 *
 * ---------------------------------------------------------------------------
 * TERMS AND PRIVACY ARE PAGES, NOT OUTBOUND LINKS
 * ---------------------------------------------------------------------------
 * They used to point at a domain that does not exist, so they were hidden, and
 * `docs/policies/README.md` step 5 says a policy nobody can find is not
 * published. They ship with the bundle now (`content/legal.ts`), which takes
 * the domain off the critical path entirely.
 */

import { NavItemLink, secondaryNav } from './SiteNav';

export function SiteFooter({ width = 'column' }: { width?: 'column' | 'full' }): JSX.Element {
  return (
    /*
     * Sticky to the bottom of whatever scrolls it, matching the header at the
     * top. On `SitePage` that is the document scroller; on the landing screen
     * the column does not scroll at all, where `sticky` costs nothing and lays
     * out exactly as it did before.
     *
     * A background is required now that prose can pass behind it — see the note
     * on `EditorialFooter`, which makes the same trade for the same reason.
     */
    <footer className="safe-pb sticky bottom-0 z-30 shrink-0 border-t border-ink-800/50 bg-ink-950/85 py-3.5 backdrop-blur-md short:py-2.5">
      {/*
        The footer takes its **own shell's** gutter, because the two shells that
        render it do not share one.
        `SitePage` puts its header in a centred `max-w-4xl px-5` column, so the
        column footer's first link sits directly under the logo. The landing and
        chat shell puts its header edge to edge at `px-3 sm:px-6`, and the same
        column there left the links starting a third of the way across from a
        logo pinned to the left margin — a small clump adrift in a full-width
        bar, which is the defect this footer already had once before and fixed
        for the other shell.
        It used to be a centred `max-w-lg` cluster, which was fine while the
        footer scrolled past at the end of a document rather than being pinned.
        Spreading the links edge to edge with `justify-between` was the other
        option and is worse: five short words strung across a wide screen stop
        reading as one set, and the last of them lands under the settings
        control in the header's corner.
      */}
      <nav
        aria-label="More"
        className={`flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-400 ${
          width === 'full' ? 'px-3 sm:px-6' : 'mx-auto w-full max-w-4xl px-5 sm:px-6'
        }`}
      >
        {secondaryNav().map((item) => (
          <NavItemLink
            key={item.to}
            item={item}
            className="rounded py-1 underline underline-offset-4 transition-colors hover:text-ink-100"
          />
        ))}
      </nav>
    </footer>
  );
}
