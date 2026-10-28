# Enrollment and cert pinning

The two pattern entries moved verbatim from TEMPLATES.md.

### Agent enrollment (one-time code → bearer + pin)
**Ref:** `src/services/agentEnrollmentService.ts` + `invitationCodeService.ts`
(atomic `consumeCode`) + `agentTokenService.ts` (SHA-384-hashed bearer) +
`certPinService.ts` (canonical + staged pins). Codes/bearers stored hashed only.

### Cert pin rotation (dual-pin)
**Ref:** `src/services/certPinService.ts` — `stageNewPin` (agents accept old+new)
→ rotate cert → `promoteStagedPin`. Pin = leaf SHA-256 from `certInfo.leafPin`.

## The rotation, as an operator runs it

1. Server Settings → Certificates → stage the new certificate's pin
   (`POST /server-settings/certificates/stage`, `serverSettingsSystem` fullwrite). Agents pick
   up canonical ∪ staged on their next `GET /agents/config`.
2. Wait until every online agent has heartbeated since the stage.
3. Install the new certificate (`POST /server-settings/certificates`), which nginx serves after
   `nginxApplyService` validates and reloads.
4. Promote the staged pin (`POST /server-settings/certificates/promote`); the old pin retires.

Skipping step 1 or 2 strands every agent that has not seen the new pin: it refuses the new
certificate and must be re-enrolled. TODO: populate when the UI reports per-agent pin adoption.

## Revocation

`POST /endpoints/:id/revoke` (`endpoints` write) → `agentTokenService → revokeBearer()`: the
endpoint goes `revoked`, `bearerRevokedAt` is stamped, and both the WS and HTTP paths reject the
bearer. Re-enrollment needs a new invitation code.
