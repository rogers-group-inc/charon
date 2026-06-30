# ARCHITECTURE.md — Charon

Deep reference, read on demand (not auto-loaded). For the elevator pitch, naming,
and cross-cutting rules see **CLAUDE.md**.

## Table of contents

1. Process model & boot path
2. File-by-file map
3. Prisma schema semantics
4. API endpoint catalogue
5. The tag pipeline (directory → tags → enforcement)
6. Fortinet enforcement architecture
7. Agent protocol
8. Integration discovery
9. pg-boss job registry
10. Frontend system
11. HA / leader election
12. Observability / metrics
13. Crypto & PQC

---

## 1. Process model & boot path

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

## 2. File-by-file map

**Entry/app:** `index.ts`, `app.ts`, `db.ts`, `jobs.ts`, `metrics.ts`.

**Middleware:** `auth.ts` (session + API bearer + agent bearer), `csrf.ts`
(synchronizer token, agent paths exempt), `permissions.ts` (dynamic-role
matrix), `rateLimits.ts` (login + enroll limiters + makeRateLimiter),
`errorHandler.ts`.

**Services (services/):**
- crypto/identity: `crypto.ts`, `password.ts`, `apiTokenService.ts`,
  `agentTokenService.ts`, `authService.ts`, `verificationService.ts`,
  `eventService.ts`.
- integrations: `httpClient.ts`, `integrationConfig.ts`, `integrationService.ts`
  (dispatcher), `fortimanagerService.ts`, `fortigateService.ts`,
  `activeDirectoryService.ts`, `ldapClient.ts`, `entraIdService.ts`,
  `directoryTypes.ts`.
- tags/enforcement: `customGroupService.ts`, `tagService.ts`,
  `tagReconciler.ts`, `policyService.ts`, `fortinetEnforcementService.ts`.
- agent/posture: `invitationCodeService.ts`, `agentEnrollmentService.ts`,
  `postureService.ts`, `certPinService.ts`.
- infra: `leaderElection.ts`, `certInfo.ts`, `nginxRenderer.ts`,
  `nginxApplyService.ts`, `backupService.ts`, `capacityService.ts`,
  `updateService.ts`, `agentDistService.ts`.

**Jobs (jobs/):** `integrationHealthCheck.ts`, `tagReconcileJob.ts`,
`enforcementSyncJob.ts`, `retentionPrune.ts`.

**Utils:** `role.ts`, `logger.ts`, `errors.ts`, `crypto.ts`, `password.ts`,
`version.ts`, `paths.ts`, `metricsServer.ts`.

## 3. Prisma schema semantics

- **Role.permissions** is a function-key → access-level JSON matrix.
  `isProtected` blocks delete/rename of built-ins.
- **User.passwordHash** is null for SSO-only operators. `ssoGroups` caches the
  last-seen IdP group keys for re-resolution. TOTP enrollment is "in progress"
  when `totpSecret` set but `totpEnabledAt` null.
- **Integration.config** is JSON; secret fields are AES-256-GCM envelopes (see
  `integrationConfig.SECRET_FIELDS`). `enforcementMode` defaults `dry_run`.
- **Endpoint** = device + agent enrollment. `bearerHash` is SHA-384 only.
  `serverCertFingerprint` + `additionalCertFingerprints` are the agent pins.
  `boundUserKey` is the verified directory identity (drives tag resolution).
  `posture` is the raw blob; `postureState` is the evaluated enum.
- **DirectoryObject** is a read-only mirror, unique on
  `(integrationId, kind, externalId)`. `attributes` feeds custom-group rules.
- **Tag** membership = union of **TagSource** rows + posture. **EndpointTag** is
  the materialized effective set (with `reasons`). **Policy** references a Tag.
- **EnforcementState** is the desired-vs-actual record per Charon-owned Fortinet
  object, unique on `(integrationId, objectType, objectName)`; `status` drives
  drift. ownerScope is implicitly "charon" (only `charon-*` objects exist here).
- **VerificationSession** is the short-lived `{user↔device↔IP}` binding.

## 4. API endpoint catalogue (under /api/v1)

Public (before requireAuth):
- `POST /auth/login`, `POST /auth/login/totp`, `POST /auth/logout`, `GET /auth/me`
- `GET /agent/auth-config` — server-dictated agent login mode
- `POST /agents/enroll` — invitation code → bearer + cert pins (rate-limited)
- `POST /agents/heartbeat|posture|login|logout`, `GET /agents/config` — agent bearer
- WS `GET /agents/ws` — telemetry (bearer in Sec-WebSocket-Protocol)

Authenticated (requirePermission gates per mount):
- `/endpoints` (+`/invitations`, `/:id`, `/:id/revoke`)
- `/integrations` (CRUD, `/:id/test`, `/test`, `/:id/discover`,
  `PATCH /:id/enforcement` [enforcement fullwrite], `/:id/enforcement-state`)
- `/directory`, `/groups` (+`/:id/members`), `/tags` (+`/:id/sources`,
  `/reconcile`), `/policies`
- `/server-settings` (`/certificates` + `/stage` + `/promote`, `/ha`,
  `/auth-mode`, `/identification`)
- `/server-settings/maintenance` (serverSettingsData): `/capacity`,
  `/backups` (+download/restore), `/update/{check,start,status}`, `/restart`,
  `/agents` (+download)
- `/events`

## 5. The tag pipeline

1. **Discover** (integrationService.discoverDirectory) writes DirectoryObject
   rows from AD/Entra (read-only).
2. **Define** Tags + TagSources (and CustomGroups) via the UI.
3. **Bind** a user to a device on agent login (verificationService) → sets
   `endpoint.boundUserKey`.
4. **Reconcile** (tagReconciler.reconcileEndpoint): `computeEffectiveTags()`
   resolves the endpoint's tags from facts (user memberOf / OU / custom-group
   membership / posture), diffs against EndpointTag, applies the delta, and
   enqueues `enforcementSync` on change.
5. **Enforce** (fortinetEnforcementService): renders the delta into FortiGate
   CMDB ops (dry-run unless the integration's enforce toggle is ON).

Triggers for reconcile: agent login/logout, posture change, directory sync, tag/
source edit (fleet-wide), manual `/tags/reconcile`.

## 6. Fortinet enforcement architecture

- One `charon-<tag>` dynamic address group per tag; one `charon-ep-<shortId>`
  address per endpoint (its current IP); membership = endpoint holds tag.
  Policies reference `charon-<tag>` groups.
- `applyEndpointDelta(endpointId, added, removed)` iterates enforcement-capable
  integrations. `dry_run` records EnforcementState (status `dry_run`) + Event +
  metrics, writes nothing. `enforce` (direct FortiGate) reads the charon-owned
  group's member set, applies the new set idempotently, records `in_sync`/`error`.
- **FMG enforce stays dry-run** for now (no half-applied policy package).
- Ownership invariant: only `charon-*` objects are created/edited.
- Concurrency/scale: direct-FortiGate ~20 concurrent; FMG-proxied serialized
  (~1). Retry/backoff + TLS-verify toggle in `httpClient.ts`.

## 7. Agent protocol

Enroll → `{ endpointId, bearerToken, serverCertPins }`. Thereafter the agent
sends heartbeat + posture (HTTP every 60s and/or over the telemetry WS), pinning
the server leaf cert. `GET /agents/config` returns current pins (for rotation) +
the active auth mode. User login (local) posts credentials → server binds
`{user↔device↔IP}` and reconciles. SAML/OIDC complete in the browser and bind
via the provider callback.

## 8. Integration discovery

`testConnection(config) → {ok,message,version?}` stereotype per type.
Directory sources (AD/Entra) also `discover() → DiscoveredDirectoryObject[]`,
upserted into DirectoryObject. A 10-minute health-check job re-tests every
enabled integration. FortiManager/FortiGate are enforcement targets (test only).

## 9. pg-boss job registry (`jobs.ts` QUEUES)

| Queue | Producer | Consumer | Payload |
|---|---|---|---|
| `charon.health-check` | leader (10 min) | worker | `{at}` |
| `charon.tag-reconcile` | login/posture/etc. | worker | `{endpointId}` |
| `charon.enforcement-sync` | reconciler | enforcer | `{endpointId, added, removed}` |
| `charon.directory-sync` | (reserved) | worker | — |
| `charon.posture-eval` | (reserved) | worker | — |

Leader-only interval producers also run in-process: health-check scheduler,
retention prune.

## 10. Frontend system

Vanilla, no build. `api.js` (CSRF-threaded fetch, 401→login), `app.js`
(`Charon.init()` → fetch `/auth/me` → render permission-gated sidebar → page
load; toast; theme), `table-sf.js` + `styles.css` (verbatim from polaris) +
`charon.css` (overlay). Pages: login, index (dashboard), endpoints, tags,
groups, integrations, server-settings (tabbed), events, setup.

## 11. HA / leader election

`leaderElection.ts` holds a dedicated pg client and calls
`pg_try_advisory_lock(key)`. Session-scoped, so it auto-frees on process death or
DB failover. Standby retries every `CHARON_LEADER_RETRY_MS` and acquires the lock
once free. `/health` reports `{ role, isLeader }` for the GSLB. See `deploy/HA.md`.

## 12. Observability / metrics

`metrics.ts` exposes a prom-client registry on `/metrics` (web/endpoint) or a
metrics-only server (enforcer/worker). Series: `charon_http_request_duration`,
`charon_http_in_flight`, `charon_endpoints_by_status`,
`charon_agent_ws_connections`, `charon_tag_reconcile_duration`,
`charon_enforcement_apply_total`, `charon_enforcement_drift`,
`charon_integration_test_total`, `charon_discovery_duration`, `charon_is_leader`,
`charon_pgboss_queue_jobs`, `charon_job_duration`/`_total`, `charon_process_role`.

## 13. Crypto & PQC

See CLAUDE.md "Cross-cutting rules" + `utils/crypto.ts`. At-rest envelope:
`c1.<alg>.<keyId>.<iv>.<tag>.<ct>` (AES-256-GCM). Transport hybrid KEX
(`X25519MLKEM768`) is negotiated by nginx/OpenSSL 3.5 and the agent's rustls
client. Token signing is designed crypto-agile (ML-DSA where supported, Ed25519
fallback with a recorded `alg`) — the current build stores opaque random tokens
hashed with SHA-384, leaving the signing path as the documented next step.
**Expert crypto review required before production.**
