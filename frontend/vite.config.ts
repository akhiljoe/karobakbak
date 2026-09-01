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
    sourcemap: true,
  },
});
