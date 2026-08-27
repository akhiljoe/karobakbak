/**
 * The route table.
 *
 * ---------------------------------------------------------------------------
 * WHY `/` IS THE APP AND EVERYTHING ELSE IS A DOCUMENT
 * ---------------------------------------------------------------------------
 * `App` owns the WebSocket. Mounting it means opening a connection, so it is
 * mounted on exactly one route — the one where somebody might actually start a
 * conversation. Reading the Safety page should not cost a socket, and before
 * this file existed it did, because every page was an overlay on top of a live
 * app.
 *
 * The consequence to be aware of: navigating from `/` to a document unmounts
 * `App` and drops the connection, and coming back opens a new session. That is
 * acceptable because the footer only renders on the landing screen — there is
 * no link out of a live conversation — but it is the reason a link must never
 * be added to the chat surface without thinking about it first.
 *
 * ---------------------------------------------------------------------------
 * UNKNOWN PATHS GET A PAGE, NOT THE APP
 * ---------------------------------------------------------------------------
 * nginx serves `index.html` for any path, so a typo used to silently render the
 * landing screen at `/saftey` — a soft 404, which is worse than a real one: the
 * visitor believes they arrived, and a crawler indexes the homepage under a
 * dozen wrong URLs.
 */
import { useState } from 'react';

import { App } from './App';
import { AboutPage } from './components/AboutPage';
import { AuthModal } from './components/AuthModal';
import { ContactPage } from './components/ContactPage';
import { HowItWorksPage } from './components/HowItWorksPage';
import { PremiumPage } from './components/PremiumPage';
import { RulesPage } from './components/RulesPage';
import { SupportPage } from './components/SupportPage';
import { NotFound } from './components/NotFound';
import { SitePage } from './components/SitePage';
import { STATIC_PAGES } from './content/pages';
import { useRoute } from './router';

/** Path to page, built from the content so the two cannot disagree. */
const PAGES = new Map(STATIC_PAGES.map((page) => [`/${page.id}`, page]));

export function Root(): JSX.Element {
  const path = useRoute();
  const [signInOpen, setSignInOpen] = useState(false);

  if (path === '/') return <App />;

  // Always reachable, unlike sign-in.
  //
  // This used to be gated on `ACCOUNTS_ENABLED` on the grounds that a pricing
  // page for something nobody can buy is an advertisement for vapourware. That
  // conflated two things: an account is needed to *hold* a subscription, and
  // nothing is needed to *read what one would be*. The page states plainly that
  // it is not open yet, which is the honest version of the same caution, and
  // hiding it entirely means somebody deciding whether this product is for them
  // cannot find out what it will cost.
  if (path === '/premium') {
    return (
      <>
        <PremiumPage onSignIn={() => setSignInOpen(true)} />
        <AuthModal open={signInOpen} onClose={() => setSignInOpen(false)} />
      </>
    );
  }

  // Always available, unlike /premium. Asking for help with the bill does not
  // depend on accounts existing, and the page is honest about payments not
  // being connected yet.
  if (path === '/support') return <SupportPage />;

  /*
   * The three pages that argue for the product get their own layouts.
   *
   * They are still in `STATIC_PAGES` — the footer, the header menu and
   * `pages.test.ts` all read that list, and dropping them from it would remove
   * them from the navigation rather than restyle them. What changes here is
   * only which component renders the words: `AboutPage` and `HowItWorksPage`
   * read the same `content/` entries `SitePage` would have.
   */
  if (path === '/about') return <AboutPage />;
  if (path === '/how-it-works') return <HowItWorksPage />;
  if (path === '/rules') return <RulesPage />;
  if (path === '/contact') return <ContactPage />;

  const page = PAGES.get(path);
  if (page !== undefined) {
    // Nothing left here needs a slot.
    //
    // About, How it works, Rules and Contact each used to take one — a donation
    // card, a sample conversation, an address block. All four now have their
    // own layouts, which is where a thing that only ever appeared on one page
    // belonged. What remains on `SitePage` is FAQ, Safety, Terms and Privacy:
    // four documents that genuinely are the same shape.
    return <SitePage page={page} />;
  }

  return <NotFound />;
}
