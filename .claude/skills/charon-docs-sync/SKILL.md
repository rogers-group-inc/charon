---
name: charon-docs-sync
description: "Pre-commit documentation review for Charon: which skill reference file each kind of change must update (new Prisma model or column, service, job, route or gate, permission key, util, env var, charon_* metric, pg-boss queue, integration type, agent protocol change, Fortinet enforcement behaviour, business rule, UI canonical, deploy artifact, version pin, the session workflow itself), the skill-authoring constraints, and what each npm run check:docs failure means. Run /charon-docs-sync before an end-of-work commit made outside /charon-deploy and after check:docs fails; /charon-deploy runs this review itself as its first step."
disable-model-invocation: true
---

# Docs sync — the commit-time review

## The procedure (before the end-of-work commit)

`/charon-deploy` runs this procedure as step 1 of its release pipeline, over the whole branch,
before its deploy audit, commit, merge and push. Invoke it on its own only for a commit made
outside that pipeline, or after `check:docs` fails.

1. **List what the change touched**: models, services, jobs, routes, utils, public/ files,
   env vars, metrics, agent code, deploy artifacts, rules cited in the diff.
2. **Open the owning entries** with the routing table below and re-read them against the
   diff. Update anything the change moved, broke or invalidated — in the same commit.
   Business-rule text is quoted, never paraphrased; a changed invariant changes both the
   `invariants.md` line and the `narrative-N.md` section.
3. **New things get new entries**: a model → its Definitions bullet + Schema block; a service
   → a `## services/<name>.ts` touches entry + a file-map line; a job → the queue table + file
   map; a route → `endpoints.md` + `routes-overview.md` if it is a new mount; a canonical UI
   pattern → `charon-ui-canon`; a new rule → next free number in `charon-business-rules`
   (`npm run rules:next`).
4. Run `npm run check:docs` (and `npm run check:versions` when a pin moved); fix every failure
   (see [references/check-docs-reference.md](references/check-docs-reference.md)).
5. Then `npm run typecheck` and the unit suite, then commit (the worktree end-of-work commit
   per `charon-worktree-workflow`).

## Routing table — change kind → what to update

The full table, with the files each row names, is
[references/change-routing.md](references/change-routing.md). Short form:

| Change | Update |
|---|---|
| Prisma model / column / enum | `charon-domain-model` reference file; `cross-cutting/schema-change.md` checklist |
| service | `charon-change-impact/references/services/<group>.md` + `file-map/src.md` |
| job / queue / scheduler | `charon-enforcement` → jobs-roles-ha.md; file map; `cross-cutting/leader-and-roles.md` |
| route / gate / function key | `charon-api-rbac` → endpoints.md / routes-overview.md / auth-rbac.md |
| UI pattern / page / nav gate | `charon-ui-canon` |
| agent protocol / pins / build | `charon-agent` |
| enforcement / tag pipeline / integration type | `charon-enforcement`; `cross-cutting/fortinet-ownership.md` |
| env var / deploy artifact / role | `charon-deploy` → env-vars.md / cross-cutting-deployment.md |
| version pin / EOL date | `charon-tech-lifecycle` |
| business rule | `charon-business-rules` |
| the session workflow | `charon-worktree-workflow` + CLAUDE.md "Session workflow" |

## Skill-authoring constraints (check-docs enforces the structural ones)

- `name:` in frontmatter equals the directory; `description:` is the ONLY auto-load signal — write it with explicit trigger phrases.
- `SKILL.md` body ≤ ~200 lines: routing and invariants, not the reference material.
- Reference files: ≤ 1500 lines (fail) and ≈ 80 KB target (warn at 100 KB); split by heading, never mid-section.
- Every `references/**/*.md` is linked from its skill's `SKILL.md` (orphans fail).
- Code references are `path/file.ts → symbol()`; never a file plus a line number, in any phrasing.
- Prose moves verbatim between files; only routing text is rewritten.
- `CLAUDE.md` stays under 15 KB (warn) / 25 KB (fail): it holds conventions and the skills index, never reference material.
- A new skill also needs its row in the CLAUDE.md skills table and its name in `SKILLS` in `scripts/check-docs.mjs`.
- No secrets, real hostnames or real data in any doc — the repo is public.
