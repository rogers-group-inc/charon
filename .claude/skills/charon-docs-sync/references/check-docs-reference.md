# check-docs reference — what each check enforces and how to fix it

`scripts/check-docs.mjs` (`npm run check:docs`) scans CLAUDE.md plus every Markdown file under
`.claude/skills/**`. It runs in the pre-commit hook (`.githooks/pre-commit`, activated by
`postinstall`) and in CI (`.github/workflows/check-docs.yml`). It checks structure only — prose
accuracy is this skill's review.

| Check | Fails when | Fix |
|---|---|---|
| `docs-present` | CLAUDE.md or a listed skill's SKILL.md is missing | restore it, or remove the skill from `SKILLS` in the script and the CLAUDE.md table |
| `no-line-numbers` | a `file.ext:NNN` or prose "(line N)" reference appears | use `path/file.ts → symbolName()` |
| `models-documented` | a Prisma model is named in no doc | add its Definitions bullet + Schema block in `charon-domain-model` |
| `files-documented` | a file in `src/services`, `src/jobs`, `src/api/routes`, `src/utils` is named in no doc | add it to the file map (and the queue table for a job) |
| `paths-exist` | a concrete `src/` `public/` `prisma/` `scripts/` `deploy/` `agent/` `tests/` `.claude/skills/` path in a doc does not exist | fix or remove the reference; templated paths (`<x>`, `*`) are skipped |
| `retired-doc` | a doc names `ARCHITECTURE.md`, `TEMPLATES.md` or `TOUCHES.md` as a pointer | point at the skill that holds the content; a provenance phrase ("moved from TOUCHES.md") is allowed |
| `touches-service-coverage` | a `src/services` file has no `services/<name>.ts` mention in `charon-change-impact/references/` | add a `## services/<name>.ts` entry |
| `skill-frontmatter` | a SKILL.md lacks frontmatter, `name` ≠ directory, the description is missing or < 40 chars, or an unknown key appears | fix the frontmatter |
| `reference-size` | a reference file exceeds 1500 lines (warns over 100 KB) | split it by heading and link both halves |
| `orphan-reference` | a file under a skill's `references/` or `scripts/` is not linked from its SKILL.md, or a skill directory holds anything else | link it from the routing table, or delete it |
| `claude-md-size` | CLAUDE.md exceeds 25 KB (warns over 15 KB) | move reference material into a skill |
| `rule-anchors` | a business-rule invariant (rule 8+) lacks or mis-targets its `→ [narrative-N.md#rule-N]` pointer, an index row has no invariant, or a `## Rule N` narrative heading has no invariant | make the three layers agree |
| `util-tests` (warn) | a `src/utils` file with exports has no `tests/unit/<name>.test.ts` | add coverage when you next touch it |

## Typical failure → cause

- `files-documented` right after adding a file → you have not run this review yet.
- `paths-exist` after a rename → a skill still names the old path; grep the old name.
- `orphan-reference` after splitting a file → the new half is not in the routing table.

Bypass a single commit with `git commit --no-verify` only when the failure is caused by someone
else's untracked file in your worktree, and say so in the hand-off.
