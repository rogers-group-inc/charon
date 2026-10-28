# Touches — operator auth, API tokens, user↔device binding, audit log

Per-service touches. verificationService's Owns / Writes / Used by / Invariant moved verbatim
from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/authService.ts

**What it owns:** operator authentication (argon2id + optional TOTP), session establishment, the
active auth mode — which also drives the agent's login GUI.
**Public API:** `getActiveAuthMode`, `getAgentAuthConfig`, `localLogin`, `verifyTotp`,
`recordLogin`; types `AuthedUser`, `AuthMode`.
**Cross-service deps:** `src/utils/password.ts`; Setting `auth.mode`.
**Used by:** `src/api/routes/auth.ts`, `src/api/routes/agent.ts` (`GET /agent/auth-config`),
`src/api/routes/agents.ts` (agent login), `src/api/routes/serverSettings.ts` (`/auth-mode`).
**Invariants:** one auth-mode setting serves operators and agents; SAML / OIDC / LDAP operator
login reuse the same session path.
**When changing this:** TODO: populate when SAML / OIDC providers are wired (their callbacks
have different transport semantics — a cross-site POST vs a same-site GET).

---

## services/apiTokenService.ts

**What it owns:** long-lived bearer tokens for external callers (`charon_<base64url>`, SHA-384
stored, shown once), each bound to a Role and an optional trusted-host list.
**Public API:** `createToken`, `listTokens`, `listRoleChoices`, `updateTrustedHosts`,
`revokeToken`, `deleteToken`, `verifyToken` (returns `TokenVerification`: ok + token, or a
reason such as `untrusted_host`), `normalizeTrustedHosts`, `grantExceedsCaller`,
`getPublicApiBaseUrl`, `MAX_TRUSTED_HOSTS`; types `AuthenticatedToken`, `ApiTokenSummary`,
`CreateTokenInput`, `CreateTokenResult`.
**Cross-service deps:** `src/utils/crypto.ts`; `src/utils/ipAllowlist.ts` (trusted-host
match); `src/api/middleware/permissions.ts` (`FUNCTION_KEYS`, `normalizePermissions`,
`isAdminEquivalentPermissions`); `eventService → logEvent()`.
**Used by:** `src/api/middleware/auth.ts → attachApiToken` (403 on `untrusted_host`),
`src/api/routes/settings/apiTokens.ts` (`/api-tokens`).
**Invariants:** rule 3 (hash-only, shown once; prefix-indexed then constant-time compared);
rule 8 (a token acts only through its bound role; a role outranking the minting caller is
refused; role-less legacy tokens reach nothing role-gated). The source-address check runs AFTER
the hash matches, so only a real token holder learns its address was refused; that refusal's
Event is throttled.
**When changing this:** `requirePermission → resolveSnapshot()` reads `apiToken.roleId` — keep
`attachApiToken`'s `req.apiToken` shape (`src/types/express-session.d.ts`) in step;
`tests/unit/apiTokensSettings.test.ts`.

---

## services/verificationService.ts

**What it owns:** the `{user↔device↔IP}` binding + VerificationSession.
**Public API:** `bindVerification`, `clearBinding`.
**Cross-service deps:** Writes Endpoint.boundUser*, VerificationSession;
`eventService → logEvent()` (`agent.login` / `agent.logout`).
**Used by:** routes/agents login/logout (`src/api/routes/agents.ts`).
**Invariants:** changing the binding MUST trigger a reconcile (user-derived tags depend on
boundUserKey).
**When changing this:** expiry handling must clear the binding the same way logout does.

---

## services/eventService.ts

**What it owns:** appending to the audit log (Event).
**Public API:** `logEvent`; types `EventLevel`, `EventInput`.
**Cross-service deps:** none.
**Used by:** nearly every writer — `src/api/routes/auth.ts`, `endpoints.ts`, `maintenance.ts`,
`serverSettings.ts`, every `src/api/routes/settings/*.ts` mutation; services agentEnrollment,
apiToken, assetTag, backup, customGroup, firmwareRepository, fortinetEnforcement, integration,
invitationCode, policy, rebootSettings, reservationMac, tagReconciler, tag, update,
verification.
**Invariants:** best-effort — a failed write never breaks the underlying operation. Every
audit-worthy mutation writes one.
**When changing this:** a test that counts Event rows a request wrote must poll when the
writer does not await `logEvent()`.
