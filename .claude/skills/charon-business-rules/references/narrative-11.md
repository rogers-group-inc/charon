<a id="rule-11"></a>
## Rule 11 — A secret is never sent to an unauthenticated server

### What happened

The polaris integrations and agent-deploy stack were ported into Charon (2026-10-28, branch
`worktree-polaris-integrations-agent`). That brought a lot of outbound connections that carry a
secret: FortiOS and FortiManager API tokens (including FortiManager's fleet-wide direct-mode
FortiGate token), the AD bind password, the WinRM password, the SSH deployment key, and the
agent invitation code written over those transports. Fortinet appliances almost always present
self-signed certificates, so operators routinely turn `verifySsl` off. Charon's own credential
probes already pinned these identities, but in ad-hoc `Setting` rows
(`credentials.pin.<ssh|tls>:<host>:<port>`) with no UI to re-trust a host.

### Why it happened

With verification off, a request's bearer token goes to whatever answers at that address. In
polaris that is the history behind its business rule 113 (scan findings F6 / F7 / F10 / F66):
the token "used to go to whatever answered". The same holds for SSH: an ssh2 connection with no
host verifier authenticates to any server. TOFU detects an identity CHANGING; it cannot
authenticate a server that was already impersonated at first contact. But it turns a silent
credential leak into a refused connection with an Event.

### The decision

- Two tables, ported from polaris: `SshHostKey` and `TlsCertPin`, keyed by the address dialed
  (no Endpoint FK). Every `ssh2.connect` goes through `utils/remoteExec.ts → withSshClient()` /
  `buildHostVerifier()`. Every unverified HTTPS request goes through `utils/tlsDispatcher.ts →
  tlsFetch()` (undici) or `utils/pinnedTlsAgent.ts` (node:https, WinRM). The credential probes
  moved off the Setting rows onto the same stores.
- The check runs after the handshake and before the request is written, and it fails closed.
- A changed certificate is parked as `pendingFingerprint`. The administrator trusts that exact
  fingerprint under Server Settings → Web Server → Pinned server identities; a different one
  presented since is a 409. Deleting a pin is the recovery for a rebuilt SSH host, and it is
  audited because it re-opens first-use trust.
- Rule 11a (polaris rule 111): an integration edit reuses a stored secret only while its
  destination is unchanged — otherwise "keep the stored one" would hand a secret the editor
  cannot read to an address the editor chose.
- Verifying connections are not pinned. They keep Charon's operator-uploaded trusted CAs, which
  `httpClient` already honoured; `tlsFetch` now does too (`verifyingTlsDispatcher`).

Rejected: keeping the Setting-backed pins (no listing, no re-trust flow, two stores to keep in
step); pinning LDAP. ldapts takes `tlsOptions`, but the bind-path refactor was out of scope — an
AD integration with `verifyTls` off is NOT pinned today, a known gap for review.

<a id="rule-11a"></a>
## Rule 11a — A stored secret follows its destination

### What happened

The ported integrations edit form leaves a stored secret blank (or echoes the mask) to mean "keep
the stored one". Charon's `integrationConfig.writeConfig()` honoured that on every edit,
including one that changed the host in the same request.

### Why it happened

"Keep the stored one" is a convenience on the SAME server. Combined with a new host, it lets
anyone with `integrations write` aim a stored FortiOS token or bind password at a machine they
control, without ever being able to read the secret (polaris rule 111, scan findings F164 /
F208 / F209 / F211 / F212 / F191).

### The decision

`writeConfig()` calls `utils/secretDestination.ts → restoreStoredSecrets()` first. A blank or
masked secret with a moved destination key (`DESTINATION_KEYS`: host, port, TLS / LDAPS
toggles, verify flags, FMG `useProxy` / `mgmtInterface` / `fortigateVerifySsl`) is a 400 naming
the field that moved. Only keys the stored row has are compared.

### Tests

`tests/unit/sshHostKey.test.ts`, `tests/unit/pinnedTlsAgent.test.ts`,
`tests/unit/tlsDispatcher.test.ts`, `tests/integration/tlsCertPin.test.ts`,
`tests/integration/tlsPinnedDispatcher.test.ts` (rule 11);
`tests/unit/secretDestination.test.ts`, `tests/unit/integrationConfig.test.ts` (rule 11a).
Transport / crypto change — needs security review before production.
