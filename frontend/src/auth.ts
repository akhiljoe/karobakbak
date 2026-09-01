/**
 * The sign-in client: four calls against the four routes in
 * `backend/src/accounts/routes.ts`.
 *
 * ---------------------------------------------------------------------------
 * SIGNING IN IS A NAVIGATION, NOT A FETCH
 * ---------------------------------------------------------------------------
 * `/auth/start` answers 302 to the identity provider's hosted page on a
 * different origin. `fetch` would follow that redirect itself and hand back an
 * opaque response, so the person would sit on our page while their browser
 * quietly loaded somebody else's login form into nothing. The whole point of
 * the redirect is that they *arrive* at the provider, look at the address bar,
 * and decide whether to type a password into it.
 *
 * So this is `location.assign`, and it is the one call here that never returns.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER TELLS US WHETHER, NEVER WHO
 * ---------------------------------------------------------------------------
 * `/auth/session` answers `{ signedIn: boolean }` and deliberately carries no
 * account id — the comment on the route says why: an opaque identifier rendered
 * into a page is one more thing that can be copied into a screenshot or a bug
 * report. Nothing here should invent one, and nothing in the interface may come
 * to depend on having one.
 *
 * ---------------------------------------------------------------------------
 * THE CREDENTIAL IS A COOKIE THIS FILE NEVER TOUCHES
 * ---------------------------------------------------------------------------
 * The session cookie is `HttpOnly`, so script cannot read it, cannot copy it
 * into `localStorage`, and cannot leak it through a logger. That is the whole
 * design: the only thing this module knows is what the server just answered.
 * `credentials: 'same-origin'` is the default for a same-origin request and is
 * stated anyway, because the day someone points one of these at an absolute URL
 * the default changes underneath them.
 */

/** What the callback appended to the return URL. Only ever these two. */
export type SigninOutcome = 'ok' | 'failed';

const START_URL = '/auth/start';
const SESSION_URL = '/auth/session';
const SIGNOUT_URL = '/auth/signout';

/** The query key the callback sets on the way home (`routes.ts:177`). */
const OUTCOME_PARAM = 'signin';

/**
 * Leave for the provider. Never returns — the page is being replaced.
 *
 * `assign` rather than `replace`: the landing page stays in history, so Back
 * from the provider's page returns here rather than to whatever came before.
 * Somebody who changes their mind at the login screen expects to come back.
 *
 * This is now the fallback rather than the ordinary path. It runs when a popup
 * is refused, which is a real case: a browser blocks `window.open` when it
 * cannot attribute the call to a click, and some are stricter than others.
 * Falling back to a full-page redirect is strictly better than telling somebody
 * to go and find their popup blocker.
 */
export function beginSignIn(): void {
  window.location.assign(START_URL);
}

/** The `source` field on the message the popup posts back. */
const SIGNIN_MESSAGE = 'karobakbak-signin';

/**
 * Open the provider in a popup and hand back the window, or null if it was
 * refused.
 *
 * MUST be called synchronously from the click handler. A browser allows
 * `window.open` only while it can attribute the call to a user gesture, and an
 * `await` before it — even one that resolves immediately — loses that
 * attribution and the popup is blocked.
 *
 * Centred on the window rather than the screen, because a maximised browser on
 * a second monitor otherwise puts the popup on the first one.
 */
export function openSignInPopup(): Window | null {
  const width = 480;
  const height = 640;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);

  return window.open(
    `${START_URL}?mode=popup`,
    // A name, so a second click focuses the window that is already open rather
    // than starting a second flow whose state cookie overwrites the first.
    'karobakbak-signin',
    `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
  );
}

/**
 * The outcome carried by a message from the popup, or null if this is not one.
 *
 * Pure and tested, because it is the only place a `message` event — which any
 * page, extension or embedded frame can fire — is turned into something the
 * application acts on. Every field is checked: a different origin, a missing
 * marker, or an outcome we did not write all answer null.
 *
 * What it returns is still only a hint. The caller re-asks `/auth/session`,
 * because the server holding a credential is the only thing that decides
 * whether somebody is signed in, and a message is not evidence of that.
 */
export function signinMessageOutcome(event: MessageEvent): SigninOutcome | null {
  if (event.origin !== window.location.origin) return null;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return null;
  const shape = data as { source?: unknown; outcome?: unknown };
  if (shape.source !== SIGNIN_MESSAGE) return null;
  if (shape.outcome === 'ok') return 'ok';
  if (shape.outcome === 'failed') return 'failed';
  return null;
}

/**
 * Whether this browser currently holds a working credential.
 *
 * Every failure answers `false`. That is the safe direction: showing a signed
 * out header to somebody who is in fact signed in costs them one click, while
 * the reverse shows account controls that then fail one by one.
 */
export async function readSession(): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(SESSION_URL, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    return false;
  }

  if (!response.ok) return false;

  try {
    const body: unknown = await response.json();
    // Strict, not truthy. A server that ever answered `"signedIn": "no"` would
    // otherwise read as signed in, and this is the check the whole account
    // surface hangs off.
    return typeof body === 'object' && body !== null && (body as { signedIn?: unknown }).signedIn === true;
  } catch {
    return false;
  }
}

/**
 * Revoke the credential. Answers whether the server confirmed it.
 *
 * A network failure answers `false` and the caller keeps showing the signed-in
 * state, which looks like the sign-out did not work — because it did not. The
 * tempting alternative is to clear the interface optimistically, and that tells
 * somebody on a shared machine that they have signed out while their credential
 * is still live on the server. That is the one lie this file must not tell.
 */
export async function endSession(): Promise<boolean> {
  try {
    const response = await fetch(SIGNOUT_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    // The route answers 200 whether or not there was anything to revoke:
    // signing out when not signed in is success, because the caller's goal is
    // that this browser holds no working credential.
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Read the callback's marker out of a query string.
 *
 * Pure and separately tested, because the alternative is asserting against
 * `window.location` in a test and this is the part with the branches. Anything
 * that is not exactly `ok` or `failed` is `null` — an unrecognised value is not
 * a third outcome to render, it is a value we did not write.
 */
export function readSigninOutcome(search: string): SigninOutcome | null {
  const value = new URLSearchParams(search).get(OUTCOME_PARAM);
  if (value === 'ok') return 'ok';
  if (value === 'failed') return 'failed';
  return null;
}

/**
 * The same URL with the marker removed, preserving every other parameter.
 *
 * The marker has to go, and not for tidiness: it survives a refresh, a
 * bookmark and a shared link, so leaving it means the page re-announces a
 * sign-in that happened last week — or announces one to whoever was sent the
 * link. Returns a path-and-query string suitable for `history.replaceState`.
 */
export function withoutSigninOutcome(url: string, base: string): string {
  const parsed = new URL(url, base);
  parsed.searchParams.delete(OUTCOME_PARAM);
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query === '' ? '' : `?${query}`}${parsed.hash}`;
}
