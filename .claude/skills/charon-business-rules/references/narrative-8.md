<a id="rule-8"></a>
## Rule 8 — API tokens act only through their bound role

### What happened

Charon's first API tokens carried a fixed list of `scopes` and nothing else; only
`requireSessionOrTokenPermission` read them, and `requirePermission` only knew sessions. Porting polaris's Server Settings → API Tokens
tab (2026-10-28, branch `worktree-polaris-settings-port`) brought polaris's model — a token is
minted against a Role and acts with that role's matrix — onto Charon's dynamic-role RBAC. Two
consequences had to be decided at the port: what a pre-existing role-less token may do, and what
stops an operator minting a token more powerful than themselves.

### Why it happened

A long-lived bearer outlives the operator session that minted it and is pasted into scripts and
SIEM configs, so it is the credential most likely to leak. Anything a token can do should be
explicit (a named role, visible in the tab) and bounded by the person who created it. A legacy
token whose scope strings map onto no function key has no defensible matrix.

### The decision

- `src/api/middleware/permissions.ts → resolveSnapshot()` resolves a presented, verified token to
  its bound role's matrix, read fresh on every request (tokens carry no session to cache a
  snapshot in); the token wins over any ambient session.
- `roleId` null → no snapshot → 403 on every role gate. Legacy `scopes` are honoured only by
  `requireSessionOrTokenPermission` for role-less tokens. Nothing is backfilled.
- `src/services/apiTokenService.ts → createToken()` refuses a role that grants more than the
  caller on any key (`grantExceedsCaller()`); an admin-equivalent binding is permitted but logs
  `api_token.admin_equivalent` at warning level.
- `ApiToken.role` is `onDelete: Restrict`, so deleting a role cannot silently strip or orphan a
  token.
- `trustedHosts` (IPs / CIDRs, ≤ 64) is checked after the hash matches; `attachApiToken` answers
  403 naming the address Charon saw, so only a real token holder learns why.
- Because a token-only request has no browser session, the CSRF check is skipped for session-less
  bearer requests (`src/api/middleware/csrf.ts → isSessionlessBearer()`); with a session present
  the check still runs.

Rejected: treating a role-less token as Read-Only (an implicit grant nobody chose); copying the
caller's matrix into the token at mint (it would never follow later role edits).

### Tests

`tests/unit/apiTokensSettings.test.ts` — trusted-host normalisation and matching,
`grantExceedsCaller`. Needs human + security review before production (CSRF / token-role
changes).
