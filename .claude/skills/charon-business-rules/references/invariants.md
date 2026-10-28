# Business rules — the invariants

The contract layer: what must hold today, and the code that holds it. Rules 1–7 are the
founding invariants (moved verbatim from the original "Global invariants" list) and have no
narrative by design. From rule 8 on, every invariant ends with a pointer to its
`narrative-N.md`. Never renumber; retire in place.

1. **Fortinet ownership scoping** — Charon only creates/edits objects named `charon-*`. No code
   path may read-then-rewrite an operator-authored object. Enforced in
   `fortinetEnforcementService.ts`; the `charon-` prefix is applied ONLY at the Fortinet
   boundary, never stored on a Tag/Policy name.
2. **Enforcement is dry-run by default** — `Integration.enforcementMode` starts `dry_run`. Going
   `enforce` requires the `enforcement` fullwrite permission + an explicit UI confirm. Dry-run
   writes NOTHING to a firewall.
3. **Secrets never leave plaintext** — Config secrets are AES-256-GCM at rest + masked on read +
   preserved-on-unchanged. Bearers/codes are stored as SHA-384 only and shown once.
   `CHARON_DATA_KEY` is required in prod.
4. **Agent trust = pin + bearer** — The agent pins the server leaf-cert SHA-256 (not system
   roots) and carries a hashed bearer. Rotating the cert without re-enrolling agents REQUIRES
   staging the new pin first (dual-pin).
5. **Leader-only singletons** — Schedulers + enforcement scheduling run only on the
   advisory-lock holder. Adding a scheduler → start it inside `startSchedulers()` (leader), not
   at module load.
6. **Roles branch on flags** — Gate subsystems on `roleConfig()` booleans, never on the
   `CHARON_ROLE` string.
7. **Repo is public** — No secrets, real hostnames, PII/COI/CIM in code, tests, migrations, or
   seeds.
