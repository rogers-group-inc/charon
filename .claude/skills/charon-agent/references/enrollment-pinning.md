# Enrollment and cert pinning

The two pattern entries moved verbatim from TEMPLATES.md.

### Agent enrollment (one-time code → bearer + pin)
**Ref:** `src/services/agentEnrollmentService.ts` + `invitationCodeService.ts`
(atomic `consumeCode`) + `agentTokenService.ts` (SHA-384-hashed bearer) +
`certPinService.ts` (canonical + staged pins). Codes/bearers stored hashed only.

### Cert pin rotation (dual-pin)
**Ref:** `src/services/certPinService.ts` — `stageNewPin` (agents accept old+new)
→ `src/services/webServerService.ts → rotateCertAndKey()` (refuses an unstaged pin; swaps the
pair; `nginx -t` + reload) → `swapCanonicalPin` (new pin canonical, old pin stays accepted)
→ `retirePin` (never the last pin, never the served cert's). Pin = bare lowercase-hex leaf
SHA-256 (`webServerService.ts → certFacts()`; `certPinService.ts → normalizePin()` also accepts
`sha256:<hex>` and colon-separated input).

## The rotation, as an operator runs it

Server Settings → Web Server → Rotate certificate (all steps `serverSettingsSystem` fullwrite,
each logs an Event):

1. **Preflight** — `POST /server-settings/proxy/cert/preflight` (multipart cert + key):
   `validateCertKeyPair()` (parses, not expired, key matches the cert) and reports the new pin.
   The PEMs are echoed back and held in the dialog, not stored.
2. **Stage** — `POST /server-settings/agents/cert-pins/bulk-add` → `stageNewPin()`. Every agent
   is handed canonical ∪ staged on its next `GET /agents/config`, which records what it was
   handed (`recordDeliveredPins()` → `Endpoint.serverCertFingerprint` /
   `additionalCertFingerprints`). `GET /server-settings/agents/cert-pins/summary` tallies uptake
   per pin across active endpoints (`listActiveDeliveredPins()` + `tallyPins()`).
3. **Swap** — `POST /server-settings/proxy/cert/rotate` → `rotateCertAndKey()`: refuses (409) a
   cert whose pin is neither canonical nor staged (only the very first cert, with no canonical
   pin, is exempt); writes the new pair in place (key 0600, `.prev` backups); re-stages the live
   nginx config through `charon-nginx-apply.sh` (`nginx -t` + reload; the old pair is restored on
   failure); updates `cert.leaf`; then `swapCanonicalPin()` — the new pin becomes canonical and
   the old one stays staged, still accepted. In Docker/dev (no wrapper) the pair is written and
   nginx must be reloaded by hand.
4. **Retire** — `POST /server-settings/agents/cert-pins/bulk-remove` → `retirePin()`. 409 for the
   pin of the cert nginx is serving (`getServedCertFingerprint()`); the last remaining pin is
   never retired (`computeRetire()` → `last_pin`); retiring the canonical pin promotes the first
   staged one.

Skipping step 2 (or swapping before agents have polled) strands every agent that has not seen
the new pin: it refuses the new certificate and must be re-enrolled. Business rules 4, 4a.

**Fresh install:** until the first rotation there is no canonical pin. When the leader acquires
(`app.ts startSchedulers`) it runs `webServerService.adoptBootstrapAgentPin()`: if no canonical
pin exists and nginx's served (bootstrap) cert can be read, that cert's pin becomes canonical and
a warning `cert.pin.bootstrap` Event is written. An existing canonical pin is never replaced
(`certPinService.computeBootstrap()`).

`setCanonicalPin()` / `promoteStagedPin()` remain exported but no route calls them since the
old `/server-settings/certificates{,/stage,/promote}` routes were removed.

## Revocation

`POST /endpoints/:id/revoke` (`endpoints` write) → `agentTokenService → revokeBearer()`: the
endpoint goes `revoked`, `bearerRevokedAt` is stamped, and both the WS and HTTP paths reject the
bearer. Re-enrollment needs a new invitation code.
