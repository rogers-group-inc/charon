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
| `CHARON_ADVISOR_PROCESS_COUNT` | unset → 1 when the role is `all`, else 4 | how many app processes open DB pools — the Capacity Advisor's `max_connections` sizing (`src/services/capacityAdvisorService.ts → estimateProcessCount()`) |

## State and container detection

| Variable | Default | Meaning |
|---|---|---|
| `CHARON_STATE_DIR` | unset → the project root | redirects all state (`.env`, `.setup-complete`, `data/backups/`, `data/agents/`, `data/firmware/`, `public/uploads/`) under one directory; the Docker image pins `/app/state` (`src/utils/paths.ts → STATE_DIR`). Also read as a container signal by `src/services/haService.ts → isContainer()` |
| `CHARON_IN_DOCKER` | unset (the Dockerfile sets `1`) | container signal for `src/utils/deploymentContext.ts → runtimeIsContainer()` (with `/.dockerenv`) — picks container help text and the image updater path |
| `KUBERNETES_SERVICE_HOST` | set by Kubernetes | same container signal, never set by hand |

## Privileged wrappers

| Variable | Default | Meaning |
|---|---|---|
| `CHARON_NGINX_APPLY_SCRIPT` | `/opt/charon/deploy/scripts/charon-nginx-apply.sh` | the sudo nginx apply wrapper (`src/services/nginxApplyService.ts`); must match the sudoers line `deploy/install-rhel.sh` writes |
| `CHARON_CHRONY_APPLY_SCRIPT` | `/opt/charon/deploy/scripts/charon-chrony-apply.sh` | the sudo chrony apply wrapper (`src/services/ntpService.ts`); must match its sudoers line |

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
| `CHARON_UPDATE_IMAGE` | `ghcr.io/rogers-group-inc/charon:latest` | container installs: the published image whose baked commit count the update check compares against `CHARON_BUILD_COMMIT_COUNT` (`src/services/updateService.ts → checkImageForUpdates()`, read via `src/utils/imageRegistry.ts`) |

## Build / seed / dev only

| Variable | Where | Meaning |
|---|---|---|
| `CHARON_BUILD_COMMIT_COUNT` | Docker build arg → image env | the version patch when no `.git` is present |
| `CHARON_SEED_ADMIN_USER` / `CHARON_SEED_ADMIN_PASSWORD` | seed | create the first administrator when both are set |
| `CHARON_DEV_PG_PORT` / `CHARON_DEV_APP_PORT` | `compose.dev.yml` | published host ports for a per-worktree dev stack |
