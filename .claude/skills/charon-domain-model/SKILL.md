---
name: charon-domain-model
description: "Charon data model: every Prisma entity (Role, User, GroupMapping, ApiToken, Setting, Event, Integration, Credential, DirectoryObject, CustomGroup, InvitationCode, Endpoint, VerificationSession, Tag, TagSource, EndpointTag, Policy, EnforcementState, and the Server Settings registries AssetTag, AssetTypeDef, DeviceIcon, HaEnrollment, FirmwareImage, FirmwareCredentialBinding, ManufacturerAlias, MibFile, ManufacturerProfile(+Metric, +MetricOverride), ManufacturerCustomWidget), its fields, enums (EndpointStatus, PostureState, AuthMode, TagSourceKind, DirectoryObjectKind, EnforcementMode, SyncStatus) and load-bearing invariants, plus the Setting keys the code reads. Load whenever a task names a table, model, column, enum or Setting key; asks what a field means or where something is stored (bearer hash, cert pins, boundUserKey, posture, enforcementMode, desired/actual); adds a field/column/model; edits prisma/schema.prisma; or writes a migration."
---

# Charon domain model

`prisma/schema.prisma` is the source of truth for shape; this skill holds the semantics — what
each entity means, which columns are load-bearing, and the invariants every write must keep.
Every reference file has the same three parts for its entities: **Definitions and invariants**
(one bullet per entity — the contract), **Schema** (the model blocks, verbatim from
`schema.prisma`), **Notes** (extended behavioural notes). Read the definitions first; go to
Schema/Notes for a field.

## Which file

| Entities | File |
|---|---|
| Role, User, GroupMapping, ApiToken | [references/identity-rbac.md](references/identity-rbac.md) |
| Integration, Credential, DirectoryObject, CustomGroup | [references/integrations-directory.md](references/integrations-directory.md) |
| InvitationCode, Endpoint, VerificationSession | [references/endpoints-agent.md](references/endpoints-agent.md) |
| Tag, TagSource, EndpointTag, Policy, EnforcementState | [references/tags-enforcement.md](references/tags-enforcement.md) |
| Setting (and every key the code reads), Event | [references/platform.md](references/platform.md) |
| AssetTag, AssetTypeDef, DeviceIcon, HaEnrollment, FirmwareImage, FirmwareCredentialBinding, ManufacturerAlias, MibFile, ManufacturerProfile, ManufacturerProfileMetric, ManufacturerProfileMetricOverride, ManufacturerCustomWidget (Server Settings) | [references/server-settings.md](references/server-settings.md) |

## Rules that bind every write

- **Secrets are never plaintext at rest.** Secret fields inside `Integration.config` /
  `Credential.config` are AES-256-GCM envelopes (`src/utils/crypto.ts → encryptSecret()`);
  bearers, API tokens and invitation codes are stored as SHA-384 only. Business rule 3.
- **Every audit-worthy write records an `Event`** (`src/services/eventService.ts → logEvent()`).
- **The repo is public** — no real data, hostnames or secrets in a migration or seed. Rule 7.
- **Adding a model or column**:
  1. `prisma migrate dev --name <change>` (or `migrate diff` for the SQL) and commit the
     migration.
  2. Update affected services, the Zod schema in the route file, the matching Definitions
     bullet + Schema block here, and the `charon-change-impact` entries via `/charon-docs-sync`.
  3. If you added a secret field, register it in `integrationConfig.SECRET_FIELDS`
     (`src/services/integrationConfig.ts`).
  4. Re-run `npm run typecheck && npm test`.

  `npm run check:docs` fails on a Prisma model no skill file names.

## Enums

```
EndpointStatus:      pending | enrolled | online | offline | revoked
PostureState:        unknown | compliant | noncompliant
AuthMode:            local | saml | oidc            // operator auth AND the agent login GUI
TagSourceKind:       directory_group | directory_ou | custom_group | posture
DirectoryObjectKind: user | group | ou | device
EnforcementMode:     dry_run | enforce              // per Integration; default dry_run
SyncStatus:          pending | in_sync | drift | error | dry_run
```

Two state flows carry most behaviour: an Endpoint's `status` (pending → enrolled → online ⇄
offline, → revoked) and an EnforcementState's `status` (pending → in_sync / drift / error, or
dry_run when the integration is not enforcing). Their writers are in `charon-change-impact`.

Related: `charon-change-impact` (who writes and reads each entity), `charon-business-rules`
(the invariants by number), `charon-enforcement` (the tag pipeline that joins these entities).
