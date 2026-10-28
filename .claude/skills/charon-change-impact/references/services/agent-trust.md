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
