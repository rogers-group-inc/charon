<a id="rule-10"></a>
## Rule 10 — Nobody grants authority they do not hold

### What happened

Porting polaris's Users page (2026-10-28, branch `worktree-users-auth-port`) brought operator
account management, the role permission matrix and IdP group mappings to Charon for the first
time. Each of them hands out authority, and each sits behind a delegable key: `users:write`
manages accounts, `roles:write` edits matrices, `users:fullwrite` edits group mappings. Polaris
had learned, in a series of scan findings, that every one of those keys was enough to
manufacture an administrator: `users:write` could create an account on an admin-equivalent role
with a password the creator chose, or reset an administrator's password and sign in as them;
`roles:write` could simply add the two fullwrite grants to a role the holder already had; a
group mapping could hand an admin role to an IdP group the caller belonged to. The opposite
failure also existed: the last admin-equivalent account could be demoted or deleted, leaving
nobody able to manage roles.

### Why it happened

A permission matrix with a write / fullwrite split on `users` and `roles` only means something
if "write" cannot be turned into "fullwrite" by the holder. Without a guard at every place
authority is HANDED OUT, the effective level of every delegated key is "full control of the
install". Charon carries the same matrix and adds a key — `enforcement`, live Fortinet writes —
where an escalation reaches production firewalls.

### The decision

- `src/api/middleware/permissions.ts → assertGrantWithinCaller()` on every grant: role create
  and edit (an edit counts only the keys it RAISES, `grantsBeyond(…, existing)`, so editing a
  role is never refused for authority someone else gave it), account create and re-role, group
  mapping create / retarget / re-enable (checked even when created disabled — one toggle from
  granting).
- `assertNoPrivilegeEscalation()` for acting on an admin-equivalent account and for withdrawing
  an admin-equivalent mapping (remove, disable, retarget).
- The mirror: `userService.changeRole() / deleteUser()` refuse to leave zero admin-equivalent
  accounts; `roleService.assertRoleDemotionAllowed()` refuses a matrix edit that takes
  admin-equivalence from the last admin role, and needs an admin-equivalent caller for any such
  demotion.
- `requirePermission` stores the resolved snapshot on `req.roleSnapshot`, so an API-token caller
  (rule 8) is held to its bound role exactly as a session is.
- An admin-equivalent group mapping is allowed (the operator asked for it) but logs a
  warning-level Event, as an admin-equivalent API-token binding does.

Rejected: a four-eyes rule (an admin-equivalent caller is unaffected — this is no-escalation,
not dual control); hiding admin roles from non-admin pickers only (the UI is not the control).

### Tests

`tests/unit/usersAuthCore.test.ts` (escalation guards, demotion guard, admin count) and
`tests/unit/usersAuthRoutes.test.ts` (an operator refused creating an admin account and
resetting an administrator's password). Needs human + security review before production.
