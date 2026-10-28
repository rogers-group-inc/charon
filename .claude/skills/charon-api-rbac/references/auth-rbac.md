# Auth and RBAC

## The three auth surfaces (`src/api/middleware/auth.ts`)

- **Session** (UI / browser): cookie-bearing requests via `express-session` +
  `connect-pg-simple`. RBAC enforced by `requirePermission(functionKey, level)`.
- **API bearer** (external): `Authorization: Bearer charon_<…>` from a long-lived ApiToken,
  resolved by `attachApiToken` before any gate and verified by
  `src/services/apiTokenService.ts → verifyToken()`. The token acts with its **bound role's**
  matrix: `requirePermission` → `resolveSnapshot()` reads `ApiToken.roleId` fresh per request
  (no session to cache in), and a presented, verified token wins over any ambient session. A
  legacy token with no role resolves to no snapshot → 403 on every role gate; only
  `requireSessionOrTokenPermission` still honours its fixed `scopes` (business rule 8).
  `attachApiToken` refuses ONE case itself: a real token presented from outside its
  `trustedHosts` → 403 naming the address Charon saw (behind a proxy with `trust proxy` unset,
  that is the proxy's address). Unknown / revoked / expired tokens fall through as "no token"
  and the downstream guard answers 401. Minting a token bound to a role that outranks the
  caller on any key is refused (`grantExceedsCaller()`); an admin-equivalent binding is allowed
  but logs an `api_token.admin_equivalent` warning Event.
- **Agent bearer**: the per-endpoint bearer, `requireAgentBearer`, verified against the Endpoint
  bearer store (`src/services/agentTokenService.ts → verifyBearer()`); 401 when missing,
  invalid or revoked.

## Permission model (`src/api/middleware/permissions.ts`)

- `FUNCTION_KEYS` — one row per functional area, in the order the UI matrix renders:
  endpoints, invitationCodes, tags, policies, groups, integrations, **enforcement** (separate,
  high blast radius — Full Read-Write only), directory, credentials, events, apiTokens, users,
  roles, serverSettingsSystem, serverSettingsData.
- Levels `none < read < write < fullwrite` (`ACCESS_LEVELS`). `normalizePermissions()` drops
  unknown keys and bad values and defaults every key to `none`.
- **Session snapshot**: the session carries a denormalized `SessionRoleSnapshot` (id, name,
  isProtected, permissions, updatedAt). `ensureSessionRoleSnapshot()` refreshes it when the
  role's `updatedAt` moves past the snapshot; call `bumpRoleVersion()` after every role write.
  A deleted role answers 401 ("Your role no longer exists").
- **Group mapping** (SSO): `GroupMapping` rows map IdP group keys → roles;
  `pickHighestPrivilegeRoleId()` picks by `rankRole()` — admin-equivalent
  (`users` + `roles` fullwrite) outranks everything, otherwise the sum of levels, ties broken by
  id.

## CSRF (`src/api/middleware/csrf.ts`)

Synchronizer token per session, mirrored into a readable cookie so same-origin page JS echoes it
in `X-CSRF-Token` on state-changing requests (`public/js/api.js` threads it). Agent paths
(`/api/v1/agents/`) are exempt (`EXEMPT_PATH_PREFIXES`). Defense-in-depth on top of
`SameSite=Lax` + strict JSON content types.

Two more exemptions:
- **`/api/v1/ha/enroll`** (and `/api/v1/ha/enroll/<x>`) — matched EXACTLY, never as a prefix
  (`isHaEnrollPath()`): `/api/v1/ha/enrollments/:id/approve` is a session route that keeps its
  check. The single-use token in the body is that route's defense.
- **Session-less bearer requests** (`isSessionlessBearer()`): an `Authorization: Bearer …`
  request with NO logged-in session skips the check — a browser cannot attach that header
  cross-origin without a CORS preflight Charon never grants. With a session present the normal
  check still runs.

## Other request-path gates

- **Local Login Access** (`src/api/routes/auth.ts → assertLoginSourceAllowed()`): when the
  `loginAccessConfig` Setting is enabled, `POST /auth/login` and `/auth/login/totp` answer 403
  from outside its IP scope (`src/services/webAccessSettingsService.ts →
  isLoginSourceAllowed()`). SAML/OIDC are never restricted; the gate fails OPEN on a settings
  read error so a DB blip is never a lockout.
- **Credential ownership** (`src/api/routes/settings/credentials.ts →
  assertCredentialOwnership()`): on the `credentials` key, write reaches only rows whose
  `createdBy` is the caller, fullwrite any row; an unowned (null) row is fullwrite-only.
- Settings-route limiters (`makeRateLimiter()`): `haEnrollLimiter` (`/ha/enroll`),
  `credentialTestLimiter` (`POST /credentials/test`), `maintenanceLimiter` (database / backup /
  advisor reads), `logoLimiter` (branding logo), `installerLimiter` (1 min / 30, the agent
  installer listing + download in `src/api/routes/maintenance.ts`).

## Rate limits (`src/api/middleware/rateLimits.ts`)

`loginLimiter` (15 min / 10) on `/api/v1/auth/login`; `enrollLimiter` (10 min / 30) on
`/api/v1/agents/enroll` — both mounted with `app.use` in `src/app.ts`, so they are invisible
from the route file. `makeRateLimiter()` builds others — the first-run wizard's `setupActionLimiter` (15 min / 30) in
`src/setup/setupRoutes.ts` guards its test-connection and finalize routes.

Two more are attached per route, in the route file:

- `agentLoginLimiter` (15 min / 10) on `POST /agents/login`, **keyed by endpoint id**, not IP — a
  fleet behind one NAT address must not share a bucket (one mistyped password would lock out
  every endpoint behind it).
- `adminActionLimiter` (15 min / 20) on the destructive Server Settings actions —
  `POST /server-settings/database/restore`, `/updates/apply`, `/restart`, `/certificates`
  (trusted-CA upload), `/proxy/apply`, `/proxy/cert/rotate`, `/agents/cert-pins/bulk-add|remove`,
  `PUT /login-access` (the local-login source scope), and
  `POST /ha/enable|disable|tokens|enrollments/:id/approve` — placed before
  `requirePermission`, **keyed by operator username** so admins on a shared jump host don't
  throttle each other. API-token callers have no session username, so they share their IP's
  bucket.

Both fall back to `ipKeyGenerator(req.ip)` when the key is missing. CodeQL's
`js/missing-rate-limiting` flags any handler that does file-system, process or credential work
without a limiter in front of it — give a new expensive or credential-checking route one.
`tests/unit/rateLimits.test.ts` → "limiter attachment" asserts the attachments a port or route
move has dropped before (the alert number stays with the line, not the route); add a route
there when you give it a limiter.

## permissions (RBAC) — touches entry

Moved verbatim from TOUCHES.md.

- **Owns:** function-key catalogue, access-level ranking, session snapshot.
- **Used by:** every authenticated route mount + `app.js` nav gating.
- **When changing:** adding a function key → seed it on built-in roles (`prisma/seed.ts`
  matrix — now `src/cli/seed.ts → seedDatabase()`), guard the routes, and add it to the nav
  map + any `Charon.can()` checks in the frontend.

A client gate that names another page's permission key fails SILENTLY — no 403, the control
just never renders. Check the route's `requirePermission` before choosing the key for a
`Charon.can()` call.
