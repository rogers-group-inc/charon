# Touches — Server Settings tab backends (ported from polaris)

Per-service touches for the services behind the Server Settings page
(`src/api/routes/settings/*.ts`). Most are single-`Setting`-row stores; the shared shape is
"parse / merge / validate a JSON blob, save it, log an Event from the route". Charon has **no
asset inventory**: anything polaris counts or rewrites on Asset rows reports zero here, and
several settings are **persist-only** (stored so the tab works, no consumer yet) — each entry
says so. Code references are `path/file.ts → symbolName()` — grep the symbol.

Setting keys and their writers/readers: `charon-domain-model` → platform.md. Models:
`charon-domain-model` → server-settings.md. Routes and gates: `charon-api-rbac` → endpoints.md.

## Web Server tab

## services/webServerService.ts

**What it owns:** the served HTTPS certificate (facts, drift), the managed nginx config apply,
and the zero-downtime certificate rotation that keeps every agent's pin valid.
**Public API:** `getHttpsInfo`, `getServedCertFingerprint`, `getDriftStatus`,
`applyProxyConfig`, `validateCertKeyPair`, `preflightCertRotation`, `rotateCertAndKey`,
`certFacts`, `parseLiveCertPaths`; types `CertFacts`, `DriftStatus`, `ApplyResult`,
`RotateResult`.
**Cross-service deps:** `proxyConfigService`, `nginxRenderer`, `nginxApplyService`,
`certPinService → getPinStore()` / `swapCanonicalPin()`; Setting `cert.leaf`; cert/key paths
from `cert.leaf`, else the live nginx `ssl_certificate` lines, else `STATE_DIR/certs`.
**Used by:** `src/api/routes/settings/webServer.ts` (`/https`, `/proxy*`, `/proxy/cert/*`,
`/agents/cert-pins/bulk-remove` → `getServedCertFingerprint`).
**Invariants:** rules 4 / 4a — `rotateCertAndKey` refuses (409) a pin that is neither canonical
nor staged (only the very first cert is exempt) and leaves the old pin accepted; the served
cert's pin can never be retired. The private key stays on disk (0600), never in the DB. A failed
`nginx -t` restores the previous pair. `applyProxyConfig` needs the wrapper (503 otherwise) and
managed mode (409 in adopt-required mode).
**When changing this:** flagged for crypto review; the rotation order is in `charon-agent` →
enrollment-pinning.md; `tests/unit/webServerSettings.test.ts`.

---

## services/proxyConfigService.ts

**What it owns:** the `proxyConfig` Setting — operator nginx controls (HTTPS port, TLS
protocols, HTTP/3, HSTS, `/metrics` allow-list, managed / adopt-required mode), short TTL cache.
**Public API:** `getProxyConfig`, `saveProxyConfig`, `parseProxyConfig`, `mergeProxyConfig`,
`validateProxyConfig`, `defaultProxyConfig`, `invalidateProxyConfigCache`,
`PROXY_SETTING_KEY`; types `ProxyConfig`, `ProxyConfigHsts`, `TlsProtocol`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/services/nginxRenderer.ts`, `src/services/webServerService.ts`,
`src/api/routes/settings/webServer.ts`.
**Invariants:** TLS 1.3 only — TLSv1.2 is refused at validation (it cannot negotiate the
`X25519MLKEM768` hybrid).
**When changing this:** a new control → a template token + `nginxRenderer` + the
`deploy/install-rhel.sh` defaults (`defaultProxyConfig()` must match them).

---

## services/trustedCaService.ts

**What it owns:** the `trustedCertificates` Setting — operator-uploaded CA certificates.
**Public API:** `listTrustedCas`, `getTrustedCaPems`, `addTrustedCa`, `deleteTrustedCa`,
`describeCaPem`, `bufferToPem`, `cleanName`; type `CertificateRecord`.
**Cross-service deps:** Node `X509Certificate` (subject / issuer / expiry).
**Used by:** `src/api/routes/settings/webServer.ts` (`/certificates`),
`src/services/httpClient.ts` (adds the PEMs to the system roots for verifying outbound calls).
**Invariants:** CA records only — private keys are refused, and the server leaf is never managed
here (it changes only through the rotate flow).
**When changing this:** `httpClient` caches the PEM set for 60 s — keep `getTrustedCaPems()`
cheap and failure-tolerant.

---

## services/webAccessSettingsService.ts

**What it owns:** source-IP-scoped settings — `loginAccessConfig` (Local Login Access),
the `ipv6Config` switch (persist-only); short TTL
caches.
**Public API:** `getLoginAccessSettings`, `saveLoginAccessSettings`,
`previewLoginAccessSettings`, `loginSourceAllowed`, `isLoginSourceAllowed`, `getIpv6Status`, `setIpv6Enabled`, `parseIpv6Config`, `isRoutableIpv6`,
`routableHostIpv6`, `parseScopedAccess`, `mergeScopedAccess`, `defaultScopedAccess`; types
`ScopedAccessSettings`, `Ipv6Config`, `Ipv6Status`.
**Cross-service deps:** `src/utils/ipScope.ts`.
**Used by:** `src/api/routes/auth.ts` (`POST /auth/login`, `/auth/login/totp`),
`src/api/routes/settings/webServer.ts` (`/login-access`, `/ipv6`).
**Invariants:** the login gate applies to the local PASSWORD path only (SAML/OIDC never) and
fails OPEN on a settings read error — a DB blip must never lock operators out.
**When changing this:** preview before save (`previewLoginAccessSettings`) so an operator sees
whether their own address would still be allowed.

---

## Time & NTP / Customization tabs

## services/ntpService.ts

**What it owns:** the `ntp` Setting, a real NTP/NTS sync test, and applying servers to the
host's chrony.
**Public API:** `getNtpSettings`, `updateNtpSettings`, `applyNtpToHost`, `testNtpSync`,
`renderChronySources`, `parseNtpSettings`, `isValidNtpServer`, `isValidTimezone`,
`parseSntpReply`, `readNtpTimestamp`, `formatOffset`, `NTP_KEY`, `NTP_MAX_SERVERS`; types
`NtpMode`, `NtpSettings`, `NtpApplyResult`.
**Cross-service deps:** `deploy/scripts/charon-chrony-apply.sh` via a scoped sudoers rule
(`CHARON_CHRONY_APPLY_SCRIPT`); `src/utils/paths.ts`.
**Used by:** `src/api/routes/settings/ntp.ts`.
**Invariants:** `timezoneOverride` is display-only — the host zone is never changed. The test
is a real SNTP query (UDP 123) or an NTS-KE TLS 1.3 handshake (TCP 4460). Whatever the app
stages, the root wrapper re-validates every line.
**When changing this:** the rendered `.sources` grammar and the wrapper's validator must agree;
`tests/unit/settingsNtpCustomization.test.ts`.

---

## services/brandingService.ts

**What it owns:** the `branding` Setting (app name, subtitle, logo URL, placement flags) and the
uploaded logo file under `public/uploads/`.
**Public API:** `getBranding`, `getPublicBranding` (+ pure `toPublicBranding` — the login page's
trimmed view: name, subtitle, opt-in logo, never the version), `updateBranding`, `setCustomLogo`, `clearCustomLogo`,
`detectImageMagic`, `hasCustomLogo`, `displayAppName`, `cleanBrandingText`,
`logoVersionStamp`, `parseBranding`, `normalizeBrandingFlag`, `normalizeTemperatureUnit`,
`BRANDING_KEY`, `LOGO_MAX_BYTES`; types `BrandingSettings`, `BrandingView`.
**Cross-service deps:** `src/utils/paths.ts → UPLOADS_DIR`; `src/utils/version.ts`.
**Used by:** `src/api/routes/settings/customization.ts`; `public/js/app.js` paints the sidebar
from `GET /server-settings/branding`.
**Invariants:** logos are magic-byte checked (PNG / JPEG / WebP), never SVG; only Charon's own
fixed upload names are rendered. The logo file is not in a DB backup.
**When changing this:** the sidebar's logo regex in `public/js/app.js → brandHtml()` must match
the stored URL shape.

---

## services/rebootSettingsService.ts

**What it owns:** the `rebootConfig` Setting (whether a reboot must give a reason).
**Public API:** `getRebootSettings`, `saveRebootSettings`, `parseRebootSettings`,
`defaultRebootSettings`, `REBOOT_SETTING_KEY`; type `RebootSettings`.
**Cross-service deps:** `eventService`.
**Used by:** `src/api/routes/settings/customization.ts` (`/reboot`).
**Invariants:** persist-only — Charon has no device- or agent-reboot action yet.
**When changing this:** TODO: populate when a reboot action consumes it.

---

## Identification tab

## services/assetTagService.ts

**What it owns:** the `AssetTag` registry + `tagSettings` Setting — NOT the ZTNA `Tag`.
**Public API:** `listAssetTags`, `createAssetTag`, `updateAssetTag`, `deleteAssetTag`,
`getTagSettings`, `saveTagSettings`, `previewTagFilter`, `normalizeTagColor`,
`randomTagColor`, `normalizeTagCondition`, `tagFilterView`, `readPostedTagFilter`,
`tagFilterSchema`; types `TagWriteInput`, `TagFilterPreview`.
**Cross-service deps:** `src/utils/deviceFilterCondition.ts`, `assetTypeService`,
`eventService`.
**Used by:** `src/api/routes/settings/identification.ts` (`/tags*`).
**Invariants:** never touches `Tag` / `TagSource` (the Fortinet pipeline). An empty auto-assign
filter is stored as NULL, never "all devices". No inventory: preview is zero, delete strips
nothing.
**When changing this:** keep the filter vocabulary in step with
`public/js/condition-builder.js`.

---

## services/assetTypeService.ts

**What it owns:** the `AssetTypeDef` device-type registry (CRUD, built-in seeding, match-rule
preview / apply).
**Public API:** `listAssetTypes`, `getAssetType`, `createAssetType`, `updateAssetType`,
`deleteAssetType`, `seedBuiltInAssetTypes`, `previewMatchRules`, `applyMatchRules`,
`normalizeAssetTypeName`, `validateAssetTypeName`, `validateAssetTypeLabel`,
`isKnownAssetType`, `BUILT_IN_ASSET_TYPES`; types `AssetTypeRow`, `MatchPreviewResult`.
**Cross-service deps:** `src/utils/assetTypeMatch.ts`.
**Used by:** `src/api/routes/settings/identification.ts` (`/asset-types`),
`assetTagService`, `deviceIconService`, `src/services/credentials/assetTypes.ts`.
**Invariants:** built-ins (`isBuiltIn` + `isProtected`) cannot be renamed, relabelled or
deleted; their match rules stay editable. Usage counts are always 0 (no inventory).
**When changing this:** a built-in change → the migration seed and `BUILT_IN_ASSET_TYPES`;
`tests/unit/assetTypeMatch.test.ts`, `identificationSettings.test.ts`.

---

## services/deviceIconService.ts

**What it owns:** `DeviceIcon` rows — uploaded vendor icons keyed manufacturer + model or
manufacturer + asset type, most-specific-wins resolution.
**Public API:** `uploadIcon`, `listIcons`, `getIconImage`, `updateIconKey`, `deleteIcon`,
`validateUpload`, `validateUploadContent`, `loadIconResolutionCache`, `resolveIconUrl`; types
`IconScope`, `UploadedIcon`, `DeviceIconSummary`.
**Cross-service deps:** `src/services/credentials/manufacturerNormalize.ts`,
`assetTypeService`.
**Used by:** `src/api/routes/settings/identification.ts` (`deviceIconsRouter`).
**Invariants:** bytes live in the DB (HA-safe); standalone type-only / model-only /
manufacturer-only icons are not supported. SVG is served under a sandboxing CSP.
**When changing this:** the image route's headers (`nosniff`, CSP) are load-bearing for SVG.

---

## services/dnsService.ts

**What it owns:** the `dnsSettings` Setting and an isolated resolver (standard, DNS-over-TLS,
DNS-over-HTTPS) that never changes the process's own DNS.
**Public API:** `getDnsSettings`, `updateDnsSettings`, `createResolver`,
`getConfiguredResolver`, `parseDnsTestTarget`, `isValidIpAddress`, `ipToPtrName`; types
`DnsSettings`, `PtrRecord`, `ARecord`, `ResolverLike`, `DnsTestTarget`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/api/routes/settings/identification.ts` (`/dns`, `/dns/test`).
**Invariants:** the test probes operator-supplied servers, so it is a write-gated route.
**When changing this:** `tests/unit/dnsTestTarget.test.ts`.

---

## services/ouiService.ts

**What it owns:** the IEEE OUI database (`oui_database`) + operator overrides
(`oui_overrides`), lazily loaded into memory.
**Public API:** `lookupOui`, `lookupOuiDetailed`, `lookupOuiBatch`, `lookupOuiOverride`,
`refreshOuiDatabase`, `getOuiStatus`, `getOuiOverrides`, `setOuiOverride`, `deleteOuiOverride`,
`normalizeMacPrefix`, `parseCsv`; type `OuiOverride`.
**Cross-service deps:** `httpClient` (download from the IEEE registry).
**Used by:** `src/api/routes/settings/identification.ts` (`/oui*`), `src/jobs/ouiRefresh.ts`,
`src/services/credentials/manufacturerProfileService.ts`.
**Invariants:** overrides take priority over the IEEE map; only the leader refreshes on a
schedule (rule 5).
**When changing this:** a format change in the stored map must keep reading the old row.

---

## Maintenance / Retention tabs

## services/backupScheduleService.ts

**What it owns:** the `backupSchedule` Setting (enabled — default false, interval 1–168 h,
optional UTC hour, retain 1–50, optional passphrase, off-host directory) and the due decision.
**Public API:** `getBackupSchedule`, `getBackupScheduleMasked`, `saveBackupSchedule`,
`parseBackupSchedule`, `defaultBackupSchedule`, `isScheduledBackupDue`,
`recordScheduledBackupOutcome`, `copyBackupOffHost`, interval / retain bounds; type
`BackupSchedule`.
**Cross-service deps:** `src/utils/crypto.ts` (passphrase sealed at rest),
`src/utils/backupPassword.ts`, `src/utils/privateFiles.ts`.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/database/backup-schedule`, fullwrite
to write), `src/jobs/scheduledBackup.ts`.
**Invariants:** off by default; only SCHEDULED backups are pruned (manual and pre-update ones
never); the passphrase is an envelope at rest and masked on read (rule 3).
**When changing this:** `tests/unit/maint_backupSchedule.test.ts`.

---

## services/capacityAdvisorService.ts

**What it owns:** the Capacity Advisor card — per lever, current vs recommended. `env` levers
(`DATABASE_POOL_SIZE`, `CHARON_PGBOSS_POOL_SIZE`) can be STAGED into `.env` (effective on
restart); `advisory-only` levers (Postgres `max_connections`, memory settings) are never
written.
**Public API:** `computeAdvisor`, `stageAdvisorState`, `estimateProcessCount`,
`recommendedPrismaPool`, `recommendedPgbossPool`, `ENV_LEVERS`, `MAX_CONNECTIONS_HEADROOM`;
types `AdvisorLeverKey`, `AdvisorRecommendation`, `AdvisorState`, `AdvisorInputs`.
**Cross-service deps:** `pgTuningService`, `src/utils/envFile.ts`, `src/utils/role.ts`; env
`CHARON_ADVISOR_PROCESS_COUNT`.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/capacity-advisor`, `/stage`).
**Invariants:** never edits PostgreSQL configuration; staging only rewrites single `.env` keys.
**When changing this:** a new pool → a new lever and the process-count estimate.

---

## services/pgTuningService.ts

**What it owns:** the PostgreSQL tuning check — `pg_settings` vs RAM-sized recommendations,
engaged once endpoints or the audit log cross `PG_TUNING_THRESHOLDS`.
**Public API:** `computePgTuning`, `gradePgSettings`, `buildPgRecommended`, `parsePgBytes`,
`isAutoConfOverride`, `PG_TUNING_THRESHOLDS`; types `PgTuningRow`, `PgTuningResult`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/pg-tuning`, `/database`),
`capacityAdvisorService`.
**Invariants:** read-only; its `pgTuningNeeded` flag feeds the capacity snapshot reason.
**When changing this:** keep the advisor's advisory levers in step.

---

## services/dbSizeService.ts

**What it owns:** catalog-only database sizing (relpages × block size), split into buckets that
sum to the total (Charon tables, pg-boss, catalog, other), plus server version facts.
**Public API:** `getTableSizes`, `summarizeBuckets`, `getDatabaseSizeBreakdown`,
`getDatabaseInfo`, `parsePostgresVersion`; types `TableSize`, `TableSizing`,
`DatabaseSizeBreakdown`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/api/routes/settings/maintenance.ts`, `capacityService`.
**Invariants:** figures are as of the last ANALYZE (never-analyzed relations are reported).
**When changing this:** buckets must still sum to the total.

---

## services/platformLifecycleService.ts

**What it owns:** the Platform Lifecycle card — Node.js, PostgreSQL, agent versions graded
against `scripts/data/platformEol.json` (owned by `charon-tech-lifecycle`), memoised 6 h.
**Public API:** `getPlatformLifecycle`, `loadPlatformEolDataset`, `parseDataset`,
`observePlatformStack`, `gradeComponent`, `deriveTrack`, `compareTracks`, `DATASET_PATH`,
watch / warning day thresholds; types `PlatformEolDataset`, `LifecycleGrade`,
`PlatformLifecycleResult`.
**Cross-service deps:** `agentDistService → getManifest()`; `src/utils/version.ts`.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/platform-lifecycle`).
**Invariants:** a missing or malformed dataset renders `datasetError`, never a silently empty
table.
**When changing this:** a dataset schema change → `charon-tech-lifecycle` → eol-dataset.md.

---

## services/sampleRetentionService.ts

**What it owns:** the `sampleRetention` Setting — flat retention windows for `events` (default
90 d, seeded from legacy `retention.eventDays`) and `verificationSessions` (default 1 d).
**Public API:** `getSampleRetention`, `updateSampleRetention`, `parseSampleRetention`,
`mergeSampleRetention`, `defaultSampleRetention`, `retentionCutoff`, `parseDays`, `FOREVER`,
`MAX_DAYS`, `FLAT_RETENTION_ENTITIES`; types `SampleRetention`, `FlatRetention`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/sample-retention`),
`src/jobs/retentionPrune.ts`, `capacityService`.
**Invariants:** −1 = forever; `events` = 0 is refused (never "delete the whole audit log").
**When changing this:** a new entity → the prune job and the Retention card.

---

## services/agentEventLogService.ts

**What it owns:** the `agentEventLog` Setting (agent OS event-log master switch + filter;
default disabled).
**Public API:** `getAgentEventLogConfig`, `updateAgentEventLogConfig`,
`parseAgentEventLogConfig`, `mergeAgentEventLogConfig`, `DEFAULT_AGENT_EVENT_LOG_CONFIG`; type
`AgentEventLogConfig`.
**Cross-service deps:** none beyond the DB.
**Used by:** `src/api/routes/settings/maintenance.ts` (`/agent-event-log`).
**Invariants:** persist-only — the Tauri agent ships no OS event log and there is no ingest
path; saving changes nothing on the wire.
**When changing this:** TODO: populate when the agent collects OS events (`charon-agent`).

---

## API Tokens tab

## services/apiDocsAccessService.ts

**What it owns:** the `apiDocsConfig` Setting — source-IP restriction for an API docs page
(loopback / rfc1918 / custom).
**Public API:** `getApiDocsSettings`, `saveApiDocsSettings`, `parseApiDocsSettings`,
`mergeApiDocsSettings`, `isApiDocsSourceAllowed`, `docsSourceAllowed`, `describeIpScope`,
`defaultApiDocsSettings`, `API_DOCS_SETTING_KEY`; types `ApiDocsIpScope`, `ApiDocsSettings`.
**Cross-service deps:** `src/utils/ipAllowlist.ts`.
**Used by:** `src/api/routes/settings/apiTokens.ts` (`/api-docs`).
**Invariants:** never public — a custom entry outside RFC1918 is refused on save AND filtered
out on read. Persist-only: Charon serves no API docs page yet.
**When changing this:** `tests/unit/apiTokensSettings.test.ts`.

---

## High Availability tab

## services/haService.ts

**What it owns:** the `ha.config` Setting (both nodes, load-balancer figures, the replication
password as an AES-256-GCM envelope), live cluster status and the guidance advisories.
**Public API:** `getHaConfig`, `parseHaConfig`, `redactHaConfig`, `revealReplicationPassword`,
`enableHa`, `disableHa`, `getClusterStatus`, `computeAdvisories`, `measureRtt`,
`detectLocalAddresses`, `isContainer`, `leaderRetrySec`, `randomReplicationPassword`,
`rememberNodeHostKeys`, `HA_CONFIG_KEY`, `HA_ROLES`; types `HaConfig`, `HaNode`, `HaRole`,
`HaClusterStatus`.
**Cross-service deps:** `leaderElection`, `src/utils/haAdvisories.ts`, `src/utils/crypto.ts`.
**Used by:** `src/api/routes/settings/ha.ts`, `haEnrollmentService`.
**Invariants:** the replication password never reaches an HTTP response (`redactHaConfig`); it
leaves the server only inside an approved node bundle; it is alphanumeric because
`deploy/setup-ha.sh` interpolates it into SQL. Enable/disable change configuration only — the
host is changed by the node scripts. Container installs and remote databases are reported as
unsupported by the install-shape advisory.
**When changing this:** `tests/unit/haSettings.test.ts`; `deploy/HA.md`.

---

## services/haEnrollmentService.ts

**What it owns:** `HaEnrollment` rows and the node join flow: mint a single-use token →
node registers (token spent) → operator approves → node downloads its bundle once; the node
bootstrap / teardown scripts.
**Public API:** `mintNodeToken`, `registerEnrollment`, `pollEnrollment`, `listEnrollments`,
`approveEnrollment`, `rejectEnrollment`, `claimBundle`, `buildNodeBundle`, `serializeBundle`,
`renderNodeScript`, `renderNodeScriptForServer`, `renderTeardownScript`,
`expireStaleEnrollments`, `hashRequestId`, `TOKEN_TTL_MS` (24 h), `APPROVAL_WINDOW_MS`
(30 min), `CLAIM_WINDOW_MS` (10 min), `BUNDLE_KEYS`.
**Cross-service deps:** `haService`, `certPinService → getAgentCertPins()`,
`certInfo → leafPin()`, `src/utils/crypto.ts` (`generateToken`, `sha384hex`,
`timingSafeHexEqual`); reads `.env` and the TLS key from disk for the bundle.
**Used by:** `src/api/routes/settings/ha.ts` (`haRouter` + public `haEnrollRouter`).
**Invariants:** rule 9 — the token buys only the right to ASK; the bundle (which carries
`CHARON_DATA_KEY`, the nginx leaf key and the replication password) is released only after an
operator approves, once, to the address that registered. Token and poll handle are stored as
SHA-384 only; every token rejection returns the same text. Values interpolated into a script
must be inert inside single quotes. Generated scripts never bake in a PostgreSQL major: they
resolve it on the host (`ls -d /usr/pgsql-*`) as `deploy/setup-ha.sh` does, because a host keeps
the major it was installed with (`charon-tech-lifecycle` → version-pin-inventory.md).
**When changing this:** needs human + crypto review; `tests/unit/haSettings.test.ts`.

---

## Repository tab

## services/firmwareRepositoryService.ts

**What it owns:** the firmware tree (manufacturer › type › model), `FirmwareImage` rows + their
files under `FIRMWARE_DIR`, primary/backup rotation per platform, and
`FirmwareCredentialBinding` resolution.
**Public API:** `getFirmwareTree`, `listImages`, `getImage`, `registerUploadedImage`,
`discardIncomingUpload`, `setPrimaryImage`, `deleteImage`, `purgeModelImages`,
`resolveImagePath`, `ensureFirmwareDirs`, `listBindings`, `upsertBinding`, `deleteBinding`,
`bindingIsLive`, `isDeviceLoginCredential`, `firmwareBindingCredentialIds`,
`listAssetsForNode` (empty), `listRecentRuns` (empty), `getRun`, `normalizeManufacturer`, size
limits and enums; types `FirmwareTree`, `FirmwareImageRow`, `EffectiveBinding`.
**Cross-service deps:** `src/utils/firmwareVersion.ts`, `src/utils/paths.ts →
FIRMWARE_DIR` / `FIRMWARE_INCOMING_DIR`, `eventService`.
**Used by:** `src/api/routes/settings/firmware.ts`.
**Invariants:** bytes on disk, identity in the DB; uploads stream into `.incoming` and are
renamed atomically; at most one primary + one backup per platform; ≤ 300 MiB FortiGate,
≤ 100 MiB switch / AP. Charon never flashes a device (no runs). Images are not in a DB backup.
**When changing this:** the nginx firmware location's body limit must stay ≥ the largest image
limit; `tests/unit/firmwareRepository.test.ts`, `firmwareVersion.test.ts`.

---

## Credentials tab — `src/services/credentials/`

A self-contained port of polaris's credential store, MIB database and manufacturer profiles.
Several files carry polaris `src/utils/...` paths in their header comments; they live here.
Polaris business-rule numbers cited in these files (110, 113, 116, 130, 132, …) are POLARIS
rules, not Charon's.

## services/credentials/credentialService.ts

**What it owns:** the Credentials-tab view of `Credential` (types `snmp`, `winrm`, `ssh`,
`restapi`, `http`): validation, sealing secrets, masking, ownership stamp.
**Public API:** `listCredentials`, `getCredential` (`revealSecrets` for server-side probes
only), `createCredential`, `updateCredential`, `deleteCredential`, `getCredentialUsage` /
`getCredentialUsageCounts` (empty), `validateConfig`, `validateHttpCheckDefinition`,
`sealSecrets`, `openSecrets`, `stripSecrets`, `mergeConfigPreservingSecrets`,
`credentialCanReboot`, `credentialAllowsReboot`, `CREDENTIAL_TYPES`.
**Cross-service deps:** `src/utils/crypto.ts` (`encryptSecret` / `decryptSecret`),
`secretMask.ts`, `httpCheck.ts`, `safeRegex.ts`, `trimTrailing.ts`.
**Used by:** `src/api/routes/settings/credentials.ts`, `manufacturerProfileService`.
**Invariants:** rule 3a — secrets are AES-256-GCM envelopes at rest, masked on every response,
preserved when the mask comes back unchanged; rows of any other type (integration-owned) are
invisible to the tab (filtered list, 404 by id). Ownership: `createdBy` is stamped once at
create; the route enforces write = own rows, fullwrite = any.
**When changing this:** a new secret field → `sealSecrets` / `openSecrets` / `stripSecrets`;
`tests/unit/credentials_*.test.ts`.

## services/credentials/credentialProbeService.ts

**What it owns:** one-shot probes behind Test Connection and the MIB walk (SNMP, WinRM, SSH,
REST API, HTTP).
**Public API:** `probeCredentialAgainstHost`, `probeHttp`, `snmpWalkRaw`,
`snmpVarbindToPrintable`, `verifyOrPin`, `fingerprintKeyBlob`.
**Cross-service deps:** `net-snmp`, `ssh2`; `cidr.ts`, `digestAuth.ts`, `httpCheck.ts`,
`oidCompare.ts`, `trimTrailing.ts`.
**Used by:** `src/api/routes/settings/credentials.ts`.
**Invariants:** SSH host keys are verified or pinned on first use and the verifier fails
CLOSED; probe targets are operator-typed and pass `netGuard` (no loopback / link-local /
metadata / multicast) — Charon has no asset targets.

### The rest of the folder

- `mibService.ts` — `MibFile` storage + SMI validation (`parseMib`, `parseMibStructured`,
  `listMibs`, `getMib`, `createMib`, `deleteMib`, `getMibFacets`).
- `oidRegistry.ts` — symbol → OID resolver over uploaded + bundled `stdMibs/*.txt`;
  `stdMibLibrary.ts` — browse/walk for the bundled standard MIBs; `mibParserUtils.ts`.
- `manufacturerAliasService.ts` — `ManufacturerAlias` CRUD + cache;
  `manufacturerNormalize.ts` — the pure normalizer (also used by `deviceIconService`).
- `manufacturerProfileService.ts` — `ManufacturerProfile` / `…Metric` / `…MetricOverride` /
  `ManufacturerCustomWidget` CRUD + cached resolver; `manufacturerProfilePortabilityService.ts`
  — export / import a profile as portable JSON (no ids, no secrets, MIBs not bundled).
- `netGuard.ts` — SSRF guard (`resolveAllowedHost`, `guardedLookup`,
  `assertOutboundHostAllowed`): blocks loopback, link-local, unspecified, multicast; RFC1918
  stays allowed; judged on the resolved ADDRESS.
- `safeRegex.ts` / `regexSafety.ts` — guards for operator-supplied regexes (Charon stores but
  never runs them on a hot path; no re2js dependency); `trimTrailing.ts` — regex-free trim.
- Pure helpers: `assetTypes.ts`, `cidr.ts`, `digestAuth.ts`, `hardwareSensors.ts`,
  `httpCheck.ts`, `modelParse.ts`, `oidCompare.ts`, `probeTarget.ts`, `secretMask.ts`,
  `stateProbes.ts`, `symbolTransforms.ts`.

**When changing the folder:** keep it free of imports from the Fortinet pipeline; the routes
are the only entry point (`src/api/routes/settings/credentials.ts`).
