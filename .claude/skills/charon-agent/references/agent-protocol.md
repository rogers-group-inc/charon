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
| ask which login to show | `GET /api/v1/agent/auth-config` (public) — `{ mode, params }`: `params.ready` (the provider is configured), `loginPath`, and `entityId` / `issuer` for SAML / OIDC; `ldap` for local mode (LDAP credentials also work at `/agents/login`). The mode is set in Users → Authentication → Settings (`PUT /auth/agent-mode`); the agent's SSO browser flow is not wired yet | `src/services/authService.ts → getAgentAuthConfig()` |
| enroll | `POST /api/v1/agents/enroll` (public, `enrollLimiter`) | `src/services/agentEnrollmentService.ts → enroll()` — optional `observedFingerprint` (the leaf SHA-256 a pinned agent saw) must be an agent pin or the enroll is refused and the code left spent; a code minted by a push deployment flips that deployment `active` (`agentDeployService → markDeploymentEnrolled()`) |
| heartbeat | `POST /api/v1/agents/heartbeat` (bearer) | `src/api/routes/agents.ts` (inline Endpoint update) |
| posture | `POST /api/v1/agents/posture` (bearer) | `src/services/postureService.ts → ingestPosture()`; reconcile on change |
| config / pin refresh | `GET /api/v1/agents/config` (bearer) | `src/services/certPinService.ts → getAgentCertPins()` + auth mode |
| user login / logout | `POST /api/v1/agents/login` (bearer, `agentLoginLimiter`), `/logout` (bearer) | `src/services/verificationService.ts → bindVerification()` / `clearBinding()`; reconcile |
| telemetry | WS `/api/v1/agents/ws` (bearer in `Sec-WebSocket-Protocol`) | `src/api/routes/agentsWs.ts` + `src/services/agentChannelService.ts` (session manager, ported from polaris) — open → `online` + `hello` frame, close → `offline` (unless a newer socket replaced it); 30 s ping / pong; a non-JSON frame closes that socket; posture over WS reconciles on change |
| server → agent | WS frame `{type:"refresh-config"}` | `agentChannelService → publishConfigRefresh()` — every pin-store change broadcasts it (`certPinService`), cross-process via Postgres NOTIFY `charon_agent_cfg_refresh`; the agent re-reads `GET /agents/config` |
| installer download | `GET /api/v1/agents/binary/:file` (public, `agentBinaryLimiter`) | `src/api/routes/agentBinary.ts` — manifest files only; the Windows push install fetches here pinned |
| liveness | (leader job) | `src/jobs/endpointSilenceJob.ts` — an `online` endpoint silent for 2 heartbeat intervals goes `offline`; abstains while the whole fleet is dark |

## Agent side (`agent/src-tauri/src/`)

- `main.rs` — Tauri commands `enroll`, `get_auth_config`, `login`, `is_enrolled`, and
  `telemetry_loop` (a 60-second interval sending heartbeat + posture). At startup an
  un-enrolled agent that can read a push-deploy preseed enrolls from it
  (`enroll_from_preseed`): pinned from the first request, reporting the observed leaf
  fingerprint, then the file is deleted (also on a 403 — a refused code never succeeds).
- `preseed.rs` — the enrollment preseed: `/etc/charon-agent/enroll.json`,
  `/Library/Application Support/Charon/enroll.json`, `%ProgramData%\Charon\agent\enroll.json`;
  root / SYSTEM-only, so only a privileged (service-mode) agent consumes it (business rule 12).
- `client.rs` — HTTP client trusting only the pinned leaf SHA-256; `pinned_client_observed`
  also records which pin the server presented.
- `config.rs` — persisted server URL, bearer, cert pins.
- `posture.rs` — disk-encryption / firewall / AV / OS collectors.

SAML / OIDC agent login — TODO: populate when the provider callbacks are implemented.

Agent-side gaps (state 2026-10-28, agent 0.1.2): the agent does not yet open the telemetry WS
(so `refresh-config` reaches only future WS clients — today's agents pick pins up on their
`/agents/config` poll), has no tray / background-service mode (so a push-deployed agent waits for
manual enrollment), and no CI build compiles it — the 0.1.2 changes (preseed, observed
fingerprint, a `Deserialize` derive the enroll response always needed) are unverified by a
compiler.
