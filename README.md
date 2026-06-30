# Charon

**Charon** is a Zero Trust Network Access (ZTNA) platform. It brokers identity- and
posture-based network access for endpoint computers and enforces decisions through a
Fortinet estate (FortiManager + FortiGate) using dynamic, tag-driven firewall policies.

> ⚠️ **Status: early scaffolding.** This repository currently contains project automation
> (CI, CodeQL, Dependabot) and security/contribution docs. Application code is being built out.

## How it works

1. An **endpoint agent** enrolls with the server using a one-time invitation code and opens a
   persistent, mutually-authenticated telemetry connection.
2. The agent presents a **login GUI** whose authentication mode (local / SAML / OIDC) is
   dictated by the server. The user authenticates for verification.
3. The server resolves the user + device to **ZTNA tags** derived from directory group/OU
   membership (Active Directory / Entra ID / Intune), app-defined custom groups, and device
   posture.
4. The server **syncs those tags to FortiManager / FortiGate** as dynamic address-group
   members and maintains dynamic firewall policies that reference them — kept continuously
   up to date as users log in and out and as posture changes.

## Architecture (high level)

- **Server:** Node.js + TypeScript, Express, Prisma, PostgreSQL. Multi-process by function
  (web UI/API, endpoint communications, Fortinet enforcement, background workers), coordinated
  through PostgreSQL + a job queue, fronted by nginx for TLS termination.
- **Endpoint agent:** Tauri (Rust core + web GUI), small per-endpoint footprint, cross-platform.
- **High availability:** primary/standby across datacenters via PostgreSQL streaming replication
  with application leader election; designed to sit behind an external GSLB.

## Security

Security lives in the cryptography and protocol design, not in keeping the source private.
The platform targets post-quantum-hybrid transport (ML-KEM), modern signatures, and
quantum-resistant symmetric/at-rest cryptography, with certificate pinning between agents and
server. See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

> The cryptographic and protocol design, and any enforcement against production firewalls,
> require expert human review before production use.

## License

License to be determined. Until a `LICENSE` file is added, all rights are reserved.
