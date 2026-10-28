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
- `POST   /agents/login`        — agent bearer; `agentLoginLimiter` (per endpoint); binds {user↔device↔IP}, enqueues reconcile
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

### Server settings — `serverSettingsSystem read` (`src/api/routes/serverSettings.ts`)
- `GET    /server-settings/certificates`
- `POST   /server-settings/certificates` — `serverSettingsSystem fullwrite`; `adminActionLimiter`; sets the canonical agent pin
- `POST   /server-settings/certificates/stage` — fullwrite; stage the next pin (dual-pin)
- `POST   /server-settings/certificates/promote` — fullwrite; promote the staged pin
- `GET    /server-settings/ha` — leader state + replication
- `GET    /server-settings/auth-mode`, `PUT /server-settings/auth-mode` (fullwrite)
- `GET    /server-settings/identification`

### Maintenance — `serverSettingsData read` (`src/api/routes/maintenance.ts`)
- `GET    /server-settings/maintenance/capacity`
- `GET    /server-settings/maintenance/backups`; `POST …/backups` (write); `GET …/backups/download/:file` (write); `POST …/backups/restore` (fullwrite, `adminActionLimiter`)
- `GET    …/update/check`, `GET …/update/status`; `POST …/update/start` (fullwrite, `adminActionLimiter`)
- `POST   …/restart` (fullwrite, `adminActionLimiter`)
- `GET    …/agents`, `GET …/agents/download/:file` — prebuilt installers (manifest allowlist)

### Events — `events read` (`src/api/routes/events.ts`)
- `GET    /events` — paginated, filtered audit log
