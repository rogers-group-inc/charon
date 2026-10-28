---
name: charon-tech-lifecycle
description: "Version lifecycle of the Charon tech stack: the committed end-of-life dataset (scripts/data/platformEol.json) and its refresh procedure, the version-pin inventory (every Node.js / PostgreSQL / OpenSSL / Rust MSRV pin and the file it lives in, as a lockstep table), the upgrade playbooks, the check:versions pin-consistency guard, and the npm dependency-audit procedure. Load when a task says EOL, end-of-life, LTS, upgrade, bump, version pin, minimum version, npm audit, npm outdated, Dependabot, CodeQL, or names a runtime version (Node 20 / 22 / 24, PostgreSQL 15 / 16 / 17, OpenSSL 3.5, rust-version) — and whenever a change edits engines.node, @types/node, a FROM line in a Dockerfile, an image tag in a compose file, node-version in a workflow, a version in deploy/install-rhel.sh or deploy/nginx/Dockerfile.pqc, or rust-version in agent/src-tauri/Cargo.toml."
---

# Charon tech-stack lifecycle

A runtime version is declared in several files at once — the Node major lives in eight sites — and
a bump that misses one leaves that path (the RHEL installer, the dev image, CI) on the old
runtime. This skill owns the site list, the guard that proves the sites agree
(`npm run check:versions`, `scripts/check-versions.mjs`), and the committed EOL dataset
(`scripts/data/platformEol.json`) that says when each pinned track stops being supported. The
dataset is read at check time only; nothing fetches EOL data at runtime.

## Which file

| You need… | Read |
|---|---|
| every version pin in the repo and the sites it must move with, per family | [references/version-pin-inventory.md](references/version-pin-inventory.md) |
| the EOL dataset: schema, where each date comes from, the refresh procedure | [references/eol-dataset.md](references/eol-dataset.md) |
| what `check:versions` asserts and how to fix a failure | [references/pin-consistency-check.md](references/pin-consistency-check.md) |
| how to move a runtime to a new major, step by step | [references/upgrade-playbooks.md](references/upgrade-playbooks.md) |
| `npm audit` / `npm outdated` / Dependabot / CodeQL triage | [references/dependency-audit.md](references/dependency-audit.md) |

## Invariants

- **One pin family, one commit.** Move every site of a family together; `check:versions` proves
  it, in the pre-commit hook and in CI.
- **A doc claim is a declaration site, not commentary.** "Installs Node.js 20" in a log line or
  README moves with the pin.
- **A family has two numbers: a floor and a pin.** The floor (`engines.node`, the installer's
  minimum check) is what still runs; the pin is what gets provisioned. Floor ≤ pin.
- **The dataset is evidence, not truth.** Every technology carries `source` and
  `sourceCheckedOn`; a date nobody read from a vendor page is `null`, never a plausible guess.
- **An upgrade is a decision, not a refresh.** Moving `charonMinimum` / `charonTarget` or a pin is
  a project decision with its own worktree and review; the quarterly refresh only updates dates.
- **Never run `npm audit fix --force`** — it jumps majors unreviewed.
- **Human review.** EOL dates and upgrade schedules drive production change windows — Claude
  drafts them, a human confirms them.

## Current state (re-derive with `npm run check:versions`)

Node.js is pinned at 20, past its end of life — the checker warns on every run until the upgrade
lands (`references/upgrade-playbooks.md` → Node.js).

Related: `charon-deploy` (the deploy-surface audit runs `check:versions`), `charon-agent`
(the Rust MSRV), `charon-docs-sync` (routes a pin change here).
