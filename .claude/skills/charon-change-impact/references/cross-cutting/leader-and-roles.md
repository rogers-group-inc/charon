## cross-cutting/leader-and-roles

**What it is:** which process runs what. `CHARON_ROLE` (`web` / `endpoint` / `enforcer` /
`worker` / `migrate`; unset = `all`) resolves to capability flags in
`src/utils/role.ts → roleConfig()`; leadership among `web` nodes is a Postgres advisory lock
(`src/services/leaderElection.ts`). Business rules 5 and 6.

**Writers** (code that decides what runs):
- `src/index.ts` — migrate role runs `prisma migrate deploy` and exits; endpoint / enforcer /
  worker require `DATABASE_URL`; web/all without it start the setup wizard.
- `src/app.ts → startSchedulers()` / `stopSchedulers()` — the leader-only in-process jobs:
  health-check scheduler, `retentionPrune`, `ouiRefresh`, `scheduledBackup`.
- `src/app.ts` — `runsSchedulers` → `startLeaderElection()`, schedulers start only in
  `onAcquire` and stop in `onLose`; `runsWorkers` → pg-boss consumers (health check, tag
  reconcile); `runsEnforcement` → the enforcement-sync consumer; `runsHttp || runsAgentComms` →
  the localhost Express listener (+ the agent WS upgrade on agent-comms roles);
  enforcer/worker → optional metrics-only server on `CHARON_METRICS_PORT`.

**Readers:**
- `/health` reports `{ role, isLeader }` for the GSLB; `GET /server-settings/ha`.
- `charon_is_leader`, `charon_process_role` metrics.

**Invariants:**
- Gate subsystems on `roleConfig()` booleans, never on the `CHARON_ROLE` string
  (`tests/unit/role.test.ts`).
- A scheduler or interval producer starts inside the leader `onAcquire` callback — never at
  module load (split-brain otherwise).
- Consumers register on their role and no-op gracefully when pg-boss is unavailable.
- The leader lock is session-scoped on a dedicated pg client, so it frees on process death or DB
  failover.

**When changing this:** a new periodic job → leader-only producer + role-gated consumer
(pattern: `references/patterns/backend-patterns.md` → Leader-gated scheduler); a new role flag →
`role.ts`, its test, `src/app.ts`, the systemd unit and the compose service for that role.
