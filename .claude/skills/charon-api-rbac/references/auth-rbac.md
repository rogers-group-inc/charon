# Auth and RBAC

## The three auth surfaces (`src/api/middleware/auth.ts`)

- **Session** (UI / browser): cookie-bearing requests via `express-session` +
  `connect-pg-simple`. RBAC enforced by `requirePermission(functionKey, level)`.
- **API bearer** (external): `Authorization: Bearer charon_<…>` from a long-lived ApiToken,
  resolved by `attachApiToken` before any gate and scoped to a fixed list of capabilities
  (`ApiToken.scopes`). Verified by `src/services/apiTokenService.ts → verifyToken()`.
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

## Rate limits (`src/api/middleware/rateLimits.ts`)

`loginLimiter` (15 min / 10) on `/api/v1/auth/login`; `enrollLimiter` (10 min / 30) on
`/api/v1/agents/enroll` — both mounted with `app.use` in `src/app.ts`, so they are invisible
from the route file. `makeRateLimiter()` builds others — the first-run wizard's `setupActionLimiter` (15 min / 30) in
`src/setup/setupRoutes.ts` guards its test-connection and finalize routes.

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
