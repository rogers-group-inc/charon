<a id="rule-9"></a>
## Rule 9 — An HA enrollment token buys only the right to ask

### What happened

Server Settings → High Availability was ported from polaris (2026-10-28, branch
`worktree-polaris-settings-port`) onto Charon's HA model (PostgreSQL streaming replication via
`deploy/setup-ha.sh` + the advisory-lock leader). Before it, building the pair meant copying the
replication password and `.env` between hosts by hand. The tab instead mints a script per node
that fetches what it needs from the running server — which requires an unauthenticated endpoint,
`/api/v1/ha/enroll`, mounted above `requireAuth` and exempt from CSRF.

### Why it happened

The node bundle is the whole install: `.env` with `CHARON_DATA_KEY` (which decrypts every stored
secret), the nginx leaf private key (agents pin that leaf, so the standby must serve the same
one) and the replication password. In the words of `src/services/haEnrollmentService.ts`: "So
the token buys one thing only — the right to ASK." A token that downloaded the bundle directly
would make anyone who saw the script — in a ticket, a chat, shell history — a holder of the data
key.

### The decision

- The token is `charon_<base64url>`, stored as SHA-384 only (`tokenHash`, prefix-indexed), with a
  24 h TTL, and is spent at registration. The poll handle is likewise stored only as its
  SHA-384 (`requestIdHash`).
- Registration records the source address, node name and SSH host-key fingerprints and waits
  (approval window 30 min). An operator with `serverSettingsSystem` fullwrite approves or rejects
  in the tab after checking them.
- Once approved the bundle is claimable for 10 minutes, once (`delivered` is terminal), and only
  from the address that registered (`claimBundle()`).
- The node script pins the server's leaf SHA-256 (the agent pin) before talking to it.
- The public surface is register / poll / download only: rate-limited (`haEnrollLimiter`),
  cannot enumerate anything, and every token rejection returns the same text. CSRF is exempted
  for exactly `/api/v1/ha/enroll` — never as a prefix, because
  `/api/v1/ha/enrollments/:id/approve` is a session route.
- Every state change logs an Event (`ha.enrollment_pending`, `ha.node_enrolled`, approvals).

Rejected: argon2id for the token (Charon's policy is SHA-384 for high-entropy random tokens);
shipping the bundle in the script itself (the script would then be the secret).

### Tests

`tests/unit/haSettings.test.ts` — poll handle stored as SHA-384, bundle encoding, node scripts
pin the cert and call `setup-ha.sh`, unsafe values refused in scripts. Needs human + crypto
review before production (the bundle carries `CHARON_DATA_KEY` and the TLS key).
