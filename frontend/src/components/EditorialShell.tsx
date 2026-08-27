/**
 * The shell the three editorial pages share: About, How it works, Premium.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND SHELL BESIDE `SitePage`
 * ---------------------------------------------------------------------------
 * `SitePage` renders a page from its data: heading, summary, then a column of
 * paragraphs. Six pages want exactly that, because they are reference material
 * somebody opens with a question — Safety, FAQ, Rules, Terms, Privacy, Contact.
 *
 * These three are not reference material. They are the pages that argue for the
 * product, and each one is laid out around its own argument: a numbered rail
 * for the three steps, a specimen conversation beside the "text only" claim, a
 * field of unverified dots above the Premium hero. None of that survives being
 * flattened into a paragraph list, which is why they get a shell that supplies
 * chrome and nothing else.
 *
 * The prose still comes from `content/`. What lives here is furniture.
 *
 * ---------------------------------------------------------------------------
 * `container-type: inline-size` IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * The design sizes every display element with `clamp(min, Ncqw, max)` and has
 * **no media queries at all**. `cqw` resolves against the nearest ancestor with
 * a container type, so removing the one below silently collapses every clamp to
 * its minimum and the pages render at phone scale on a monitor.
 *
 * Container queries rather than breakpoints because these headlines want to
 * scale continuously — a 96px hero that steps down to 62px at some arbitrary
 * width is visibly a jump, and there is no layout change to justify one.
 */
import type { ReactNode } from 'react';

import { RouteLink, useDocumentTitle } from '../router';
import { LogoMark } from './Logo';
import { SiteNav, SiteNavLinks, secondaryNav } from './SiteNav';
import { StartChattingLink } from './StartChattingLink';

interface EditorialShellProps {
  /** Document title, without the product suffix. */
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * Three slow warm/sage blobs behind the page.
 *
 * Purely atmospheric, so `aria-hidden` and `pointer-events-none`. They are
 * positioned outside the page edges and clipped by `overflow-hidden` on the
 * root, which is what keeps them from adding a horizontal scrollbar as they
 * drift.
 */
function AmbientField(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <span className="absolute -right-[110px] -top-20 block h-[340px] w-[340px] animate-drift rounded-full bg-[radial-gradient(circle,rgba(255,180,32,.09),rgba(255,180,32,0)_70%)]" />
      <span
        className="absolute -left-[140px] top-[48%] block h-[300px] w-[300px] animate-drift rounded-full bg-[radial-gradient(circle,rgba(127,176,105,.07),rgba(127,176,105,0)_70%)]"
        style={{ animationDuration: '34s', animationDelay: '4s' }}
      />
      <span
        className="absolute -right-[90px] bottom-[4%] block h-[260px] w-[260px] animate-drift rounded-full bg-[radial-gradient(circle,rgba(255,180,32,.06),rgba(255,180,32,0)_70%)]"
        style={{ animationDuration: '30s', animationDelay: '8s' }}
      />
    </div>
  );
}

/**
 * The footer these three pages use, which is not `SiteFooter`.
 *
 * Same five links, set the way the design sets them: aligned to the left edge
 * of the 680px measure rather than centred, 13px, and unadorned — no
 * underlines. It reads as the end of a column of prose, which is what it is.
 *
 * `SiteFooter` stays centred and underlined for the landing screen and the
 * document pages, where there is no column to align to and the links are the
 * only thing in the region. Two treatments because the two contexts genuinely
 * differ; the *list* is shared through `secondaryNav()`, which is the half that
 * must never fall out of step.
 */
function EditorialFooter(): JSX.Element {
  return (
    <footer
      className="safe-pb relative z-[1] flex flex-none justify-center border-t border-ink-800"
      style={{ padding: '24px clamp(22px, 4cqw, 40px) 32px' }}
    >
      <nav
        aria-label="More"
        className="flex w-full max-w-[680px] flex-wrap text-[13px]"
        style={{ gap: '8px 20px' }}
      >
        {secondaryNav().map((item) => (
          <RouteLink
            key={item.to}
            to={item.to}
            className="rounded text-ink-400 transition-colors hover:text-ink-100"
          >
            {item.label}
          </RouteLink>
        ))}
      </nav>
    </footer>
  );
}

export function EditorialShell({
  title,
  children,
}: EditorialShellProps): JSX.Element {
  useDocumentTitle(`${title} · karobakbak`);

  /*
   * A scroll container of its own, for the reason spelled out in `SitePage`:
   * `#root` is a definite height with `overflow-hidden`, so a page that only
   * set `min-h-full` grows past it and is clipped with no way to reach the
   * rest.
   */
  return (
    <div className="h-full overflow-y-auto bg-ink-950">
      <div
        className="relative flex min-h-full flex-col overflow-x-hidden"
        style={{ containerType: 'inline-size' }}
      >
        <AmbientField />

        <header
          className="safe-pt sticky top-0 z-30 flex h-14 flex-none items-center gap-3.5 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md"
          style={{ paddingInline: 'clamp(14px, 3cqw, 32px)' }}
        >
          {/*
            Logo then menu, both on the left, matching the app header and
            `SitePage`. The mock drew its own hamburger and its own mark; both
            are the real components here, so the menu opens and the mark stays
            the one mark.
          */}
          <div className="flex min-w-0 items-center gap-2">
            <SiteNav />
            {/*
              The existing mark, at the design's wordmark size (17px Fraunces
              rather than `Logo`'s 16px). `Logo` is not reused because it hard-
              codes that size and it is shared with the app header, where the
              smaller setting is correct.
            */}
            <RouteLink
              to="/"
              aria-label="karobakbak — home"
              className="inline-flex items-center gap-2 rounded-lg transition-opacity hover:opacity-80"
            >
              <LogoMark size={24} />
              <span className="truncate font-display text-[17px] font-semibold tracking-[-0.01em] text-ink-100">
                karobakbak
              </span>
            </RouteLink>
            <SiteNavLinks />
          </div>

          {/*
            The one place this chrome differs from `SitePage`: a solid amber
            pill rather than an outlined button. These are the pages somebody
            reads while deciding, so the way out of them is the primary action
            on the page rather than a quiet return link.
          */}
          {/*
            The horizontal padding tightens on a narrow screen.

            At a fixed `px-4` the header overflowed by 6px at 320px wide —
            hamburger, mark, wordmark and this pill add up to more than the
            viewport, and `flex-none` means the pill wins and the row spills.
            The About board frames a 320 artboard specifically, so 320 is a
            width the design expects to work rather than an edge case.

            Clamping the padding rather than shrinking the type keeps the tap
            target full height, which is the part that matters on a phone.
          */}
          <StartChattingLink
            className="ml-auto flex-none rounded-full bg-amber-400 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300"
            style={{ paddingInline: 'clamp(11px, 4cqw, 16px)' }}
          />
        </header>

        <main
          className="relative z-[1] flex flex-1 flex-col items-center"
          style={{
            padding: 'clamp(44px, 7cqw, 88px) clamp(22px, 4cqw, 40px) 0',
          }}
        >
          <div className="w-full max-w-[680px]">{children}</div>
        </main>

        <EditorialFooter />
      </div>
    </div>
  );
}
