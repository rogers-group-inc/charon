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
(`src/api/routes/serverSettings.ts`), `src/services/haService.ts` (HA tab status), `/health`.
**Invariants:** only the leader runs schedulers/enforcement scheduling. A scheduler started
outside the `onAcquire` path is a split-brain bug (rule 5).
**When changing this:** see `cross-cutting/leader-and-roles.md`.

---

## services/nginxRenderer.ts

**What it owns:** rendering `deploy/nginx/charon.conf.template` (`{{TOKENS}}`) from settings.
**Public API:** `renderNginxConfig`, `sha256Hex`; per-token renderers `renderSslProtocols`,
`renderQuicListen`, `renderAltSvcHeader`, `renderHstsHeader`, `renderMetricsAllow`; type
`NginxSettings`.
**Cross-service deps:** the template; an `NginxSettings` object from the caller (server name,
web / endpoint upstream ports, cert / key paths); the proxy-control tokens come from a
`ProxyConfig` (`src/services/proxyConfigService.ts`).
**Used by:** `src/services/nginxApplyService.ts`, `src/services/webServerService.ts` (render,
drift hash).
**Invariants:** rendering is separate from applying so the UI can preview before touching the
live config. `{{SSL_PROTOCOLS_LIST}}` only ever renders TLSv1.3 (validation refuses 1.2); a
disabled control renders as a comment line.
**When changing this:** a new token → the template, the renderer, `proxyConfigService` and the
`sed` defaults in `deploy/install-rhel.sh` (charon-deploy → cross-cutting-deployment.md).

---

## services/nginxApplyService.ts

**What it owns:** stage → validate → sudo-apply of the rendered nginx config.
**Public API:** `renderAndApply`, `applyNginxContents`, `isWrapperAvailable`,
`readLiveNginxConfig`, `LIVE_NGINX_CONF`; type `ApplyResult`.
**Cross-service deps:** `nginxRenderer`; `deploy/scripts/charon-nginx-apply.sh` via a scoped
sudoers rule (path overridable by `CHARON_NGINX_APPLY_SCRIPT`).
**Used by:** `src/services/webServerService.ts` (Save & Apply, cert rotation).
**Invariants:** apply validates with `nginx -t` and rolls back on failure. Best-effort in
dev/Docker: returns "skipped" instead of throwing.
**When changing this:** the wrapper script and the sudoers rule installed by
`deploy/install-rhel.sh` must agree on paths.

---

## services/backupService.ts

**What it owns:** database backup / restore (streamed pg_dump → gzip → optional AES-256-GCM
with a scrypt key, `BACKUP_MAGIC` header; reverse for restore), version-stamped filenames, the
`backup_history` Setting (newest last, capped at 50).
**Public API:** `listBackups`, `getBackupRecord`, `deleteBackup`, `backupFilePath`,
`createBackup`, `restoreBackup`, `resolvePgTool`, `getBackupToolingStatus`, `backupFilename`,
`encryptedBackupFormat`, `BACKUP_MAGIC`, `ENCRYPTED_HEADER_LEN`; types `BackupKind`,
`BackupRecord`, `CreateBackupInput`, `RestoreBackupInput`.
**Cross-service deps:** `src/utils/pgClientTools.ts` (client binary by server MAJOR),
`src/utils/pgEnv.ts` (credentials as PG* env, never argv), `src/utils/privateFiles.ts`
(owner-only modes), `src/utils/deploymentContext.ts`; `src/utils/paths.ts → BACKUP_DIR`;
`src/utils/version.ts`; `eventService`.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/database/*`),
`src/jobs/scheduledBackup.ts`, `src/services/updateService.ts` (pre-update backup).
**Invariants:** Maintenance-tab backend (see shared note below). The connection password never
reaches a command line; backup files are readable by the Charon account only. A backup covers
the database only — firmware images, the logo, TLS key and `.env` are not in it.
**When changing this:** the encrypted-backup header format is read by restore — change both;
`tests/unit/maint_pgClientTools.test.ts`, `maint_pgEnv.test.ts`, `maintenanceSettings.test.ts`.

---

## services/updateService.ts

**What it owns:** the in-app updater (Application Updates card, polaris state machine): git
installs pull + `npm ci` + build + migrate + restart; Docker installs are "image mode" (check
only — compares this image's `CHARON_BUILD_COMMIT_COUNT` with the published image's); progress
in `.update-status.json`; Settings `update.train` / `update.skip_backup`.
**Public API:** `getUpdateStatus`, `getUpdateActivity`, `initUpdateStatus`,
`clearUpdateStatus`, `checkForUpdates`, `checkImageForUpdates`, `applyUpdate`,
`restartService`, `getRecentCommits`, `getUpdateRepoInfo`, `get/setUpdateTrain`,
`get/setSkipBackup`, `isUpdateMechanismAvailable`, `isImageUpdateMode`, `detectHaPair`,
`isSafeGitRef`, `isSafeRepoUrl`, `DEFAULT_UPDATE_IMAGE`; types `UpdateStatus`, `UpdateTrain`.
**Cross-service deps:** `backupService`; `src/utils/imageRegistry.ts`,
`src/utils/deploymentContext.ts`; `eventService`; env `CHARON_UPDATE_REPO`,
`CHARON_UPDATE_IMAGE`.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/updates/*`, `/restart`).
**Invariants:** updater self-updates ONLY from a git checkout outside Docker; restart targets the
whole `charon.target`. Every git/npm call is `execFile` with an argv array; a dirty checkout is
refused, never reset; a failed pre-update backup is fatal unless the operator opted out.
**When changing this:** HA note: the updater requires a "this node is safe" confirm — follow
the standby-first order in `deploy/HA.md`.

---

## services/capacityService.ts

**What it owns:** the Database card's capacity snapshot — host stats, every distinct volume
Charon (and a co-located Postgres) writes to, database size + connection pool, Charon's
workload (endpoints, tags, policies, directory mirror, audit log), and graded `reasons`
(disk_*, pg_tuning_needed, max_connections_undersized, metrics/health_token_unset,
data_key_unset) with a worst-of severity.
**Public API:** `getCapacitySnapshot`, `computeReasons`, `worstSeverity`,
`projectSteadyStateBytes`, `prismaPoolSize`, `pgbossPoolSize`, `volumeLabel`; types `Severity`,
`CapacityReason`, `VolumeStat`, `CapacitySnapshot`, `SnapshotOptions`.
**Cross-service deps:** `dbSizeService`, `sampleRetentionService` (audit-log window for the
projection), `src/utils/deploymentContext.ts`, `src/utils/paths.ts`. The tuning check moved to
`pgTuningService` (its flag is passed in).
**Used by:** `src/api/routes/settings/maintenance.ts` (`/database`, `/capacity-advisor`).
**Invariants:** Maintenance-tab backend (see shared note below).
**When changing this:** a new reason → `computeReasons()` + the Maintenance tab's reason
renderer (`public/js/server-settings-maintenance.js`). TODO: populate when the sidebar critical
alert consumes it.

---

**Shared Maintenance-tab note (verbatim, "backupService / updateService / capacityService /
agentDistService"):** Owns: Maintenance-tab backend. Invariants: updater self-updates ONLY from a
git checkout outside Docker; agent installers are served strictly from the manifest allowlist
(no path traversal); restart targets the whole `charon.target`. HA note: the updater requires a
"this node is safe" confirm — follow the standby-first order in `deploy/HA.md`.
