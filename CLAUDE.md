# CLAUDE.md — Charon project memory

> Auto-loaded into every session. Keep it concise and current. On any commit
> that changes behavior, review **CLAUDE.md / ARCHITECTURE.md / TEMPLATES.md /
> TOUCHES.md** and update what drifted.

## What Charon is

Charon is a **Zero Trust Network Access (ZTNA)** platform for Rogers Group. It
decides *who* and *what* may reach network resources and enforces by pushing
**dynamic tags to Fortinet**, where FortiGates apply dynamic firewall policies.

Flow: an **endpoint agent** enrolls with a one-time invitation code → opens a
telemetry connection → shows a **server-dictated login GUI** → the server
resolves user + device to **ZTNA tags** (directory group / OU / custom group /
posture) → syncs tags to FortiManager/FortiGate as dynamic address-group members
and maintains `charon-*` policies referencing them.

**The repo is PUBLIC.** Security lives in the crypto/protocol, never in
obscurity. No secrets or real data (PII/COI/CIM/hostnames) ever get committed.

## Version policy

`package.json` holds `major.minor`; **patch = git commit count** computed at
runtime by `src/utils/version.ts` (or baked via `CHARON_BUILD_COMMIT_COUNT` in
Docker). Surface it in the sidebar + Maintenance tab; the updater compares local
vs remote commit counts to show "N commits behind".

## Tech stack

- **Server:** Node 20+, TypeScript (ESM), Express 5, Prisma 7 + `@prisma/adapter-pg`,
  PostgreSQL 15. Sessions via `express-session` + `connect-pg-simple`. Zod
  validation at the top of route files. Pino logs. **pg-boss** jobs.
  `prom-client` metrics. `undici` for pinned/TLS-toggle outbound HTTP.
- **Frontend:** vanilla JS + static HTML in `public/`, **no build step**. Design
  system copied from polaris (`public/css/styles.css`) + `charon.css` overlay.
- **Endpoint agent:** **Tauri** (Rust core + web GUI) under `agent/`, built in CI.
- **Tests:** Vitest (+ Supertest).

## Architecture tree (src/)

```
src/
  index.ts            entry — setup detection + role gating; one-shot migrate
  app.ts              Express app; branches on roleConfig(); leader election;
                      per-role consumers; agent WS attach
  db.ts               Prisma client singleton (adapter-pg)
  jobs.ts             pg-boss bootstrap + QUEUES
  metrics.ts          prom-client registry + helpers
  api/router.ts       aggregate routes under /api/v1
  api/middleware/     auth, csrf, permissions (RBAC), rateLimits, errorHandler
  api/routes/         auth, agent (public), agents (+enroll), endpoints,
                      integrations, directory, groups, tags, policies,
                      serverSettings, maintenance, events
  services/           crypto-agile + integrations + tags + enforcement + agent
                      + cert/nginx + backup/update/capacity + leaderElection
  jobs/               integrationHealthCheck, tagReconcileJob, enforcementSyncJob,
                      retentionPrune
  utils/              role, logger, errors, crypto, password, version, paths,
                      metricsServer
  setup/              first-run wizard (detectSetup, setupServer, setupRoutes)
  generated/          Prisma client (gitignored)
agent/                Tauri app (src-tauri + ui)
prisma/               schema.prisma + migrations + seed
deploy/               install-rhel.sh, setup-ha.sh, HA.md, systemd/, nginx/, scripts/
```

## Domain model (Prisma — see prisma/schema.prisma)

Enums: `EndpointStatus` (pending/enrolled/online/offline/revoked), `PostureState`
(unknown/compliant/noncompliant), `AuthMode` (local/saml/oidc), `TagSourceKind`
(directory_group/directory_ou/custom_group/posture), `DirectoryObjectKind`,
`EnforcementMode` (dry_run/enforce), `SyncStatus`.

Entities: **Role / User / GroupMapping** (RBAC + SSO); **Setting**;
**Integration / Credential** (encrypted config); **InvitationCode / Endpoint**
(agent enrollment, posture, binding, bearer, cert pins); **DirectoryObject**
(read-only directory mirror) / **CustomGroup** / **Tag / TagSource /
EndpointTag** (the tag pipeline); **Policy / EnforcementState** (Fortinet
writeback); **VerificationSession** (user↔device↔IP binding); **ApiToken**;
**Event** (audit log).

## RBAC

Dynamic-role matrix (`src/api/middleware/permissions.ts`). Function keys:
endpoints, invitationCodes, tags, policies, groups, integrations, **enforcement**
(separate, high blast radius), directory, credentials, events, apiTokens, users,
roles, serverSettingsSystem, serverSettingsData. Levels none<read<write<fullwrite.
Sessions carry a role snapshot; group-mapping uses highest-privilege-wins.
Built-in roles seeded: Administrator / Operator / Read-Only.

## Deployment modes

- **Roles** via `CHARON_ROLE`: `web` (UI/API + leader-elected schedulers),
  `endpoint` (agent comms, nginx upstream), `enforcer` (gate push), `worker`
  (sync/reconcile/posture/health), `migrate` (one-shot). Unset = `all` (dev).
  Branch on `roleConfig()` flags, never the role string.
- **HA:** Postgres streaming replication + app leader election via a Postgres
  **advisory lock** (`services/leaderElection.ts`). Only the leader runs
  schedulers/enforcement scheduling. See `deploy/HA.md`.
- **nginx** terminates TLS (HTTP/2 + HTTP/3, PQC-hybrid KEX); app listens
  localhost HTTP. `deploy/nginx/charon.conf.template` + renderer + apply wrapper.
- **Docker:** `Dockerfile` (multi-stage), `docker-entrypoint.sh`,
  `docker-compose.yml` (roles → services), `compose.dev.yml`. Image at
  `ghcr.io/rogers-group-inc/charon`.
- **RHEL 9.5:** `deploy/install-rhel.sh` (+ PQC OpenSSL 3.5), systemd units.

## Cross-cutting rules

- **Crypto is crypto-agile + PQC-hybrid.** At-rest secrets are AES-256-GCM
  envelopes (`utils/crypto.ts`, algorithm/keyid named in the ciphertext);
  hashing SHA-384/512; passwords argon2id; bearer/codes stored as SHA-384 only.
  Transport: TLS 1.3 hybrid `X25519MLKEM768`. `CHARON_DATA_KEY` is required in
  prod — back it up (losing it = unrecoverable stored secrets). Don't hand-roll
  primitives. **Expert crypto review required before production.**
- **Fortinet writes are destructive.** Default **dry-run** per integration
  (`EnforcementMode`); flipping to `enforce` needs the `enforcement` fullwrite
  permission + human review. Only ever touch `charon-*` objects (ownership
  invariant). Every change logs an Event.
- **Agent trust:** the agent pins the server **leaf-cert SHA-256** (not system
  roots) + a per-agent bearer (hashed server-side). Dual-pin rotation supported.
- **Secrets:** never hardcoded; `.env` + env/Key Vault; encrypted at rest. LLM
  features (if any) route through **Azure AI Foundry**, never personal keys.
- **Human review required** for deployed code, enforcement enablement, and
  anything customer/vendor/regulator-facing.

See **ARCHITECTURE.md** (deep reference), **TEMPLATES.md** (canonical patterns),
**TOUCHES.md** (cross-cutting invariants + per-service writer/reader map).
