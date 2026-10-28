# Integration discovery

`testConnection(config) → {ok,message,version?}` stereotype per type. The clients are ported
from polaris (transport layer verbatim; polaris's Asset / Subnet / Reservation sync is not
carried). Directory sources (AD / Entra) also run discovery into the read-only DirectoryObject
mirror. FortiManager / FortiGate are enforcement targets (test only — no discovery run).

## Types

| Type | Role | Client |
|---|---|---|
| `fortimanager` | enforcement target (dry-run only today) | `src/services/fortimanagerService.ts` (JSON-RPC; `rpc()` retry; per-integration `fmgWorker.ts` lanes — `/sys/proxy/json` serialized at 1, native calls parallel; direct mode `useProxy: false` reaches each FortiGate with `fortigateApiToken`) |
| `fortigate` | enforcement target | `src/services/fortigateService.ts` (REST `/api/v2`; every call paced by `utils/fortiosRequestGate.ts` — ≤2 in flight per gate, doubling pause after a 401 so FortiOS 7.6's API-key lockout is never driven) |
| `activedirectory` | directory source | `src/services/activeDirectoryService.ts` (+ `ldapClient.ts`; PAGED searches — AD's 1000-entry page limit) |
| `entraid` | directory source; Intune is `config.enableIntune` | `src/services/entraIdService.ts` (Graph; host-pinned, 401/403 re-mint, 429 backoff via `utils/graphThrottle.ts`) |

There is no `intune` type (Intune is a flag on `entraid`, as in polaris) and no Azure Arc.
The authoritative list is `src/services/integrationService.ts → INTEGRATION_TYPES`. Adding a
type: `INTEGRATION_TYPES` + `integrationConfig.SECRET_FIELDS` + the
`discovery/directoryDiscovery.ts → runPreflightTest()` dispatch (and `readDirectory()` for a
directory source) + the type's config schema in `src/api/routes/integrations.ts →
CONFIG_SCHEMAS` / `CREATE_DEFAULTS` + the configure-modal form in `public/js/integrations.js`
(`charon-change-impact` → patterns/backend-patterns.md → Integration type).

## Config validation and secrets

Create AND update parse the config with the type's schema (`parseConfig`); unknown keys are
stripped on both paths. Host-bearing schemas refuse loopback / link-local / metadata /
multicast hosts (`utils/netGuard.ts`, SSRF). Secrets: `integrationConfig.writeConfig()`
encrypts; a masked / blank secret is reused ONLY while the destination is unchanged
(`utils/secretDestination.ts` — host, port, TLS mode, FMG's direct-mode leg); otherwise the
save is refused until the secret is re-entered. With TLS verification off, the leaf
certificate is trust-on-first-use pinned (`TlsCertPin`, via `utils/tlsDispatcher.ts`).

## What discovery mirrors

`src/services/discovery/directoryDiscovery.ts → runDiscovery()`:

| Source | users | groups | OUs | devices |
|---|---|---|---|---|
| Active Directory | `attributes.memberOf` = group DNs | DN in `identifier` | yes | computer objects (`kind: device`) |
| Entra ID | `attributes.memberOf` = transitive group object ids | id in `identifier` | — | Entra devices, + Intune compliance / serial / MAC with `enableIntune` |

A `directory_group` tag source's `ref` is what the user's `memberOf` holds: a group DN for AD,
a group object id for Entra (`tagService` compares them directly). Entra membership is read
group-wise (`/groups/{id}/transitiveMembers/microsoft.graph.user`, 4 groups concurrently).

## Run lifecycle

`triggerDiscovery()` validates, coalesces (a re-trigger while queued/running is a no-op),
upserts the `DiscoveryRun` row `queued` and publishes `charon.directory-sync` (or runs
in-process when pg-boss is down). The worker's `runDiscovery()`: preflight test → read →
chunked upserts (`persistObjects`, 500 per transaction) → guarded sweep → `completed`, then a
fleet-wide `reconcileAll()`. It polls `cancelRequested` every 3 s and heartbeats every 60 s.

**The sweep.** Objects a run no longer returns are deleted (a deleted user must lose the tags
their memberOf granted) — polaris's opt-in `decommissionMissing` is NOT carried; the sweep is
always on, behind `planSweep()`: refused on a partial read (cancelled, capped, a failed group
member read), on an empty read, and when more than max(50, 20%) of a kind would go. A refusal
keeps the rows and writes an `integration.discovery.sweep_skipped` warning Event.

## Scheduling and health

`src/jobs/directoryDiscoveryJob.ts` (leader): every 15 min enqueue each enabled, autoDiscover,
last-test-OK directory source due by `pollInterval` hours since `lastDiscoveryAt`; every 60 s
reap a run whose worker heartbeat is > 3 min old.

`src/jobs/integrationHealthCheck.ts`: the leader schedules a job every 10 minutes
(`scheduleHealthChecks()`); the worker consumes it (`registerHealthCheckConsumer()`) and runs
`integrationService → runHealthChecks()` — sequential (FMG drops parallel sessions), skipping
any integration with an active discovery run, stamping `lastTestAt` / `lastTestOk` and writing
`integration.test.recovered` / `integration.test.failed` Events on a state change.
