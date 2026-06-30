# Charon application image — multi-stage.
#
# Builder compiles TypeScript + the Prisma client; the runtime stage ships only
# dist/ + production deps on a slim base with postgresql-client (pg_dump/psql
# for backups) and tini (PID 1 / signal forwarding). The Tauri/Rust toolchain
# is intentionally ABSENT — agent installers come from CI artifacts.
#
# PQC note: nginx (the TLS-terminating service in docker-compose) is where
# hybrid KEX is offered; that image needs OpenSSL 3.5+/oqs-provider (see
# deploy/nginx/Dockerfile.pqc). This app image's Node uses its bundled OpenSSL
# for OUTBOUND TLS (to FortiGate/Graph), hybrid where the peer supports it.

# ── Builder ───────────────────────────────────────────────────────────────────
FROM node:20-bookworm AS builder
WORKDIR /app

# Native build deps for @node-rs/argon2 fallback compile (prebuilt usually, but
# keep the toolchain so npm ci never fails on a missing binary).
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# DATABASE_URL is only needed for `prisma generate` to resolve the config; a
# dummy value is fine — no DB connection is made at generate time.
ENV DATABASE_URL=postgresql://charon:charon@localhost:5432/charon
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production CHARON_IN_DOCKER=1 CHARON_STATE_DIR=/app/state

RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Build arg → baked commit count so version.ts works without a .git dir.
ARG CHARON_BUILD_COMMIT_COUNT=0
ENV CHARON_BUILD_COMMIT_COUNT=${CHARON_BUILD_COMMIT_COUNT}

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY public ./public
COPY deploy ./deploy
COPY docker-entrypoint.sh ./

# State dirs (bind-mounted in compose); pre-create so first run doesn't race.
RUN mkdir -p /app/state/data/backups /app/state/data/agents /app/state/public/uploads /app/state/certs \
    && chmod +x docker-entrypoint.sh

EXPOSE 3000 3001
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
