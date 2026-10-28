---
name: charon-api-rbac
description: "Charon REST API under /api/v1 and its permission model: every route file and mount, which surfaces are public (operator login, agent auth-config, agent enroll + bearer-guarded telemetry, the agent WebSocket) and which sit behind requireAuth, Zod schema placement, the 15 function keys (endpoints, invitationCodes, tags, policies, groups, integrations, enforcement, directory, credentials, events, apiTokens, users, roles, serverSettingsSystem, serverSettingsData), requirePermission levels (none/read/write/fullwrite), built-in roles (Administrator / Operator / Read-Only), session role snapshots, SSO group mapping (highest privilege wins), API tokens and agent bearers, CSRF, and the login / enroll rate limiters. Load when adding or changing an endpoint or route gate, adding a permission key, debugging a 401/403 or CSRF failure, asking who can do X, minting tokens, anything about login, TOTP, SAML/OIDC, or touching src/api/."
---

# Charon API and RBAC

Every route lives under `/api/v1` (`src/api/router.ts`). Public surfaces mount BEFORE the
blanket `requireAuth`; everything after it needs a session or an API bearer, and each mount
applies its own `requirePermission(functionKey, level)`. Handlers are thin: validate with Zod
(schema at the top of the route file), call a service, return a response; errors are
`AppError` (`src/utils/errors.ts`) with an `httpStatus`, passed to `next(err)`.

## Which file

| You need… | Read |
|---|---|
| the RBAC model: function keys, levels, built-in roles, session snapshot + refresh, group mapping, the three auth surfaces, CSRF, rate limits; the touches entry for `permissions.ts` | [references/auth-rbac.md](references/auth-rbac.md) |
| the mount order, which mount carries which gate, public vs authenticated | [references/routes-overview.md](references/routes-overview.md) |
| every endpoint, its method, path and gate | [references/endpoints.md](references/endpoints.md) |

## The rules every route obeys

- **Declare the gate on the route.** The mount gives `read`; each mutating route adds its own
  `requirePermission(key, "write" | "fullwrite")`. An unknown key throws at boot
  (`requirePermission` validates against `FUNCTION_KEYS`).
- **`enforcement` is its own key** — live Fortinet writes are fullwrite-only and need human
  review (business rule 2). Never fold it into `integrations`.
- **Coerce `req.params.id` with `String()`** — Express 5 types it `string | string[]`. Express 5
  also rejects `:param(regex)` route syntax AT BOOT; keep paths plain and literal paths before
  `/:id`.
- **Untyped input never reaches a Prisma `where`** — parse with Zod first.
- **New endpoints go through a service** — never raw Prisma in a handler; any audit-worthy
  mutation writes an `Event`. Several route files still carry inline Prisma (`endpoints.ts`,
  `integrations.ts`, `serverSettings.ts`, `agents.ts`, `agentsWs.ts`, `auth.ts`,
  `directory.ts`, `events.ts`); extract opportunistically when you touch one, and until then any
  audit-worthy mutation there still writes its Event inline.
- **Agents never hold a session.** Agent routes are bearer-guarded (`requireAgentBearer`) and
  CSRF-exempt (`/api/v1/agents/`); never mount an agent route behind `requireAuth`.
- **Adding a function key** = an entry in `FUNCTION_KEYS` + seed it on built-in roles
  (`src/cli/seed.ts` matrix) + guard the routes + add it to the nav map / any `Charon.can()`
  checks in the frontend. Stored Role matrices missing the key read as `none`
  (`normalizePermissions`).

## Built-in roles (seeded by `src/cli/seed.ts → seedDatabase()`)

| Role | Matrix |
|---|---|
| Administrator | fullwrite everywhere; `isProtected` |
| Operator | write everywhere except: `roles` none; `enforcement`, `users`, `apiTokens`, `serverSettingsData` read |
| Read-Only | read everywhere |

Related: `charon-change-impact` (services behind each route), `charon-agent` (the agent
protocol over the public routes), `charon-ui-canon` (page → gate table).
