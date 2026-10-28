# Agent protocol

First paragraph moved verbatim from ARCHITECTURE.md § 7.

Enroll → `{ endpointId, bearerToken, serverCertPins }`. Thereafter the agent
sends heartbeat + posture (HTTP every 60s and/or over the telemetry WS), pinning
the server leaf cert. `GET /agents/config` returns current pins (for rotation) +
the active auth mode. User login (local) posts credentials → server binds
`{user↔device↔IP}` and reconciles. SAML/OIDC complete in the browser and bind
via the provider callback.

## Routes (server side)

| Agent action | Route | Server code |
|---|---|---|
| ask which login to show | `GET /api/v1/agent/auth-config` (public) | `src/services/authService.ts → getAgentAuthConfig()` |
| enroll | `POST /api/v1/agents/enroll` (public, `enrollLimiter`) | `src/services/agentEnrollmentService.ts → enroll()` |
| heartbeat | `POST /api/v1/agents/heartbeat` (bearer) | `src/api/routes/agents.ts` (inline Endpoint update) |
| posture | `POST /api/v1/agents/posture` (bearer) | `src/services/postureService.ts → ingestPosture()`; reconcile on change |
| config / pin refresh | `GET /api/v1/agents/config` (bearer) | `src/services/certPinService.ts → getAgentCertPins()` + auth mode |
| user login / logout | `POST /api/v1/agents/login`, `/logout` (bearer) | `src/services/verificationService.ts → bindVerification()` / `clearBinding()`; reconcile |
| telemetry | WS `/api/v1/agents/ws` (bearer in `Sec-WebSocket-Protocol`) | `src/api/routes/agentsWs.ts` — open → `online`, close → `offline`; posture over WS reconciles on change |

## Agent side (`agent/src-tauri/src/`)

- `main.rs` — Tauri commands `enroll`, `get_auth_config`, `login`, `is_enrolled`, and
  `telemetry_loop` (a 60-second interval sending heartbeat + posture).
- `client.rs` — HTTP client trusting only the pinned leaf SHA-256.
- `config.rs` — persisted server URL, bearer, cert pins.
- `posture.rs` — disk-encryption / firewall / AV / OS collectors.

SAML / OIDC agent login — TODO: populate when the provider callbacks are implemented.
