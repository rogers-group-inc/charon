# Endpoint catalogue (under /api/v1)

Gates read "mount gate" unless the route adds its own. Paths are relative to `/api/v1`. The
public / authenticated split and catalogue moved from ARCHITECTURE.md § 4, expanded per route
file.

### Public — operator auth (`src/api/routes/auth.ts`)
- `POST   /auth/login`          — local login (argon2id); `loginLimiter`
- `POST   /auth/login/totp`     — second factor
- `POST   /auth/logout`
- `GET    /auth/me`             — current user + permissions snapshot (drives `Charon.init()`)

### Public — agent (`src/api/routes/agent.ts`, `src/api/routes/agents.ts`, `src/api/routes/agentsWs.ts`)
- `GET    /agent/auth-config`   — server-dictated agent login mode
- `POST   /agents/enroll`       — invitation code → bearer + cert pins (rate-limited)
- `POST   /agents/heartbeat`    — agent bearer
- `POST   /agents/posture`      — agent bearer; enqueues a reconcile when the state changed
- `GET    /agents/config`       — agent bearer; current pins (rotation) + active auth mode
- `POST   /agents/login`        — agent bearer; binds {user↔device↔IP}, enqueues reconcile
- `POST   /agents/logout`       — agent bearer; clears the binding, enqueues reconcile
- WS `GET /agents/ws`           — telemetry (bearer in `Sec-WebSocket-Protocol`)

### Endpoints — `endpoints read` (`src/api/routes/endpoints.ts`)
- `GET    /endpoints/invitations`        — `invitationCodes read`
- `POST   /endpoints/invitations`        — `invitationCodes write`; plaintext shown once
- `DELETE /endpoints/invitations/:id`    — `invitationCodes write`
- `GET    /endpoints`
- `GET    /endpoints/:id`                — includes tags
- `POST   /endpoints/:id/revoke`         — `endpoints write`

### Integrations — `integrations read` (`src/api/routes/integrations.ts`)
- `GET    /integrations/types`
- `GET    /integrations`, `GET /integrations/:id` — secrets masked
- `POST   /integrations`, `PUT /integrations/:id`, `DELETE /integrations/:id` — `integrations write`
- `POST   /integrations/:id/test`, `POST /integrations/test` (unsaved config) — `integrations write`
- `POST   /integrations/:id/discover` — `integrations write`
- `PATCH  /integrations/:id/enforcement` — **`enforcement fullwrite`** (dry_run ⇄ enforce)
- `GET    /integrations/:id/enforcement-state` — `enforcement read`

### Directory — `directory read` (`src/api/routes/directory.ts`)
- `GET    /directory` — read-only DirectoryObject listing

### Groups — `groups read` (`src/api/routes/groups.ts`)
- `GET    /groups`, `GET /groups/:id/members`
- `POST   /groups`, `PUT /groups/:id`, `DELETE /groups/:id` — `groups write`

### Tags — `tags read` (`src/api/routes/tags.ts`)
- `GET    /tags`
- `POST   /tags`, `PUT /tags/:id`, `DELETE /tags/:id` — `tags write`
- `POST   /tags/:id/sources`, `DELETE /tags/sources/:sourceId` — `tags write`
- `POST   /tags/reconcile` — `tags write`; fleet-wide reconcile

### Policies — `policies read` (`src/api/routes/policies.ts`)
- `GET    /policies`
- `POST   /policies`, `PUT /policies/:id`, `DELETE /policies/:id` — `policies write`

### Public — HA node enrollment (`src/api/routes/settings/ha.ts` → `haEnrollRouter`)
Mounted at `/ha/enroll` BEFORE `requireAuth`; rate-limited (`haEnrollLimiter`); CSRF-exempt at
exactly this path. The caller holds a single-use token, never a session (business rule 9).
- `POST   /ha/enroll`               — spend the token, record a pending request, return the poll handle
- `GET    /ha/enroll/:requestId`    — poll; `?download=1` downloads the bundle once, after approval

### Server settings — `serverSettingsSystem read` (`src/api/routes/serverSettings.ts`)
- `GET    /server-settings/ha` — leader state + replication (older summary; the HA tab uses `/ha/*`)
- `GET    /server-settings/auth-mode`, `PUT /server-settings/auth-mode` (fullwrite)
- `GET    /server-settings/identification`

The old `/server-settings/certificates{,/stage,/promote}` routes are gone; the leaf cert changes
only through the Web Server tab's rotate flow below.

### Server Settings tabs (`src/api/routes/settings/*.ts`)
Mounted at `/server-settings` (and the root mounts noted) with NO router-level gate — every route
declares its own `requirePermission`. "sys" = `serverSettingsSystem`, "data" =
`serverSettingsData`.

**Time & NTP** (`ntp.ts`)
- `GET /server-settings/ntp` — sys read; `PUT /server-settings/ntp` — sys write (+ chrony apply);
  `POST /server-settings/ntp/test` — sys write (real SNTP / NTS-KE probe)

**Identification** (`identification.ts`) — sys read for GET / previews, sys write for mutations and outbound probes
- `/server-settings/tags` (GET, POST), `/tags/settings` (GET, PUT), `/tags/filter-schema` (GET),
  `POST /tags/preview-criteria` (read), `PUT|DELETE /tags/:id` — asset tags, not ZTNA tags
- `GET|PUT /server-settings/dns`, `POST /dns/test` (write)
- `GET /server-settings/oui`, `POST /oui/refresh`, `GET /oui/lookup/:prefix`,
  `GET|POST /oui/overrides`, `DELETE /oui/overrides/:prefix`
- `GET|PUT /server-settings/reservation-mac`
- root mount `/device-icons`: `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`; `GET /:id/image` —
  no permission key (any signed-in user; SVG served under a sandboxing CSP)
- root mount `/asset-types`: `GET /`, `GET /match-schema`, `POST /match-preview` (read),
  `POST /match-apply` (write), `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`

**Web Server** (`webServer.ts`) — anything touching TLS, pins, nginx or the login scope is fullwrite
- `GET /server-settings/certificates` (read), `POST` (fullwrite, multipart), `DELETE /:id`
  (fullwrite) — trusted CA list, NOT the leaf
- `GET /server-settings/https` (read) — served leaf-cert facts
- `GET /server-settings/proxy` (read); `PUT /proxy`, `POST /proxy/adopt-managed-mode`,
  `POST /proxy/apply` (fullwrite)
- `POST /server-settings/proxy/cert/preflight` (fullwrite, multipart cert + key) — validate a pair
- `POST /server-settings/proxy/cert/rotate` (fullwrite) — refuses an unstaged pin (409)
- `GET /server-settings/agents/cert-pins/summary` (read) — per-pin uptake + the accepted store
- `POST /server-settings/agents/cert-pins/bulk-add` (fullwrite) — stage a pin
- `POST /server-settings/agents/cert-pins/bulk-remove` (fullwrite) — retire a pin; 409 for the
  served cert's pin; the last pin is never retired (business rule 4a)
- `GET|PUT /server-settings/dash` (read / fullwrite), `GET|PUT /ipv6` (read / write),
  `GET|PUT /login-access` (read / fullwrite)

**Maintenance + Retention** (`maintenance.ts`, mounted at `/server-settings`)
- `GET /server-settings/database`, `/capacity-advisor`, `/platform-lifecycle`, `/pg-tuning`,
  `/queue-mode` — sys read; `POST /capacity-advisor/stage` — sys write (stages `.env`)
- `POST /database/backup` (data write); `POST /database/restore` (data fullwrite, multipart);
  `GET /database/backups`, `/database/backup-tooling` (data read); `DELETE /database/backups/:id`,
  `GET /database/backups/:id/download` (data write)
- `GET /database/backup-schedule` (data read); `PUT` (data fullwrite — holds a passphrase)
- `POST /queue-mode`, `POST /security-tokens/generate` (data write); `POST /restart` (data fullwrite)
- `GET /updates/check`, `/updates/status`, `/updates/repo`, `/updates/settings`,
  `/updates/history` (data read); `POST /updates/apply` (data fullwrite); `POST /updates/dismiss`,
  `PUT /updates/settings` (data write); `GET /updates/activity` — no permission key (any
  signed-in user; redacted)
- `GET|PUT /sample-retention` (data read / write); `GET|PUT /agent-event-log` (sys read / write)

**Customization** (`customization.ts`)
- `GET /server-settings/branding` — no permission key (the sidebar reads it for every user);
  `PUT /branding`, `POST /branding/logo` (multipart, magic-byte checked, no SVG),
  `DELETE /branding/logo` — sys write
- `GET|PUT /server-settings/reboot` (sys read / write)

**Credentials** (`credentials.ts`)
- root mount `/credentials`: `GET /`, `GET /usage`, `GET /:id`, `GET /:id/usage` (credentials
  read); `POST /test` (credentials write, rate-limited, ownership-scoped), `POST /`, `PUT /:id`,
  `DELETE /:id` (credentials write: own rows; fullwrite: any row)
- `/server-settings/mibs`: `GET /facets`, `GET /std`, `GET /std/:key/structure`, `GET /`,
  `GET /:id`, `GET /:id/download`, `GET /:id/structure` (sys read); `POST /` upload,
  `DELETE /:id` (sys write); `POST /std/:key/walk`, `POST /:id/walk` (sys read + credentials write)
- `/server-settings/manufacturer-aliases`: `GET` (sys read); `POST`, `PUT /:id`, `DELETE /:id` (sys write)
- `/server-settings/manufacturer-profiles`: `GET /`, `/suggestions`, `/:id`, `/:id/export`,
  `/:id/code`, `/:id/widgets/:widgetId/assets` (sys read); `POST /`, `POST /import/preview`,
  `POST /import`, `PUT|DELETE /:id`, `PUT /:id/metrics/:metricKey`,
  `POST|PUT|DELETE …/overrides[/:overrideId]`, `POST|PUT|DELETE /:id/widgets[/:widgetId]`,
  `PUT /:id/widgets/:widgetId/assets`, `PUT /:id/code`, `PUT /:id/widget-layout` (sys write)

**API Tokens** (`apiTokens.ts`)
- `GET /server-settings/api-docs` (sys read), `PUT` (sys write)
- root mount `/api-tokens`: `GET /` (apiTokens read); `POST /` (mint, role-bound; raw token
  returned once), `PUT /:id/trusted-hosts`, `POST /:id/revoke`, `DELETE /:id` (apiTokens write)

**High Availability** (`ha.ts`; root mount `/ha`)
- `GET /ha/status`, `POST /ha/advisories` (sys read)
- `POST /ha/enable`, `POST /ha/disable`, `POST /ha/tokens`, `POST /ha/enrollments/:id/approve`,
  `POST /ha/enrollments/:id/reject`, `GET /ha/teardown-script` (sys **fullwrite**)

**Repository** (`firmware.ts`) — sys read to look, sys fullwrite to change
- `GET /server-settings/firmware/tree`, `/assets` (always empty), `/images`, `/images/:id`,
  `/bindings`, `/runs` (always empty), `/runs/:id` (always 404)
- `POST /firmware/images` (multipart ≤ 300 MiB; nginx location raises the body limit),
  `POST /images/:id/make-primary`, `DELETE /images/:id`, `POST /models/purge`,
  `PUT /bindings`, `DELETE /bindings/:id` (fullwrite)

### Maintenance — agent installers — `serverSettingsData read` (`src/api/routes/maintenance.ts`)
- `GET    /server-settings/maintenance/agents`, `GET …/agents/download/:file` — prebuilt installers (manifest allowlist)

Capacity, backups, updates and restart moved to `src/api/routes/settings/maintenance.ts` above.

### Events — `events read` (`src/api/routes/events.ts`)
- `GET    /events` — paginated, filtered audit log
