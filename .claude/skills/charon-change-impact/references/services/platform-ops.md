# Touches — leader election, nginx, backup, updater, capacity

Per-service touches. leaderElection's and certInfo/nginx's and the Maintenance-tab block's
Owns / Reads / Used by / Invariants moved verbatim from TOUCHES.md. Code references are
`path/file.ts → symbolName()` — grep the symbol.

## services/leaderElection.ts

**What it owns:** advisory-lock leadership + `charon_is_leader` metric.
**Public API:** `isLeader`, `startLeaderElection`, `stopLeaderElection`.
**Cross-service deps:** a dedicated long-lived `pg` client (NOT the Prisma pool); env
`CHARON_LEADER_LOCK_KEY`, `CHARON_LEADER_RETRY_MS`.
**Used by:** app.ts schedulers (`src/app.ts`), serverSettings `/ha`
(`src/api/routes/serverSettings.ts`), `/health`.
**Invariants:** only the leader runs schedulers/enforcement scheduling. A scheduler started
outside the `onAcquire` path is a split-brain bug (rule 5).
**When changing this:** see `cross-cutting/leader-and-roles.md`.

---

## services/nginxRenderer.ts

**What it owns:** rendering `deploy/nginx/charon.conf.template` (`{{TOKENS}}`) from settings.
**Public API:** `renderNginxConfig`; type `NginxSettings`.
**Cross-service deps:** the template; an `NginxSettings` object from the caller (server name,
web / endpoint upstream ports, cert / key paths) — it reads no Setting row itself.
**Used by:** `src/services/nginxApplyService.ts`.
**Invariants:** rendering is separate from applying so the UI can preview before touching the
live config.
**When changing this:** a new token → the template, the renderer and the settings that feed it.

---

## services/nginxApplyService.ts

**What it owns:** stage → validate → sudo-apply of the rendered nginx config.
**Public API:** `renderAndApply`; type `ApplyResult`.
**Cross-service deps:** `nginxRenderer`; `deploy/scripts/charon-nginx-apply.sh` via a scoped
sudoers rule.
**Used by:** `src/api/routes/serverSettings.ts` (certificates).
**Invariants:** apply validates with `nginx -t` and rolls back on failure. Best-effort in
dev/Docker: returns "skipped" instead of throwing.
**When changing this:** the wrapper script and the sudoers rule installed by
`deploy/install-rhel.sh` must agree on paths.

---

## services/backupService.ts

**What it owns:** database backup / restore (pg_dump → gzip → optional AES-256-GCM with a
scrypt key; reverse for restore), version-stamped filenames.
**Public API:** `listBackups`, `createBackup`, `restoreBackup`; type `BackupInfo`.
**Cross-service deps:** `pg_dump` / `psql` on PATH; `src/utils/paths.ts → BACKUP_DIR`;
`src/utils/version.ts`.
**Used by:** `src/api/routes/maintenance.ts`, `src/services/updateService.ts` (pre-update
backup).
**Invariants:** Maintenance-tab backend (see shared note below).
**When changing this:** the encrypted-backup header format is read by restore — change both.

---

## services/updateService.ts

**What it owns:** the in-app updater pipeline (backup → `git pull --ff-only` → `npm ci` →
`prisma generate` → build → migrate → restart), progress in `.update-status.json`.
**Public API:** `detectEnvironment`, `readStatus`, `checkForUpdate`, `startUpdate`; types
`UpdateStep`, `UpdateStatus`, `Environment`.
**Cross-service deps:** `backupService`; env `CHARON_UPDATE_REPO`.
**Used by:** `src/api/routes/maintenance.ts` (`/update/*`).
**Invariants:** updater self-updates ONLY from a git checkout outside Docker; restart targets the
whole `charon.target`.
**When changing this:** HA note: the updater requires a "this node is safe" confirm — follow
the standby-first order in `deploy/HA.md`.

---

## services/capacityService.ts

**What it owns:** per-volume free space with a severity pill, database size, a lightweight
Postgres tuning advisor.
**Public API:** `getCapacity`; types `Severity`, `VolumeUsage`, `CapacitySnapshot`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/api/routes/maintenance.ts` (`/capacity`).
**Invariants:** Maintenance-tab backend (see shared note below).
**When changing this:** TODO: populate when the sidebar critical alert consumes it.

---

**Shared Maintenance-tab note (verbatim, "backupService / updateService / capacityService /
agentDistService"):** Owns: Maintenance-tab backend. Invariants: updater self-updates ONLY from a
git checkout outside Docker; agent installers are served strictly from the manifest allowlist
(no path traversal); restart targets the whole `charon.target`. HA note: the updater requires a
"this node is safe" confirm — follow the standby-first order in `deploy/HA.md`.
