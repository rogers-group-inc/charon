## cross-cutting/fortinet-ownership

**What it is:** the two safety rails on every Fortinet write — the `charon-*` ownership namespace
(business rule 1) and the per-integration dry-run default (rule 2). Fortinet writes are
destructive; these are the only things standing between a tag change and a production firewall.

**Writers** (the only code that may write to a Fortinet device):
- `src/services/fortinetEnforcementService.ts → applyEndpointDelta()` — the delta applier;
  names objects via `addrGroupName()` / `endpointAddressName()`.
- `src/services/fortigateService.ts → fgWrite()` — the transport, called only from the above.
- `src/services/fortinetEnforcementService.ts → setEnforcementMode()` — flips
  `Integration.enforcementMode`, behind `PATCH /integrations/:id/enforcement`
  (`enforcement` fullwrite).

**Readers:**
- `src/jobs/enforcementSyncJob.ts` (enforcer role) drains `QUEUES.enforcementSync`.
- `GET /integrations/:id/enforcement-state` (`enforcement` read) and the Integrations page drift
  surface (EnforcementState `status`).

**Invariants:**
- The `charon-` prefix is applied ONLY at the Fortinet boundary; never stored on a Tag/Policy
  name; never read-then-rewrite a non-`charon-*` object.
- `dry_run` computes the change, records EnforcementState (status `dry_run`) + Event + metrics,
  and writes NOTHING. Dry-run and enforce branches keep the same EnforcementState / Event /
  metrics shape.
- FMG enforce stays dry-run (a half-applied policy package is worse than none) until the
  policy-package install flow is completed and reviewed.
- Concurrency: direct-FortiGate ~20 concurrent; FMG-proxied serialized (~1).

**When changing this:** flipping any default toward `enforce`, widening the namespace, or adding
a new write path needs the `enforcement` fullwrite gate, a test proving dry-run writes nothing,
and human review before it ships.
