# Routes overview — mount order and gates

`src/app.ts` mounts `/api/v1` → `src/api/router.ts` (after the login / enroll limiters), plus
`/health` and `/metrics` (each optionally bearer-gated by `HEALTH_TOKEN` / `METRICS_TOKEN`) and
`/uploads` static. The agent telemetry WebSocket (`/api/v1/agents/ws`) is an HTTP upgrade
handler attached in `src/app.ts` on agent-comms roles, not an Express route.

Order inside `router.ts` matters:

| Order | Mount | Router file | Gate |
|---|---|---|---|
| 0 | (all) | — | `attachApiToken` resolves any bearer first |
| 1 | `/auth` | `src/api/routes/auth.ts` | public |
| 2 | `/agent` | `src/api/routes/agent.ts` | public |
| 3 | `/agents/enroll` | `src/api/routes/agents.ts` (`agentsEnrollRouter`) | public (invitation code; `enrollLimiter`) |
| 4 | `/agents` | `src/api/routes/agents.ts` (`agentsRouter`) | agent bearer |
| — | (all below) | — | `requireAuth` |
| 5 | `/endpoints` | `src/api/routes/endpoints.ts` | `endpoints` read |
| 6 | `/integrations` | `src/api/routes/integrations.ts` | `integrations` read |
| 7 | `/directory` | `src/api/routes/directory.ts` | `directory` read |
| 8 | `/groups` | `src/api/routes/groups.ts` | `groups` read |
| 9 | `/tags` | `src/api/routes/tags.ts` | `tags` read |
| 10 | `/policies` | `src/api/routes/policies.ts` | `policies` read |
| 11 | `/server-settings/maintenance` | `src/api/routes/maintenance.ts` | `serverSettingsData` read (inside the router) — mounted BEFORE `/server-settings` so its guard applies instead of serverSettingsSystem |
| 12 | `/server-settings` | `src/api/routes/serverSettings.ts` | `serverSettingsSystem` read |
| 13 | `/events` | `src/api/routes/events.ts` | `events` read |

The telemetry WebSocket handler lives in `src/api/routes/agentsWs.ts` (bearer in
`Sec-WebSocket-Protocol`).

Not yet mounted: users / roles / API-token management and credential routes — TODO: populate
when those routers exist (their function keys are already in the catalogue).
