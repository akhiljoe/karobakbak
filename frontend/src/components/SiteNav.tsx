/**
 * The header navigation, and the only navigation on the homepage.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MENU EXISTS ON DESKTOP TOO
 * ---------------------------------------------------------------------------
 * The homepage has no footer. It is one screen with a button on it, and a
 * footer was the only thing making it scroll — so the links a footer carries
 * had to go somewhere, and this is it.
 *
 * That makes the menu load-bearing rather than a mobile convenience:
 * `docs/policies/age-gate.md` requires Terms and the Privacy Policy to be
 * reachable **without passing the gate**, and with no footer the header is the
 * only place left that satisfies it. A visitor who never presses "Start
 * chatting" must still be able to read both, and now can, at every screen size.
 *
 * ---------------------------------------------------------------------------
 * TWO GROUPS, DELIBERATELY UNEQUAL
 * ---------------------------------------------------------------------------
 * Primary — how it works, safety, FAQ, about — is what somebody asks before
 * deciding. Those sit inline from `md` up because they are the ones worth
 * spending header width on.
 *
 * Secondary — rules, contact, terms, privacy — is what somebody looks up once.
 * Those live in the menu at every size. Putting all nine inline would be a
 * sitemap in a header, which means the product could not decide what mattered.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { RouteLink, useRoute } from "../router";
import { clientConfig } from "../config";
import { PAYMENTS_ENABLED } from "../features";

export interface NavItem {
  readonly to: string;
  readonly label: string;
  /**
   * An absolute URL that leaves the site, rendered as an anchor rather than a
   * route.
   *
   * Only "Buy me a coffee" is ever one, and only while payments are off. It is
   * a **link and never an embed**: a donation widget is a third-party script,
   * and the Privacy Policy's claim that the site makes no third-party requests
   * from the browser is worth more than an inline button. An anchor requests
   * nothing until somebody clicks it and leaves.
   */
  readonly external?: boolean;
}

const PRIMARY_BASE: readonly NavItem[] = [
  { to: "/about", label: "About" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/safety", label: "Safety" },
  { to: "/premium", label: "Premium" },
  { to: "/faq", label: "FAQ" },
];

const SECONDARY_BEFORE: readonly NavItem[] = [
  { to: "/rules", label: "Rules" },
  { to: "/contact", label: "Contact" },
];

const SECONDARY_AFTER: readonly NavItem[] = [
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
];

/*
 * The order is the design's: About, How it works, Safety, Premium, FAQ.
 *
 * It reads as the order the questions arrive in — what is this, how does it
 * work, is it safe, what does it cost, and then everything else. Premium sat
 * second for a while on the argument that it belongs right after the
 * explanation; the design puts it after Safety instead, which is the more
 * honest sequence for a product whose main objection is not price.
 *
 * It is not gated. `ACCOUNTS_ENABLED` governs signing in, which is a different
 * question from whether the plan can be read about.
 */
function primary(): readonly NavItem[] {
  // Premium is hidden entirely while payments are off, rather than shown and
  // disabled. The asymmetry is the one `features.ts` already draws: a filter
  // says "we know you want this" and teaches something, while a plan nobody can
  // buy teaches nothing and costs a click to find out. It returns the moment
  // the flag flips — nothing here is deleted.
  if (!PAYMENTS_ENABLED) return PRIMARY_BASE.filter((item) => item.to !== "/premium");
  return PRIMARY_BASE;
}

/**
 * Every path the header can reach, so nothing else has to repeat the list.
 *
 * The secondary set is no longer among them: it moved out of the menu and into
 * the footer, which is on every page. Two copies of the same five links, one of
 * them behind a button, was a menu teaching people to look in the wrong place.
 */
export function navPaths(): ReadonlySet<string> {
  return new Set(primary().map((item) => item.to));
}

/**
 * The things somebody looks up once, rather than navigates by.
 *
 * Shared with `SiteFooter`, which lists exactly these. The header keeps them
 * behind the menu button; the footer puts them in the open, because the foot of
 * a page is where a reader goes looking for the rules and the legal documents
 * and it is cheaper to show five links than to teach a menu.
 */
export function secondaryNav(): readonly NavItem[] {
  return [...SECONDARY_BEFORE, ...coffee(), ...SECONDARY_AFTER];
}

/**
 * Where "buy me a coffee" points, and whether it appears at all.
 *
 * Three states, and each one is the honest answer to a different situation:
 *
 *  * **Payments on** — `/support`, the page with the amounts on it.
 *  * **Payments off, a URL configured** — straight out to that page. Nothing
 *    here can take money, and somebody who wants to give some should not be
 *    routed through a page that says so before letting them.
 *  * **Payments off, nothing configured** — no link. A "buy me a coffee" that
 *    goes nowhere is worse than none, which is the rule `clientConfig.supportUrl`
 *    already states: empty hides it entirely.
 */
function coffee(): readonly NavItem[] {
  if (PAYMENTS_ENABLED) return [{ to: "/support", label: "Buy me a coffee" }];
  if (clientConfig.supportUrl === "") return [];
  return [{ to: clientConfig.supportUrl, label: "Buy me a coffee", external: true }];
}

/**
 * One nav item, as a route or as a way off the site.
 *
 * Shared so the three places that render this list — the two footers and the
 * support page — cannot disagree about which items leave the site. An external
 * item that a caller rendered with `RouteLink` would push a full URL through the
 * router and land on the 404 page.
 */
export function NavItemLink({
  item,
  className,
}: {
  item: NavItem;
  className?: string;
}): JSX.Element {
  if (item.external === true) {
    return (
      // `noreferrer` as well as `noopener`: the destination has no business
      // learning which page on an anonymous chat service sent somebody.
      <a href={item.to} target="_blank" rel="noreferrer noopener" className={className}>
        {item.label}
      </a>
    );
  }
  return (
    <RouteLink to={item.to} className={className}>
      {item.label}
    </RouteLink>
  );
}

/*
 * The link for the page you are on is lit; the rest are quiet.
 *
 * The design marks the current page rather than leaving five identical links,
 * which is the difference between a navigation bar and a row of words. Driven
 * off `useRoute` so it cannot disagree with what is rendered.
 */
const INLINE_CLASS =
  "rounded-lg px-2 py-1.5 text-sm transition-colors hover:text-ink-100";
const INLINE_REST = "text-ink-400";
const INLINE_CURRENT = "text-ink-100";

const PANEL_CLASS =
  "rounded-lg px-3 py-2.5 text-base text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50";

/**
 * The desktop inline links, rendered separately from the menu button.
 *
 * Split so a header can put the button at the far left — before the logo —
 * while the links still sit after it. As one component the two could only ever
 * be adjacent, which forced a choice between a leftmost button and links that
 * read before the brand.
 */
export function SiteNavLinks(): JSX.Element {
  const path = useRoute();
  return (
    <nav aria-label="Site" className="ml-2 hidden items-center gap-[22px] md:flex">
      {primary().map((item) => {
        const current = path === item.to;
        return (
          <RouteLink
            key={item.to}
            to={item.to}
            className={`${INLINE_CLASS} ${current ? INLINE_CURRENT : INLINE_REST}`}
            {...(current ? { "aria-current": "page" as const } : {})}
          >
            {item.label}
          </RouteLink>
        );
      })}
    </nav>
  );
}

export function SiteNav(): JSX.Element {
  const [open, setOpen] = useState(false);
  const links = primary();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = (): void => setOpen(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="More"
        aria-expanded={open}
        className="group inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-ink-800"
      >
        {/*
          Three drawn rules rather than an icon-font glyph, which is what the
          design uses: 18px wide, 1.5px each, and noticeably lighter than a
          lucide `Menu` at the same size. The difference is visible next to the
          wordmark, which is the only place this button ever sits.
        */}
        <span aria-hidden="true" className="flex w-[18px] flex-col gap-1">
          <span className="h-[1.5px] rounded-sm bg-ink-300 transition-colors group-hover:bg-ink-50" />
          <span className="h-[1.5px] rounded-sm bg-ink-300 transition-colors group-hover:bg-ink-50" />
          <span className="h-[1.5px] rounded-sm bg-ink-300 transition-colors group-hover:bg-ink-50" />
        </span>
      </button>

      {open &&
        /*
         * Rendered into `document.body`, not in place.
         *
         * The header carries `backdrop-blur-md`, and `backdrop-filter` creates
         * a **containing block for fixed-position descendants** — exactly as
         * `transform` and `filter` do. So `fixed inset-0` inside the header was
         * not the viewport at all; it was the header's own box, 56px tall.
         *
         * The backdrop therefore only existed across that strip. Tapping
         * anywhere below it hit nothing, because there was nothing there —
         * which is why the X and the hamburger worked and the whole rest of the
         * screen did not. No amount of click-versus-pointer handling could have
         * fixed it.
         *
         * A portal escapes the containing block, so `fixed inset-0` means the
         * viewport again.
         */
        createPortal(
          <div
            className="fixed inset-0 z-50"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            {/*
            A button, not a div.

            iOS Safari does not reliably fire a click on a non-interactive
            element, so a plain div backdrop swallowed the tap and the only way
            out was the X. A button is focusable, keyboard operable, and taps
            everywhere.
          */}
            <button
              type="button"
              aria-label="Close menu"
              onClick={close}
              /*
               * `pointerdown` as well as `click`, because a tap that starts and
               * ends a few pixels apart — which is most taps on a phone — can be
               * interpreted as a scroll gesture and never become a click. Closing
               * on the press is also what a person expects from a backdrop.
               */
              onPointerDown={close}
              className="absolute inset-0 h-full w-full animate-fade-in cursor-default bg-ink-950/70 backdrop-blur-sm"
            />

            {/*
            Anchored left, because the control that opens it is on the left.

            A panel that appears on the opposite side of the screen from the
            button pressed breaks the link between the two — the eye has to go
            looking for what just happened. The hamburger sits beside the logo
            on every header, so the panel drops from there.
          */}
            <div className="safe-pt absolute left-3 top-3 w-56 animate-fade-in rounded-2xl border border-ink-700 bg-ink-900 px-2 pb-2 shadow-lift sm:w-64">
              <div className="flex justify-end py-1 pr-0.5">
                <button
                  onClick={close}
                  aria-label="Close menu"
                  className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Already inline on desktop; only the small header needs these. */}
              <nav aria-label="Product" className="flex flex-col md:hidden">
                {links.map((item) => (
                  <RouteLink
                    key={item.to}
                    to={item.to}
                    onClick={close}
                    className={PANEL_CLASS}
                  >
                    {item.label}
                  </RouteLink>
                ))}
              </nav>

            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
