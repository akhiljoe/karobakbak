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
import { AuthModal } from './components/AuthModal';
import { ContactCard } from './components/ContactCard';
import { PremiumPage } from './components/PremiumPage';
import { ACCOUNTS_ENABLED } from './features';
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

  // Gated by the constant, not by configuration. With accounts off, `/premium`
  // is a 404 like any other unknown path — the surface does not exist rather
  // than existing and being disabled, because a pricing page for something
  // nobody can buy is an advertisement for vapourware.
  if (path === '/premium' && ACCOUNTS_ENABLED) {
    return (
      <>
        <PremiumPage onSignIn={() => setSignInOpen(true)} />
        <AuthModal open={signInOpen} onClose={() => setSignInOpen(false)} />
      </>
    );
  }

  const page = PAGES.get(path);
  if (page !== undefined) {
    // Contact is the only page with something to *do* on it. Special-cased here
    // rather than giving every page an optional component slot in its data,
    // which would put React in the content layer for one exception.
    return (
      <SitePage page={page}>{page.id === 'contact' ? <ContactCard /> : undefined}</SitePage>
    );
  }

  return <NotFound />;
}
