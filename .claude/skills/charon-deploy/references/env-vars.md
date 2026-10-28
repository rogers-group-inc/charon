# Environment variables

Mirror of `.env.example` (the file an install reads). Keep both in step; `.env.example` wins on
a disagreement. Values shown are placeholders or defaults — never real secrets.

## Core

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required outside the wizard) | PostgreSQL connection string used by Prisma |
| `CHARON_DB_DIRECT_URL` | unset | session-level direct connection for pg-boss / pg_dump when a pooler (PgBouncer) fronts `DATABASE_URL` |
| `SESSION_SECRET` | — (required in production) | signs session cookies; long random value |
| `CHARON_DATA_KEY` | — (required in production) | 32-byte key (base64 or hex) encrypting every at-rest secret (AES-256-GCM). Back it up to Key Vault. Generate: `openssl rand -base64 32` |
| `HEALTH_TOKEN` / `METRICS_TOKEN` | unset (open) | bearer tokens gating `/health` and `/metrics` |
| `NODE_ENV` | `production` | |
| `LOG_LEVEL` | `info` | Pino level |
| `PORT` | `3000` | app listen port |
| `CHARON_BIND` | `127.0.0.1` | app listens localhost-only behind nginx |

## Multi-process role

| Variable | Default | Meaning |
|---|---|---|
| `CHARON_ROLE` | unset = `all` | `web` / `endpoint` / `enforcer` / `worker` / `migrate` |
| `CHARON_METRICS_PORT` | unset | enforcer/worker expose `/metrics` here (e.g. `9109`) |
| `CHARON_METRICS_BIND` | `127.0.0.1` | |
| `DATABASE_POOL_SIZE` | `25` | |
| `CHARON_PGBOSS_POOL_SIZE` | `10` | |

## High availability

| Variable | Default | Meaning |
|---|---|---|
| `CHARON_LEADER_LOCK_KEY` | built-in constant | advisory-lock key both nodes contend on; override only for test isolation |
| `CHARON_LEADER_RETRY_MS` | `10000` | standby retry interval |
| `CHARON_PUBLIC_URL` | unset | surfaced to the GSLB via `/health` |

## In-app updater

| Variable | Default | Meaning |
|---|---|---|
| `CHARON_UPDATE_REPO` | `origin` | git remote the updater pulls from |

## Build / seed / dev only

| Variable | Where | Meaning |
|---|---|---|
| `CHARON_BUILD_COMMIT_COUNT` | Docker build arg → image env | the version patch when no `.git` is present |
| `CHARON_SEED_ADMIN_USER` / `CHARON_SEED_ADMIN_PASSWORD` | seed | create the first administrator when both are set |
| `CHARON_DEV_PG_PORT` / `CHARON_DEV_APP_PORT` | `compose.dev.yml` | published host ports for a per-worktree dev stack |
