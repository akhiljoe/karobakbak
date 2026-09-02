import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/ws` to the backend so the browser talks to one
 * origin in development, exactly as it does in the compose topology behind
 * nginx. That matters for more than convenience: the block token is an
 * HttpOnly `SameSite=Lax` cookie, and a cross-origin dev setup would drop it
 * on every connection and make blocking untestable locally.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/health': 'http://localhost:8080',
      '/ready': 'http://localhost:8080',
      // The four sign-in routes, for the same reason nginx.conf proxies them:
      // without this they fall through to the SPA and `/auth/session` answers
      // 200 with index.html, which reads as "permanently signed out" rather
      // than as a missing proxy. `/auth/start` 302s to another origin, so
      // following redirects here would defeat the point — the browser has to
      // land on the provider itself.
      '/auth': { target: 'http://localhost:8080', followRedirects: false },
    },
  },
  build: {
    outDir: 'dist',
    /*
      ---------------------------------------------------------------------
      NO SOURCE MAP IN THE BUILD THAT SHIPS
      ---------------------------------------------------------------------
      This was `true`, and nginx served the result: `/assets/index-*.js.map`
      answered **HTTP 200 with 1,246,040 bytes** to anyone who asked. That is
      the entire frontend source — component names, comments, the reasoning in
      them — readable by any visitor who opens devtools, plus 1.2 MB of egress
      every time somebody does and 1.2 MB of image nobody needs.

      A source map earns its place when something consumes it: an error
      reporter that symbolicates stack traces, or a developer with the same
      build open. Neither exists here — there is no error-reporting service,
      and a developer debugging this runs `npm run dev`, where Vite serves maps
      from memory and this setting is not consulted.

      So it buys nothing and costs the source. `'hidden'` was the other option
      — emit the map but strip the `//# sourceMappingURL` comment — and it is
      the wrong one for the same reason: the file would still sit in the image
      and still answer a request from anyone who guessed the name.
    */
    sourcemap: false,
  },
});
