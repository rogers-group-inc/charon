---
name: charon-agent
description: "The Charon endpoint agent (Tauri: Rust core in agent/src-tauri, web GUI in agent/ui) end to end: enrollment with a one-time invitation code, the per-agent bearer, leaf-cert SHA-256 pinning instead of system roots and dual-pin rotation (stage → rotate → promote), the heartbeat + posture loop and the telemetry WebSocket, the server-dictated login GUI (local / SAML / OIDC) and the {user↔device↔IP} binding, posture collectors, how installers are built and served from the Maintenance tab, and agent/VERSION. Load for anything under agent/, the /agents/* and /agent/* routes, enrollment, invitation codes, cert pins or certificate rotation, agent bearer revocation, posture reporting, or agent install / build / upgrade."
---

# Charon agent

The agent is a small Tauri app: it enrolls with a one-time invitation code, pins the server's
leaf certificate, reports heartbeat + posture, and shows the login GUI whose mode the server
dictates. Its trust model is business rule 4: **pin + bearer** — never system roots.

## Which file

| You need… | Read |
|---|---|
| the wire protocol: enroll response, heartbeat / posture cadence, the WS, config refresh, user login and binding | [references/agent-protocol.md](references/agent-protocol.md) |
| enrollment internals and cert-pin rotation (the two canonical patterns), revocation | [references/enrollment-pinning.md](references/enrollment-pinning.md) |
| the Rust / UI layout, how installers are built, versioned and served | [references/agent-build.md](references/agent-build.md) |

## Invariants

- **The agent trusts only the pinned leaf SHA-256** (canonical ∪ staged), not system roots
  (`agent/src-tauri/src/client.rs`; server side `src/services/certInfo.ts → leafPin()`).
- **Rotating the server cert without re-enrolling agents requires staging the new pin first**
  and letting every agent heartbeat it in, then promoting (rule 4).
- **Bearers and invitation codes are stored hashed (SHA-384) and shown once** (rule 3).
  Revoking a bearer sets the endpoint `revoked` and locks out both WS and HTTP.
- **A login, logout or posture-state change must reconcile tags** —
  `src/jobs/tagReconcileJob.ts → enqueueReconcile()` from the agent routes.
- **The server image ships no Rust toolchain**; installers are built outside it and served from
  a manifest allowlist.
- An agent response shape (`enroll`, `/agents/config`, `/agent/auth-config`) is parsed by
  `agent/src-tauri/src/main.rs` — change server and agent together and bump `agent/VERSION`.

Related: `charon-api-rbac` (the public agent routes and CSRF exemption),
`charon-change-impact` → services/agent-trust.md (the server-side services),
`charon-business-rules` (rules 3, 4).
