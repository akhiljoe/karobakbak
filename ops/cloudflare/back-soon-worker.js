// karobakbak "back soon" — a Cloudflare Worker in front of karobakbak.com.
//
// Deployed by pasting this file into the Cloudflare dashboard (Workers, with
// a route on the site's hostname). This copy is the source of truth; the
// dashboard holds a copy of it.
//
// ---------------------------------------------------------------------------
// WHAT IT DOES
// ---------------------------------------------------------------------------
// Every request is passed to the origin unchanged, WebSocket upgrades included,
// and the origin's answer is returned unchanged. The ONE exception: the origin
// is unreachable (the host is down or the tunnel is disconnected) AND the
// request is a browser loading a page. Then, instead of Cloudflare's error 1033,
// the visitor gets the page below, which checks every 20 seconds and reloads
// itself when the site answers again.
//
// Everything else that fails — /ws, /ready, /api/*, /auth/*, assets — keeps the
// origin's real status. The app already reads those (a refused handshake asks
// /api/capacity, D64), and handing it an HTML page with a 503 would hide the
// answer it is built to interpret.
//
// ---------------------------------------------------------------------------
// WHAT IT MUST NOT DO
// ---------------------------------------------------------------------------
// * Load anything from anywhere else. The page is one self-contained response:
//   inline styles, inline SVG, no fonts, no scripts from a CDN. The site makes
//   no third-party requests from the browser, and an outage page is not an
//   exception to that.
// * Be cached. A cached "back soon" outlives the outage. `no-store`, always.
// * Claim anything. It does not say why the site is down or when it will be
//   back, because it does not know.

// The statuses Cloudflare produces when it cannot get an answer from the
// origin. 530 is what a Worker sees for error 1033 (tunnel not connected).
const ORIGIN_DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

export default {
  async fetch(request) {
    let response;
    try {
      // Same hostname from inside a route goes to the origin, not back into
      // this Worker.
      response = await fetch(request);
    } catch {
      return isPageLoad(request) ? backSoon() : unreachable();
    }
    if (ORIGIN_DOWN.has(response.status) && isPageLoad(request)) {
      return backSoon();
    }
    return response;
  },
};

// A browser navigating to a page: GET, asks for HTML, not a WebSocket.
function isPageLoad(request) {
  if (request.method !== 'GET') return false;
  if (request.headers.get('Upgrade')) return false;
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}

function unreachable() {
  return new Response('origin unreachable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30' },
  });
}

function backSoon() {
  return new Response(PAGE, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '30',
      // Nothing on this page needs anything but itself.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>karobakbak — back soon</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='11' fill='%2313100b'/%3E%3Cpath d='M17.2 15.5 A 11.9 11.9 0 0 1 17.2 32.5' stroke='%23ffb420' stroke-width='3.1' stroke-linecap='round' fill='none'/%3E%3Cpath d='M31.2 18.6 A 8.6 8.6 0 0 0 31.2 29.4' stroke='%23ffc94a' stroke-opacity='0.5' stroke-width='3.1' stroke-linecap='round' fill='none'/%3E%3Ccircle cx='25' cy='24' r='1.5' fill='%23ffb420'/%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #13100b; color: #eee6d6;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 24px 16px;
  }
  main { max-width: 420px; text-align: center; }
  svg { width: 72px; height: 72px; margin-bottom: 20px; }
  h1 { font-size: 26px; font-weight: 650; margin: 0 0 10px; letter-spacing: -0.01em; }
  p { margin: 0 0 8px; color: #b9ae9a; }
  .status { margin-top: 26px; font-size: 13px; color: #8a8070; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #ffb420;
         margin-right: 7px; vertical-align: 1px; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
</style>
</head>
<body>
<main>
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <rect width="48" height="48" rx="11" fill="#1d1912"/>
    <path d="M17.2 15.5 A 11.9 11.9 0 0 1 17.2 32.5" stroke="#ffb420" stroke-width="3.1" stroke-linecap="round" fill="none"/>
    <path d="M31.2 18.6 A 8.6 8.6 0 0 0 31.2 29.4" stroke="#ffc94a" stroke-opacity="0.5" stroke-width="3.1" stroke-linecap="round" fill="none"/>
    <circle cx="25" cy="24" r="1.5" fill="#ffb420"/>
  </svg>
  <h1>Back soon</h1>
  <p>karobakbak is offline for a little while.</p>
  <p>This page will reload by itself when it is back.</p>
  <div class="status" role="status"><span class="dot"></span><span id="s">Checking every 20 seconds</span></div>
</main>
<script>
  // Same-origin only (connect-src 'self'). /ready answers 200 when the site
  // is serving again; while it is down the Worker passes the error through.
  (function () {
    var s = document.getElementById('s');
    function check() {
      fetch('/ready', { cache: 'no-store' }).then(function (r) {
        if (r.ok) { s.textContent = 'Back - reloading'; location.reload(); }
      }).catch(function () {});
    }
    setInterval(check, 20000);
  })();
</script>
</body>
</html>`;
