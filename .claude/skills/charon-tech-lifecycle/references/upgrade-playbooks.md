# Upgrade playbooks

Each playbook is an ordered list. Do the whole family in one worktree and one commit series, prove
it with `npm run check:versions`, and have a human review before merge.

## Node.js (major)

1. Read the new major's breaking changes for the dependencies that matter here: Prisma 7 +
   `@prisma/adapter-pg`, `pg-boss`, `@node-rs/argon2` (native), `undici`, Express 5. Check
   each dependency's `engines.node`: it can set the floor (`undici` 8 → `>=22.19.0`, `pg-boss`
   12 → `>=22.12.0` set today's floor of 22). Moving the Debian base (`bookworm` → `trixie`) in
   the same change is fine; check that every apt package the Dockerfiles name still exists.
2. Move every site in version-pin-inventory.md → Node.js, including the not-checked prose.
   Move the floor (`engines.node`, `@types/node`, the installer's `-lt N` check) in the same
   change unless a deliberate floor/pin gap is the point.
3. `rm -rf node_modules && npm ci`, `npx prisma generate`, `npm run typecheck`, the unit suite,
   and the suite against a real database.
4. Build the image (`podman build -f Dockerfile .`) and bring up `compose.podman.yml`.
5. Existing RHEL installs: re-running the installer moves a host that is below the floor to the
   pin (it rewrites the NodeSource repo, then `dnf upgrade -y nodejs` — `dnf install` alone keeps
   an installed older package). A host at or above the floor is left alone; to move it to the pin
   by hand: `dnf -qy module disable nodejs; curl -fsSL https://rpm.nodesource.com/setup_24.x |
   bash -; dnf upgrade -y nodejs; systemctl restart charon.target`. TODO: confirm on a real RHEL
   host the first time a running install takes this path.

## PostgreSQL (major)

1. Move every site in version-pin-inventory.md → PostgreSQL, including the installer's data-dir
   and binary paths and the named `postgresql-client-N` in both Dockerfiles. `setup-ha.sh` and
   the generated HA teardown script detect the host's major and need no edit.
2. Fresh installs pick it up directly; the installer skips PostgreSQL when `psql` exists, so an
   existing host keeps its major. Moving one is `pg_dump` / restore or `pg_upgrade`; in HA, both
   nodes must end on the same major (streaming replication is same-major only) — rebuild the
   standby from the upgraded primary with `setup-ha.sh --role standby`. TODO: populate with the
   tested runbook.
3. Compose volumes: a data volume initialised by an older major will not start under the new
   image. The compose stacks are throwaway (`down -v`, re-seed); say so in each compose file.
4. Backups taken by `backupService` use the server's `pg_dump`; the client in the image must be ≥
   the server major.

## OpenSSL (minor)

1. Move the `ARG OPENSSL_VERSION` in `deploy/nginx/Dockerfile.pqc` and the tarball + `/opt`
   prefix in `deploy/install-rhel.sh` together.
2. Verify the hybrid group still negotiates:
   `openssl s_client -connect <host>:443 -groups X25519MLKEM768 -tls1_3`.
3. Any change to TLS needs a security-qualified reviewer (`CONTRIBUTING.md`).

## Rust MSRV

Raise `rust-version` in `agent/src-tauri/Cargo.toml` only when a dependency requires it; bump
`agent/VERSION`.
