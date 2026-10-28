# Domain model — tags, tag sources, effective tags, policies, enforcement state

## Definitions and invariants

- **Tag** — a named ZTNA tag. Membership = union of its **TagSource** rows + posture. `name`
  never carries the `charon-` prefix; it is applied only at the Fortinet boundary (business
  rule 1).
- **TagSource** — maps a source to a Tag: `kind` ∈ TagSourceKind; `ref` is the
  DirectoryObject.externalId (or DN) for directory_group / directory_ou, the customGroupId for
  custom_group, the PostureState value for posture. Unique on `(tagId, kind, ref)`.
- **EndpointTag** — the materialized effective tag set for an endpoint, with `reasons` (audit
  breadcrumb of contributing sources). The row exists while the endpoint holds the tag. It is
  written only by the reconciler (`src/services/tagReconciler.ts → reconcileEndpoint()`) —
  always reconcile after a trigger rather than mutating it directly.
- **Policy** — a Charon-managed dynamic firewall policy referencing a Tag. `spec` holds the
  intent (source/destination/service/action), rendered to FortiGate CMDB shape by the
  enforcement service; namespaced `charon-*` at the Fortinet boundary.
- **EnforcementState** — the desired-vs-actual record per Charon-owned Fortinet object, unique
  on `(integrationId, objectType, objectName)`; `objectType` is `addrgrp | address | policy`;
  `status` drives drift. ownerScope is implicitly "charon" (only `charon-*` objects exist here).

## Schema

```prisma
/// A named ZTNA tag. Its membership is the union of its TagSources, combined
/// with device posture. The reconciler computes each endpoint's effective tag
/// set and the enforcer mirrors it into Fortinet as `charon-<tag>` objects.
model Tag {
  id          String   @id @default(uuid())
  name        String   @unique // ZTNA tag name (the `charon-` prefix is added at the Fortinet boundary)
  description String?
  color       String?
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  sources      TagSource[]
  endpointTags EndpointTag[]
  policies     Policy[]

  @@map("tags")
}

/// Maps a source ({directory group | OU | custom group | posture state}) → a Tag.
model TagSource {
  id            String        @id @default(uuid())
  tagId         String        @map("tag_id")
  tag           Tag           @relation(fields: [tagId], references: [id], onDelete: Cascade)
  kind          TagSourceKind
  // For directory_group/ou: the DirectoryObject.externalId (or DN). For
  // custom_group: customGroupId. For posture: the PostureState value.
  ref           String
  customGroupId String?       @map("custom_group_id")
  customGroup   CustomGroup?  @relation(fields: [customGroupId], references: [id], onDelete: Cascade)
  createdAt     DateTime      @default(now())

  @@unique([tagId, kind, ref])
  @@index([kind, ref])
  @@map("tag_sources")
}

/// Effective tag membership for an endpoint, computed by the reconciler. The
/// row exists while the endpoint holds the tag; removed when it no longer does.
model EndpointTag {
  id         String   @id @default(uuid())
  endpointId String   @map("endpoint_id")
  endpoint   Endpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)
  tagId      String   @map("tag_id")
  tag        Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  // Why the endpoint has this tag (audit breadcrumb): list of contributing
  // source descriptions.
  reasons    Json     @default("[]")
  assignedAt DateTime @default(now()) @map("assigned_at")

  @@unique([endpointId, tagId])
  @@index([tagId])
  @@map("endpoint_tags")
}

/// A Charon-managed dynamic firewall policy. Always namespaced `charon-*` at the
/// Fortinet boundary so Charon never touches operator-authored policies.
model Policy {
  id          String   @id @default(uuid())
  name        String   @unique // Charon-side name; `charon-` prefix applied on push
  description String?
  tagId       String   @map("tag_id")
  tag         Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  // Policy intent: source/destination/service/action, kept abstract here and
  // rendered to FortiGate CMDB shape by the enforcement service.
  spec        Json     @default("{}")
  enabled     Boolean  @default(true)
  createdBy   String   @map("created_by")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tagId])
  @@map("policies")
}

/// Desired-vs-actual sync record for a Charon-owned Fortinet object on a given
/// integration. Drives the drift surface on the Integrations page and the
/// enforcer's idempotent delta application. ownerScope is always "charon" — the
/// ownership invariant that keeps Charon from rewriting operator objects.
model EnforcementState {
  id            String      @id @default(uuid())
  integrationId String      @map("integration_id")
  integration   Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  // What kind of object: "addrgrp" | "address" | "policy".
  objectType    String      @map("object_type")
  // Charon-managed object name (always charon-*).
  objectName    String      @map("object_name")
  endpointId    String?     @map("endpoint_id")
  endpoint      Endpoint?   @relation(fields: [endpointId], references: [id], onDelete: SetNull)
  desired       Json        @default("{}")
  actual        Json        @default("{}")
  status        SyncStatus  @default(pending)
  lastError     String?     @map("last_error")
  lastAppliedAt DateTime?   @map("last_applied_at")
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@unique([integrationId, objectType, objectName])
  @@index([status])
  @@index([integrationId])
  @@map("enforcement_state")
}
```

## Notes

#### Fortinet object naming

One `charon-<tag>` dynamic address group per tag; one `charon-ep-<shortId>` address per endpoint
(its current IP) — `src/services/fortinetEnforcementService.ts → addrGroupName()` /
`endpointAddressName()`. An endpoint holding a tag ⇒ its address is a member of that tag's
group.

#### EnforcementState in dry-run

A `dry_run` integration still records EnforcementState rows (status `dry_run`) plus an Event and
metrics — and writes nothing to the firewall (business rule 2).
