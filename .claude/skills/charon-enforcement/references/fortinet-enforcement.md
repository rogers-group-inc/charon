# Fortinet enforcement architecture

Moved verbatim from ARCHITECTURE.md § 6.

- One `charon-<tag>` dynamic address group per tag; one `charon-ep-<shortId>`
  address per endpoint (its current IP); membership = endpoint holds tag.
  Policies reference `charon-<tag>` groups.
- `applyEndpointDelta(endpointId, added, removed)` iterates enforcement-capable
  integrations. `dry_run` records EnforcementState (status `dry_run`) + Event +
  metrics, writes nothing. `enforce` (direct FortiGate) reads the charon-owned
  group's member set, applies the new set idempotently, records `in_sync`/`error`.
- **FMG enforce stays dry-run** for now (no half-applied policy package).
- Ownership invariant: only `charon-*` objects are created/edited.
- Concurrency/scale: direct-FortiGate ~20 concurrent; FMG-proxied serialized
  (~1). Retry/backoff + TLS-verify toggle in `httpClient.ts`.

## Turning enforcement on

`PATCH /integrations/:id/enforcement` (`enforcement` fullwrite) →
`src/services/fortinetEnforcementService.ts → setEnforcementMode()`. The UI confirms loudly;
**flipping a production integration to `enforce` requires human review** (rule 2). The drift
surface on the Integrations page reads EnforcementState `status`
(`GET /integrations/:id/enforcement-state`) and `refreshDriftCounts()` feeds
`charon_enforcement_drift`.

## FortiManager ↔ standalone FortiGate

The two integrations are paired surfaces talking to the same FortiOS fleet over different
transports. A feature added to one path is evaluated for the other in the same change; skip
parity only when the feature is structurally FMG-only (ADOM scoping, policy-package install,
FMG-proxy concurrency).
