---
name: charon-deploy
description: "Charon deployment, runtime configuration and the release pipeline: the environment-variable catalogue (.env.example), the split-role layout (web / endpoint@ / enforcer@ / worker@ / migrate under charon.target; the same roles as docker-compose services), nginx TLS termination with PQC-hybrid KEX and the render → stage → sudo-apply flow, the RHEL 9.5 installer and its PQC OpenSSL build, HA (setup-ha.sh, deploy/HA.md, standby-first updates), the ghcr image build, the in-app updater, and the first-run wizard. /charon-deploy is also the release pipeline for a finished worktree: it runs the docs-sync review itself, audits the deployment surfaces, verifies, commits, merges THIS worktree's branch to main and pushes — invoking it is the go-ahead for that merge and push. Run it when a task is done, when adding or changing an env var, or when a change touches deploy/, a Dockerfile, a compose file, docker-entrypoint.sh, a systemd unit, the nginx template, .env.example or a CI workflow."
disable-model-invocation: true
---

# Charon deployment and operations

## Which file

| You need… | Read |
|---|---|
| every environment variable, its default and what it tunes | [references/env-vars.md](references/env-vars.md) (mirror of `.env.example`, which a running install reads — keep both in step) |
| what moves together when a deploy artifact changes: roles → units → compose services, the image, nginx, HA, the installer | [references/cross-cutting-deployment.md](references/cross-cutting-deployment.md) |

## The release pipeline — what /charon-deploy does, in order

Invoking this skill on a finished worktree is the user's go-ahead for everything below,
**including the merge and the push**. Do not ask for the docs-sync review, the merge or the push
separately; the only things that stop the pipeline are a failing check, a merge conflict, or
`main` behind `origin/main`.

0. **Restore `WORKLOCK` if the worktree has none.** The usual way to reach this pipeline is a
   task already finished the CLAUDE.md way — `WORKLOCK` deleted, work committed — and the
   PreToolUse hook then refuses step 1's and step 2's edits inside the worktree. Write the lock
   back (`printf '%s %s\n' "$(date -u +%FT%TZ)" "deploy pipeline" > WORKLOCK`) before editing,
   and delete it again at step 4. Its absence here means the work is committed, not that a new
   worktree is needed — which is what the hook's own message will otherwise tell you.
1. **Docs-sync review — run it, never ask the user to.** Read
   `.claude/skills/charon-docs-sync/SKILL.md` and follow its procedure over the whole branch
   (`git diff main...HEAD`). The Skill tool refuses that skill by design
   (`disable-model-invocation`); reading the file and following it is how this pipeline runs
   it. While the branch is still one diff, also walk the merge-time skill review in
   `charon-worktree-workflow` → merge-protocol.md § 4 and make those edits here in the worktree
   — after the merge they would need a worktree of their own.
2. **Deployment-surface audit** — the checks in the next section. Fixes are commits in the
   worktree, before the merge, so `main` never receives a direct commit.
3. **Verify**: `npm run check:docs && npm run check:versions && npm run typecheck && npx vitest
   run tests/unit --no-file-parallelism`. A failure stops the pipeline; report the output. When
   the branch touched a route, a service or the schema, also run the suite against a real
   database (`charon-worktree-workflow` → dev-environment.md); without one, DB-gated tests SKIP
   and the green is worthless — if no database can be had, say so in the report rather than
   calling the branch verified.
4. **End-of-work commit**: `rm WORKLOCK`, commit everything pending (one logical change per
   commit). A `DEVLOCK` means a dev stack is up: `podman compose -f compose.dev.yml -p
   charon-<slug> down -v`, delete the lock, then commit.
5. **Merge this chat's worktree — and only it.** From the main checkout — a worktree-isolated
   session must `ExitWorktree` (keep) first. **Before merging**, confirm main is clean (no
   `MERGE_HEAD`, empty `git status --porcelain`), `git fetch origin` and check
   `git log origin/main..main`: it must be empty. Commits there were merged by someone else and
   would ride along on this push — stop, list them, and let the user decide. Then
   `git merge --no-ff worktree-<slug>`. **No inventory, no numbered menu** — that is what a bare
   "merge" is for. Conflict → stop and report. Then `npx prisma generate`,
   `npm run check:docs` + `npm run typecheck` on `main`.
6. **Push** per push-protocol.md § 1–2: `git push origin main` (stop and report if `main` is
   behind `origin/main`). Clean-up (§ 3) covers **this worktree and its branch only**.
7. **Report**: the pushed range, the worktree and branch removed, skill entries changed, and
   anything skipped with the reason. **Deployed code still needs human review**; enabling
   enforcement against a production firewall is never part of this pipeline.

## The deployment-surface audit (pipeline step 2; also what a bare "push" runs)

1. Re-read `README.md`, `deploy/install-rhel.sh`, `deploy/setup-ha.sh`, `deploy/HA.md`, the
   units under `deploy/systemd/`, `deploy/nginx/charon.conf.template` (+ `Dockerfile.pqc`),
   `deploy/scripts/charon-nginx-apply.sh`, `Dockerfile`, `docker-entrypoint.sh`,
   `docker-compose.yml`, `compose.dev.yml`, `compose.podman.yml`, `compose.setup.yml`,
   `.env.example` and `.github/workflows/docker.yml` for anything the change invalidated (a new
   env var, a new runtime dependency, a changed port, a new role or unit, a new nginx location).
   Stage the fixes as their own commit.
2. A new or renamed `charon_*` metric → any dashboard or alert rule naming it moves with it.
3. A runtime or dependency pin moved → every declaration site moved in lockstep. Run
   `npm run check:versions` to prove it — the site list per family is `charon-tech-lifecycle` →
   version-pin-inventory.md.
4. The range contains no secret, real hostname, PII/COI/CIM or real data (business rule 7) — the
   repo is public and a push publishes it.

## Adding an environment variable

Add it to `.env.example` with a comment → `references/env-vars.md` → the installer if it writes
`.env` (`deploy/install-rhel.sh`) → the setup wizard if it generates `.env`
(`src/setup/setupRoutes.ts`) → the compose files if a role needs it. A secret never gets a real
default anywhere in the repo; production secrets come from the environment / Key Vault.

## Facts that bite

- **The repo is public.** `.env`, keys and certificates are gitignored; dev values in compose
  files are throwaway.
- **`CHARON_DATA_KEY` is required in production** and must be backed up — losing it makes every
  stored integration secret unrecoverable.
- **The app listens on localhost HTTP; nginx terminates TLS** (TLS 1.3, `X25519MLKEM768`). RHEL
  9.5's stock OpenSSL is too old for the hybrid KEX, so the installer builds OpenSSL 3.5 under
  `/opt` or fails loudly — it never silently ships classical-only TLS.
- **Version is automatic**: `package.json` holds `major.minor`; the patch is the commit count
  (`CHARON_BUILD_COMMIT_COUNT` baked into the image by the Docker workflow, else
  `git rev-list --count HEAD`). Never edit the patch.
- **The in-app updater self-updates only a git checkout outside Docker**; Docker installs pull a
  new image. In HA, update the standby first (`deploy/HA.md`).

Related: `charon-worktree-workflow` (merge and push protocols), `charon-docs-sync` (step 1),
`charon-tech-lifecycle` (pins and EOL), `charon-enforcement` (roles and HA behaviour).
