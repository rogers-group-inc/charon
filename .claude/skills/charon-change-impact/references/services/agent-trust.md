# Touches — enrollment, agent bearers, invitation codes, cert pins, installers

Per-service touches. The shared Owns / Reads / Used by / Invariants block below moved verbatim
from TOUCHES.md ("agentEnrollmentService / agentTokenService / invitationCodeService /
certPinService"); each service then has its own entry. Code references are
`path/file.ts → symbolName()` — grep the symbol.

**Shared (verbatim):**
- **Owns:** Endpoint enrollment, bearer issue/verify/revoke, invitation codes, cert pins.
- **Reads:** Setting `agent.cert_pins`.
- **Used by:** routes/agents(+enroll), routes/endpoints, agentsWs, serverSettings certificates.
  (Since the Server Settings port the certificate routes live in
  `src/api/routes/settings/webServer.ts`, driven by `src/services/webServerService.ts`.)
- **Invariants:** #3 (hashed storage), #4 (pin trust). Revoking a bearer sets status=revoked and
  locks WS + HTTP.

## services/agentEnrollmentService.ts

**What it owns:** invitation → bearer enrollment: consume the code, create/attach the Endpoint,
issue the bearer, return the leaf-cert pin(s).
**Public API:** `enroll`; types `EnrollInput`, `EnrollResult`.
**Cross-service deps:** `invitationCodeService → consumeCode()`,
`agentTokenService → issueBearer()`, `certPinService → getAgentCertPins()`,
`eventService → logEvent()`.
**Used by:** `src/api/routes/agents.ts` (`agentsEnrollRouter`, `POST /agents/enroll`,
rate-limited by `enrollLimiter`).
**Invariants:** rules 3 and 4; the agent trusts only the returned pins, never system roots.
**When changing this:** the agent's `enroll` command (`agent/src-tauri/src/main.rs`) parses
this response — change both together.

---

## services/agentTokenService.ts

**What it owns:** endpoint-agent bearers (`charon_<base64url>`, SHA-384 stored,
prefix-indexed), separate from ApiToken.
**Public API:** `issueBearer`, `revokeBearer`, `verifyBearer`; type `VerifiedAgent`.
**Cross-service deps:** `src/utils/crypto.ts → generateToken()` / `sha384hex()` /
`timingSafeHexEqual()`.
**Used by:** `src/api/middleware/auth.ts` (agent bearer), `src/api/routes/agentsWs.ts`,
`src/api/routes/endpoints.ts` (`POST /:id/revoke`), `src/services/agentEnrollmentService.ts`.
**Invariants:** shared block above.
**When changing this:** a revoke must close both the WS and HTTP paths.

---

## services/invitationCodeService.ts

**What it owns:** one-time enrollment codes (hash-only storage, use cap, expiry, revoke).
**Public API:** `issueCode`, `listCodes`, `revokeCode`, `consumeCode`; type `IssuedCode`.
**Cross-service deps:** `src/utils/crypto.ts`; `eventService → logEvent()`.
**Used by:** `src/api/routes/endpoints.ts` (`/endpoints/invitations`),
`src/services/agentEnrollmentService.ts`.
**Invariants:** `consumeCode` is atomic and capped — two agents racing one code cannot both
enroll.
**When changing this:** keep the plaintext shown exactly once (issuance response).

---

## services/certPinService.ts

**What it owns:** the `agent.cert_pins` Setting `{ canonical, staged[] }`, the dual-pin
rotation API, and the per-Endpoint record of the pins each agent was last handed
(`Endpoint.serverCertFingerprint` / `additionalCertFingerprints`).
**Public API:** `getAgentCertPins`, `getPinStore`, `stageNewPin`, `swapCanonicalPin`,
`retirePin`, `recordDeliveredPins`, `listActiveDeliveredPins`; pure `normalizePin`,
`computeSwap`, `computeRetire`, `computeBootstrap`, `tallyPins`, `rowHasPin`; `adoptBootstrapPin`
(fresh install only — never replaces a canonical pin; called via
`webServerService.adoptBootstrapAgentPin()` when the leader acquires); types `PinStore`, `RetireOutcome`,
`DeliveredPinRow`. `setCanonicalPin` / `promoteStagedPin` are still exported but no longer
called by any route.
**Cross-service deps:** Setting `agent.cert_pins`; Prisma `Endpoint`.
**Used by:** `src/api/routes/agents.ts` (`GET /agents/config` → `getAgentCertPins`,
`recordDeliveredPins`), `src/api/routes/settings/webServer.ts` (`/agents/cert-pins/summary`,
`bulk-add` → `stageNewPin`, `bulk-remove` → `retirePin`), `src/services/webServerService.ts`
(`rotateCertAndKey` → `getPinStore`, `swapCanonicalPin`), `src/services/agentEnrollmentService.ts`,
`src/services/haEnrollmentService.ts` (`getAgentCertPins` for node scripts).
**Invariants:** rule 4 — stage the new pin before rotating the cert; rule 4a — the swap keeps the
old pin accepted, the last pin is never retired (`computeRetire` → `last_pin`), and the route
refuses the served cert's pin. Pins are bare lowercase-hex SHA-256. `recordDeliveredPins` writes
only when the set changed (no write per config poll) and never fails the config response.
**When changing this:** see `charon-agent` → enrollment-pinning.md for the rotation order;
`tests/unit/webServerSettings.test.ts` pins swap / retire / tally.

---

## services/certInfo.ts

**What it owns:** leaf-certificate inspection — the SHA-256 leaf fingerprint (THE agent pin)
plus subject / SAN / validity for display.
**Public API:** `parseCert`, `leafPin`, `isValidCertPem`; type `CertSummary`.
**Cross-service deps:** none (Node `X509Certificate`).
**Used by:** `src/services/haEnrollmentService.ts` (`leafPin` — the pin the HA node scripts
check). Server Settings → Web Server computes the same fingerprint itself
(`src/services/webServerService.ts → certFacts()`).
**Invariants:** the first cert's swap sets the canonical agent pin. The pin is the fingerprint, not
the key type, so it survives a classical → PQC certificate transition.
**When changing this:** the agent compares the same value (`agent/src-tauri/src/client.rs`).

---

## services/agentDistService.ts

**What it owns:** serving prebuilt agent installers from `data/agents/<version>/` per its
`manifest.json`.
**Public API:** `getManifest`, `resolveInstaller`, `listInstallers`; types `AgentFile`,
`AgentManifest`.
**Cross-service deps:** `src/utils/paths.ts → AGENT_DIST_DIR`.
**Used by:** `src/api/routes/maintenance.ts` (`/server-settings/maintenance/agents`),
`src/services/platformLifecycleService.ts` (agent version facts).
**Invariants:** agent installers are served strictly from the manifest allowlist (no path
traversal).
**When changing this:** the CI release job that writes the manifest must agree on its shape.

**Push deploy addendum:** also used by `src/api/routes/agentBinary.ts` (PUBLIC
`/agents/binary/:file`, the Windows pinned download) and `agentDeployService` (installer
selection + bytes). A push deploy needs a `sha256` on every manifest file it uses — add it in
the CI release job.

---

## services/agentDeployService.ts

**What it owns:** the push-deployment lifecycle on `AgentDeployment` (polaris
agentInstallService orchestration): create (bulk, BULK_POOL = 5 at a time), install, retry /
reinstall, upgrade, upgrade-all, uninstall, delete; the per-run single-use invitation code; the
agent server-URL resolution and its override Setting (`agent.serverUrlOverride`); the
enrollment hook.
**Public API:** `createDeployments`, `listDeployments`, `getDeployment`, `retryDeployment`,
`startUpgrade`, `upgradeAllOutdated`, `startUninstall`, `deleteDeployment`,
`markDeploymentEnrolled`, `inferAgentServerUrl`, `setAgentServerUrlOverride`,
`__setDeployTransportsForTests`, `BULK_POOL`, `DEPLOY_CODE_TTL_MINUTES`,
`AGENT_SERVER_URL_SETTING_KEY`, `UPGRADEABLE_STATUSES`; types `DeployTransports`, `HostFacts`.
**Cross-service deps:** `credentials/credentialService → getCredential()` (ssh / winrm
credentials, secrets opened server-side only); `agentDistService`; `certPinService →
getAgentCertPins()`; `invitationCodeService → issueCode()`; `agentTokenService →
revokeBearer()`; `agentInstallScripts`; `utils/remoteExec`, `utils/remoteStaging`,
`utils/winrm`, `utils/agentServerUrl`; `webServerService → getHttpsInfo()` (URL fallback).
**Used by:** `src/api/routes/agentDeploy.ts`, `src/api/routes/settings/agents.ts`,
`agentEnrollmentService → enroll()` (`markDeploymentEnrolled`).
**Invariants:** rule 12 — fullwrite-gated routes, pinned transports (rule 11), manifest SHA-256
required and verified on the host, root / SYSTEM-only preseed, one fresh code per install
(`maxUses: 1`, 10 min), uninstall revokes the bearer. Runs are detached and bounded.
`invitationCodeId` is never returned by `listDeployments`.
**When changing this:** `tests/integration/agentDeploy.test.ts` (fake transports; needs a
`*_test` DB); a new status → the UI badges and `UPGRADEABLE_STATUSES` / the busy list.

---

## services/agentInstallScripts.ts

**What it owns:** everything a push deployment runs on a host — the Linux (deb / rpm /
AppImage), macOS (dmg) and Windows (msi / NSIS) install-or-upgrade and uninstall scripts, the
host probes, installer selection, the enrollment preseed, and the allowlists for every
substituted value. Pure.
**Public API:** `selectInstaller`, `installerKindOf`, `platformOfKind`, `normalizeArch`,
`renderEnrollmentPreseed`, `unixInstallScript`, `unixUninstallScript`, `windowsInstallPs`,
`windowsUninstallPs`, `parseUnixProbe`, `UNIX_PROBE_COMMAND`, `WINDOWS_PROBE_PS`,
`stagedInstallerName`, `assertPins`, `assertInstallerFilename`, `assertSha256`,
`PRESEED_PATHS`, `AGENT_PACKAGE_NAME`, `AGENT_PRODUCT_NAME`, `AGENT_OS_PLATFORMS`; types
`AgentOsPlatform`, `AgentTransport`, `InstallerKind`, `ManifestFile`, `EnrollmentPreseed`.
**Cross-service deps:** `utils/remoteStaging → STAGED_SCRIPT_PRELUDE`,
`utils/agentServerUrl → assertScriptSafeServerUrl()`.
**Used by:** `agentDeployService`.
**Invariants:** the digest check precedes the install step in every script; the Windows
download accepts only an agent pin; the preseed directory is created root / SYSTEM-only BEFORE
the file is written; no unchecked string reaches a script. `AGENT_PACKAGE_NAME` /
`AGENT_PRODUCT_NAME` must match `agent/src-tauri/tauri.conf.json`.
**When changing this:** `tests/unit/agentInstallScripts.test.ts`; renaming the agent product
changes the uninstall match and the dmg `.app` path.

---

## services/windowsSshOnboardingService.ts

**What it owns:** the SSH Deployment card (ported from polaris): the onboarding config Setting
(account mode, user name, `charonServerIp`), the managed ed25519 deployment keypair stored as
one Credentials-tab `ssh` credential per platform ("Windows SSH (Charon-managed)" / "Linux SSH
(Charon-managed)"), and rendering the onboarding remediation / detection scripts.
**Public API:** `getOnboardingState`, `saveOnboardingConfig`, `generateKeypair`,
`getOnboardingScript`, `sshPublicKeyFingerprint`, `MANAGED_CREDENTIAL_NAMES`, `_invalidateCache`.
**Cross-service deps:** `settingsStore`, `credentials/credentialService` (create / update — the
key is sealed by rule 3a), `utils/sshKeygen`, `sshOnboardingScript`, `eventService`.
**Used by:** `src/api/routes/settings/agents.ts`, `intunePublishService`.
**Invariants:** the private key is never returned (the state read and the credential list mask
it); regenerating rotates IN PLACE and is a warning Event — every host must re-run the onboarding
script. The generate route chains `credentials` write.
**When changing this:** `tests/unit/windowsSshOnboarding.test.ts`.

---

## services/sshOnboardingScript.ts

**What it owns:** the onboarding scripts (polaris, rebranded): Windows (OpenSSH server, local or
existing account, authorized key, firewall rule scoped to `charonServerIp`) and Linux (account,
authorized key, passwordless sudo for the deploy account), each with a detection script —
the scripts that make a host reachable for a push deploy. Pure.
**Public API:** `buildWindowsOnboardingScript`, `buildWindowsOnboardingDetectionScript`,
`buildLinuxOnboardingScript`, `buildLinuxOnboardingDetectionScript`, `assertValidServerIp`,
`assertValidUsername`, `assertValidLinuxUsername`; type `SshOnboardingAccountMode`.
**Cross-service deps:** `utils/cidr → isValidIpv4()` / `isValidCidr()`.
**Used by:** `windowsSshOnboardingService`.
**Invariants:** every value written into script text is validated as one clean line (no control
or line-separator characters, no zone-indexed IPv6); these scripts GRANT ADMINISTRATIVE SSH —
human review before any change ships.
**When changing this:** `tests/unit/sshOnboardingScript.test.ts`,
`tests/unit/sshOnboardingLinuxInjection.test.ts`.

---

## services/intunePublishService.ts

**What it owns:** publishing the Windows onboarding pair to Intune as a Remediation
(deviceHealthScripts) through an `entraid` integration with `publishToIntune` on — always
UNASSIGNED; a human assigns it in Intune.
**Public API:** `listPublishTargets`, `publishOnboardingScripts`; type `IntunePublishResult`.
**Cross-service deps:** `entraIdService → graphApiRequest()`, `integrationConfig →
decryptConfig()` (the client secret is an envelope), `windowsSshOnboardingService →
getOnboardingScript()`, Prisma `Integration`.
**Used by:** `src/api/routes/settings/agents.ts` (chained `integrations` fullwrite).
**Invariants:** never assigns the policy; idempotent by display name; needs
`DeviceManagementScripts.ReadWrite.All` on the app registration.
**When changing this:** `tests/unit/intunePublish.test.ts`.

---

## services/settingsStore.ts

**What it owns:** `createSettingStore<T>()` — one typed, cached Setting row with defaults
(polaris helper).
**Public API:** `createSettingStore`; type `SettingStore`.
**Cross-service deps:** Prisma `Setting`.
**Used by:** `windowsSshOnboardingService`.
**Invariants:** the cache is per process; writers invalidate it.

---

## services/agentChannelService.ts

**What it owns:** the agent WebSocket session map for THIS process (ported from polaris, keyed
by Endpoint id): attach (`hello`, 30 s ping / pong, newest attach wins), session-scoped detach,
the `refresh-config` verb, and the cross-process NOTIFY channel `charon_agent_cfg_refresh`
(payload: endpoint ids, `*`, or `revoke:<ids>`).
**Public API:** `attach`, `detach`, `isAttached`, `refreshConfig`, `refreshAllConfigs`,
`disconnect`, `publishConfigRefresh`, `publishDisconnect`, `startConfigRefreshListener`,
`shutdownAllSessions`, `liveSessionCount`, `asFrame`, `CFG_REFRESH_CHANNEL`; types `Session`,
`Frame`, `FrameHandler`.
**Cross-service deps:** `ws` (type only), `pg` (the LISTEN client on `CHARON_DB_DIRECT_URL` ||
`DATABASE_URL`), Prisma `$executeRaw` (`pg_notify`).
**Used by:** `src/api/routes/agentsWs.ts` (attach + frame dispatch + listener),
`certPinService → write()` (refresh all), `agentTokenService → revokeBearer()` (disconnect),
`src/app.ts` (shutdown).
**Invariants:** a replaced socket's late close never tears down its replacement (session-scoped
detach); a non-JSON frame closes only that socket; every verb is best-effort — the agent's
`/agents/config` poll is the guaranteed floor. LISTEN needs a session-pinned connection (never a
transaction pooler).
**When changing this:** `tests/unit/agentChannel.test.ts`; a new server → agent frame must be
handled by the agent (bump `agent/VERSION`).

**Side effects added to existing entries:** `certPinService` — every pin-store write pushes
`refresh-config` to all agents; `agentTokenService → revokeBearer()` — also closes the endpoint's
live WebSocket in every process; `agentEnrollmentService → enroll()` — refuses an
`observedFingerprint` that is not an agent pin (code left spent) and links push deployments.
