## Project Overview

**Charon** is a **Zero Trust Network Access (ZTNA)** platform. It decides *who* and *what* may
reach network resources and enforces by pushing **dynamic tags to Fortinet**, where FortiGates
apply dynamic firewall policies. A member of the Polaris family: it reuses Polaris's stack,
conventions and UI design system, but shares no runtime or database with it.

Flow: an **endpoint agent** enrolls with a one-time invitation code → opens a telemetry
connection → shows a **server-dictated login GUI** → the server resolves user + device to **ZTNA
tags** (directory group / OU / custom group / posture) → syncs tags to FortiManager/FortiGate as
dynamic address-group members and maintains `charon-*` policies referencing them.

**The repo is PUBLIC.** Security lives in the crypto/protocol, never in obscurity. No secrets or
real data (PII/COI/CIM/hostnames) ever get committed.

Version policy: `package.json` holds `major.minor`; the patch is the git commit count, computed
at runtime by `src/utils/version.ts` (or baked via `CHARON_BUILD_COMMIT_COUNT` in Docker).
Surfaced in the sidebar + Maintenance tab; the updater compares local vs remote commit counts to
show "N commits behind". Never edit the patch in `package.json`.

---

## Skills — where the project memory lives

This file is the always-loaded floor. Everything deeper lives in eleven project skills under
`.claude/skills/` and loads on demand — each `SKILL.md` routes to its `references/` with
"read X when Y" tables. **Load the skill before you design, not at commit time**: the
invariants and "when changing this" checklists are what make a change land right the first time.

| Skill | Load when | Invocation |
|---|---|---|
| `charon-domain-model` | a task names a model, column, enum or Setting key; edits `prisma/schema.prisma`; writes a migration | auto |
| `charon-business-rules` | **before changing any behavior** around Fortinet writes, the dry-run toggle, secrets/tokens, agent trust, leader election, process roles, or anything that could leak data into this public repo — or when anything cites "rule N" | auto (model only) |
| `charon-api-rbac` | adding/changing an endpoint or gate, a function key, a 401/403/CSRF failure, tokens, login, anything in `src/api/` | auto |
| `charon-change-impact` | **before editing anything** in `src/services`, `src/jobs`, `src/utils` or a route; adding a service/job/integration/metric; "where does X live" / "what depends on X" | auto |
| `charon-ui-canon` | any change under `public/` or `agent/ui/`; HTML/CSS/JS/theme/table/modal work | auto |
| `charon-enforcement` | tags, reconcile, discovery, integrations, Fortinet enforcement, drift, pg-boss queues, roles, HA, metrics | auto |
| `charon-agent` | anything under `agent/`, enrollment, invitation codes, cert pins / rotation, posture reporting | auto |
| `charon-tech-lifecycle` | EOL dates, a version pin or minimum, bumping Node / PostgreSQL / OpenSSL / Rust, `npm audit`, Dependabot, CodeQL | auto |
| `charon-worktree-workflow` | the start of every coding task; "worktree", "lock", "dev environment", "merge", "push" | auto + `/charon-worktree-workflow` |
| `charon-deploy` | a task is done: it runs docs-sync, audits deploy surfaces, commits, merges and pushes; env vars, systemd/nginx/Docker, the updater | `/charon-deploy` only |
| `charon-docs-sync` | a commit made outside `/charon-deploy`; after `check:docs` fails | `/charon-docs-sync` only |

In-place references the skills point at: `.env.example` (runtime variables, with comments),
`deploy/HA.md` (HA topology, failover, HA-aware updates), `agent/README.md`, `CONTRIBUTING.md`,
`SECURITY.md`.

---

## Session workflow (always in force)

1. **Never edit the main checkout.** Before the first edit of a task, create a worktree
   (`EnterWorktree` → `.claude/worktrees/<slug>`, branch `worktree-<slug>`) and write a
   `WORKLOCK` file at its root (one line: ISO timestamp + purpose). A PreToolUse hook refuses
   Edit/Write inside the repo without one.
2. **Finishing a task = delete `WORKLOCK`, then commit everything in the worktree.** Run
   `/charon-docs-sync` first — or `/charon-deploy`, which runs it and carries on through
   merge and push. The end-of-work commit does not wait for approval; merges and pushes do,
   and `/charon-deploy` is that approval.
3. **A dev environment = a `DEVLOCK` file at the worktree root + one podman stack per worktree**
   (`podman compose -f compose.dev.yml -p charon-<slug>`; podman, never docker).
4. **"merge"** → list every worktree WITHOUT a lock file as a numbered menu, merge the chosen
   ones to `main` with `--no-ff`, never push; then review what landed against the skills
   (update an entry, or add a skill, when the work changed what a future session needs told).
   **"push"** → audit deploy surfaces, push `main`, then remove the merged worktrees and
   branches. Both protocols are in `/charon-worktree-workflow`.
5. `WORKLOCK` / `DEVLOCK` are gitignored and never committed.
6. **Record every error you hit while working**: a failed test or check you did not cause, a
   tool or hook refusal, a missing generated file, a trap that cost a retry. One file per error
   in `error-log/` beside your memory directory
   (`~/.claude/projects/c--Users-dmoore-VSCode-charon/error-log/`, OUTSIDE the repository — it
   is local and **never committed**; `YYYY-MM-DD-<slug>.md`, frontmatter `category:` + `cost:`,
   then what happened, the cause, the fix; its README has the shape). The user reviews the most
   frequent categories to fix the workflow, so log a known trap again each time it recurs; that
   count is the signal.

---

## Architecture

Code lives in `src/` (`api/routes/`, `api/middleware/`, `services/`, `jobs/`, `utils/`,
`setup/`, `cli/`). Frontend is vanilla JavaScript in `public/`. The endpoint agent is a Tauri app
in `agent/`. Database schema in `prisma/schema.prisma`, migrations in `prisma/migrations/`.
Installer, HA script, systemd units and nginx template in `deploy/`; doc and version guards in
`scripts/`.

> The file-by-file map is `charon-change-impact` → references/file-map/; writer/reader
> relationships are its cross-cutting and per-service entries. Process roles (`web` /
> `endpoint` / `enforcer` / `worker` / `migrate`; unset = `all`) are gated by
> `src/utils/role.ts → roleConfig()` — see `charon-enforcement` → jobs-roles-ha.md. HA is
> Postgres streaming replication + app leader election via a Postgres advisory lock.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 (floor 22.19) / TypeScript (ESM) — pins and EOL dates: `charon-tech-lifecycle` |
| Framework | Express 5 |
| ORM | Prisma 7 (driver adapter `@prisma/adapter-pg`; generated client at `src/generated/prisma/`, regenerated by `postinstall`) |
| Database | PostgreSQL 17 (existing installs may run 15) |
| Jobs | pg-boss |
| Sessions | express-session + connect-pg-simple |
| Validation | Zod |
| Logging | Pino + pino-pretty |
| Auth | argon2id via @node-rs/argon2, otpauth (TOTP), @node-saml/node-saml, openid-client, ldapts |
| Outbound HTTP | undici (per-call TLS-verify toggle) |
| Metrics | prom-client |
| Transport | nginx TLS 1.3 with hybrid `X25519MLKEM768` (OpenSSL 3.5) |
| Endpoint agent | Tauri (Rust core + web GUI) |
| Testing | Vitest + Supertest |
| Frontend | Vanilla JavaScript + HTML, no build step; Polaris UI design system (`styles.css`) + `charon.css` |

> Each runtime version above has several declaration sites. Never bump one alone —
> `charon-tech-lifecycle` owns the lockstep list, EOL dates and `check:versions`.

---

## Getting Started

```bash
npm install                 # deps + Prisma client + git hooks (core.hooksPath .githooks)
npm run db:migrate          # prisma migrate dev
npm run db:seed             # built-in roles (+ first admin when CHARON_SEED_ADMIN_* are set)
npm run dev                 # tsx --watch, single "all" role
npm test                    # vitest
npm run build && npm start  # production build

# Type check / lint / structural guards (the guards also run in CI + pre-commit)
npm run typecheck
npm run lint
npm run check:docs && npm run check:versions
npm run rules:next          # next free business-rule number
```

---

## Deployment posture — this is a public, open-source application

Charon is public and may be installed by people other than us. Nothing may assume the Rogers
Group install's shape. Concretely, a change must keep working when:

- **Auth is any supported mode** — local accounts (optionally with TOTP) and the SSO modes the
  schema models (`AuthMode` saml / oidc; LDAP operators). Never fix a login-adjacent bug for the
  provider you happen to run; the others have different transport semantics.
- **TLS terminates in front of the app** — the app listens on localhost HTTP behind nginx (or
  another proxy); never let a feature hard-require `req.secure` or an absolute public URL.
  `CHARON_PUBLIC_URL` may be unset.
- **Install path varies** — RHEL/systemd (`deploy/install-rhel.sh`) or Docker/podman compose,
  single node or an HA pair.
- **Fleet size spans 1 to 2000+ endpoints** (see the scale-check convention below).
- **No integration is guaranteed** — no FortiManager, no FortiGate, no AD, no Entra. Every
  integration is optional and absent by default; enforcement is dry-run until an operator turns
  it on.

When a fix is correct for one deployment shape and silently wrong for another, ship the one that
is correct for all of them, and cover each shape with a test.

---

## Key Coding Conventions

- **Crypto is crypto-agile + PQC-hybrid.** At-rest secrets are AES-256-GCM envelopes
  (`src/utils/crypto.ts`, algorithm/key id named in the ciphertext); hashing SHA-384/512;
  passwords argon2id; bearers/codes stored as SHA-384 only. `CHARON_DATA_KEY` is required in
  prod — back it up (losing it = unrecoverable stored secrets). Don't hand-roll primitives.
  **Expert crypto review required before production.**
- **Fortinet writes are destructive.** Default **dry-run** per integration (`EnforcementMode`);
  flipping to `enforce` needs the `enforcement` fullwrite permission + human review. Only ever
  touch `charon-*` objects. Every change logs an Event. (Business rules 1, 2.)
- **Agent trust:** the agent pins the server **leaf-cert SHA-256** (not system roots) + a
  per-agent bearer (hashed server-side). Dual-pin rotation supported. (Rule 4.)
- **Roles:** branch on `roleConfig()` flags, never the role string; schedulers start only on the
  leader. (Rules 5, 6.)
- Services (`src/services/`) contain **all business logic**. Route handlers are thin — validate
  input, call a service, return a response.
- All Zod schemas live co-located with their route file (top of file).
- Database calls go through service functions only — never raw Prisma in route handlers.
  **Interim state:** several route files still carry inline Prisma (`charon-api-rbac` lists
  them). New endpoints MUST use services; extract opportunistically when you touch one. Until
  then, any audit-worthy mutation there still writes its `Event` inline.
- All errors thrown by services are `AppError` (`src/utils/errors.ts`) with an `httpStatus`.
- Use `async/await` throughout; avoid `.then()` chains.
- Write a unit test for every public function in `src/utils/` and `src/services/`.
  `vitest.config.ts` excludes `**/.claude/**` so worktree checkouts' tests are never collected.
- All audit-worthy actions (creates, updates, deletes, enrollments, logins, enforcement applies)
  write an `Event`.
- **FortiManager ↔ standalone FortiGate parity.** They are paired enforcement surfaces; a feature
  added to one is evaluated for the other in the same change, unless it is structurally FMG-only.
- **Scale-check every change at 100 and 2000 endpoints.** For code touching jobs, reconcile,
  discovery or per-endpoint queries, reason through both ends: `for…of rows { await
  prisma…update() }` → batch or `$transaction`; sequential awaits in a job tick → `Promise.all`
  when order doesn't matter; queries loading every endpoint without a tight `select`.
- **Secrets:** never hardcoded; `.env` + env / Key Vault; encrypted at rest. LLM features (if
  any) route through **Azure AI Foundry**, never personal keys.
- **Commits.** Each logical change gets its own commit. Inside a worktree the end-of-work commit
  (after deleting `WORKLOCK`) happens without asking. Merging to `main` and pushing happen only
  when the user says so.
- **Run `/charon-docs-sync` before the end-of-work commit.** It names the skill entries each
  kind of change must refresh and runs `npm run check:docs`, which enforces the structural half
  (every model / service / job / route named, no `file:line` refs, every service has a touches
  entry, every referenced path exists).
- **Never push without the user's explicit go-ahead.** "push" and `/charon-deploy` are that
  go-ahead; both run the deployment-surface audit first.
- **Human review required** for deployed code, enforcement enablement, crypto / auth / agent
  protocol changes, and anything customer-, vendor- or regulator-facing.

---

## Out of Scope

TODO: populate when the product scope is written down (README and code state none yet).
