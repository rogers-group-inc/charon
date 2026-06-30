# Charon — High Availability

Two data centers, active/standby. PostgreSQL streaming replication carries
state; the app layer elects ONE leader via a Postgres **advisory lock** so only
one node runs schedulers + Fortinet enforcement scheduling (no split-brain). A
GSLB steers clients to the active DC using each node's `/health`.

## Topology

```
        GSLB (health-checks /health on both nodes)
        │
   ┌────┴─────┐                         ┌──────────┐
   │  DC-A    │   PostgreSQL streaming  │  DC-B    │
   │ primary  │ ───── replication ────▶ │ standby  │
   │ (leader) │      (TLS 1.3, 5432)    │(follower)│
   └──────────┘                         └──────────┘
```

- **Postgres replication:** TCP 5432 between DCs, `hostssl` only (TLS 1.3;
  PQC-hybrid where the OpenSSL build supports `X25519MLKEM768`). A physical
  replication slot (`charon_standby`) prevents WAL removal while the standby is
  briefly down.
- **App health / GSLB:** HTTPS to each node; `/health` returns
  `{ status, role, isLeader }`. The GSLB sends traffic to the DC whose node
  reports `isLeader: true` (or simply to DC-A while it's healthy).
- **Leader election:** every `web` process calls `pg_try_advisory_lock` on the
  shared key (`CHARON_LEADER_LOCK_KEY`). The holder runs schedulers + enqueues
  enforcement; the connection-scoped lock auto-releases if that node dies or the
  DB fails over. The standby's `web` keeps retrying and acquires the lock once
  it's free — at which point it resumes schedulers and Fortinet sync.

## Normal operation

- DC-A Postgres is primary; DC-B streams. DC-A `web` holds the advisory lock →
  it is the leader and runs all schedulers + the enforcer's scheduling.
- DC-B `web` is up and serving read-mostly traffic but is NOT leader, so it does
  not double-run reconcilers or enforcement.

## Failover (promote DC-B)

1. **Promote Postgres in DC-B:** `pg_ctl promote -D <PGDATA>` (or let Patroni/
   repmgr do it). DC-B is now a read/write primary.
2. **Leadership transfers automatically:** when the old primary's DB connection
   drops, DC-A's advisory lock frees. DC-B's `web` wins the lock on its next
   retry (≤ `CHARON_LEADER_RETRY_MS`, default 10s), becomes leader, and resumes
   schedulers + Fortinet sync.
3. **GSLB steers to DC-B:** DC-B's `/health` now reports `isLeader: true`; the
   GSLB sends clients there.
4. Confirm: `curl -sk https://dc-b/health` → `isLeader:true`; check Events for
   "Acquired leadership"; verify tag/policy sync resumed.

## Failback / re-seed the old primary as a new standby

1. Bring the old DC-A Postgres back as a **standby** of DC-B:
   `sudo ./setup-ha.sh --role standby --primary-ip <DC-B-ip>` on DC-A.
2. Verify streaming (`pg_stat_replication` on DC-B).
3. When ready to return to DC-A as primary, schedule a maintenance window and
   repeat the promote/failover steps in the opposite direction.

## HA-aware updates (avoid split-brain during an upgrade)

The in-app updater gates "apply" behind an explicit "this node is safe to
update" confirmation. Safe order for a primary/standby pair:

1. **Update the STANDBY node first** (it's not leader). Verify it comes back
   healthy (`/health`, logs, version in the sidebar).
2. **Fail over** via GSLB so the just-updated node becomes active (promote its
   DB if you're also moving the primary).
3. **Update the now-standby (old primary).**

This guarantees the two nodes never run mismatched schema as the active leader.
The updater runs `prisma migrate deploy`; apply migrations on the node you
promote first, and keep migrations backward-compatible across one release so a
brief mixed-version window is safe.

## Automated failover (optional)

The `setup-ha.sh` script configures plain streaming replication that **Patroni**
or **repmgr** can manage for automatic promotion + fencing. Adopt one of those
for hands-off failover; Charon's app-layer leader election composes with either
(it only cares which DB is currently primary).
