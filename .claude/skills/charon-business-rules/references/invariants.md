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
3a. **Credentials-tab secrets are sealed and never returned** — Secret fields of the Server
   Settings → Credentials types (`snmp` / `winrm` / `ssh` / `restapi` / `http`) are sealed with
   `src/utils/crypto.ts → encryptSecret()` before they reach `Credential.config`
   (`src/services/credentials/credentialService.ts → sealSecrets()`), masked on every response
   (`stripSecrets()`), and preserved when the mask comes back unchanged
   (`mergeConfigPreservingSecrets()`). `openSecrets()` / `getCredential(…, { revealSecrets })`
   serve server-side probes only. The tab sees only its own five types (`CREDENTIAL_TYPES`): a
   `Credential` row of any other type — one an integration owns — is invisible to it (filtered
   from the list, 404 by id), so the tab can neither show nor overwrite it. Leans on rule 3.
4a. **A pin rotation can never strand the fleet** — `src/services/webServerService.ts →
   rotateCertAndKey()` refuses (409) a certificate whose leaf SHA-256 is neither the canonical
   nor a staged pin (only the first cert, with no canonical pin, is exempt), and
   `src/services/certPinService.ts → swapCanonicalPin()` keeps the previous pin accepted.
   `retirePin()` never removes the last remaining pin (`computeRetire()` → `last_pin`), and
   `POST /server-settings/agents/cert-pins/bulk-remove` refuses the pin of the certificate nginx
   is serving (`getServedCertFingerprint()`). Pins are bare lowercase-hex SHA-256. Leans on
   rule 4.
8. **API tokens act only through their bound role** — A verified bearer token is authorised by
   the permission matrix of `ApiToken.roleId`, read fresh per request
   (`src/api/middleware/permissions.ts → resolveSnapshot()`), and wins over any ambient session.
   A token with no role (minted before role binding) resolves to no snapshot and reaches nothing
   gated by `requirePermission`; only `requireSessionOrTokenPermission` still honours its legacy
   `scopes`. `src/services/apiTokenService.ts → createToken()` refuses a role that outranks the
   minting caller on any function key (`grantExceedsCaller()`); an admin-equivalent binding is
   allowed but logs a warning Event. A role referenced by a token cannot be deleted
   (`onDelete: Restrict`). Non-empty `trustedHosts` limit source addresses; a real token from
   elsewhere is answered 403 by `attachApiToken`. Leans on rule 3.
   → [narrative-8.md#rule-8](narrative-8.md#rule-8)
9. **An HA enrollment token buys only the right to ask** — `POST /api/v1/ha/enroll` is public,
   so the token it takes is single-use (spent at registration), expires (24 h), and is stored as
   SHA-384 only, as is the node's poll handle (`HaEnrollment.tokenHash`, `requestIdHash`;
   `src/services/haEnrollmentService.ts → registerEnrollment()`, `hashRequestId()`). Registration
   records the source address, node name and SSH host-key fingerprints and waits; the bundle —
   which carries `.env` (`CHARON_DATA_KEY`), the nginx leaf key and the replication password — is
   released by `claimBundle()` only after an operator approves (`approveEnrollment()`,
   `serverSettingsSystem` fullwrite), only once (`delivered` is terminal), only to the address
   that registered, inside the claim window. Every token rejection returns the same text.
   Leans on rule 3.
   → [narrative-9.md#rule-9](narrative-9.md#rule-9)
