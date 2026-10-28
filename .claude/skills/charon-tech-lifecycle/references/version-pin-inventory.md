# Version-pin inventory

## How to read this

Each family lists every site that declares its version. **Kind**: *pin* (what gets provisioned
or built), *floor* (the minimum that still runs), *prose* (a path or message that names the
version and must move with it). `npm run check:versions` asserts the pins agree with each other,
the floors agree with each other, and the floor never exceeds the pin. If you add a declaration
site, add it to `FAMILIES` in `scripts/check-versions.mjs`; the `## Family index` table at the
end of this file is the row set the script mirrors.

## Node.js

**Floor 22, pinned 24**, across 9 checked sites. The floor is set by dependencies, not taste:
`undici` 8 requires `>=22.19.0` and `pg-boss` 12 `>=22.12.0`.

| Site | Form | Kind |
|---|---|---|
| `package.json` | `engines.node` `">=22.19.0"` | floor |
| `package.json` | `@types/node` `"^22.20.5"` | floor |
| `Dockerfile` | `FROM node:24-trixie AS builder` | pin |
| `Dockerfile` | `FROM node:24-trixie-slim AS runtime` | pin |
| `Dockerfile.dev` | `FROM node:24-trixie` | pin |
| `.github/workflows/ci.yml` | `node-version: "24"` | pin |
| `.github/workflows/check-docs.yml` | `node-version: "24"` | pin |
| `deploy/install-rhel.sh` | `-lt 22` minimum check | floor |
| `deploy/install-rhel.sh` | NodeSource `setup_24.x` | pin |

Not checked, but moves with it: the installer's "Installing Node.js 24" log line, its header
comment and the floor comment above the check; the CLAUDE.md tech-stack row. `@types/node`
tracks the floor so code cannot type-check against an API the floor lacks.

## PostgreSQL

**Pinned 17**, across 7 checked sites. No floor is checked; the dataset's `charonMinimum` (15)
says what an existing install may still run.

| Site | Form | Kind |
|---|---|---|
| `compose.dev.yml` | `image: postgres:17-alpine` | pin |
| `compose.podman.yml` | `image: docker.io/library/postgres:17-alpine` | pin |
| `compose.setup.yml` | `image: docker.io/library/postgres:17-alpine` | pin |
| `deploy/install-rhel.sh` | `postgresql17-server` | pin |
| `deploy/install-rhel.sh` | `systemctl enable --now postgresql-17` | pin |
| `Dockerfile` | `postgresql-client-17` (runtime stage) | pin |
| `Dockerfile.dev` | `postgresql-client-17` | pin |

The client is named by major, never the unversioned `postgresql-client`: `pg_dump` refuses a
server newer than itself, and the metapackage silently follows the base image's Debian release.
Debian trixie carries 17; a major trixie lacks would need the PGDG apt repo in both Dockerfiles.

Not checked, but moves with it: `/var/lib/pgsql/17/data`, `/usr/pgsql-17/bin/postgresql-17-setup`
and the log line in the installer; the CLAUDE.md tech-stack row. **Not** pins: `deploy/setup-ha.sh`
and the teardown script `haEnrollmentService` generates resolve the host's major at run time
(`ls -d /usr/pgsql-*`), because the installer never upgrades PostgreSQL in place and a host
installed on 15 stays on 15. A major upgrade of an existing install is a dump/restore or
`pg_upgrade` — see upgrade-playbooks.md.

## OpenSSL (PQC transport)

**Pinned 3.5** (3.5.9), across 4 checked sites. 3.5 is the LTS line and the first with ML-KEM,
which the `X25519MLKEM768` hybrid KEX needs — it is a floor for security, not just a version.

| Site | Form | Kind |
|---|---|---|
| `deploy/nginx/Dockerfile.pqc` | `ARG OPENSSL_VERSION=3.5.9` | pin |
| `deploy/install-rhel.sh` | `openssl-3.5.9.tar.gz` | pin |
| `deploy/install-rhel.sh` | `/opt/openssl-3.5` prefix | prose |
| `deploy/nginx/Dockerfile.pqc` | `/opt/openssl-3.5` prefix | prose |

Not checked, but moves with it: the patch version is pinned with a SHA-256 in both files
(`ARG OPENSSL_SHA256`; the installer's `sha256sum -c` line), taken from the release's published
`.sha256`, and the installer's "older than 3.5.9 → rebuild /opt" comparison. `Dockerfile.pqc`
also pins `NGINX_VERSION` (stable line, 1.30.6) + `NGINX_SHA256` (computed from a tarball whose
PGP signature verified against the nginx.org keys) and its `debian:trixie-slim` base. A patch
bump moves version, hash and comparison together.

Both OpenSSL builds configure `-Wl,-rpath,/opt/openssl-3.5/lib64` and run `make install_sw
install_ssldirs`. Without the rpath `bin/openssl` loads the system `libcrypto.so.3` (RHEL's
3.0/3.2; trixie's own 3.5.x), so the installer's cert and X25519MLKEM768 checks test the wrong
library. Without `install_ssldirs` there is no `openssl.cnf` and `openssl req` fails.

## Rust (agent MSRV)

**Floor 1.77**, 1 checked site: `agent/src-tauri/Cargo.toml` `rust-version = "1.77"`. Rust
supports only the latest stable toolchain, so there is no EOL track; the MSRV moves when a
dependency demands it.

## Family index

| Family | Agree on | Floor → pin | Dataset id |
|---|---|---|---|
| `node-major` | major | 22 → 24 | `node` |
| `postgres-major` | major | — → 17 | `postgres` |
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
