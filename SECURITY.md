# Security Policy

> **Note:** This is a starting template. The security contact and threat model below must be
> reviewed and completed by the Rogers Group security team before this repository is relied upon.

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Preferred: use GitHub's **[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
on this repository (Security tab → "Report a vulnerability").

Alternative contact: `TODO: add Rogers Group security contact`.

When reporting, please include:
- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected component(s) and version/commit.

We aim to acknowledge reports within a few business days and will keep you updated on
remediation progress. Please allow a reasonable disclosure window before any public discussion.

## Scope

Charon is security infrastructure. The threat model assumes the source code is public; the
security boundary is the cryptography and protocol design, not source secrecy.

High-value areas for scrutiny:
- **Agent ↔ server** transport (TLS, certificate pinning, mutual authentication) and the
  enrollment / token lifecycle.
- **Server ↔ FortiGate / FortiManager** API authentication and the firewall-policy writeback
  (object ownership scoping, dry-run gating).
- **User verification** (local / SAML / OIDC) and session/token signing.
- **Secret handling** (encryption at rest, no secrets in source or logs).

## Cryptography

The platform is designed to be crypto-agile and to use **hybrid post-quantum** transport
(e.g. `X25519MLKEM768`), post-quantum signatures where supported (ML-DSA, with classical
fallback recorded per-token), and quantum-resistant symmetric/at-rest primitives
(AES-256-GCM, SHA-384/512), with argon2id for password hashing.

Cryptographic primitives must come from vetted libraries — never hand-rolled — and the design
must be reviewed by a cryptography/security expert before production use.

## Handling of sensitive data

Do not commit secrets, credentials, private keys, or real production/customer data to this
repository. Use redacted or synthetic examples. Automated secret scanning and push protection
are enabled; treat any flagged item as a potential incident.
