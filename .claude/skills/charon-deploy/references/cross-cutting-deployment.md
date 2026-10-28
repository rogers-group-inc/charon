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

`Dockerfile` (multi-stage, `node:20-bookworm` builder → `node:20-bookworm-slim` runtime, with
`postgresql-client` for backups) + `docker-entrypoint.sh` (loads `/app/state/.env` written by the
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

### RHEL 9.5

`deploy/install-rhel.sh` — idempotent single-node installer: Node, PostgreSQL 15 (PGDG), nginx,
a PQC OpenSSL 3.5 build under `/opt/openssl-3.5` (hard requirement), the `charon` system user +
`/opt/charon`, DB + least-privilege role, generated secrets + `.env` (including
`CHARON_DATA_KEY`), migrations + seed, the per-role units, nginx render, firewalld + SELinux.

### High availability

`deploy/setup-ha.sh` + `deploy/HA.md`: Postgres streaming replication across two sites, app
leader election via advisory lock, an external GSLB reading `/health`. Updates go standby first,
fail over, then update the new standby — the in-app updater requires a "this node is safe"
confirm.

### First-run wizard

`src/setup/` + `public/setup.html`: when `web`/`all` starts with no `DATABASE_URL`, the wizard
collects the DB connection and first admin, generates `SESSION_SECRET` + `CHARON_DATA_KEY`,
writes `.env` under the state dir, migrates and seeds. `compose.setup.yml` exercises it.

**When changing this:** run the deploy-surface audit in `SKILL.md`; a container-only change is
also checked against the RHEL path and vice versa — both are supported install shapes.
