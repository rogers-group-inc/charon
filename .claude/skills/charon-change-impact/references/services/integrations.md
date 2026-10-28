# Touches — integrations, discovery, outbound HTTP, Fortinet and directory clients

Per-service touches. The four integration clients and the run-state / worker plumbing are
ported from polaris (transport verbatim; polaris's inventory sync not carried). Business-rule
numbers quoted in the ported files' comments are POLARIS rules. Code references are
`path/file.ts → symbolName()` — grep the symbol.

## services/integrationService.ts

**What it owns:** Integration CRUD, the persisted connection test, the preflight test of an
unsaved form, and the 10-minute health sweep.
**Public API:** `INTEGRATION_TYPES` (`fortimanager`, `fortigate`, `activedirectory`,
`entraid`), `isDirectorySource` (re-export), `listIntegrations`, `getIntegration`,
`getDecryptedIntegration` (server-side only — never returned), `createIntegration`,
`updateIntegration`, `deleteIntegration` (also drops the DiscoveryRun row), `testIntegration`,
`preflightTest`, `runHealthChecks`; type `TestResult`.
**Cross-service deps:** Prisma `Integration`, `DiscoveryRun`; `integrationConfig`;
`discovery/directoryDiscovery → runPreflightTest()` / `isDiscoveryRunning()`;
`eventService → logEvent()`; `recordIntegrationTest`.
**Used by:** `src/api/routes/integrations.ts`, `src/jobs/integrationHealthCheck.ts`.
**Invariants:** `runHealthChecks` is sequential (FMG drops parallel sessions) and skips any
integration with an active discovery run; it writes `integration.test.recovered` /
`integration.test.failed` only on an ok-state change. The route layer never special-cases a
type beyond its config schema.
**When changing this:** a new type → `INTEGRATION_TYPES` + `integrationConfig.SECRET_FIELDS` +
`runPreflightTest` dispatch (+ `readDirectory` for a directory source) + the route's
`CONFIG_SCHEMAS` / `CREATE_DEFAULTS` + the `integrations.js` form.

---

## services/integrationConfig.ts

**What it owns:** secret handling for `Integration.config`: which fields are secrets per type
(`SECRET_FIELDS` — FMG `apiToken` + `fortigateApiToken`, FGT `apiToken`, AD `bindPassword`,
Entra `clientSecret`), encrypt-on-write, mask-on-read, preserve-on-unchanged,
decrypt-for-use.
**Public API:** `SECRET_FIELDS`, `secretFieldsFor`, `writeConfig`, `readConfigMasked`,
`decryptConfig`; type `IntegrationType`.
**Cross-service deps:** `src/utils/crypto.ts → encryptSecret()` / `decryptSecret()` /
`isMaskedValue()`; `src/utils/secretDestination.ts → restoreStoredSecrets()`.
**Used by:** `integrationService`, `discovery/directoryDiscovery`,
`fortinetEnforcementService`.
**Invariants:** never return a plaintext secret from a GET; resubmitting the mask or empty keeps
the stored ciphertext (rule 3) — ONLY while the destination is unchanged: a moved host / port /
TLS mode / FMG direct-mode leg with a blank secret throws 400 (a stored token is never sent to a
new destination). Never polaris's `secretBox` (plaintext fallback without its key). Pinned by
`tests/unit/integrationConfig.test.ts`.
**When changing this:** a new secret field → `SECRET_FIELDS`, and a unit case proving it is
encrypted, masked, preserved, and refused on a moved destination.

---

## services/discovery/directoryDiscovery.ts

**What it owns:** the discovery run for directory sources — trigger, the worker's
`runDiscovery`, normalizing AD / Entra reads to `DiscoveredDirectoryObject`, the chunked mirror
write, the guarded removal sweep — and the per-type connection-test dispatch.
**Public API:** `DISCOVERABLE_TYPES`, `isDirectorySource`, `runPreflightTest`,
`triggerDiscovery`, `isDiscoveryRunning`, `runDiscovery`, `persistObjects`, `planSweep`,
`SWEEP_MAX_FRACTION`, `SWEEP_MIN_CAP`; types `DirectoryRead`, `SweepPlan`, `DirectoryKind`.
**Cross-service deps:** the four clients; `discoveryRunState`; `integrationConfig →
decryptConfig()`; `jobs.ts → publish(QUEUES.directorySync)`; Prisma `Integration`,
`DirectoryObject`; `tagReconciler → reconcileAll()` (dynamic import, after a run);
`recordDiscovery`; `eventService`.
**Used by:** `src/api/routes/integrations.ts` (Discover), `src/jobs/directoryDiscoveryJob.ts`
(scheduler + consumer), `integrationService`.
**Invariants:** read-only toward every directory. A re-trigger while queued/running is a no-op.
Upserts go in 500-row transactions. The sweep always runs but `planSweep` refuses a partial
read, an empty read, and removals above max(50, 20%) of a kind — refusals keep rows and write a
warning Event. Fortinet types have no discovery run.
**When changing this:** `tests/unit/directoryDiscoverySweep.test.ts`,
`tests/integration/directoryMirror.test.ts`; a new mirrored attribute → the tag pipeline that
reads it (`tagService`, `customGroupService`).

---

## services/discoveryRunState.ts

**What it owns:** the DB-backed live state of discovery runs (`DiscoveryRun`), verbatim from
polaris: queued upsert, started, throttled progress flush, worker heartbeat, terminal status,
cancel flag, stale-run reaping.
**Public API:** `upsertQueuedRun`, `markRunStarted`, `flushRunProgress`, `touchWorkerHeartbeat`,
`finishRun`, `isRunActive`, `anyRunActive`, `isCancelRequested`, `requestCancel`,
`listActiveRuns`, `persistSlowFlags`, `reapStaleRuns`, `newRunAccumulator`; types
`DiscoveryRunStatus`, `RunAccumulator`, `ActiveDeviceEntry`, `DiscoveryRunRow`.
**Cross-service deps:** Prisma `DiscoveryRun`.
**Used by:** `discovery/directoryDiscovery`, `src/api/routes/integrations.ts` (`/discoveries`,
cancel), `src/jobs/directoryDiscoveryJob.ts` (reaper).
**Invariants:** one row per integration (`integrationId` unique), reused across runs; progress
writes are best-effort and never fail a run; only the worker aborts — the web role only sets
`cancelRequested`.
**When changing this:** the reaper threshold (3 min) must stay above the worker heartbeat
(60 s) with margin.

---

## services/integrationHealthService.ts

**What it owns:** the sidebar's `GET /integrations/health-summary`: enabled integrations whose
last test failed (+ polaris's FMG proxy advisory shape, always empty — Charon keeps no
managed-gate inventory to count).
**Public API:** `getIntegrationHealthSummary`, `selectProxyAdvice`,
`integrationIsFmgProxyMode`, `FMG_PROXY_GATE_ADVISORY_THRESHOLD`.
**Cross-service deps:** Prisma `Integration`.
**Used by:** `src/api/routes/integrations.ts`.
**Invariants:** id / name / type / lastTestAt only — never config.
**When changing this:** `tests/unit/integrationHealthService.test.ts`.

---

## services/httpClient.ts

**What it owns:** plain outbound HTTP (timeout, transient retry, per-call TLS-verify toggle) for
PUBLIC downloads — today only the IEEE OUI list. The integrations moved to
`src/utils/tlsDispatcher.ts → tlsFetch()`.
**Public API:** `httpRequest`, `httpJson`; type `HttpOptions`.
**Cross-service deps:** undici's own `fetch` (never Node's global — a dispatcher is only valid to
the undici copy that created it); `utils/tlsDispatcher.ts → verifyingTlsDispatcher()` (system
roots + operator-uploaded trusted CAs).
**Used by:** `src/services/ouiService.ts`.
**Invariants:** permanent faults (401/403/404/405) throw immediately; transient faults retry.
TLS verification is per request, never via `NODE_TLS_REJECT_UNAUTHORIZED`; default ON.
**When changing this:** a new caller that carries a secret belongs on `tlsFetch` (TLS pinning
when unverified), not here.

---

## services/fortimanagerService.ts

**What it owns:** the FortiManager JSON-RPC client (polaris connection layer): bearer API-key
auth (no login/logout — the key's session is shared), `rpc()` with retry, the per-integration
`fmgWorker` lanes, management-IP resolution, the direct-mode random-gate test, the API
console's `proxyQuery` / `proxyQueryViaFortigate` / `fmgProxyRest`, central-management
detection, and the device roster.
**Public API:** `testConnection`, `testRandomFortiGate`, `resolveDeviceMgmtIpViaFmg`,
`proxyQuery`, `proxyQueryViaFortigate`, `fmgProxyRest`, `detectCentralManagement`,
`decodeCentralManagementFlags`, `extractRosterIdentities`, `extractRosterConnectivity`,
`fetchRosterConnectivity`, `buildFmgOsVersion`, `fmgNameKey`; type `FortiManagerConfig`.
**Cross-service deps:** `utils/tlsDispatcher → tlsFetch()`, `fmgWorker`, `fortigateService`
(direct mode), `utils/integrationFilter`.
**Used by:** `discovery/directoryDiscovery → runPreflightTest()`, the integrations route
(console, fortigate-sample).
**Invariants:** `/sys/proxy/json` calls are serialized per integration (the proxy lane); native
calls are not. FMG enforce stays dry-run (see fortinetEnforcementService).
**When changing this:** evaluate the same change for `fortigateService.ts` (paired surfaces);
`tests/unit/fmgRpcRetry.test.ts`, `fmgWorker.test.ts`, `decodeCentralManagementFlags.test.ts`.

---

## services/fmgWorker.ts

**What it owns:** one worker per FortiManager integration with two lanes — PROXY (strict
concurrency 1, every `/sys/proxy/json` call) and NATIVE (unbounded) — plus the lane gauges.
**Public API:** `getFmgWorker`, `getAllFmgWorkers`; type `FmgLaneState`.
**Cross-service deps:** `metrics.ts → setFmgWorkerQueueDepth / setFmgWorkerInflight /
setFmgWorkerNativeInflight` (`charon_fmg_worker_*`).
**Used by:** `fortimanagerService → rpc()`, `fmgActivityService`.
**Invariants:** process-local; the proxy lane never runs two calls at once.
**When changing this:** `tests/unit/fmgWorker.test.ts`.

---

## services/fmgActivityService.ts

**What it owns:** a 2-second snapshot of every FmgWorker's lane state into the
`fmgActivitySnapshot` Setting, and the web role's read of it (stale after 10 s).
**Public API:** `startFmgActivityHeartbeat`, `getFmgActivityForIntegration`, `STALENESS_MS`;
types `FmgActivitySnapshot`, `FmgActivityReadout`.
**Cross-service deps:** `fmgWorker`, Prisma `Setting`, `utils/role → getRole()`.
**Used by:** `src/app.ts → startConsumers()` (worker / enforcer processes start the
heartbeat), `GET /integrations/:id/fmg-activity`.
**Invariants:** the web role never holds worker instances — it reads the snapshot only.

---

## services/fortigateService.ts

**What it owns:** the direct FortiGate REST client (polaris transport verbatim): every call
through `fgRequest`, paced per gate by `utils/fortiosRequestGate.ts`; 401/403/404 mapped to
distinct errors; FortiOS CLI error detail surfaced; `fgGet` / `fgWrite` for enforcement.
**Public API:** `testConnection`, `fgRequest`, `fgGet`, `fgWrite`, `proxyQuery`,
`describeFgTransportError`, `FortiosAuthPausedError`; types `FortiGateConfig`,
`FgRequestOptions`.
**Cross-service deps:** `utils/tlsDispatcher → tlsFetch()`, `utils/fortiosRequestGate`,
`utils/fortiosEnvelope`, `utils/cidr → urlHost()`.
**Used by:** `fortinetEnforcementService` (CMDB reads / writes), `fortimanagerService` (direct
mode), `discovery/directoryDiscovery → runPreflightTest()`, the integrations route (console).
**Invariants:** ≤ 2 requests in flight per gate (`CHARON_FORTIOS_PER_GATE_CONCURRENCY`); after a
401 nothing is sent to that gate for a pause that doubles per consecutive 401; a 404 is
`AppError(404)` — the only error enforcement may read as "absent".
**When changing this:** evaluate the same change for `fortimanagerService.ts` (paired
surfaces); `tests/unit/fortiosRequestGate.test.ts`, `tests/unit/fortinetEnforcement.test.ts`.

---

## services/activeDirectoryService.ts

**What it owns:** on-prem AD (LDAP): connection test, the read-only API console, computer
discovery (`discoverDevices`, polaris verbatim — paged, 10 000 cap, sweep completeness) and
users / groups / OUs (`discoverDirectory`, Charon — paged, 50 000 per kind).
**Public API:** `testConnection`, `proxyQuery`, `discoverDevices`, `adSweepBlockedReason`,
`discoverDirectory`, `DIRECTORY_HARD_CAP`; types `ActiveDirectoryConfig`,
`DiscoveredAdDevice`, `AdDiscoveryResult`, `AdDirectoryResult`.
**Cross-service deps:** `ldapClient`, `utils/integrationFilter`, `directoryTypes`.
**Used by:** `discovery/directoryDiscovery`, the integrations route (console).
**Invariants:** strictly read-only — Charon never writes to AD. Every search is PAGED (AD's
default MaxPageSize is 1000; an unpaged search silently truncates). A capped or cancelled read
reports `complete: false`.
**When changing this:** a new mirrored attribute → `USER_ATTRIBUTES` / `GROUP_ATTRIBUTES` and
the tag-pipeline reader.

---

## services/ldapClient.ts

**What it owns:** the one ldapts TLS / bind / unbind code path and the LDAP filter-injection
escape (polaris verbatim).
**Public API:** `buildLdapUrl`, `newLdapClient`, `withBoundLdapClient`,
`escapeLdapFilterValue`, `decodeObjectGuid`, `formatLdapError`; type `LdapConnectionConfig`.
**Cross-service deps:** none (ldapts).
**Used by:** `src/services/activeDirectoryService.ts` (and any future LDAP operator login).
**Invariants:** exactly one place decides `rejectUnauthorized`, timeouts and the bind lifecycle;
every externally sourced value interpolated into a search filter passes through
`escapeLdapFilterValue`. LDAP with `verifyTls` off is NOT certificate-pinned (TlsCertPin covers
HTTPS only) — a known gap for human review.
**When changing this:** `tests/unit/ldapClient.test.ts`.

---

## services/entraIdService.ts

**What it owns:** Entra ID + Intune via Microsoft Graph: client-credentials token cache per
(tenant, client), the host-pinned Graph transport (401 / 403 re-mint, 429 backoff), paging,
device + Intune discovery with the Ethernet-MAC `$batch` (polaris verbatim), users / groups +
transitive membership (`discoverDirectory`, Charon), the read-only API console, and
`graphApiRequest` (write verbs, for Intune script publishing).
**Public API:** `testConnection`, `discoverDirectory`, `discoverDevices`,
`entraSweepBlockedReason`, `planEthernetMacFetch`, `proxyQuery`, `graphApiRequest`,
`GRAPH_HOST`, `DIRECTORY_HARD_CAP`; types `EntraIdConfig`, `DiscoveredEntraDevice`,
`EntraDiscoveryResult`, `EntraDirectoryResult`, `KnownEthernetMac`, `GraphRequestOptions`.
**Cross-service deps:** `utils/entraClientCredentials`, `utils/graphThrottle`, `utils/mac`,
`utils/integrationFilter`, `directoryTypes`.
**Used by:** `discovery/directoryDiscovery`, the integrations route (console).
**Invariants:** every Graph URL is asserted to be `graph.microsoft.com`; reads are read-only.
Intune is `config.enableIntune`, not a type. Membership is read group-wise; a failed group read
marks the directory read incomplete (the sweep then refuses).
**When changing this:** a new Graph read → its application permission in the Entra form's help
text and `testConnection`'s probe; `tests/unit/entraEthernetMac.test.ts`,
`entraClientCredentials.test.ts`.

---

## services/directoryTypes.ts

**What it owns:** the shared `DiscoveredDirectoryObject` shape every directory source
normalizes to before persistence as DirectoryObject rows.
**Public API:** type `DiscoveredDirectoryObject` (`kind`: user | group | ou | device).
**Cross-service deps:** none.
**Used by:** `activeDirectoryService`, `entraIdService`, `discovery/directoryDiscovery`.
**Invariants:** `externalId` is stable per source (objectGUID hex / Entra object id / Entra
deviceId) — it is the DirectoryObject uniqueness key.
**When changing this:** a field added here needs the DirectoryObject column or `attributes` key
that persists it.

---

## services/sshHostKeyService.ts

**What it owns:** the `SshHostKey` trust-on-first-use store (ported from polaris): the first
SSH connection to host:port pins the server's host-key fingerprint; a later different key is
refused before authentication.
**Public API:** `verifyOrPin`, `fingerprintKeyBlob`, `keyTypeFromBlob`, `listHostKeys`,
`listHostKeysWithEndpoints`, `deleteHostKey`, `forgetCachedHostKey`, `_resetCaches`; types
`SshHostKeyRecord`, `HostKeyVerdict`.
**Cross-service deps:** Prisma `SshHostKey`, `Endpoint` (display join only);
`eventService → logEvent()`.
**Used by:** `src/utils/remoteExec.ts → buildHostVerifier()` (dynamic import) — every
`ssh2.connect` in the tree: `credentials/credentialProbeService` today, agent push install
next.
**Invariants:** fail CLOSED — an internal error rejects the handshake, never accepts it; a
mismatch writes a warning Event with both fingerprints; deleting a pin re-opens first-use trust
and is audited; a pin is keyed by the address dialed, never by an Endpoint FK. TOFU detects a
key CHANGING, not a host already impersonated when first pinned.
**When changing this:** keep `tlsCertPinService` the same shape (they render together as
"Pinned server identities"); `tests/unit/sshHostKey.test.ts`.

---

## services/tlsCertPinService.ts

**What it owns:** the `TlsCertPin` trust-on-first-use store for HTTPS connections that carry a
secret WITHOUT verifying a CA chain (integration `verifySsl` off, WinRM, credential probes),
including the pending-certificate re-trust flow.
**Public API:** `verifyOrPinCert`, `normalizeFingerprint`, `listCertPins`,
`listCertPinsWithUsers`, `pinsForEndpoints`, `changedCertPins`, `trustPendingCert`,
`allowRepin`, `deleteCertPin`, `forgetCachedCertPin`, `_resetCaches`; types
`TlsCertPinRecord`, `CertPinVerdict`, `CertPinUser`.
**Cross-service deps:** Prisma `TlsCertPin`, `Endpoint` + `Integration` (display join, id /
name / address columns only — never config secrets); `eventService → logEvent()`.
**Used by:** `src/utils/pinnedTlsAgent.ts → pinnedAgentFor()` and
`src/utils/tlsDispatcher.ts → pinnedTlsDispatcher()` (dynamic imports) — credential probes,
WinRM, and every integration request with TLS verification off.
**Invariants:** the decision happens after the handshake and BEFORE the request carrying the
secret is written; a changed certificate is remembered as `pendingFingerprint` and trusted only
when an administrator confirms that exact fingerprint (`trustPendingCert`); one mismatch Event
per NEW certificate; a CA-verified connection is never pinned.
**When changing this:** `tests/integration/tlsCertPin.test.ts`,
`tests/integration/tlsPinnedDispatcher.test.ts` (need a `*_test` DB).
