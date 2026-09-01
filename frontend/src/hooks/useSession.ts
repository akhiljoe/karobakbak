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

import { beginSignIn, endSession, readSession, readSigninOutcome, withoutSigninOutcome, type SigninOutcome } from '../auth';
import { ACCOUNTS_ENABLED } from '../features';

export interface Session {
  /** Whether the server confirmed a working credential. */
  readonly signedIn: boolean;
  /** True until the first answer arrives, so the header can avoid flickering. */
  readonly checking: boolean;
  /** What the callback just reported, once, or null. */
  readonly outcome: SigninOutcome | null;
  /** Leave for the provider. Does not return. */
  signIn(): void;
  /** Revoke. Resolves false when the server did not confirm it. */
  signOut(): Promise<boolean>;
  /** Acknowledge the outcome so it stops being shown. */
  dismissOutcome(): void;
}

export function useSession(): Session {
  const [signedIn, setSignedIn] = useState(false);
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
      setSignedIn(result);
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, []);

  const signOut = useCallback(async (): Promise<boolean> => {
    const confirmed = await endSession();
    // Only on confirmation. Clearing this optimistically would tell somebody on
    // a shared machine they had signed out while the credential still worked.
    if (confirmed) setSignedIn(false);
    return confirmed;
  }, []);

  const dismissOutcome = useCallback((): void => setOutcome(null), []);

  return { signedIn, checking, outcome, signIn: beginSignIn, signOut, dismissOutcome };
}
