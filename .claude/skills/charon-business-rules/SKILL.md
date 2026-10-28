---
name: charon-business-rules
description: "The numbered Charon business rules — each invariant and the incident that forced it. Load BEFORE changing any behavior around Fortinet writes and the charon-* ownership namespace, the dry-run / enforce toggle (EnforcementMode), at-rest secrets and their masking, bearer / API-token / invitation-code hashing, CHARON_DATA_KEY, agent trust (leaf-cert pin, dual-pin rotation, bearer revocation), leader election and which schedulers run where, API-token role binding, HA node enrollment, Credentials-tab secrets, process roles and roleConfig() flags, or anything that could put secrets, hostnames or real data into this public repo; whenever code, a commit or a doc cites 'business rule N' / 'rule N' / 'rule Na'; and when asked to add or retire a rule, or which rule number is free next."
user-invocable: false
---

# Charon business rules

A business rule is an invariant the code must keep, with the reason it exists. Each rule has a
stable number; code comments, tests, commits and other skills cite it as "rule N".

## Numbering

- **Rule numbers are a stable citation key.** Never renumber. Retire a rule in place ("retired
  YYYY-MM-DD, see rule M") and give a new rule the next free number. A retired number is never
  re-used.
- **The next free number is derived, never stated**: `npm run rules:next`
  (`scripts/next-rule-number.mjs`) scans `main` and every `worktree-*` branch, because two open
  worktrees each taking "the next free number" off main alone collide. Run it **before the
  first citation**, not at merge.
- **Sub-clauses**: a new PRINCIPLE gets a new number; a new CONSEQUENCE of an existing principle
  gets a letter on that rule (`4a`). A lettered clause large enough to carry its own narrative
  gets its own `## Rule Na` heading and index row.

## How to read

| Layer | Where | What it is | Length |
|---|---|---|---|
| **title** | the index below | the aphorism a commit or comment cites beside the number | one line |
| **invariant** | [references/invariants.md](references/invariants.md) | the CONTRACT as it stands today: what must hold, the functions and columns that hold it, and pointers to the rules it leans on. No dated history | about 150 words; 250 is the ceiling |
| **narrative** | `references/narrative-N.md`, one file per rule | the incident, the reasoning, the alternatives rejected, the dated history — verbatim, never summarized | as long as it needs |

Rules 1–7 are the founding invariants carried over from the project's original design (the
"global invariants" list); they have **no narrative by design** — no incident forced them. Every
rule from 8 on has a narrative file.

| You are about to… | Read |
|---|---|
| write to a Fortinet device, name a Fortinet object, add a policy push | 1, 2 |
| touch a secret field, a token, a code, `CHARON_DATA_KEY` | 3, 3a, 9 |
| change enrollment, the agent's TLS trust, cert upload or rotation | 4, 4a |
| change API-token auth, token roles, CSRF for bearers | 8 |
| open an outbound SSH / HTTPS connection that carries a secret; edit an integration's host / TLS | 11, 11a |
| push-deploy, upgrade or uninstall the agent; change an install script or the enrollment preseed | 12 |
| change HA node enrollment or the `/ha/enroll` surface | 9 |
| add a scheduler, a periodic job, anything that must run exactly once | 5 |
| gate code on the process role | 6 |
| add a fixture, seed, migration, test data, example config | 7 |

## Add or retire a rule

1. `npm run rules:next` for the number. Never take one listed as claimed by another branch.
2. **Invariant**: one paragraph appended to [references/invariants.md](references/invariants.md)
   (the filename is a stable citation key and keeps its name), in the contract shape above —
   about 150 words, the functions and columns named, no dated history — ending with the pointer
   `→ [narrative-N.md#rule-N](narrative-N.md#rule-N)`.
3. **Narrative**: a new file `references/narrative-N.md` headed `## Rule N — <title>` (with an
   `<a id="rule-N"></a>` anchor above it), holding `### What happened`, `### Why it happened`,
   `### The decision` and the tests that pin it. Link it from the reference list below.
4. **Index row** in the table below, and the number cited from the code and the test that pins
   it. `npm run check:docs` (`rule-anchors`) fails on a pointer that does not resolve, an index
   row with no invariant, or a narrative heading with no invariant.
5. **Retiring**: leave the number in every table with "retired YYYY-MM-DD, see rule M"; never
   delete or renumber.

## Reference files

- [references/invariants.md](references/invariants.md) — every rule's invariant, in number order.
- Narratives (rules 1–7 and lettered clauses on them have none by design):
  [references/narrative-8.md](references/narrative-8.md) (rule 8),
  [references/narrative-9.md](references/narrative-9.md) (rule 9),
  [references/narrative-11.md](references/narrative-11.md) (rule 11),
  [references/narrative-12.md](references/narrative-12.md) (rule 12).
- Rule 10 is claimed by the in-flight `worktree-users-auth-port` branch (`npm run rules:next`).

## Index

| # | Rule | Invariant | Narrative |
|---|---|---|---|
| 1 | Fortinet ownership scoping — Charon only creates/edits `charon-*` objects | invariants | — |
| 2 | Enforcement is dry-run by default | invariants | — |
| 3 | Secrets never leave plaintext | invariants | — |
| 3a | Credentials-tab secrets are sealed and never returned; integration-owned rows are invisible to the tab | invariants | — |
| 4 | Agent trust = pin + bearer | invariants | — |
| 4a | A pin rotation can never strand the fleet (unstaged pin refused; last / served pin never retired) | invariants | — |
| 5 | Leader-only singletons | invariants | — |
| 6 | Roles branch on flags, never the role string | invariants | — |
| 7 | The repo is public — no secrets, real hostnames, PII/COI/CIM | invariants | — |
| 8 | API tokens act only through their bound role | invariants | narrative-8 |
| 9 | An HA enrollment token buys only the right to ask | invariants | narrative-9 |
| 11 | A secret is never sent to an unauthenticated server (SSH host key / TLS cert TOFU pins) | invariants | narrative-11 |
| 11a | A stored secret follows its destination | invariants | narrative-11 |
| 12 | A push deploy runs as root only behind fullwrite, a pinned transport, a verified installer and a sealed single-use code | invariants | narrative-12 |

Related: `charon-change-impact` (where each rule is enforced in code),
`charon-enforcement` (rules 1, 2, 5 in the pipeline), `charon-agent` (rule 4).
