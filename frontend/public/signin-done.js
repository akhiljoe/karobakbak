/*
 * Report the outcome to the window that opened this one, then close.
 *
 * WHY THE OUTCOME IS NOT TRUSTED BY THE OPENER
 * What travels in the message is a hint, not a credential. The opener re-asks
 * `/auth/session` when it hears this, because the only thing that decides
 * whether somebody is signed in is the server holding a valid credential — and
 * a `postMessage` is something any script in any window could send. Treating
 * the message as proof would be a way to paint a signed-in header on a browser
 * that holds nothing.
 *
 * WHY THE TARGET ORIGIN IS EXPLICIT
 * `postMessage(data, '*')` would deliver to whatever ended up opening this,
 * including a page on another origin that popped it up. The outcome is not
 * secret, but naming the origin costs one expression and keeps the habit.
 *
 * WHY IT CLOSES ITSELF RATHER THAN BEING CLOSED
 * A window may only be closed by script that opened it, or by itself. The
 * opener also watches for this window closing, so a browser that refuses
 * `close()` still ends with the opener re-checking the session — this file
 * failing entirely costs a stranded window, never a broken sign-in.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var raw = params.get('signin');
  var outcome = raw === 'ok' || raw === 'failed' ? raw : 'failed';

  var status = document.getElementById('status');
  if (status) {
    status.textContent = outcome === 'ok' ? 'Signed in. Closing…' : 'Sign-in did not finish.';
  }

  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage({ source: 'karobakbak-signin', outcome: outcome }, window.location.origin);
    } catch (err) {
      // A cross-origin opener, or one severed by COOP. Nothing to do about it
      // here: the opener's fallback is to re-check the session when this window
      // closes, which happens either way.
    }
    window.close();
    return;
  }

  // Opened directly, or the opener is gone. Say so rather than showing a
  // permanent "Signing you in…" to somebody with nothing to go back to.
  if (status) {
    status.textContent = outcome === 'ok' ? 'You are signed in.' : 'Sign-in did not finish.';
  }
  var stranded = document.getElementById('stranded');
  if (stranded) stranded.hidden = false;
})();
