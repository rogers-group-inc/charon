# Change routing — what each kind of change must update (same commit)

Skill paths are under `.claude/skills/`. "File map" means
`charon-change-impact/references/file-map/src.md`.

| Change | Documentation to update (same commit) |
|---|---|
| new Prisma model / column / enum | `charon-domain-model/references/<domain>.md` (Definitions bullet + the Schema block re-copied from `prisma/schema.prisma`); the enum block in `charon-domain-model/SKILL.md`; any service entry whose Writers/Readers changed |
| new Setting key | `charon-domain-model/references/platform.md` Setting-key table |
| new or changed service | `charon-change-impact/references/services/<group>.md` (`## services/<name>.ts`); file map; cross-cutting file(s) whose Writers/Readers changed |
| new or changed job / queue / scheduler | `charon-enforcement/references/jobs-roles-ha.md` (queue table); file map; `charon-change-impact/references/cross-cutting/leader-and-roles.md` |
| new or changed route / gate | `charon-api-rbac/references/endpoints.md`; `routes-overview.md` for a new mount |
| new function key | `charon-api-rbac/SKILL.md` description + `references/auth-rbac.md`; the built-in role table; `charon-ui-canon` page → gate table if a page uses it |
| new util | file map; a unit test (`tests/unit/<name>.test.ts`) |
| env var | `.env.example`; `charon-deploy/references/env-vars.md`; the installer / wizard / compose files that set it |
| `charon_*` metric | `charon-enforcement/references/observability.md` |
| integration type | `charon-enforcement/references/integrations-discovery.md`; `charon-change-impact/references/services/integrations.md`; `charon-domain-model/references/integrations-directory.md` if config shape changed |
| Fortinet enforcement behaviour | `charon-enforcement/references/fortinet-enforcement.md`; `charon-change-impact/references/cross-cutting/fortinet-ownership.md`; business rules 1–2 if their contract moved |
| agent protocol / pins / build | `charon-agent/references/*`; `charon-change-impact/references/services/agent-trust.md` |
| UI pattern or shared module | `charon-ui-canon/references/canon-patterns.md` or `frontend-shell.md` |
| business rule | `charon-business-rules` (invariant + narrative + index row) — the number from `npm run rules:next` |
| deploy artifact / Dockerfile / unit / nginx / role | `charon-deploy/references/cross-cutting-deployment.md`; README / installer per the deploy-surface audit |
| version pin / dependency major / EOL date | `charon-tech-lifecycle/references/version-pin-inventory.md`; `FAMILIES` in `scripts/check-versions.mjs`; `scripts/data/platformEol.json` |
| the session workflow itself | `charon-worktree-workflow`; CLAUDE.md "Session workflow"; the hook script if enforcement changed |
| crypto / auth / agent protocol / enforcement code | the owning entries above, plus the human-review note in the commit: these need a security-qualified reviewer (`CONTRIBUTING.md`) |

## Retired root docs

The project memory was split from root `ARCHITECTURE.md`, `TEMPLATES.md` and `TOUCHES.md` into
these skills (each section moved verbatim). Those root files no longer exist, and
`check:docs` (`retired-doc`) fails on a reference to them — point at the skill that now holds
the content instead.
