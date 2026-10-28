# The tag pipeline

Moved verbatim from ARCHITECTURE.md § 5.

1. **Discover** (integrationService.discoverDirectory) writes DirectoryObject
   rows from AD/Entra (read-only).
2. **Define** Tags + TagSources (and CustomGroups) via the UI.
3. **Bind** a user to a device on agent login (verificationService) → sets
   `endpoint.boundUserKey`.
4. **Reconcile** (tagReconciler.reconcileEndpoint): `computeEffectiveTags()`
   resolves the endpoint's tags from facts (user memberOf / OU / custom-group
   membership / posture), diffs against EndpointTag, applies the delta, and
   enqueues `enforcementSync` on change.
5. **Enforce** (fortinetEnforcementService): renders the delta into FortiGate
   CMDB ops (dry-run unless the integration's enforce toggle is ON).

Triggers for reconcile: agent login/logout, posture change, directory sync, tag/
source edit (fleet-wide), manual `/tags/reconcile`.

## Source matching (`src/services/tagService.ts → computeEffectiveTags()`)

| Source kind | Matches when |
|---|---|
| `directory_group` | the bound user is a member of the group (memberOf DN / group externalId) |
| `directory_ou` | the bound user's DN sits under the OU's DN |
| `custom_group` | the bound user is in the resolved custom-group member set |
| `posture` | the endpoint's PostureState equals the source ref |

Each effective tag carries `reasons[]` — the audit breadcrumb stored on EndpointTag.
