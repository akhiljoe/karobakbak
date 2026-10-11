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
import { useEffect, useState } from 'react';

import { App } from './App';
import { clientConfig } from './config';
import { PAYMENTS_ENABLED } from './features';
import { AboutPage } from './components/AboutPage';
import { AuthModal } from './components/AuthModal';
import { ContactPage } from './components/ContactPage';
import { FaqPage } from './components/FaqPage';
import { SafetyPage } from './components/SafetyPage';
import { HowItWorksPage } from './components/HowItWorksPage';
import { PremiumPage } from './components/PremiumPage';
import { RulesPage } from './components/RulesPage';
import { SupportPage } from './components/SupportPage';
import { NotFound } from './components/NotFound';
import { SitePage } from './components/SitePage';
import { STATIC_PAGES } from './content/pages';
import { useRoute } from './router';
import { applyPageMeta } from './meta';
import { useSession } from './hooks/useSession';

/** Path to page, built from the content so the two cannot disagree. */
const PAGES = new Map(STATIC_PAGES.map((page) => [`/${page.id}`, page]));

export function Root(): JSX.Element {
  const path = useRoute();
  const [signInOpen, setSignInOpen] = useState(false);
  // Above every early return, because hooks are unconditional. Only one of
  // these two mount sites is ever live — `/premium` renders instead of `App`,
  // never beside it — so this is one session check, not two.
  const session = useSession();

  // Title, description and canonical for the page about to render. Premium and
  // support are 404s while nothing can be bought, so they take the 404's meta
  // — including `noindex` — rather than a title for a page that is not there.
  useEffect(() => {
    const unbuyable = !PAYMENTS_ENABLED && (path === '/premium' || path === '/support');
    applyPageMeta(unbuyable ? '/__not_found' : path);
  }, [path]);

  if (path === '/') return <App />;

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

  /*
   * Premium and the support page exist only when something can actually be
   * bought. While `PAYMENTS_ENABLED` is false neither route is registered, so
   * both fall through to the 404 rather than rendering a page that explains it
   * cannot sell anything.
   *
   * Nothing is deleted: flipping the flag brings both back, along with the
   * Premium entry in the nav and the footer's "Buy me a coffee" pointing back
   * at `/support` instead of off-site.
   */
  if (PAYMENTS_ENABLED) {
    if (path === '/premium') {
      return (
        <>
          <PremiumPage
            onSignIn={() => setSignInOpen(true)}
            credential={clientConfig.devAccountCredential || null}
          />
          <AuthModal open={signInOpen} onClose={() => setSignInOpen(false)} session={session} />
        </>
      );
    }
    if (path === '/support') return <SupportPage />;
  }
  // Its own layout, like About, How it works, Rules and Contact: twenty
  // questions as a grouped accordion rather than twenty stacked sections.
  if (path === '/faq') return <FaqPage />;
  // Controls first, then the advice: somebody who opens this mid-incident
  // needs Skip, Block and Report above the essay, which `SitePage` could not
  // express.
  if (path === '/safety') return <SafetyPage />;

  const page = PAGES.get(path);
  if (page !== undefined) {
    // Nothing left here needs a slot.
    //
    // About, How it works, Rules and Contact each used to take one — a donation
    // card, a sample conversation, an address block. All four now have their
    // own layouts, which is where a thing that only ever appeared on one page
    // belonged. What remains on `SitePage` is Terms and Privacy: two long
    // documents that genuinely are the same shape.
    return <SitePage page={page} />;
  }

  return <NotFound />;
}
