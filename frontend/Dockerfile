FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

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

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
