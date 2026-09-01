/**
 * Whether this browser is signed in, and the two things you can do about it.
 *
 * ---------------------------------------------------------------------------
 * IT ASKS THE SERVER ONCE, ON MOUNT
 * ---------------------------------------------------------------------------
 * There is no polling and no revalidation on focus. The credential lasts thirty
 * days (`AUTH_SESSION_TTL_SECONDS`), so the answer does not change while
 * somebody is looking at the page — except when they sign in or out, and both
 * of those go through here and update the state directly. A poll would be a
 * request per interval per tab to learn something that changes twice a month.
 *
 * ---------------------------------------------------------------------------
 * THE MARKER IS READ ONCE AND THEN REMOVED FROM THE URL
 * ---------------------------------------------------------------------------
 * This still matters with a popup, because the popup is not guaranteed: a
 * blocked `window.open` falls back to a full-page redirect and the browser
 * comes back to `/?signin=ok` exactly as before.
 *
 * The callback sends the browser to `/?signin=ok`. If that parameter is left in
 * place it survives a refresh, a bookmark and a shared link, so the page would
 * announce a sign-in that happened last week — or announce one to whoever the
 * link was sent to. It is read into state and stripped with `replaceState`, so
 * there is no new history entry to go Back into.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HAPPENS AT ALL WHILE THE FLAG IS OFF
 * ---------------------------------------------------------------------------
 * `ACCOUNTS_ENABLED` false means the backend was very likely started with
 * `AUTH_ENABLED` false too, and in that build the four routes are never
 * registered — `/auth/session` would be answered by the static file server with
 * the SPA shell. So the hook does not ask. The guard is here rather than only
 * at the call site so a second caller cannot reintroduce the request.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  beginSignIn,
  endSession,
  openSignInPopup,
  readSession,
  readSigninOutcome,
  signinMessageOutcome,
  withoutSigninOutcome,
  type SigninOutcome,
} from '../auth';
import { ACCOUNTS_ENABLED } from '../features';

export interface Session {
  /** Whether the server confirmed a working credential. */
  readonly signedIn: boolean;
  /** Whether `/auth/avatar` has an image to serve. Never a provider URL. */
  readonly avatar: boolean;
  /** True until the first answer arrives, so the header can avoid flickering. */
  readonly checking: boolean;
  /** What the callback just reported, once, or null. */
  readonly outcome: SigninOutcome | null;
  /**
   * Start signing in.
   *
   * Answers whether a window opened. `allowRedirect` false suppresses the
   * full-page fallback, for callers that would lose something by navigating —
   * a live conversation being the one that matters.
   */
  signIn(allowRedirect?: boolean): boolean;
  /** Revoke. Resolves false when the server did not confirm it. */
  signOut(): Promise<boolean>;
  /** Acknowledge the outcome so it stops being shown. */
  dismissOutcome(): void;
}

export function useSession(): Session {
  const [signedIn, setSignedIn] = useState(false);
  const [avatar, setAvatar] = useState(false);
  const [checking, setChecking] = useState(ACCOUNTS_ENABLED);
  const [outcome, setOutcome] = useState<SigninOutcome | null>(null);

  useEffect(() => {
    if (!ACCOUNTS_ENABLED) return;

    const found = readSigninOutcome(window.location.search);
    if (found !== null) {
      setOutcome(found);
      const cleaned = withoutSigninOutcome(window.location.href, window.location.origin);
      window.history.replaceState(window.history.state, '', cleaned);
    }

    // Guards the state update against a component that unmounted while the
    // request was open — a refused sign-in can leave the page quickly.
    let live = true;
    void readSession().then((result) => {
      if (!live) return;
      setSignedIn(result.signedIn);
      setAvatar(result.avatar);
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Sign in without leaving the page.
   *
   * The popup runs the ordinary redirect flow — our `/auth/start`, the
   * provider, our `/auth/callback` — and lands on `/signin-done.html`, which
   * posts the outcome back and closes. Nothing about the protocol changes; the
   * cookie it sets belongs to this origin and is therefore already ours when
   * the popup goes away.
   *
   * TWO WAYS OF FINDING OUT, ON PURPOSE
   * The message is the fast path. The close watcher is the one that always
   * works: `window.close()` can be refused, a `Cross-Origin-Opener-Policy`
   * header added later would sever `opener` and silently kill `postMessage`,
   * and somebody can simply close the window themselves half way through. In
   * every one of those the poll notices the window is gone and re-checks the
   * session, so the failure mode is "a second slower", never "signed in and the
   * page never noticed".
   *
   * Neither path trusts what it is told. Both end in `readSession`.
   */
  const signIn = useCallback((allowRedirect = true): boolean => {
    const popup = openSignInPopup();
    if (popup === null) {
      /*
       * Refused. A full-page redirect is a worse experience and a working one —
       * except from inside a conversation, where it is neither.
       *
       * The socket dies with the navigation and `RESUME_GRACE_SECONDS` is 20,
       * so a round trip through the provider will not finish inside the window
       * that holds the seat. The stranger waits, times out, and is gone. That is
       * a real loss to trade for a sign-in nobody asked to prioritise, so the
       * caller is told instead and can say so.
       */
      if (!allowRedirect) return false;
      beginSignIn();
      return true;
    }

    popup.focus();

    let settled = false;
    // Declared before `finish` closes over it. A `const` assigned further down
    // would be in the temporal dead zone if a message arrived first, and the
    // popup posting before this function returns is unlikely rather than
    // impossible — the failure would be a thrown ReferenceError inside an
    // event listener, which is invisible.
    let watcher = 0;

    const finish = (found: SigninOutcome | null): void => {
      if (settled) return;
      settled = true;
      window.clearInterval(watcher);
      window.removeEventListener('message', onMessage);
      if (found !== null) setOutcome(found);
      void readSession().then((result) => {
        setSignedIn(result.signedIn);
        setAvatar(result.avatar);
      });
    };

    const onMessage = (event: MessageEvent): void => {
      const found = signinMessageOutcome(event);
      if (found !== null) finish(found);
    };
    window.addEventListener('message', onMessage);

    // `closed` is readable across origins, which is the whole reason this
    // works while the popup is sitting on the provider's domain.
    watcher = window.setInterval(() => {
      if (popup.closed) finish(null);
    }, 400);
    return true;
  }, []);

  const signOut = useCallback(async (): Promise<boolean> => {
    const confirmed = await endSession();
    // Only on confirmation. Clearing this optimistically would tell somebody on
    // a shared machine they had signed out while the credential still worked.
    if (confirmed) {
      setSignedIn(false);
      setAvatar(false);
    }
    return confirmed;
  }, []);

  const dismissOutcome = useCallback((): void => setOutcome(null), []);

  return { signedIn, avatar, checking, outcome, signIn, signOut, dismissOutcome };
}
