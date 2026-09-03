FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Every file the build reads. `tailwind.config.js` and `postcss.config.js` are
# not optional extras: without them PostCSS never runs, Tailwind emits no
# utilities at all, and the image ships a stylesheet containing only font
# declarations — a page that serves 200 and renders as unstyled HTML.
COPY tsconfig.json vite.config.ts index.html tailwind.config.js postcss.config.js ./
COPY src ./src
COPY public ./public

# Build-time values. Vite inlines them into the bundle, so they are public by
# construction — nothing secret may be passed this way.
ARG VITE_WS_URL=""
ARG VITE_ADS_ENABLED="false"
ARG VITE_ADS_PROVIDER="noop"
# Where the published Terms and Privacy Policy live. Empty is a launch blocker,
# not a default: the age gate links both, and a build without them shows a
# notice saying so rather than pretending nothing is missing.
ARG VITE_TERMS_URL=""
ARG VITE_PRIVACY_URL=""
# A Dockerfile only receives build args it declares. Compose passed these two
# for a whole build before anyone noticed the links were still missing from the
# bundle — there is no warning for an undeclared arg, it is simply dropped.
ARG VITE_CONTACT_EMAIL=""
ARG VITE_SUPPORT_URL=""

# Local testing only; empty in every real build. See the note in `src/config.ts`
# — a value here is inlined into the bundle and readable by anyone.
ARG VITE_DEV_ACCOUNT_CREDENTIAL=""

# Client-side timings. Empty means the value in `frontend/src/config.ts`, which
# is where every default lives — a default repeated here would be a second one,
# and the two would drift the first time either moved.
ARG VITE_TYPING_IDLE_MS=""
ARG VITE_RECONNECT_BACKOFF_MS=""
ARG VITE_MESSAGE_GROUPING_MS=""
ARG VITE_TOAST_VISIBLE_MS=""
ARG VITE_CAPACITY_PROBE_TIMEOUT_MS=""
ARG VITE_AUTOSEARCH_BACKOFF_MS=""
ARG VITE_CHECKOUT_LOAD_TIMEOUT_MS=""
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_ADS_ENABLED=$VITE_ADS_ENABLED
ENV VITE_ADS_PROVIDER=$VITE_ADS_PROVIDER
ENV VITE_TERMS_URL=$VITE_TERMS_URL
ENV VITE_PRIVACY_URL=$VITE_PRIVACY_URL
ENV VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL
ENV VITE_SUPPORT_URL=$VITE_SUPPORT_URL
ENV VITE_DEV_ACCOUNT_CREDENTIAL=$VITE_DEV_ACCOUNT_CREDENTIAL
# The ENV is what vite actually reads. An ARG alone is invisible to the build,
# which is the frontend's version of F-045 and the reason `verify-config`
# checks for both.
ENV VITE_TYPING_IDLE_MS=$VITE_TYPING_IDLE_MS
ENV VITE_RECONNECT_BACKOFF_MS=$VITE_RECONNECT_BACKOFF_MS
ENV VITE_MESSAGE_GROUPING_MS=$VITE_MESSAGE_GROUPING_MS
ENV VITE_TOAST_VISIBLE_MS=$VITE_TOAST_VISIBLE_MS
ENV VITE_CAPACITY_PROBE_TIMEOUT_MS=$VITE_CAPACITY_PROBE_TIMEOUT_MS
ENV VITE_AUTOSEARCH_BACKOFF_MS=$VITE_AUTOSEARCH_BACKOFF_MS
ENV VITE_CHECKOUT_LOAD_TIMEOUT_MS=$VITE_CHECKOUT_LOAD_TIMEOUT_MS

RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

# Runs before nginx starts. `worker_connections` is in the main config's
# `events` block, which no site config can reach, and its stock 1024 caps this
# edge at 512 people — 256 conversations, since a proxied WebSocket costs two
# connections and a conversation is two people. See the script for the full
# reasoning.
COPY tune-worker-connections.sh /docker-entrypoint.d/20-tune-worker-connections.sh
RUN chmod +x /docker-entrypoint.d/20-tune-worker-connections.sh

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
