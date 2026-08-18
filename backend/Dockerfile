# Multi-stage: the build stage carries a toolchain and the whole dependency
# tree; the runtime stage carries neither. What ships is the compiled output,
# production dependencies, and nothing that could compile more.
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies are installed from the lockfile before the sources are copied,
# so an edit to a source file does not invalidate the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# `npm ci --omit=dev` after the build rather than a second install: the same
# lockfile, minus everything only the compiler needed.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Node's default heap is sized for the machine, not the container. An explicit
# limit is what makes the process fail predictably rather than being OOM-killed
# by the kernel with no log line.
ENV NODE_OPTIONS="--max-old-space-size=384"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The migrations are .sql files the compiler does not emit, and the migration
# runner reads them from disk beside the compiled output.
COPY --from=build /app/src/storage/migrations ./dist/storage/migrations

# The spool holds plaintext message bodies. It is owned by the non-root user
# and created 0700 by the application; the volume behind it is where encryption
# at rest belongs (§2.1, D28).
RUN mkdir -p /var/lib/karobakbak/spool && chown -R node:node /var/lib/karobakbak

# Never root. A process that cannot write outside its own directories is a
# smaller problem when something else goes wrong.
USER node

EXPOSE 8080

# Liveness only — the process, not its dependencies. /ready is what the load
# balancer reads, and a Redis outage must not make Docker restart a process
# that is working correctly (§10.18).
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
