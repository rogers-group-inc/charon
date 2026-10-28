# Domain model — integrations, credentials, the directory mirror, custom groups

## Definitions and invariants

- **Integration** — one configured external system. `type` is one of
  `src/services/integrationService.ts → INTEGRATION_TYPES` (FortiManager / FortiGate are
  enforcement targets; Active Directory / Entra ID / Intune are directory sources).
  `config` is JSON; secret fields are AES-256-GCM envelopes (see
  `integrationConfig.SECRET_FIELDS`). `enforcementMode` defaults `dry_run`; flipping to
  `enforce` needs the `enforcement` fullwrite permission and human review (business rule 2).
  `lastTestAt` / `lastTestOk` are stamped by the health-check job.
- **Credential** — a stored connection credential (`ldap`, `restapi`, …) used by integrations;
  secret fields are AES-256-GCM envelopes.
- **DirectoryObject** — a read-only mirror of a directory user / group / OU, unique on
  `(integrationId, kind, externalId)`. `attributes` feeds custom-group rules. Charon never
  writes back to the directory.
- **CustomGroup** — an operator-defined group: membership is the UNION of explicit `members`
  (directory user keys) and the users matched by `rules` over DirectoryObject attributes
  (`src/services/customGroupService.ts → resolveGroupMembers()`). A tag source like a directory
  group.

## Schema

```prisma
model Integration {
  id              String    @id @default(uuid())
  type            String // "fortimanager" | "fortigate" | "activedirectory" | "entraid" | "intune"
  name            String
  config          Json      @default("{}") // connection settings; secret fields are AES-256-GCM envelopes
  enabled         Boolean   @default(true)
  autoDiscover    Boolean   @default(true)
  pollInterval    Int       @default(4) // hours
  // Per-integration enforcement gate. dry_run (default) logs intended Fortinet
  // changes without writing — flipping to enforce requires human review.
  enforcementMode EnforcementMode @default(dry_run) @map("enforcement_mode")
  lastTestAt      DateTime?
  lastTestOk      Boolean?
  lastDiscoveryAt DateTime?
  lastSyncAt      DateTime? @map("last_sync_at")
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  directoryObjects DirectoryObject[]
  enforcementState EnforcementState[]

  @@index([type])
  @@index([enabled])
  @@map("integrations")
}

model Credential {
  id        String   @id @default(uuid())
  name      String   @unique
  type      String // "ldap" | "restapi" | ...
  config    Json     @default("{}") // secret fields are AES-256-GCM envelopes
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([type])
  @@map("credentials")
}

/// A user / group / OU discovered from AD / Entra / Intune. Persisted as a tag
/// source. Read-only mirror of directory state, refreshed by the worker sync.
model DirectoryObject {
  id            String              @id @default(uuid())
  integrationId String              @map("integration_id")
  integration   Integration         @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  kind          DirectoryObjectKind
  externalId    String              @map("external_id") // objectGUID / Entra object id
  name          String
  // For users: UPN/sam. For groups/OUs: distinguishedName / group id.
  identifier    String?
  attributes    Json                @default("{}") // raw directory attributes (for custom-group rules)
  parentOu      String?             @map("parent_ou")
  syncedAt      DateTime            @default(now()) @map("synced_at")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([integrationId, kind, externalId])
  @@index([kind])
  @@index([identifier])
  @@map("directory_objects")
}

/// Net-new: an operator-defined group with explicit members and/or rules over
/// directory attributes. A tag source like a directory group.
model CustomGroup {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  // Explicit member identifiers (directory user keys), unioned with rule matches.
  members     String[] @default([])
  // Rule set over DirectoryObject.attributes, e.g.
  // { "all": [ { "attr": "department", "op": "eq", "value": "OT" } ] }.
  rules       Json     @default("{}")
  createdBy   String   @map("created_by")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  sources TagSource[]

  @@map("custom_groups")
}
```

## Notes

#### Integration.config secrets

Written by `integrationConfig.ts → writeConfig()` (encrypt incoming, preserve stored ciphertext
when the mask sentinel or empty is resubmitted), projected by `readConfigMasked()`, decrypted
for use by `decryptConfig()`. A GET never returns a plaintext secret.

#### CustomGroup.rules

Shape `{ "all": [Condition…], "any": [Condition…] }`, `Condition = { attr, op: eq|neq|contains|in, value }`.
A user matches when ALL `all` conditions hold AND (no `any`, or ANY `any` condition holds);
`attr` is read from the user's `DirectoryObject.attributes` or the top-level identifier/name.
