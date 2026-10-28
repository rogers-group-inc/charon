# Domain model — integrations, credentials, the directory mirror, custom groups

## Definitions and invariants

- **Integration** — one configured external system. `type` is one of
  `src/services/integrationService.ts → INTEGRATION_TYPES` (FortiManager / FortiGate are
  enforcement targets; Active Directory and Entra ID are directory sources — Intune is
  Entra's `config.enableIntune`, not a type). `config` keys per type are fixed by
  `src/api/routes/integrations.ts → CONFIG_SCHEMAS` (create AND update).
  `config` is JSON; secret fields are AES-256-GCM envelopes (see
  `integrationConfig.SECRET_FIELDS`). `enforcementMode` defaults `dry_run`; flipping to
  `enforce` needs the `enforcement` fullwrite permission and human review (business rule 2).
  `lastTestAt` / `lastTestOk` are stamped by the health-check job.
- **Credential** — a stored connection credential; secret fields are AES-256-GCM envelopes.
  The Server Settings → Credentials tab owns the `snmp` / `winrm` / `ssh` / `restapi` / `http`
  types (`src/services/credentials/credentialService.ts → CREDENTIAL_TYPES`) and sees ONLY
  those — a row of any other type is invisible to it (404 by id). `createdBy` is the ownership
  column for the `credentials` key: write = your own rows, fullwrite = any row; null = unowned
  (fullwrite-only), never backfilled. Business rule 3a.
- **DirectoryObject** — a read-only mirror of a directory user / group / OU / device, unique
  on `(integrationId, kind, externalId)`. `attributes` feeds custom-group rules; a user's
  `attributes.memberOf` holds group DNs (AD) or group object ids (Entra) — what a
  `directory_group` tag source's `ref` must equal. Rows a whole read no longer returns are
  removed by the guarded sweep (`discovery/directoryDiscovery.ts → planSweep()`). Charon never
  writes back to the directory.
- **CustomGroup** — an operator-defined group: membership is the UNION of explicit `members`
  (directory user keys) and the users matched by `rules` over DirectoryObject attributes
  (`src/services/customGroupService.ts → resolveGroupMembers()`). A tag source like a directory
  group.
- **DiscoveryRun** — live state of one integration's discovery run (ported from polaris), one
  row per integration (`integrationId` unique, no FK). `status` queued → running → completed /
  aborted / error; the web process sets `cancelRequested`, the worker polls it and heartbeats
  `workerHeartbeatAt`; a run whose worker went silent is failed by the stale-run reaper. The
  device counters belong to the Fortinet types.
- **SshHostKey** — trust-on-first-use pin of an SSH server's host key, unique on `(host, port)`
  (the address dialed — no Endpoint FK). Every outbound `ssh2.connect` checks it before
  authenticating (`src/utils/remoteExec.ts → buildHostVerifier()`, fails closed) unless the
  credential sets `verifyHostKey: false`. Deleting a row re-opens first-use trust (audited).
- **TlsCertPin** — trust-on-first-use pin of a TLS leaf certificate (SHA-256), unique on
  `(host, port)`, for HTTPS connections that send a secret WITHOUT CA verification. A
  different certificate is refused before the request is written and parked in
  `pendingFingerprint` until an administrator trusts that exact fingerprint
  (`src/services/tlsCertPinService.ts → trustPendingCert()`); `repinUntil` opens a short
  automatic re-pin window (`allowRepin()`).

## Schema

```prisma
model Integration {
  id              String    @id @default(uuid())
  type            String // "fortimanager" | "fortigate" | "activedirectory" | "entraid" (Intune = entraid config.enableIntune)
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
  type      String // "snmp" | "winrm" | "ssh" | "restapi" | "http" (Server Settings → Credentials)
  config    Json     @default("{}") // secret fields are AES-256-GCM envelopes
  // Ownership dimension for the `credentials` function key (ported from
  // polaris): write = edit/delete/test your own rows, fullwrite = any row. A
  // username, no FK; null = UNOWNED (fullwrite-only) — never backfilled.
  createdBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  customWidgets ManufacturerCustomWidget[] @relation("ManufacturerCustomWidgetCredential")

  @@index([type])
  @@map("credentials")
}

/// A user / group / OU / device discovered from AD / Entra (+ Intune). Persisted as a tag
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

model DiscoveryRun {
  id                  String    @id @default(uuid())
  integrationId       String    @unique
  integrationName     String
  type                String // mirrors Integration.type
  status              String    @default("queued") // queued | running | completed | aborted | error
  actor               String // who triggered it (username or "auto-discovery")
  startedAt           DateTime? // set by the worker at run start
  updatedAt           DateTime  @updatedAt
  finishedAt          DateTime?
  totalDevices        Int?
  completedCount      Int       @default(0)
  skippedOfflineCount Int       @default(0)
  skippedErrorCount   Int       @default(0)
  activeDevices       Json      @default("[]") // [{ name, startedAt }]
  slowAlerted         Boolean   @default(false)
  slowAlertedDevices  Json      @default("[]")
  cancelRequested     Boolean   @default(false) // web sets this; the worker polls it and aborts
  workerHeartbeatAt   DateTime? // last write from the worker; drives the stale-run reaper
  scopeDeviceName     String? // set when the run is scoped to one FortiGate; NULL = full run
  createdAt           DateTime  @default(now())

  @@index([status])
  @@map("discovery_runs")
}

model SshHostKey {
  id          String   @id @default(uuid())
  host        String
  port        Int      @default(22)
  keyType     String // "ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa", ...
  fingerprint String // "SHA256:<base64, unpadded>" — same form `ssh-keygen -lf` prints
  firstSeen   DateTime @default(now())
  lastSeen    DateTime @default(now())

  @@unique([host, port])
  @@map("ssh_host_keys")
}

model TlsCertPin {
  id                 String    @id @default(uuid())
  host               String
  port               Int
  fingerprint        String // leaf certificate SHA-256, colon-separated hex
  subject            String    @default("") // the certificate's subject CN, for display
  firstSeen          DateTime  @default(now())
  lastSeen           DateTime  @default(now())
  pendingFingerprint String?   @map("pending_fingerprint")
  pendingSubject     String?   @map("pending_subject")
  pendingSeenAt      DateTime? @map("pending_seen_at")
  repinUntil         DateTime? @map("repin_until")

  @@unique([host, port])
  @@map("tls_cert_pins")
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
