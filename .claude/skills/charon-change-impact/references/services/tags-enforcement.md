# Touches — tags, reconcile, custom groups, policies, posture, enforcement

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants /
When changing this). Owns / Reads / Used by / Invariant / When-changing text moved verbatim
from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/tagService.ts

**What it owns:** Tag, TagSource, EndpointTag; effective-tag computation (shared with
tagReconciler).
**Public API:** `computeEffectiveTags`, `listTags`, `createTag`, `updateTag`, `deleteTag`,
`addSource`, `removeSource`; type `EffectiveTag`.
**Cross-service deps:** Reads Endpoint (boundUserKey, postureState), DirectoryObject,
CustomGroup; `customGroupService → resolveGroupMembers()`; `eventService → logEvent()`.
**Used by:** `src/api/routes/tags.ts` (CRUD + sources), `src/services/tagReconciler.ts`;
enforcement via the enforcement-sync payload.
**Invariants:**
- EndpointTag is the materialized truth; always reconcile after a trigger rather than mutating
  it directly.
- The `charon-` Fortinet prefix is never stored on a Tag name (rule 1).
**When changing this:**
- A new TagSourceKind needs the enum, `computeEffectiveTags` matching, the source route schema,
  and the UI source modal.

---

## services/tagReconciler.ts

**What it owns:** recomputing one endpoint's effective tag set and applying the delta to
EndpointTag.
**Public API:** `reconcileEndpoint`, `reconcileAll`; type `ReconcileResult`.
**Cross-service deps:** `tagService → computeEffectiveTags()`; `eventService → logEvent()`
(breadcrumb); publishes `QUEUES.enforcementSync` (`src/jobs.ts → publish()`).
**Used by:** `src/jobs/tagReconcileJob.ts` (worker consumer), `src/api/routes/tags.ts`
(`POST /tags/reconcile`), `src/services/integrationService.ts` (after directory discovery).
**Invariants:**
- Idempotent: diff desired vs stored EndpointTag, apply the delta, publish `enforcementSync`
  only on change.
- Ownership-scoped by construction: only Charon's own EndpointTag/Tag rows are touched here.
**When changing this:** keep the "enqueue only on change" property — an unconditional publish
turns every login into a Fortinet write attempt.

---

## services/customGroupService.ts

**What it owns:** CustomGroup CRUD and membership resolution (explicit members ∪ rule matches
over DirectoryObject attributes).
**Public API:** `userMatchesRules`, `resolveGroupMembers`, `listGroups`, `createGroup`,
`updateGroup`, `deleteGroup`; types `RuleOp`, `Condition`, `RuleSet`.
**Cross-service deps:** `eventService → logEvent()`.
**Used by:** `src/api/routes/groups.ts`, `src/services/tagService.ts` (custom_group sources).
**Invariants:** `userMatchesRules` is pure (no DB) — it is what `tests/unit/customGroupRules.test.ts`
pins.
**When changing this:** a new rule `op` needs `RuleOp`, `userMatchesRules`, the route Zod
schema and the groups UI rule builder. A membership change should be followed by a reconcile of
affected endpoints — TODO: populate when the group-edit → reconcile trigger is wired.

---

## services/policyService.ts

**What it owns:** Policy CRUD (intent only; the enforcer applies it).
**Public API:** `listPolicies`, `createPolicy`, `updatePolicy`, `deletePolicy`; type
`PolicySpec`.
**Cross-service deps:** `eventService → logEvent()`.
**Used by:** `src/api/routes/policies.ts`.
**Invariants:** namespaced `charon-*` at the Fortinet boundary (rule 1); applied dry-run unless
the integration's enforce toggle is ON (rule 2).
**When changing this:** TODO: populate when policy push lands in `fortinetEnforcementService`.

---

## services/postureService.ts

**What it owns:** posture evaluation + ingest.
**Public API:** `getPosturePolicy`, `setPosturePolicy`, `evaluatePosture`, `ingestPosture`;
types `PostureState`, `PostureRaw`, `PosturePolicy`.
**Cross-service deps:** Reads/writes Endpoint.posture/postureState; Setting `posture.policy`.
**Used by:** `src/api/routes/agents.ts` (`POST /agents/posture`), `src/api/routes/agentsWs.ts`.
**Invariants:** `evaluatePosture` is what `tests/unit/posture.test.ts` pins.
**When changing this:** a posture state change must enqueue a reconcile (the posture tag source
depends on it).

---

## services/fortinetEnforcementService.ts

**What it owns:** EnforcementState; all Fortinet CMDB writes.
**Public API:** `addrGroupName`, `endpointAddressName`, `applyEndpointDelta`,
`refreshDriftCounts`, `setEnforcementMode`.
**Cross-service deps:** Reads Integration (enforcementMode + decrypted config via
`integrationConfig → decryptConfig()`), Endpoint.currentIp; `fortigateService → fgGet()` /
`fgWrite()`; `eventService → logEvent()`; metrics `recordEnforcementApply`,
`setEnforcementDrift`.
**Used by:** `src/jobs/enforcementSyncJob.ts` (enforcer role), `src/api/routes/integrations.ts`
(`PATCH /:id/enforcement` → `setEnforcementMode`).
**Invariants:** ownership scoping (rule 1), dry-run default (rule 2). FMG enforce is
intentionally dry-run-only until the policy-package install is completed.
**When changing this:** keep dry-run and enforce branches symmetric (same
EnforcementState/Event/metrics shape); never widen scope past `charon-*`. FortiManager and
standalone FortiGate are paired surfaces — a feature added to one path is evaluated for the
other in the same change.
