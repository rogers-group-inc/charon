# Touches — integrations, outbound HTTP, Fortinet and directory clients

Per-service touches. Owns / Reads / Used by / When-changing text for integrationService /
integrationConfig moved verbatim from TOUCHES.md. Code references are
`path/file.ts → symbolName()` — grep the symbol.

## services/integrationService.ts

**What it owns:** Integration CRUD, the testConnection/discover dispatchers, secret
encryption/masking (with integrationConfig).
**Public API:** `INTEGRATION_TYPES`, `isDirectorySource`, `listIntegrations`, `getIntegration`,
`createIntegration`, `updateIntegration`, `deleteIntegration`, `testIntegration`,
`preflightTest`, `discoverDirectory`, `runHealthChecks`; type `TestResult`.
**Cross-service deps:** Reads/writes Integration, DirectoryObject (discovery);
`integrationConfig`; the per-type clients below; `tagReconciler` after discovery;
`eventService → logEvent()`.
**Used by:** `src/api/routes/integrations.ts`, `src/jobs/integrationHealthCheck.ts`; the
per-type client modules import its `TestResult` type. Health-check job, enforcement (config),
tag pipeline (directory data).
**Invariants:** the route layer never special-cases a type.
**When changing this:** a new type → `INTEGRATION_TYPES` + dispatch switches + `SECRET_FIELDS`
+ the configure-modal field map in `integrations.js`.

---

## services/integrationConfig.ts

**What it owns:** secret handling for `Integration.config`: which fields are secrets per type
(`SECRET_FIELDS`), encrypt-on-write, mask-on-read, preserve-on-unchanged, decrypt-for-use.
**Public API:** `writeConfig`, `readConfigMasked`, `decryptConfig`; type `IntegrationType`.
**Cross-service deps:** `src/utils/crypto.ts → encryptSecret()` / `decryptSecret()` /
`isMaskedValue()`.
**Used by:** `src/services/integrationService.ts`, `src/services/fortinetEnforcementService.ts`.
**Invariants:** never return a plaintext secret from a GET; resubmitting the mask or empty keeps
the stored ciphertext (rule 3). Pinned by `tests/unit/integrationConfig.test.ts`.
**When changing this:** a new secret field → `SECRET_FIELDS`, and a unit case proving it is
encrypted, masked and preserved.

---

## services/httpClient.ts

**What it owns:** the shared outbound HTTP conventions for integrations — per-request timeout,
external-abort race, transient retry with backoff, per-call TLS-verify toggle via an undici
dispatcher.
**Public API:** `httpRequest`, `httpJson`; type `HttpOptions`.
**Cross-service deps:** none (undici).
**Used by:** `src/services/fortigateService.ts`, `src/services/fortimanagerService.ts`,
`src/services/entraIdService.ts`.
**Invariants:**
- Permanent faults (401/403/404/405) throw immediately; only transient faults (network, 5xx,
  timeout) retry.
- TLS verification is set per request, never via the process-global
  `NODE_TLS_REJECT_UNAUTHORIZED` — disabling it for one appliance must not weaken every other
  call. Verification defaults ON.
**When changing this:** every Fortinet / Graph call inherits the change; check all three users.

---

## services/fortimanagerService.ts

**What it owns:** the FortiManager JSON-RPC client (connection stereotype; enforcement target).
**Public API:** `testConnection`; type `FortiManagerConfig`.
**Cross-service deps:** `httpClient`.
**Used by:** `src/services/integrationService.ts` (dispatch).
**Invariants:** FMG-proxied calls are serialized (~1 concurrent) at scale; FMG enforce stays
dry-run (see fortinetEnforcementService).
**When changing this:** evaluate the same change for `fortigateService.ts` (paired surfaces).

---

## services/fortigateService.ts

**What it owns:** the direct FortiGate REST client (`/api/v2`, bearer API token, per-call TLS
toggle).
**Public API:** `fgGet`, `fgWrite`, `testConnection`; type `FortiGateConfig`.
**Cross-service deps:** `httpClient`.
**Used by:** `src/services/integrationService.ts` (dispatch),
`src/services/fortinetEnforcementService.ts` (CMDB reads/writes).
**Invariants:** direct-to-FortiGate calls run up to ~20 concurrent.
**When changing this:** evaluate the same change for `fortimanagerService.ts` (paired surfaces).

---

## services/activeDirectoryService.ts

**What it owns:** on-prem AD (LDAP) directory discovery — users / groups / OUs under the
configured base DN, normalized to `DiscoveredDirectoryObject`.
**Public API:** `testConnection`, `discover`; type `ActiveDirectoryConfig`.
**Cross-service deps:** `ldapClient`, `directoryTypes`.
**Used by:** `src/services/integrationService.ts` (dispatch).
**Invariants:** strictly read-only — Charon never writes to AD. Every filter value is RFC 4515
escaped (`ldapClient → escapeLdapFilterValue()`).
**When changing this:** TODO: populate when AD discovery gains incremental sync.

---

## services/ldapClient.ts

**What it owns:** the one ldapts TLS / bind / unbind code path and the LDAP filter-injection
escape.
**Public API:** `buildLdapUrl`, `newLdapClient`, `withBoundLdapClient`,
`escapeLdapFilterValue`, `decodeObjectGuid`, `formatLdapError`; type `LdapConnectionConfig`.
**Cross-service deps:** none (ldapts).
**Used by:** `src/services/activeDirectoryService.ts` (and any future LDAP operator login).
**Invariants:** exactly one place decides `rejectUnauthorized`, timeouts and the bind lifecycle;
every externally sourced value interpolated into a search filter passes through
`escapeLdapFilterValue`.
**When changing this:** a second LDAP consumer imports these helpers rather than opening its own
client.

---

## services/entraIdService.ts

**What it owns:** Entra ID + Intune via Microsoft Graph — client-credentials token cache per
(tenant, client), user/group discovery, Intune connection test.
**Public API:** `testConnectionEntra`, `testConnectionIntune`, `discoverEntra`; type
`EntraConfig`.
**Cross-service deps:** `httpClient`, `directoryTypes`.
**Used by:** `src/services/integrationService.ts` (dispatch).
**Invariants:** all reads are read-only. Entra group membership for `directory_group` sources
needs richer discovery than exists today (see tagService).
**When changing this:** TODO: populate when Intune posture reads are wired.

---

## services/directoryTypes.ts

**What it owns:** the shared `DiscoveredDirectoryObject` shape every directory source
normalizes to before persistence as DirectoryObject rows.
**Public API:** type `DiscoveredDirectoryObject`.
**Cross-service deps:** none.
**Used by:** `src/services/activeDirectoryService.ts`, `src/services/entraIdService.ts`,
`src/services/integrationService.ts`.
**Invariants:** `externalId` is stable per source (objectGUID hex / Entra object id / DN
fallback) — it is the DirectoryObject uniqueness key and the TagSource `ref`.
**When changing this:** a field added here needs the DirectoryObject column or `attributes` key
that persists it.
