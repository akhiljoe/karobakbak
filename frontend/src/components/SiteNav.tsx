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
import { Menu, X } from "lucide-react";

import { RouteLink } from "../router";

interface NavItem {
  readonly to: string;
  readonly label: string;
}

const PRIMARY_BASE: readonly NavItem[] = [
  { to: "/how-it-works", label: "How it works" },
  { to: "/premium", label: "Premium" },
  { to: "/safety", label: "Safety" },
  { to: "/faq", label: "FAQ" },
  { to: "/about", label: "About" },
];

const SECONDARY: readonly NavItem[] = [
  { to: "/rules", label: "Rules" },
  { to: "/contact", label: "Contact" },
  { to: "/support", label: "Buy me a coffee" },
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
];

/*
 * Premium sits second — after the explanation, before the reassurance — which
 * is where the design put it and where somebody looks once they have decided
 * the product is interesting but not yet whether it is worth anything.
 *
 * It is not gated. `ACCOUNTS_ENABLED` governs signing in, which is a different
 * question from whether the plan can be read about.
 */
function primary(): readonly NavItem[] {
  return PRIMARY_BASE;
}

/** Every path the header can reach, so nothing else has to repeat the list. */
export function navPaths(): ReadonlySet<string> {
  return new Set([...primary(), ...SECONDARY].map((item) => item.to));
}

const INLINE_CLASS =
  "rounded-lg px-2 py-1.5 text-sm text-ink-300 transition-colors hover:bg-ink-800/60 hover:text-ink-50";

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
  return (
    <nav aria-label="Site" className="hidden items-center gap-0.5 md:flex">
      {primary().map((item) => (
        <RouteLink key={item.to} to={item.to} className={INLINE_CLASS}>
          {item.label}
        </RouteLink>
      ))}
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
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-50"
      >
        <Menu className="h-5 w-5" />
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

              <div className="my-2 border-t border-ink-800 md:mt-0" />

              <nav aria-label="More" className="flex flex-col">
                {SECONDARY.map((item) => (
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
