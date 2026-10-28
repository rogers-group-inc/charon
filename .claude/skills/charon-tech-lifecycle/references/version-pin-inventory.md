# Version-pin inventory

## How to read this

Each family lists every site that declares its version. **Kind**: *pin* (what gets provisioned
or built), *floor* (the minimum that still runs), *prose* (a path or message that names the
version and must move with it). `npm run check:versions` asserts the pins agree with each other,
the floors agree with each other, and the floor never exceeds the pin. If you add a declaration
site, add it to `FAMILIES` in `scripts/check-versions.mjs`; the `## Family index` table at the
end of this file is the row set the script mirrors.

## Node.js

**Floor 20, pinned 20**, across 9 checked sites.

| Site | Form | Kind |
|---|---|---|
| `package.json` | `engines.node` `">=20.0.0"` | floor |
| `package.json` | `@types/node` `"^20.14.2"` | floor |
| `Dockerfile` | `FROM node:20-bookworm AS builder` | pin |
| `Dockerfile` | `FROM node:20-bookworm-slim AS runtime` | pin |
| `Dockerfile.dev` | `FROM node:20-bookworm` | pin |
| `.github/workflows/ci.yml` | `node-version: "20"` | pin |
| `.github/workflows/check-docs.yml` | `node-version: "20"` | pin |
| `deploy/install-rhel.sh` | `-lt 20` minimum check | floor |
| `deploy/install-rhel.sh` | NodeSource `setup_20.x` | pin |

Not checked, but moves with it: the installer's "Installing Node.js 20" log line and header
comment, and the CLAUDE.md tech-stack row.

## PostgreSQL

**Pinned 15**, across 5 checked sites.

| Site | Form | Kind |
|---|---|---|
| `compose.dev.yml` | `image: postgres:15-alpine` | pin |
| `compose.podman.yml` | `image: docker.io/library/postgres:15-alpine` | pin |
| `compose.setup.yml` | `image: docker.io/library/postgres:15-alpine` | pin |
| `deploy/install-rhel.sh` | `postgresql15-server` | pin |
| `deploy/install-rhel.sh` | `systemctl enable --now postgresql-15` | pin |

Not checked, but moves with it: `/var/lib/pgsql/15/data`, `/usr/pgsql-15/bin/postgresql-15-setup`
and the log line in the installer; `deploy/setup-ha.sh` and `deploy/HA.md` paths if they name a
major; the CLAUDE.md tech-stack row. A major upgrade of an existing install is a dump/restore or
`pg_upgrade` — see upgrade-playbooks.md.

## OpenSSL (PQC transport)

**Pinned 3.5**, across 4 checked sites. 3.5 is the first line with ML-KEM, which the
`X25519MLKEM768` hybrid KEX needs — it is a floor for security, not just a version.

| Site | Form | Kind |
|---|---|---|
| `deploy/nginx/Dockerfile.pqc` | `ARG OPENSSL_VERSION=3.5.0` | pin |
| `deploy/install-rhel.sh` | `openssl-3.5.0.tar.gz` | pin |
| `deploy/install-rhel.sh` | `/opt/openssl-3.5` prefix | prose |
| `deploy/nginx/Dockerfile.pqc` | `/opt/openssl-3.5` prefix | prose |

## Rust (agent MSRV)

**Floor 1.77**, 1 checked site: `agent/src-tauri/Cargo.toml` `rust-version = "1.77"`. Rust
supports only the latest stable toolchain, so there is no EOL track; the MSRV moves when a
dependency demands it.

## Family index

| Family | Agree on | Floor → pin | Dataset id |
|---|---|---|---|
| `node-major` | major | 20 → 20 | `node` |
| `postgres-major` | major | — → 15 | `postgres` |
| `openssl-minor` | major.minor | — → 3.5 | `openssl` |
| `rust-msrv` | major.minor | 1.77 → — | — |

## Things that are NOT pins

- `pg`, `prisma`, `express` and other npm dependency ranges — Dependabot's job
  (dependency-audit.md), except when a major is architectural (Prisma 7's driver-adapter model,
  Express 5's route syntax): those get a playbook entry before they move.
- GitHub Actions majors (`actions/checkout`, `actions/setup-node`, `github/codeql-action`,
  `docker/*`) — Dependabot's `github-actions` ecosystem. Move one action's major across every
  workflow at once (grep `uses:` in `.github/workflows/`), including workflows added after the
  Dependabot PR was opened.
- `agent/VERSION` and `package.json` `version` — the app's own versions, not the runtime's.
