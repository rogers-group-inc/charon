# Upgrade playbooks

Each playbook is an ordered list. Do the whole family in one worktree and one commit series, prove
it with `npm run check:versions`, and have a human review before merge.

## Node.js (major)

1. Read the new major's breaking changes for the dependencies that matter here: Prisma 7 +
   `@prisma/adapter-pg`, `pg-boss`, `@node-rs/argon2` (native), `undici`, Express 5.
2. Move every site in version-pin-inventory.md → Node.js, including the not-checked prose.
   Move the floor (`engines.node`, `@types/node`, the installer's `-lt N` check) in the same
   change unless a deliberate floor/pin gap is the point.
3. `rm -rf node_modules && npm ci`, `npx prisma generate`, `npm run typecheck`, the unit suite,
   and the suite against a real database.
4. Build the image (`podman build -f Dockerfile .`) and bring up `compose.podman.yml`.
5. Existing RHEL installs: the installer only installs Node when missing or below the floor —
   document the manual NodeSource switch for running hosts. TODO: populate with the tested
   steps the first time this runs.

## PostgreSQL (major)

1. Move every site in version-pin-inventory.md → PostgreSQL, including the installer's data-dir
   and binary paths.
2. Fresh installs pick it up directly. Existing installs need `pg_dump` / restore or
   `pg_upgrade`; in HA, upgrade the standby first per `deploy/HA.md`. TODO: populate with the
   tested runbook.
3. Backups taken by `backupService` use the server's `pg_dump`; the client in the image must be ≥
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
