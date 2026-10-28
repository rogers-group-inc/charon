## cross-cutting/deployment

**What it is:** the deployment artifacts and what must move together when one changes. A process
role is declared in four places; a runtime pin in more (`charon-tech-lifecycle`).

### Roles → units → compose services

| Role | `roleConfig()` flags (`src/utils/role.ts`) | systemd unit | compose service |
|---|---|---|---|
| `migrate` | one-shot `prisma migrate deploy` | `deploy/systemd/charon-migrate.service` | `migrate` |
| `web` | HTTP UI/API + leader-elected schedulers | `deploy/systemd/charon-web.service` (ExecStartPre re-renders + applies nginx) | `web` |
| `endpoint` | agent comms (HTTP + WS), nginx upstream | `deploy/systemd/charon-endpoint@.service` | `endpoint` |
| `enforcer` | enforcement-sync consumer | `deploy/systemd/charon-enforcer@.service` | `enforcer` |
| `worker` | health check, tag reconcile consumers | `deploy/systemd/charon-worker@.service` | `worker` |
| — | all of the above grouped | `deploy/systemd/charon.target` | — |

Every unit runs `node dist/index.js` with `Environment=CHARON_ROLE=<role>`. A new role or flag →
`role.ts` + its test, `src/app.ts`, a unit, a compose service, the installer's unit list, and
`charon-enforcement` → jobs-roles-ha.md.

### The container image

`Dockerfile` (multi-stage, `node:24-trixie` builder → `node:24-trixie-slim` runtime, with
`postgresql-client-17` named by major for backups) + `docker-entrypoint.sh` (loads `/app/state/.env` written by the
wizard). `.github/workflows/docker.yml` computes the commit count, bakes it as
`CHARON_BUILD_COMMIT_COUNT`, and pushes to GHCR (`ghcr.io/<org>/charon`).
`docker-compose.yml` runs the roles as services behind an `nginx` service
(`deploy/nginx/Dockerfile.pqc` builds the PQC-capable nginx).

### nginx

`deploy/nginx/charon.conf.template` (`{{TOKENS}}`) → `src/services/nginxRenderer.ts` →
`src/services/nginxApplyService.ts` stages it → `deploy/scripts/charon-nginx-apply.sh` (scoped
sudoers) runs `nginx -t`, reloads, or rolls back. TLS 1.3 with hybrid `X25519MLKEM768`;
HTTP/2 + HTTP/3. A new location or upstream → template + renderer tokens + the settings feeding
them.

Tokens: `{{SERVER_NAME}}`, `{{WEB_PORT}}`, `{{ENDPOINT_PORT}}`, `{{CERT_PATH}}`, `{{KEY_PATH}}`,
plus the proxy controls rendered from the `proxyConfig` Setting (Server Settings → Web Server →
nginx Proxy, `src/services/proxyConfigService.ts`): `{{HTTPS_PORT}}`, `{{SSL_PROTOCOLS_LIST}}`
(TLSv1.3 only — TLSv1.2 is refused, it cannot negotiate the hybrid group), `{{QUIC_LISTEN}}`,
`{{ALT_SVC_HEADER}}`, `{{HSTS_HEADER}}`, `{{METRICS_ALLOW}}`. A disabled control renders as a
comment line. `deploy/install-rhel.sh` substitutes the same tokens with defaults that match
`proxyConfigService.ts → defaultProxyConfig()` — change both together.

Locations beyond `/` and the endpoint upstream: `location = /metrics` (source-IP allow-list from
`{{METRICS_ALLOW}}`, empty = `deny all`; `METRICS_TOKEN` still gates the app) and
`location = /api/v1/server-settings/firmware/images` (`client_max_body_size 300m`,
`proxy_request_buffering off`, 600 s timeouts — the Repository upload; the server-wide limit
stays 12m).

The leaf certificate is rotated from Server Settings → Web Server
(`src/services/webServerService.ts → rotateCertAndKey()`): the new pair is written in place, the
live config re-staged through the same wrapper (`nginx -t` + reload, old pair restored on
failure). In Docker/dev (no wrapper) the pair is written and nginx must be reloaded by hand.

### RHEL 9.5

`deploy/install-rhel.sh` — idempotent single-node installer: Node 24, PostgreSQL 17 (PGDG; an
existing install keeps its major), nginx, a SHA-256-verified PQC OpenSSL 3.5 build under
`/opt/openssl-3.5` (hard requirement; rebuilt when older than the pinned patch), the `charon` system user +
`/opt/charon`, DB + least-privilege role, generated secrets + `.env` (including
`CHARON_DATA_KEY`), migrations + seed, the per-role units, nginx render, firewalld + SELinux.

It writes two scoped sudoers files: `/etc/sudoers.d/charon-nginx`
(`deploy/scripts/charon-nginx-apply.sh`) and `/etc/sudoers.d/charon-chrony`
(`deploy/scripts/charon-chrony-apply.sh`). The chrony wrapper (`apply <staged>` / `disable`)
installs `/etc/chrony.d/charon.sources` from Server Settings → Time & NTP
(`src/services/ntpService.ts → applyNtpToHost()`), re-validating every staged line as root (only
comments and `server <host> iburst [nts]`), backing up `chrony.conf` once to
`chrony.conf.charon-orig`, and restarting chronyd. Wrapper paths must agree across the script,
the sudoers line and `CHARON_NGINX_APPLY_SCRIPT` / `CHARON_CHRONY_APPLY_SCRIPT` (env-vars.md).

### Backups

`src/services/backupService.ts` streams `pg_dump` (client picked by server MAJOR,
`src/utils/pgClientTools.ts`; credentials via PG* env, never argv, `src/utils/pgEnv.ts`) to
`data/backups/` with owner-only modes (`src/utils/privateFiles.ts`), optionally AES-256-GCM
under a passphrase. A database backup covers the **database only**: firmware images
(`data/firmware/`), the uploaded logo (`public/uploads/`), the TLS key and `.env`
(`CHARON_DATA_KEY`) are files under the state dir and need a file-level backup. Device icons and
MIB files are in the DB and are covered. Scheduled backups (`src/jobs/scheduledBackup.ts`,
leader-only, default off) can copy each finished backup to an off-host directory.

### High availability

`deploy/setup-ha.sh` + `deploy/HA.md`: Postgres streaming replication across two sites, app
leader election via advisory lock, an external GSLB reading `/health`. Updates go standby first,
fail over, then update the new standby — the in-app updater requires a "this node is safe"
confirm.

`setup-ha.sh` flags: `--role primary|standby`, `--standby-ip` (primary), `--primary-ip`
(standby), `--repl-pass-file <file>` (non-interactive replication password, 16–128 alphanumeric —
it is interpolated into SQL; on the primary it is authoritative and ALTERs an existing role).
Addresses are validated (`[A-Za-z0-9._:-]`), the pg_hba mask is /128 for IPv6, and the standby
passes `PGPASSWORD` through `sudo --preserve-env` with `sslmode=require` in the conninfo.
Server Settings → High Availability drives it without hand-copied secrets: per-node bootstrap
scripts (`src/services/haEnrollmentService.ts → renderNodeScript()`) pin the server leaf
SHA-256, register at the public `POST /api/v1/ha/enroll` with a single-use token, wait for
operator approval, download their bundle once and run `setup-ha.sh --repl-pass-file …`
(business rule 9; `deploy/HA.md` → "Building the pair from the UI"). Container installs are not
covered.

### First-run wizard

`src/setup/` + `public/setup.html`: when `web`/`all` starts with no `DATABASE_URL`, the wizard
collects the DB connection as fields (host / port / user / password / database — inside a
compose network the host is the service name, not localhost) and the first admin, generates
`SESSION_SECRET` + `CHARON_DATA_KEY`, creates the target database if missing, writes `.env`
under the state dir, migrates and seeds — then **exits the process**. Something must restart
it (`restart: unless-stopped` in `compose.setup.yml`); a container with no restart policy just
stays down. The RHEL installer writes `.env` itself and never reaches the wizard. On restart the entrypoint
loads `/app/state/.env` and boots the full app; the wizard page polls `/health` and redirects
to login. It never overwrites a working config.

API (`src/setup/setupRoutes.ts`, unauthenticated, first-run only behind the `.setup-complete`
lock): `GET /status`, `POST /preflight` (disk-free advisories for the app, state and local
Postgres volumes), `POST /generate-secret`, `POST /test-connection` and `POST /finalize` — the
last two DB-touching routes are rate-limited by `setupActionLimiter` (15 min / 30) so a network
neighbour can't use them as a connect proxy or brute-force surface. `compose.setup.yml`
exercises the flow.

**When changing this:** run the deploy-surface audit in `SKILL.md`; a container-only change is
also checked against the RHEL path and vice versa — both are supported install shapes.
