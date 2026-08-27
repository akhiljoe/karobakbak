/**
 * The shell every static page shares: header, readable column, footer.
 *
 * ---------------------------------------------------------------------------
 * ONE TEMPLATE, NOT SIX PAGES
 * ---------------------------------------------------------------------------
 * About, FAQ, Safety, Rules, Terms and Privacy differ only in their content,
 * which already lives as data in `content/pages.ts`. Giving each its own layout
 * would guarantee they drift — one gets a wider measure, another a different
 * heading size, and nobody notices until they are read back to back.
 *
 * ---------------------------------------------------------------------------
 * THE MEASURE IS THE DESIGN DECISION
 * ---------------------------------------------------------------------------
 * `max-w-2xl` on the prose column is roughly 65-75 characters at this type
 * size, which is the range long-form text stays readable in. These are pages
 * people open when they are worried about something — legibility beats
 * personality, and a full-width paragraph on a 1440px monitor is neither.
 */
import type { StaticPage } from "../content/pages";
import { RouteLink, useDocumentTitle } from "../router";
import { Logo } from "./Logo";
import { SiteFooter } from "./SiteFooter";
import { StartChattingLink } from "./StartChattingLink";
import { SiteNav, SiteNavLinks } from "./SiteNav";

interface SitePageProps {
  readonly page: StaticPage;
  /**
   * Anything a page needs that prose cannot carry — a link, a form, a live
   * value. Rendered above the sections, because on the one page that has this
   * (Contact) the actionable part is what the visitor came for and the prose is
   * context around it.
   */
  readonly children?: React.ReactNode;
}

export function SitePage({ page, children }: SitePageProps): JSX.Element {
  useDocumentTitle(`${page.title} · karobakbak`);

  /*
   * A scroll container of its own.
   *
   * `#root` is `h-[100dvh]` with `overflow-hidden` (see index.css), because the
   * chat app owns exactly one viewport and scrolls inside itself. A document
   * page that only set `min-h-full` therefore grew past the root and was
   * **clipped with no way to scroll to the rest** — it simply ended mid-sentence
   * on any screen shorter than its content.
   *
   * So the outer element scrolls and the inner one keeps `min-h-full`, which
   * still lets a short page push its footer to the bottom edge. `sticky` on the
   * header resolves against this container rather than the viewport, which is
   * what keeps it in place while the prose moves.
   */
  return (
    <div className="h-full overflow-y-auto bg-ink-950">
      <div className="flex min-h-full flex-col">
        <header className="safe-pt sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-3 px-5 sm:px-6">
            {/*
              Logo then menu, both on the left, matching the app header. The
              menu panel drops from its own control rather than from the far
              side of the screen.
            */}
            <div className="flex items-center gap-1.5">
              <SiteNav />
              <RouteLink
                to="/"
                aria-label="karobakbak — home"
                className="rounded-lg transition-opacity hover:opacity-80"
              >
                <Logo size={24} />
              </RouteLink>
              <SiteNavLinks />
            </div>

            {/*
              The same amber pill the editorial pages carry.

              These are documents somebody opens while deciding whether to use
              the product, so the way back into it is the primary action on the
              page rather than a quiet return link. It was an outlined button
              with a back-arrow; the arrow in particular read as "undo", which
              is not what starting a conversation is.
            */}
            <StartChattingLink
              className="ml-auto flex-none rounded-full bg-amber-400 px-3 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 sm:px-4"
            />
          </div>
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-50 sm:text-4xl">
            {page.title}
          </h1>
          <p className="mt-2 text-base text-ink-400">{page.summary}</p>
          {page.intro !== undefined && (
            <p className="mt-4 text-base leading-relaxed text-ink-300">
              {page.intro}
            </p>
          )}

          {children !== undefined && <div className="mt-8">{children}</div>}

          <div className="mt-9">
            {page.sections.map((section) => (
              <section key={section.heading} className="mb-8 last:mb-0">
                <h2 className="mb-2.5 font-display text-lg font-semibold text-ink-100">
                  {section.heading}
                </h2>
                {section.body.map((paragraph) => (
                  <p
                    key={paragraph}
                    className="mb-3 text-base leading-relaxed text-ink-300 last:mb-0"
                  >
                    {paragraph}
                  </p>
                ))}

                {/*
                  A section's list and its closing paragraphs.

                  No page rendered by this template carries either today — the
                  two that do (Rules, Contact) have their own layouts. They are
                  rendered anyway because `PageSection` allows them: a template
                  that silently drops half a section the first time somebody
                  adds a list is a worse failure than a plain `<ul>` nobody
                  currently sees.
                */}
                {section.bullets !== undefined && (
                  <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">
                    {section.bullets.map((item) => (
                      <li
                        key={item}
                        className="text-base leading-relaxed text-ink-300"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                )}

                {section.tail?.map((paragraph) => (
                  <p
                    key={paragraph}
                    className="mb-3 text-base leading-relaxed text-ink-300 last:mb-0"
                  >
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
