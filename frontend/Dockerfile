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
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_ADS_ENABLED=$VITE_ADS_ENABLED
ENV VITE_ADS_PROVIDER=$VITE_ADS_PROVIDER

RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

# Runs before nginx starts. `worker_connections` is in the main config's
# `events` block, which no site config can reach, and its stock 1024 caps this
# edge at roughly 512 concurrent conversations — a proxied WebSocket costs two
# connections. See the script for the full reasoning.
COPY tune-worker-connections.sh /docker-entrypoint.d/20-tune-worker-connections.sh
RUN chmod +x /docker-entrypoint.d/20-tune-worker-connections.sh

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
