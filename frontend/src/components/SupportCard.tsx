/**
 * The support card, on the About page.
 *
 * ---------------------------------------------------------------------------
 * WHY HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 * About is the page that has just explained what this is and that it is free
 * with no advertising. That is the only context in which asking for money reads
 * as a person mentioning something rather than a banner.
 *
 * It deliberately does not appear on the landing screen. That page has one job
 * and one button, and a second ask beside the primary action competes with it.
 * The menu carries a link for anybody looking; this carries the reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * Not a widget, not a coloured band, not a coffee cup. It links to `/support`,
 * which is a page in this app — no third-party script, because the Content
 * Security Policy is `default-src 'self'` and the Privacy page states the site
 * makes no third-party requests from the browser.
 *
 * Amber is used at its quietest here: the border on hover and nothing else. The
 * accent belongs to "Start chatting", and a support element that competes with
 * the primary action of the product is wrong however well it is drawn.
 */
import { ArrowRight } from 'lucide-react';

import { RouteLink } from '../router';

export function SupportCard(): JSX.Element {
  return (
    <RouteLink
      to="/support"
      className="group block rounded-xl border border-ink-800 bg-ink-900/40 px-5 py-4 transition-colors hover:border-amber-400/40"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-100">Buy me a coffee</p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-400">
            The site is free and carries no advertising. If you want to help with what it costs to
            run, you can — it changes nothing, and nothing here is behind a payment.
          </p>
        </div>
        <ArrowRight
          className="mt-0.5 h-4 w-4 shrink-0 text-ink-600 transition-colors group-hover:text-amber-300"
          aria-hidden="true"
        />
      </div>
    </RouteLink>
  );
}
