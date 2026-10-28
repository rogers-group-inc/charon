## cross-cutting/crypto-secrets

**What it is:** how Charon stores and transports secrets (business rule 3). Text below "At rest /
Transport / Signing" moved verbatim from ARCHITECTURE.md § 13.

**At rest / Transport / Signing:** See CLAUDE.md "Key coding conventions" + `utils/crypto.ts`.
At-rest envelope: `c1.<alg>.<keyId>.<iv>.<tag>.<ct>` (AES-256-GCM). Transport hybrid KEX
(`X25519MLKEM768`) is negotiated by nginx/OpenSSL 3.5 and the agent's rustls client. Token
signing is designed crypto-agile (ML-DSA where supported, Ed25519 fallback with a recorded
`alg`) — the current build stores opaque random tokens hashed with SHA-384, leaving the signing
path as the documented next step. **Expert crypto review required before production.**

**Writers:**
- `src/utils/crypto.ts → encryptSecret()` (envelope names the alg + key id), `sha384hex()`,
  `generateToken()`; `src/utils/password.ts → hashPassword()` (argon2id).
- `src/services/integrationConfig.ts → writeConfig()` (Integration.config secrets).
- `agentTokenService`, `apiTokenService`, `invitationCodeService` (hash-only token storage).
- `src/services/backupService.ts` (optional AES-256-GCM backups, scrypt-derived key).

**Readers:**
- `src/utils/crypto.ts → decryptSecret()`, `timingSafeHexEqual()`;
  `integrationConfig → decryptConfig()` / `readConfigMasked()`.

**Invariants:**
- `CHARON_DATA_KEY` is required in prod; losing it makes stored secrets unrecoverable — back it
  up (Key Vault).
- Hashing is SHA-384/512; passwords argon2id; bearers / codes / API tokens stored as SHA-384
  only and shown once; comparisons constant-time.
- Never hand-roll a primitive; `tests/unit/crypto.test.ts` pins the envelope.

**When changing this:** any change here, to the agent↔server protocol, or to TLS settings needs
review by a security-qualified maintainer before merge (`CONTRIBUTING.md`).
