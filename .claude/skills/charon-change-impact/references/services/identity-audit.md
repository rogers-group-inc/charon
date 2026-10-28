# Touches — operator auth, API tokens, user↔device binding, audit log

Per-service touches. verificationService's Owns / Writes / Used by / Invariant moved verbatim
from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/authService.ts

**What it owns:** operator authentication logic — the local password step, the TOTP / backup-code
login step, the forced and self-service password change, TOTP self-enrollment, the login
lockout bookkeeping and login Events — plus the endpoint agent's sign-in mode (`auth.mode`).
The SESSION (rotate id, stamp identity, park `pendingAuth`) belongs to the route,
`src/api/routes/auth.ts → regenerateSession() / stampLoginSession()`.
**Public API:** `passwordStep`, `totpLoginStep`, `localLogin` (agent path, no session),
`resolveSecondFactors`, `recordLogin`, `recordPasswordChangeDemanded`,
`completeForcedPasswordChange`, `changeOwnPassword`, `totpStatus`, `startTotpEnrollment`,
`confirmTotpEnrollment`, `disableOwnTotp`, `getActiveAuthMode`, `setAgentAuthMode`,
`getAgentAuthConfig`, `loadUserWithRole`; types `AuthMode`, `UserWithRole`, `LoginContext`,
`PasswordStepResult`.
**Cross-service deps:** `src/utils/password.ts`, `src/utils/loginLockout.ts`,
`src/utils/crypto.ts` (TOTP secret envelope), `passwordPolicyService`, `totpService`,
`totpStepService`, `settingsStore` (Setting `auth.mode`), `eventService → logEvent()`.
**Used by:** `src/api/routes/auth.ts`, `src/api/routes/agent.ts` (`GET /agent/auth-config`),
`src/api/routes/agents.ts → /agents/login` (`localLogin`).
**Invariants:** an unknown username costs one argon2 verify like a known one; the per-username
failure counter covers password, LDAP and TOTP steps and is cleared only when no factor is still
owed; a forced password change is offered only after every factor passed; a TOTP code is
accepted once (`totpStepService.claimTotpStep`); the TOTP secret is a `crypto.ts` envelope
(rule 3) — `openTotpSecret()` still reads a legacy plaintext base32.
**When changing this:** the login steps are pinned by `tests/unit/usersAuthRoutes.test.ts`; a new
first factor (LDAP, passkey) must feed the SAME lockout counter and the same pending-auth
hand-off (`src/utils/pendingAuth.ts`), never a parallel one.

---

## services/ssoProvisioning.ts

**What it owns:** the one find-or-provision path for SAML / OIDC / LDAP / App Proxy operators.
**Public API:** `provisionExternalUser`, `deriveUsername`, `normalizeGroupList`,
`DEFAULT_SSO_ROLE_NAME`; types `ExternalUserProfile`, `ExternalProvider`.
**Cross-service deps:** `groupMappingService → resolveGroupsToAccess()`.
**Used by:** `samlAuthService`, `oidcAuthService`, `ldapAuthService`, `entraProxyAuthService`.
**Invariants:** a provisioned account has NO password (`passwordHash` null — the local path can
never sign it in); a login whose groups map nothing keeps an existing user's role (a manual
assignment is never clobbered) and gives a NEW user the built-in Read-Only role +
`needsRoleReview`; SAML and App Proxy share `azureOid`, and the last login path owns
`authProvider` + `ssoGroups`.
**When changing this:** renaming the Read-Only role breaks the fallback (500 on first SSO login).

---

## services/samlAuthService.ts

**What it owns:** SAML 2.0 operator SSO (`@node-saml`) and the `saml` Setting.
**Public API:** `getSamlSettings`, `updateSamlSettings`, `defaultSamlSettings`,
`parseSamlSettings`, `samlBaseUrl`, `isSamlEnabled`, `getSamlLoginUrl`, `validateSamlResponse`,
`getSamlLogoutUrl`, `findOrProvisionSamlUser`, `testSamlSettings`, `resetSamlForTests`,
`SAML_CALLBACK_PATH`.
**Cross-service deps:** `settingsStore`, `ssoProvisioning`, `ssoProbe`,
`src/utils/samlReplayCache.ts`.
**Used by:** `src/api/routes/authSso.ts`, `authService` (`getAgentAuthConfig`,
`skipLoginSsoTarget`).
**Invariants:** assertions must be signed; a response naming InResponseTo is bound to its
request; every assertion id is accepted once (process-local cache). The SP base is the
operator's Application URL, else `CHARON_PUBLIC_URL` — with neither, SAML refuses rather than
trusting a Host header.
**When changing this:** the ACS path `/api/v1/auth/saml/callback` is configured at the IdP and
is CSRF-exempt by prefix (`csrf.ts`); the callback is a cross-site POST, so the session cookie is
usually absent there.

---

## services/oidcAuthService.ts

**What it owns:** OIDC operator SSO (Authorization Code + PKCE, `openid-client` v6) and the
`oidc` Setting.
**Public API:** `getOidcSettings`, `getOidcSettingsForUi`, `updateOidcSettings`,
`defaultOidcSettings`, `isOidcEnabled`, `getRedirectUri`, `buildAuthorizationUrl`,
`handleCallback`, `findOrProvisionOidcUser`, `testOidcConnection`, `resetOidcForTests`,
`OIDC_CALLBACK_PATH`.
**Cross-service deps:** `settingsStore`, `ssoProvisioning`, `src/utils/settingSecret.ts`.
**Used by:** `src/api/routes/authSso.ts`, `authService`.
**Invariants:** `clientSecret` is sealed at rest (rule 3), masked on read, and never reused
after the discovery URL or client id changes. The redirect URI is `CHARON_PUBLIC_URL`-based when
set, else the request origin (the IdP only honours registered URIs). state / nonce / PKCE live
in the session between login and callback.
**When changing this:** the callback rebuilds the URL on the redirect URI's base — the library
compares the two.

---

## services/ldapAuthService.ts

**What it owns:** operator sign-in by binding AS the user against LDAP / AD, group lookup, and
the `ldap` Setting.
**Public API:** `getLdapSettings`, `getLdapSettingsMasked`, `updateLdapSettings`,
`defaultLdapSettings`, `isLdapEnabled`, `authenticateLdapUser`, `findOrProvisionLdapUser`,
`testLdapConnection`, `resetLdapForTests`.
**Cross-service deps:** `ldapClient` (shared with `activeDirectoryService`), `settingsStore`,
`ssoProvisioning`, `src/utils/settingSecret.ts`.
**Used by:** `authService → passwordStep()` (LDAP accounts, and unknown names while LDAP is on),
`src/api/routes/authSso.ts` (settings / test).
**Invariants:** empty passwords are refused before any bind; the username is RFC 4515-escaped;
an unknown name pays a dummy bind (timing); exactly one search match or fail closed;
`bindPassword` sealed at rest and never reused after the URL or certificate check changes.
**When changing this:** `tests/unit/ldapLoginTiming.test.ts` pins the bind count.

---

## services/entraProxyAuthService.ts

**What it owns:** Entra Application Proxy header SSO and the `entraProxy` Setting.
**Public API:** `getEntraProxySettings`, `updateEntraProxySettings`, `isEntraProxyEnabled`,
`isTrustedEntraProxySource`, `isEntraProxyLoginAvailable`, `extractEntraProxyIdentity`,
`findOrProvisionEntraProxyUser`, `testEntraProxyRequest`, `identityHeaderNames`,
`defaultIdentityHeaderNames`, `clearEntraProxySettingsCache`.
**Cross-service deps:** `settingsStore`, `src/utils/ipAllowlist.ts`, `ssoProvisioning`.
**Used by:** `src/api/routes/authSso.ts`, `src/api/middleware/entraProxyHeaders.ts`,
`src/app.ts → sendToSignIn()` (silent auto-login).
**Invariants:** the headers are UNSIGNED — honoured only from an allowlisted connector source IP
(`req.ip`, trust-proxy resolved); no allowlist = no header login; untrusted requests have the
headers stripped (fail closed on a settings read error); duplicate headers are refused; header
names can never be infrastructure headers.
**When changing this:** behind a second proxy, `req.ip` is that proxy — the allowlist must name
what Charon sees.

---

## services/passkeyService.ts

**What it owns:** WebAuthn passkeys for local accounts (`@simplewebauthn/server`) — the
`passkeyConfig` policy, the register / passwordless-login / second-factor ceremonies, and
credential CRUD.
**Public API:** `getPasskeySettings`, `savePasskeySettings`, `defaultPasskeySettings`,
`normalizeRpId`, `passkeyLoginEnabled`, `passkeySecondFactorEnabled`, `requireRelyingParty`,
`getPasskeyAvailability`, `anyLoginPasskeyRegistered`, `listPasskeys`, `countPasskeysByUser`,
`renamePasskey`, `deletePasskey`, `deleteAllPasskeys`, `startRegistration`,
`finishRegistration`, `startLogin`, `startSecondFactor`, `finishAuthentication`,
`userHasPasskey`, `invalidatePasskeyCache`, `PASSKEY_SETTING_KEY`.
**Cross-service deps:** `settingsStore`, `src/utils/webauthnChallenge.ts`,
`src/utils/webauthnRp.ts`.
**Used by:** `src/api/routes/authPasskeys.ts`, `src/api/routes/auth.ts` (second-factor check),
`userService` (admin revoke).
**Invariants:** a read failure answers mode "off" (never lets a credential sign someone in);
never provisions a user; passwordless login names no credentials before the assertion
(no enumeration); a counter going backwards refuses the login (clone signal); RP ID + origin
are pinned at challenge issue time.
**When changing this:** passkeys need a secure context and a hostname — `webauthnRp.ts` explains
the refusals; the default mode is "both" (offering a stronger login refuses nothing).

---

## services/ssoProbe.ts

**What it owns:** the SSRF-guarded "is this IdP URL reachable" probe for the Test buttons.
**Public API:** `probeIdpUrl`; type `ProbeResult`.
**Cross-service deps:** `services/credentials/netGuard.ts → isBlockedOutboundHost()`.
**Used by:** `samlAuthService → testSamlSettings()`.
**Invariants:** http(s) only, never a blocked range; any HTTP status = reachable; no redirects
followed.
**When changing this:** keep the guard ahead of the fetch.

---

## services/userService.ts

**What it owns:** operator account management for the Users page — list (online dot from the
`session` table, TOTP and passkey status), create a local account, reset password, change role,
dismiss the SSO role-review flag, reset TOTP, list / revoke passkeys, delete.
**Public API:** `listUsers`, `createLocalUser`, `resetPassword`, `changeRole`,
`dismissRoleReview`, `resetTotp`, `listUserPasskeys`, `revokePasskeys`, `deleteUser`,
`getUserForAction`, `getRoleForAssignment`; types `UserListRow`, `Actor`.
**Cross-service deps:** `passwordPolicyService`, `roleService` (`countAdminEquivalentUsers`,
`isAdminEquivalentRole`), `sessionRevocationService`, `src/utils/loginLockout.ts`,
`eventService → logEvent()`.
**Used by:** `src/api/routes/users.ts`.
**Invariants:** lastAdminEquivalent — no action leaves zero users on an admin-equivalent role
(409); every change that should cut an account off revokes its sessions (the caller's own is
kept when acting on themselves). The escalation checks need the caller's Request, so the ROUTE
runs them (`permissions.ts → assertNoPrivilegeEscalation / assertGrantWithinCaller`) on the
account / role this service loads.
**When changing this:** `listUsers` is three queries regardless of row count — keep it that way
at 2000 operators (no per-row passkey or session lookups).

---

## services/roleService.ts

**What it owns:** Role CRUD and the admin-equivalence guards. Administrator is protected (no
edit / rename / delete); Operator and Read-Only are built-in (editable, not renamable, not
deletable); custom roles are free.
**Public API:** `listRoles`, `getRole`, `createRole`, `updateRole`, `deleteRole`,
`validateRoleName`, `normalizeRoleColor`, `countAdminEquivalentUsers`, `isAdminEquivalentRole`,
`assertRoleDemotionAllowed`; types `RoleSummary`, `CreateRoleInput`, `UpdateRoleInput`.
**Cross-service deps:** `permissions.ts` (`bumpRoleVersion`, `normalizePermissions`,
`isAdminEquivalentPermissions`, `FUNCTION_KEYS`), `eventService → logEvent()`.
**Used by:** `src/api/routes/roles.ts`, `userService`.
**Invariants:** every write calls `bumpRoleVersion()` so live session snapshots refresh; delete
refuses while a user or API token holds the role (group mappings cascade); a built-in name
cannot be taken by a custom role in any case.
**When changing this:** a new function key needs no change here (matrices are normalized), but
DOES need seeding in `src/cli/seed.ts`.

---

## services/groupMappingService.ts

**What it owns:** IdP group → Role mappings (provider `saml` / `oidc` / `ldap` / `entra-proxy`)
and the login-time resolver.
**Public API:** `resolveGroupsToAccess`, `normalizeGroupKey`, `isGroupMappingProvider`,
`listGroupMappings`, `getGroupMapping`, `createGroupMapping`, `updateGroupMapping`,
`deleteGroupMapping`, `roleGrantFor`, `mappingGrantState`, `invalidateGroupMappingCache`,
`GROUP_MAPPING_PROVIDERS`.
**Cross-service deps:** `permissions.ts → pickHighestPrivilegeRoleId()`,
`eventService → logEvent()`.
**Used by:** `src/api/routes/groupMappings.ts`; the SSO provisioning path.
**Invariants:** highest privilege wins across matched groups; `normalizeGroupKey()` runs on write
AND on incoming claims (LDAP / Entra lowercased, SAML / OIDC trimmed only); a mapping onto an
admin-equivalent role is allowed but logged at `warning`; the route refuses a mapping whose role
exceeds the caller. The enabled-mappings cache is 30 s per process.
**When changing this:** a new provider is a new `GROUP_MAPPING_PROVIDERS` entry and a decision
in `normalizeGroupKey()` about case.

---

## services/sessionRevocationService.ts

**What it owns:** ending an account's live sessions, and the online-user set — raw SQL on the
`session` table owned by connect-pg-simple.
**Public API:** `revokeUserSessions(userId, keepSid?)`, `getOnlineUserIds()`.
**Cross-service deps:** none (raw SQL).
**Used by:** `userService`, `src/api/routes/auth.ts` (self password change).
**Invariants:** best effort — the triggering change is already committed, so a failure returns
0, never throws; deletes signed-in sessions AND half-finished logins (`pendingAuth.userId`); the
backstop for paths that don't revoke is `src/api/middleware/sessionRevalidate.ts`.
**When changing this:** a renamed session field (`userId`, `pendingAuth`) breaks the JSON path
here silently.

---

## services/passwordPolicyService.ts

**What it owns:** the `passwordPolicyConfig` Setting (Users → Authentication → Settings); the
pure rules are `src/utils/passwordPolicy.ts`.
**Public API:** `getPasswordPolicy`, `savePasswordPolicy`, `assertPasswordMeetsPolicy`,
`passwordNeedsPolicyChange`, `invalidatePasswordPolicyCache`, `PASSWORD_POLICY_SETTING_KEY`.
**Cross-service deps:** `settingsStore`.
**Used by:** `userService` (create / reset), `authService` (forced and self change, login
re-check), `src/api/routes/auth.ts` (`/password-policy`).
**Invariants:** fails to the DEFAULT policy, never to "no policy"; `minLength` floor 8. The setup
wizard (`src/setup/setupRoutes.ts`) validates against `defaultPasswordPolicy()` with the same
evaluator.
**When changing this:** `forceChangeOnLogin` is evaluated against the plaintext at login only —
there is no other moment a hash can be checked.

---

## services/sessionSettingsService.ts

**What it owns:** the `sessionConfig` Setting — `autoLogoutMinutes` (server-side idle timeout in
`src/app.ts`, mirrored by the client) and `skipLoginPage`.
**Public API:** `getSessionSettings`, `peekSessionSettings`, `saveSessionSettings`,
`parseSessionSettings`, `clampAutoLogout`, `invalidateSessionSettingsCache`,
`AUTO_LOGOUT_MAX_MINUTES`.
**Cross-service deps:** `settingsStore`.
**Used by:** `src/app.ts` (idle-timeout middleware), `src/api/routes/auth.ts`
(`/session-settings`, `/me`).
**Invariants:** a failed read answers the defaults (no timeout) — settings trouble never signs
anyone out.
**When changing this:** the idle check runs on every request; keep it on the cached `peek()`.

---

## services/totpService.ts

**What it owns:** pure RFC 6238 helpers — secret generation, the otpauth URI + QR SVG, code →
time-step verification (±1 step), backup codes (argon2id-hashed).
**Public API:** `generateSecret`, `buildEnrollment`, `verifyCode`, `verifyCodeStep`,
`generateBackupCodes`, `consumeBackupCode`.
**Cross-service deps:** `src/utils/password.ts`.
**Used by:** `authService`.
**Invariants:** SHA1 / 6 digits / 30 s — changing them invalidates every enrollment.
**When changing this:** pure; replay protection is `totpStepService`.

---

## services/totpStepService.ts

**What it owns:** one-time use of a TOTP code — `User.totpLastStep`.
**Public API:** `claimTotpStep(userId, step)`.
**Cross-service deps:** none.
**Used by:** `authService` (login step, self-disable).
**Invariants:** one conditional UPDATE, so two concurrent submissions of a code cannot both win.
**When changing this:** the enrollment confirm records its step too, so the confirming code
cannot be replayed at login.

---

## services/settingsStore.ts

**What it owns:** the TTL-cached "JSON blob in a Setting row" accessor.
**Public API:** `createSettingStore({ key, ttlMs, parse })` → `get` / `peek` / `save` /
`invalidate`; type `SettingStore`.
**Cross-service deps:** none.
**Used by:** `webAccessSettingsService`, `passwordPolicyService`, `sessionSettingsService`,
`authService` (`auth.mode`).
**Invariants:** the cache is per process — a write reaches other processes / the HA peer within
`ttlMs`; the store has no read-failure opinion (each caller picks its own fallback).
**When changing this:** none of its adopters may rely on read-after-write across processes.

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
apiToken, assetTag, backup, customGroup, fortinetEnforcement, integration,
invitationCode, policy, rebootSettings, tagReconciler, tag, update,
verification.
**Invariants:** best-effort — a failed write never breaks the underlying operation. Every
audit-worthy mutation writes one.
**When changing this:** a test that counts Event rows a request wrote must poll when the
writer does not await `logEvent()`.
