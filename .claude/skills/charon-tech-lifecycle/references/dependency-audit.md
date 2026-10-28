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

TODO: populate with an `overrides` policy if one is ever added to `package.json`.
