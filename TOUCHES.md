# TOUCHES.md — Charon cross-cutting invariants & change map

"If I change X, what else touches it?" Read the relevant section before editing.

## Global invariants (never break these)

1. **Fortinet ownership scoping.** Charon only creates/edits objects named
   `charon-*`. No code path may read-then-rewrite an operator-authored object.
   Enforced in `fortinetEnforcementService.ts`; the `charon-` prefix is applied
   ONLY at the Fortinet boundary, never stored on a Tag/Policy name.
2. **Enforcement is dry-run by default.** `Integration.enforcementMode` starts
   `dry_run`. Going `enforce` requires the `enforcement` fullwrite permission +
   an explicit UI confirm. Dry-run writes NOTHING to a firewall.
3. **Secrets never leave plaintext.** Config secrets are AES-256-GCM at rest +
   masked on read + preserved-on-unchanged. Bearers/codes are stored as SHA-384
   only and shown once. `CHARON_DATA_KEY` is required in prod.
4. **Agent trust = pin + bearer.** The agent pins the server leaf-cert SHA-256
   (not system roots) and carries a hashed bearer. Rotating the cert without
   re-enrolling agents REQUIRES staging the new pin first (dual-pin).
5. **Leader-only singletons.** Schedulers + enforcement scheduling run only on
   the advisory-lock holder. Adding a scheduler → start it inside
   `startSchedulers()` (leader), not at module load.
6. **Roles branch on flags.** Gate subsystems on `roleConfig()` booleans, never
   on the `CHARON_ROLE` string.
7. **Repo is public.** No secrets, real hostnames, PII/COI/CIM in code, tests,
   migrations, or seeds.

## Per-service map

### tagService / tagReconciler
- **Owns:** Tag, TagSource, EndpointTag; effective-tag computation.
- **Reads:** Endpoint (boundUserKey, postureState), DirectoryObject, CustomGroup.
- **Used by:** routes/tags, enforcement (via the enforcement-sync payload).
- **Invariant:** EndpointTag is the materialized truth; always reconcile after a
  trigger rather than mutating it directly.
- **When changing:** a new TagSourceKind needs the enum, `computeEffectiveTags`
  matching, the source route schema, and the UI source modal.

### fortinetEnforcementService
- **Owns:** EnforcementState; all Fortinet CMDB writes.
- **Reads:** Integration (enforcementMode + decrypted config), Endpoint.currentIp.
- **Used by:** enforcementSyncJob (enforcer role).
- **Invariants:** ownership scoping (#1), dry-run default (#2). FMG enforce is
  intentionally dry-run-only until the policy-package install is completed.
- **When changing:** keep dry-run and enforce branches symmetric (same
  EnforcementState/Event/metrics shape); never widen scope past `charon-*`.

### integrationService / integrationConfig
- **Owns:** Integration CRUD, the testConnection/discover dispatchers, secret
  encryption/masking.
- **Reads/writes:** Integration, DirectoryObject (discovery).
- **Used by:** routes/integrations, health-check job, enforcement (config),
  tag pipeline (directory data).
- **When changing:** a new type → INTEGRATION_TYPES + dispatch switches +
  SECRET_FIELDS + the configure-modal field map in `integrations.js`.

### agentEnrollmentService / agentTokenService / invitationCodeService / certPinService
- **Owns:** Endpoint enrollment, bearer issue/verify/revoke, invitation codes,
  cert pins.
- **Reads:** Setting `agent.cert_pins`.
- **Used by:** routes/agents(+enroll), routes/endpoints, agentsWs, serverSettings
  certificates.
- **Invariants:** #3 (hashed storage), #4 (pin trust). Revoking a bearer sets
  status=revoked and locks WS + HTTP.

### postureService
- **Owns:** posture evaluation + ingest.
- **Reads/writes:** Endpoint.posture/postureState; Setting `posture.policy`.
- **Used by:** routes/agents posture, agentsWs.
- **When changing:** a posture state change must enqueue a reconcile (the
  posture tag source depends on it).

### verificationService
- **Owns:** the `{user↔device↔IP}` binding + VerificationSession.
- **Writes:** Endpoint.boundUser*, VerificationSession.
- **Used by:** routes/agents login/logout.
- **Invariant:** changing the binding MUST trigger a reconcile (user-derived
  tags depend on boundUserKey).

### permissions (RBAC)
- **Owns:** function-key catalogue, access-level ranking, session snapshot.
- **Used by:** every authenticated route mount + `app.js` nav gating.
- **When changing:** adding a function key → seed it on built-in roles
  (`prisma/seed.ts` matrix), guard the routes, and add it to the nav map +
  any `Charon.can()` checks in the frontend.

### leaderElection
- **Owns:** advisory-lock leadership + `charon_is_leader` metric.
- **Used by:** app.ts schedulers, serverSettings `/ha`, `/health`.
- **Invariant:** only the leader runs schedulers/enforcement scheduling. A
  scheduler started outside the `onAcquire` path is a split-brain bug.

### certInfo / nginxRenderer / nginxApplyService
- **Owns:** leaf-cert fingerprint (the agent pin), nginx config render + apply.
- **Reads:** Setting `cert.leaf`, the template.
- **Used by:** serverSettings certificates, web unit ExecStartPre, the updater.
- **Invariant:** uploading a cert sets the canonical agent pin; apply validates
  with `nginx -t` and rolls back on failure.

### backupService / updateService / capacityService / agentDistService
- **Owns:** Maintenance-tab backend.
- **Invariants:** updater self-updates ONLY from a git checkout outside Docker;
  agent installers are served strictly from the manifest allowlist (no path
  traversal); restart targets the whole `charon.target`.
- **HA note:** the updater requires a "this node is safe" confirm — follow the
  standby-first order in `deploy/HA.md`.

## When you change the Prisma schema

1. `prisma migrate dev --name <change>` (or `migrate diff` for the SQL) and
   commit the migration.
2. Update affected services + this map + ARCHITECTURE.md §3.
3. If you added a secret field, register it in `integrationConfig.SECRET_FIELDS`.
4. Re-run `npm run typecheck && npm test`.
