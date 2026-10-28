# Boot path, roles, jobs, HA

Sections moved verbatim from ARCHITECTURE.md §§ 1, 9 and 11.

## Process model & boot path

`src/index.ts` resolves the process role (`getRole()`) and the setup state
(`getSetupState()`):

- **migrate** role → `prisma migrate deploy`, exit 0 (one-shot ordering anchor).
- **endpoint/enforcer/worker** require `DATABASE_URL` configured (no wizard).
- **needs-setup** (web/all, no DATABASE_URL) → first-run wizard (`setupServer`).
- otherwise → `app.ts startApp()`.

`app.ts` calls `roleConfig()` (capability flags) and branches:
- `runsSchedulers` (web/all) → `startLeaderElection()`; schedulers start only on
  `onAcquire` (leader) and stop on `onLose`.
- `runsWorkers` (worker/all) → register pg-boss consumers (health check, tag
  reconcile).
- `runsEnforcement` (enforcer/all) → register the enforcement-sync consumer.
- `runsHttp || runsAgentComms` → bind the localhost Express listener; agent-comms
  roles also attach the telemetry WebSocket upgrade handler.
- enforcer/worker (no public listener) → optional metrics-only server on
  `CHARON_METRICS_PORT`.

Graceful shutdown stops leader election + pg-boss on SIGTERM/SIGINT.

## pg-boss job registry (`jobs.ts` QUEUES)

| Queue | Producer | Consumer | Payload |
|---|---|---|---|
| `charon.health-check` | leader (10 min) | worker | `{at}` |
| `charon.tag-reconcile` | login/posture/etc. | worker | `{endpointId}` |
| `charon.enforcement-sync` | reconciler | enforcer | `{endpointId, added, removed}` |
| `charon.directory-sync` | leader scheduler (15 min, due by `pollInterval`) + the Discover button (`directoryDiscovery → triggerDiscovery()`) | worker (`src/jobs/directoryDiscoveryJob.ts → registerDirectoryDiscoveryConsumer()`) | `{integrationId, actor}` |
| `charon.posture-eval` | (reserved) | worker | — |

Leader-only interval producers also run in-process: health-check scheduler, the
directory-discovery scheduler + its stale-run reaper (60 s; fails a `DiscoveryRun` whose worker
heartbeat is > 3 min old), retention prune.

Worker and enforcer processes also start `fmgActivityService → startFmgActivityHeartbeat()`
(2 s): they hold the FortiManager worker lanes, so they snapshot lane state into the
`fmgActivitySnapshot` Setting for the web role's `/integrations/:id/fmg-activity`.

In-process leader-only jobs (no pg-boss queue; started in `app.ts → startSchedulers()`, stopped
in `stopSchedulers()`):

| Job | Cadence | What it does |
|---|---|---|
| `src/jobs/endpointSilenceJob.ts` | every 60 s | marks `online` endpoints silent for 2 heartbeat intervals `offline`; abstains while every agent is silent (Charon not receiving) |
| `src/jobs/retentionPrune.ts` | every 6 h | trims Events + expired/revoked VerificationSessions to the `sampleRetention` windows |
| `src/jobs/ouiRefresh.ts` | weekly (fetches on first run if missing / stale) | refreshes the IEEE OUI database (`ouiService.refreshOuiDatabase()`) |
| `src/jobs/scheduledBackup.ts` | 5-min tick (first tick after 2 min), runs when `isScheduledBackupDue()` | takes a scheduled backup, prunes old scheduled copies, optional off-host copy; default off |

## HA / leader election

`leaderElection.ts` holds a dedicated pg client and calls
`pg_try_advisory_lock(key)`. Session-scoped, so it auto-frees on process death or
DB failover. Standby retries every `CHARON_LEADER_RETRY_MS` and acquires the lock
once free. `/health` reports `{ role, isLeader }` for the GSLB. See `deploy/HA.md`.

### Operator sign-in state across nodes

Sessions live in Postgres (connect-pg-simple), so a signed-in session — and a
half-finished login (`pendingAuth`: second factor or forced password change owed) — survives
a failover and can finish on either node. Three pieces of sign-in state are process-local by
design and reset on restart or failover: the per-username login lockout
(`src/utils/loginLockout.ts`; each node counts separately), the SAML assertion replay cache
(`src/utils/samlReplayCache.ts`; an assertion also expires on its own NotOnOrAfter) and
in-flight passkey ceremonies (`src/utils/webauthnChallenge.ts`; a ceremony is one click,
and pre-auth rows in the session table would be an unauthenticated write surface). The GSLB
sends a sign-in to the active node start to finish, which is what these rely on.
