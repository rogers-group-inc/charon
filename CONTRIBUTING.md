# Contributing to Charon

Thanks for your interest in contributing.

## Ground rules

- **Never commit secrets or real data.** No credentials, private keys, `.env` files, customer
  or production data, or internal hostnames. Use redacted or synthetic examples. Secret
  scanning + push protection are enabled.
- **Security-sensitive changes need review.** Anything touching cryptography, the agent↔server
  protocol, authentication, or the Fortinet enforcement writeback requires review by a
  security-qualified maintainer before merge.
- **Fortinet writes are destructive.** Enforcement against real firewalls defaults to dry-run
  and is gated behind an explicit per-integration toggle. Charon only manages objects it owns
  (the `charon-*` namespace) and must never modify operator-authored policies.

## Development workflow

1. Branch from the default branch; do not push directly to it.
2. Keep changes focused; write tests (Vitest) for new behavior.
3. Run lint and tests locally before opening a PR.
4. Update the living docs when behavior changes: `CLAUDE.md`, `ARCHITECTURE.md`,
   `TEMPLATES.md`, `TOUCHES.md`.
5. Open a PR; ensure CI, CodeQL, and Dependabot checks pass.

## Commit / PR conventions

- Clear, imperative commit messages describing the change and why.
- Reference related issues where applicable.
- PRs should describe the change, the testing performed, and any security considerations.
