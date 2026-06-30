# Charon Endpoint Agent (Tauri)

Small-footprint endpoint agent: enrolls with a one-time invitation code,
reports posture telemetry, and presents the **server-dictated** user login
(local / SAML / OIDC). Windows-first, then macOS and Linux.

## Layout

- `src-tauri/` — Rust core (Tauri v2)
  - `src/config.rs` — persisted server URL, bearer, and **cert pins**
  - `src/client.rs` — HTTP client that trusts **only** the server leaf-cert
    SHA-256 pin (not system roots); TLS 1.3, PQC-hybrid KEX as the rustls
    provider supports `X25519MLKEM768`
  - `src/posture.rs` — disk-encryption / firewall / AV / OS collectors
  - `src/main.rs` — Tauri commands (`enroll`, `get_auth_config`, `login`) +
    the background heartbeat/posture loop
- `ui/` — web GUI (vanilla JS) reusing the Charon stylesheet so it matches the
  server. Enrollment view → server-dictated login view.

## Trust model

The agent does **not** trust system roots. At enrollment the server returns its
leaf-cert SHA-256 pin(s); the agent pins them and accepts the TLS connection
only when the presented leaf matches (canonical ∪ staged, for dual-pin
rotation). The bearer is stored locally and sent on every authenticated call.

## Build (CI / release only)

The server image ships **no** Rust toolchain. Installers (MSI / NSIS / dmg /
AppImage / deb) are produced in CI via `tauri build` and published as release
artifacts; the server's Maintenance tab serves the prebuilt installers and the
cert-pin rotation pane. `agent/VERSION` is bumped on any agent change.

```
cd agent && cargo tauri build      # produces platform installers
```

Icons (`src-tauri/icons/`) are provided by the CI bundle step.
