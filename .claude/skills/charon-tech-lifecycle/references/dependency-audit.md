# Dependency audit

## The feeds

- **Dependabot** — `.github/dependabot.yml`; opens PRs for npm (and the ecosystems it lists).
- **CodeQL** — `.github/workflows/codeql.yml`; JavaScript/TypeScript today, Rust once the agent
  crate is added to it.
- **`npm audit` / `npm outdated`** — run locally in a worktree.

## Procedure

1. In a worktree: `npm outdated` and `npm audit --audit-level=high`.
2. For each finding, decide: patch/minor within range (take it), a major (it is an upgrade —
   check whether it is architectural; see version-pin-inventory.md "Things that are NOT pins"),
   or not reachable (record why).
3. **Never `npm audit fix --force`.** Bump deliberately, one dependency or one family per commit.
4. `npm ci` from clean, `npx prisma generate`, typecheck, unit suite. A dependency change that
   only fails under a clean `npm ci` is real — CI runs `npm ci`.
5. Security-relevant packages (`@node-rs/argon2`, `@node-saml/node-saml`, `openid-client`,
   `ldapts`, `undici`, `ws`, `express-session`, `helmet`) get a changelog read, not just a green
   suite.

## Reviewing a Dependabot backlog

Old Dependabot PRs go stale: their lockfile is from a previous `main`, and their target majors
age (a PR for setup-node 6 when 7 is current). Rather than merging the PR branches, re-apply
each bump in a worktree on current `main`, verify it (step 4), commit it with "supersedes
Dependabot #N", and close the PR with a comment naming the commit. A grouped minor/patch PR is
re-applied at its versions in one commit.

Bumps that stay held, and why (as of 2026-10-28):

| Bump | Held because | Unblocked by |
|---|---|---|
| `undici` 8 | engines `node >=22.19.0` | the Node upgrade (upgrade-playbooks.md → Node.js) |
| `@types/node` major | must match the runtime major (it is a `node-major` floor site) | the Node upgrade, in the same commit |
| agent Rust crates (`reqwest` 0.13, `thiserror` 2, `directories` 6, `sha2` 0.11, `tokio-tungstenite` 0.30) | no toolchain here and no CI job builds the agent; `reqwest` 0.13 removed the rustls root-store features the pinned-TLS client uses | an agent build job, then a pinning test per bump |

Traps seen:
- `eslint.config.mjs` imports `@eslint/js`; it must be a declared devDependency at the same
  major as `eslint` (it used to resolve only through eslint 9).
- zod 4: `ZodError.errors` → `.issues` (tsc misses it where the caught error is untyped), and
  `z.record()` needs an explicit key schema.

TODO: populate with an `overrides` policy if one is ever added to `package.json`.
