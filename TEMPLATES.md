# TEMPLATES.md — Charon canonical implementations

When you add something, copy the canonical example here rather than inventing a
new shape. Each entry: what it is, the reference file, conventions to match.

## Reused polaris patterns

### Permission-gated route
**Ref:** `src/api/routes/events.ts` + mount in `src/api/router.ts`.
Mount under `requirePermission(key, "read")`; per-route writes add
`requirePermission(key, "write")`. Zod schema at the top; `next(err)` to the
shared `errorHandler`. Coerce `req.params.id` with `String()` (Express 5 types
it `string|string[]`).

### Integration type (testConnection stereotype)
**Ref:** `src/services/fortigateService.ts` (+ registration in
`integrationService.ts` dispatcher). Export
`testConnection(config, signal?) → {ok,message,version?}`; directory sources
also export `discover() → DiscoveredDirectoryObject[]`. Route HTTP through
`httpClient.ts` (timeout + abort race + transient retry + per-call TLS-verify).
Add the type to `INTEGRATION_TYPES`, the `dispatchTest`/`dispatchDiscover`
switches, and `SECRET_FIELDS` in `integrationConfig.ts`.

### Setting-backed config with masked secrets
**Ref:** `src/services/integrationConfig.ts`. Secrets are AES-256-GCM envelopes
at rest (`writeConfig`), masked on read (`readConfigMasked`),
preserved-on-unchanged when the mask is resubmitted, decrypted for use
(`decryptConfig`). Never return a plaintext secret from a GET.

### Table / modal / toast (frontend)
**Ref:** `public/js/integrations.js` (cards + data-driven modal) and
`public/js/endpoints.js` (table + modal). Use `window.api.{get,post,put,patch,del}`,
`window.Charon.{init,toast,escapeHtml,can}`. Tabs: `public/js/server-settings.js`.
`.charon-modal` + `.data-table` + `.btn-*` + `.badge-*` from `charon.css`.

### Prometheus instrumentation
**Ref:** `src/metrics.ts`. Define the metric once, export a typed helper
(`startXTimer()` / `recordX(...)`); callers never touch metric objects. HTTP
timing is wired in `app.ts`.

### Queue-on-failure / retry (HTTP)
**Ref:** `src/services/httpClient.ts` — `markRetryable` on transient faults
(network/5xx/timeout), permanent faults (401/403/404/405) throw immediately;
bounded backoff; external-abort race distinct from timeout.

## Charon-new patterns

### Managed-tag namespace (ownership scoping)
**Ref:** `src/services/fortinetEnforcementService.ts` — `addrGroupName()` /
`endpointAddressName()` apply the `charon-` prefix at the Fortinet boundary.
**Never** read-then-rewrite a non-`charon-*` object. Tag names themselves never
carry the prefix.

### Tag source + effective-tag computation
**Ref:** `src/services/tagService.ts` `computeEffectiveTags()` — gather endpoint
facts once, match each TagSource by kind, return `{tagId, tagName, reasons[]}`.
Add a new source kind here + in `TagSourceKind` + the reconciler.

### Reconcile → enqueue enforcement (dry-run safe)
**Ref:** `src/services/tagReconciler.ts` — diff desired vs stored EndpointTag,
apply delta, log a breadcrumb Event, publish `enforcementSync` only on change.

### Enforcement writeback (per-integration enforce toggle)
**Ref:** `src/services/fortinetEnforcementService.ts` `applyEndpointDelta()` —
dry-run records EnforcementState + Event + metrics and writes nothing; enforce
applies idempotently. Gate the toggle route by the `enforcement` fullwrite key
with a human-review confirm.

### Agent enrollment (one-time code → bearer + pin)
**Ref:** `src/services/agentEnrollmentService.ts` + `invitationCodeService.ts`
(atomic `consumeCode`) + `agentTokenService.ts` (SHA-384-hashed bearer) +
`certPinService.ts` (canonical + staged pins). Codes/bearers stored hashed only.

### Cert pin rotation (dual-pin)
**Ref:** `src/services/certPinService.ts` — `stageNewPin` (agents accept old+new)
→ rotate cert → `promoteStagedPin`. Pin = leaf SHA-256 from `certInfo.leafPin`.

### Leader-gated scheduler / role consumer
**Ref:** `src/app.ts startSchedulers/startConsumers` + `jobs/*.ts`. Schedulers
run only inside the leader `onAcquire` callback; consumers register on their
role; both no-op gracefully when pg-boss is unavailable.

### Crypto-agile at-rest secret
**Ref:** `src/utils/crypto.ts` — `encryptSecret`/`decryptSecret` (envelope names
the alg + key id), `sha384hex`, `generateToken`, `timingSafeHexEqual`.

### nginx render → stage → sudo apply
**Ref:** `src/services/nginxRenderer.ts` + `nginxApplyService.ts` +
`deploy/scripts/charon-nginx-apply.sh`. App stages, the scoped sudoers wrapper
runs `nginx -t` and reloads/rolls back.
