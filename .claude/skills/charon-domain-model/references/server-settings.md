# Domain model — Server Settings registries (identification, HA enrollment, firmware, credentials catalogue)

The models ported from polaris with the Server Settings page. Charon has **no asset inventory**:
nothing references these rows from an Endpoint yet, so every device count, usage panel and
match preview reads zero. Charon's own `Tag` (the ZTNA tag pushed to Fortinet) is a different
model — see tags-enforcement.md.

## Definitions and invariants

- **AssetTag** — the Identification tab's asset-tag registry (`asset_tags`), NOT the ZTNA `Tag`.
  `color` is `#rrggbb` or `severity:<level>`, written only via
  `src/services/assetTagService.ts → normalizeTagColor()`. `assetCondition` is the auto-assign
  device filter (validated by `src/utils/deviceFilterCondition.ts`); an empty tree is collapsed
  to NULL on write — never "all devices".
- **AssetTypeDef** — the device-type registry behind Identification → Device Types. Built-ins
  are seeded by migration `20261028000005_settings_identification` (and
  `src/services/assetTypeService.ts → seedBuiltInAssetTypes()` when the table is empty) with
  `isBuiltIn` + `isProtected`: they cannot be renamed, relabelled or deleted, but their
  `matchRules` stay editable. `matchRules` is the AND/OR tree `src/utils/assetTypeMatch.ts`
  validates; null = never inferred.
- **DeviceIcon** — an operator-uploaded icon, bytes in the DB (so HA nodes serve the same image
  with no shared filesystem), unique on `(scope, key)`; `scope` is `manufacturer-type` or
  `manufacturer-model`. SVG is stored as-is and served under a sandboxing CSP
  (`src/api/routes/settings/identification.ts → deviceIconsRouter`).
- **HaEnrollment** — one HA node enrollment (`src/services/haEnrollmentService.ts`). Only
  SHA-384 digests are stored: `tokenHash` (the single-use token, prefix-indexed by
  `tokenPrefix`) and `requestIdHash` (the node's poll handle). `status` walks
  issued → pending (token spent) → approved (operator) → delivered (bundle downloaded once,
  terminal), or → rejected / expired; `expireStaleEnrollments()` expires rows past their window
  before every lookup. Business rule 9.
- **FirmwareImage** — one uploaded firmware `.out` filed under manufacturer › device type
  (`switch` / `access_point` / `firewall`) › model. Bytes live on disk under
  `src/utils/paths.ts → FIRMWARE_DIR` (`storagePath` is relative to it) — never in the DB, so a
  database backup does not carry them. `sha256` is unique. Each platform holds at most one
  `primary` and one `backup` (partial unique indexes + CHECKs in migration
  `20261028000007_settings_firmware`; `role = "swapping"` only inside the make-primary
  transaction).
- **FirmwareCredentialBinding** — which device-admin login applies at a manufacturer
  (`assetType` null), device-type (`model` null) or model scope; the most specific live binding
  wins. `credentialId` names a Credential LOOSELY (no FK): a deleted credential leaves a dangling
  id that reads as stale.
- **ManufacturerAlias** — lowercased + trimmed `alias` → `canonical` manufacturer spelling,
  cached by `src/services/credentials/manufacturerNormalize.ts`.
- **MibFile** — an SNMP MIB module uploaded on Credentials → MIB Database; text inline
  (≤ 1 MiB), validated by the SMI parser on upload (`src/services/credentials/mibService.ts`).
  Unique on `(manufacturer, model, moduleName)`; `manufacturer` null = generic.
- **ManufacturerProfile** — an operator-editable per-manufacturer SNMP telemetry profile;
  `manufacturer` is the canonical (alias-mapped) form. `matchPattern` is an operator regex
  (`src/utils/safeRegex.ts` guards it).
- **ManufacturerProfileMetric** — one row per System-tab metric a profile owns, unique on
  `(profileId, metricKey)`; cascades with the profile.
- **ManufacturerProfileMetricOverride** — a scoped row under a metric (device-type default,
  per-model exception, or both); the scope CHECK lives in migration
  `20261028000006_settings_credentials`.
- **ManufacturerCustomWidget** — an operator-defined widget (gauge / line / value / table /
  state / http) on a profile; `credentialId` (SetNull) attaches a Credential for an HTTP check.

## Schema

```prisma
// ─── Server Settings: Identification ───
// Ported from polaris (Tag / AssetTypeDef / DeviceIcon). Named Asset* because
// charon's own `Tag` is the ZTNA tag pushed to Fortinet — these are the
// asset/device classification registries behind the Identification tab.
// Charon has no asset inventory yet, so nothing references these rows; the
// registries are kept so charon Endpoints can be classified by them later.
// DNS / OUI config lives in the Setting table (as polaris).

// Asset-tag registry. `assetCondition` is the auto-assign device filter (the
// shared condition-builder tree); NULL = an ordinary manual tag. An empty
// tree is collapsed to NULL on write — it is never "all devices".
model AssetTag {
  id             String   @id @default(uuid())
  name           String   @unique
  category       String   @default("General")
  // "#rrggbb" or "severity:<level>" — written only via normalizeTagColor.
  color          String   @default("#4fc3f7")
  assetCondition Json?    @map("asset_condition")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  @@index([category])
  @@map("asset_tags")
}

// Device-type registry (polaris AssetTypeDef). Built-ins are seeded by the
// migration with isBuiltIn + isProtected; their matching rules stay editable.
model AssetTypeDef {
  id            String   @id @default(uuid())
  name          String   @unique // lowercase [a-z0-9_-], 2-32 chars
  label         String
  description   String?
  isBuiltIn     Boolean  @default(false) @map("is_built_in")
  isProtected   Boolean  @default(false) @map("is_protected")
  createdBy     String?  @map("created_by")
  // Nested AND/OR tree validated by src/utils/assetTypeMatch.ts; null = never inferred.
  matchRules    Json?    @map("match_rules")
  matchContexts String[] @default([]) @map("match_contexts")
  matchPriority Int      @default(100) @map("match_priority")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@map("asset_type_defs")
}

// Operator-uploaded device icons (bytes in the DB, as polaris, so HA replicas
// serve the same images without a shared filesystem).
model DeviceIcon {
  id         String   @id @default(uuid())
  scope      String // "manufacturer-type" | "manufacturer-model"
  key        String // "<manufacturer>/<assetType|model>"
  filename   String
  mimeType   String   @map("mime_type")
  data       Bytes
  size       Int
  uploadedBy String?  @map("uploaded_by")
  uploadedAt DateTime @default(now()) @map("uploaded_at")

  @@unique([scope, key])
  @@index([scope])
  @@map("device_icons")
}

// ─── Server Settings: API Tokens + High Availability ───

// One HA node enrollment (polaris port). The tab mints a single-use token
// embedded in a bootstrap script; the node registers with it (token spent),
// an operator approves, and the node downloads its bundle ONCE. Only SHA-384
// digests of the token and of the poll handle are stored.
model HaEnrollment {
  id       String @id @default(uuid())
  role     String // "primary" | "standby"
  nodeName String @map("node_name")
  nodeAddr String @map("node_addr")

  tokenHash     String   @map("token_hash") // SHA-384 of the raw token
  tokenPrefix   String   @map("token_prefix")
  expiresAt     DateTime @map("expires_at")
  requestIdHash String?  @unique @map("request_id_hash") // SHA-384 of the poll handle

  // issued | pending | approved | delivered | rejected | expired
  status String @default("issued")

  registeredFromIp       String?   @map("registered_from_ip")
  registeredNodeName     String?   @map("registered_node_name")
  sshHostKeyFingerprints String[]  @default([]) @map("ssh_host_key_fingerprints")
  registeredAt           DateTime? @map("registered_at")

  approvedBy  String?   @map("approved_by")
  approvedAt  DateTime? @map("approved_at")
  rejectedBy  String?   @map("rejected_by")
  rejectedAt  DateTime? @map("rejected_at")
  deliveredAt DateTime? @map("delivered_at")

  createdBy String?  @map("created_by")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([tokenPrefix])
  @@index([status])
  @@map("ha_enrollments")
}

// ─── Server Settings: Repository (firmware) ───
// Ported from polaris (business rule 87). Bytes live on disk under
// FIRMWARE_DIR (data/firmware); rows carry identity and placement. The CHECKs
// and PARTIAL unique indexes Prisma cannot express live in migration
// 20261028000007_settings_firmware. No upgrade-run / schedule / group models:
// Charon has no Asset inventory and never flashes a device.

/// One uploaded `.out`, filed under a manufacturer › device type › model node.
/// Each PLATFORM under a node holds at most one `primary` and one `backup`.
model FirmwareImage {
  id           String   @id @default(uuid())
  manufacturer String
  assetType    String   @map("asset_type") // "switch" | "access_point" | "firewall" — CHECK in the migration
  model        String // tree placement only
  platform     String? // header token, e.g. S108FF / FP231K; null = filename-only parse, never offered
  versionMajor Int?     @map("version_major")
  versionMinor Int?     @map("version_minor")
  versionPatch Int?     @map("version_patch")
  build        Int?
  versionLabel String   @map("version_label") // "7.6.8 build1164", or "7 build1164" from a filename-only parse
  parsedFrom   String   @map("parsed_from") // "header" | "filename"
  role         String   @default("primary") // "primary" | "backup" ("swapping" only inside the make-primary transaction)
  filename     String // original upload name
  sizeBytes    Int      @map("size_bytes") // ≤ 300 MiB (FortiGate); ≤ 100 MiB switch / AP
  sha256       String   @unique
  storagePath  String   @map("storage_path") // relative to FIRMWARE_DIR: "<id>.out"
  notes        String?  @db.Text
  uploadedBy   String?  @map("uploaded_by")
  uploadedAt   DateTime @default(now()) @map("uploaded_at")

  @@index([manufacturer, assetType, platform])
  @@index([manufacturer, assetType, model])
  @@map("firmware_images")
}

/// Which device-admin login applies at a manufacturer (assetType null), device
/// type (model null) or model scope; the most specific live one wins.
/// credentialId names a Credential LOOSELY (no relation / FK — Charon
/// adaptation): a deleted credential leaves a dangling id that reads as stale.
model FirmwareCredentialBinding {
  id           String   @id @default(uuid())
  manufacturer String
  assetType    String?  @map("asset_type") // null = manufacturer-wide
  model        String? // non-null only with assetType
  source       String   @default("credential") // "credential" | "integration-token" (firewall scopes only)
  credentialId String?  @map("credential_id")
  createdBy    String?  @map("created_by")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@index([manufacturer, assetType, model])
  @@map("firmware_credential_bindings")
}

// ─── Server Settings: Credentials (MIB database + manufacturer profiles) ───
// Ported from polaris (Server Settings → Credentials). Charon has no Asset
// inventory, so the polaris per-asset columns/tables are left out: no
// MibFile.assetId pin, no AssetCustomWidgetEnable, and none of the deprecated
// `composition` columns. Hand-written SQL (incl. the override scope CHECK and
// the partial type-default unique index Prisma cannot express) lives in
// migration 20261028000006_settings_credentials. Credential.createdBy (the
// ownership column) is added by the same migration.

/// Manufacturer alias map: lowercased+trimmed `alias` → canonical spelling.
model ManufacturerAlias {
  id        String   @id @default(uuid())
  alias     String   @unique // lowercased + trimmed input string
  canonical String // canonical manufacturer name (as-typed)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([canonical])
  @@map("manufacturer_aliases")
}

/// SNMP MIB module uploaded from the MIB Database card. Text inline (≤ 1 MiB),
/// validated by the SMI parser on upload. manufacturer null = generic.
model MibFile {
  id           String   @id @default(uuid())
  filename     String
  moduleName   String
  manufacturer String?
  model        String?
  contents     String   @db.Text
  imports      String[] @default([])
  size         Int
  notes        String?  @db.Text
  uploadedBy   String?
  uploadedAt   DateTime @default(now())

  profileMetricDefaults  ManufacturerProfileMetric[]         @relation("ManufacturerProfileMetricDefaultMib")
  profileMetricOverrides ManufacturerProfileMetricOverride[] @relation("ManufacturerProfileMetricOverrideMib")
  customWidgets          ManufacturerCustomWidget[]          @relation("ManufacturerCustomWidgetMib")

  @@unique([manufacturer, model, moduleName])
  @@index([manufacturer, model])
  @@index([moduleName])
  @@map("mib_files")
}

/// Operator-editable per-manufacturer SNMP telemetry profile.
model ManufacturerProfile {
  id           String   @id @default(uuid())
  manufacturer String   @unique // canonical form via ManufacturerAlias map
  matchPattern String? // "also applies when" regex (RE2 syntax)
  widgetLayout Json? // Custom MIB tab arrangement; null = default grid
  createdBy    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  metrics ManufacturerProfileMetric[]
  widgets ManufacturerCustomWidget[]

  @@map("manufacturer_profiles")
}

/// One row per System-tab metric a profile owns (METRIC_KEYS).
model ManufacturerProfileMetric {
  id                   String              @id @default(uuid())
  profileId            String
  profile              ManufacturerProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  metricKey            String
  defaultSymbol        String?
  defaultAggregate     String              @default("none") // "none" | "avg" | "sum"
  defaultLabel         String?
  defaultParsePattern  String?
  defaultParseTemplate String?
  defaultSensorColumns Json?
  defaultMibId         String?
  defaultMib           MibFile?            @relation("ManufacturerProfileMetricDefaultMib", fields: [defaultMibId], references: [id], onDelete: SetNull)
  defaultMibStdKey     String?
  defaultType          String              @default("scalar") // "scalar" | "double_scalar" | "table"
  defaultTransform     String?
  defaultSymbolB       String?

  overrides ManufacturerProfileMetricOverride[]

  @@unique([profileId, metricKey])
  @@index([defaultMibId])
  @@map("manufacturer_profile_metrics")
}

/// Scoped row under a metric: device-type default, per-model exception, or both.
model ManufacturerProfileMetricOverride {
  id            String                    @id @default(uuid())
  metricRowId   String
  metricRow     ManufacturerProfileMetric @relation(fields: [metricRowId], references: [id], onDelete: Cascade)
  assetType     String?
  modelPattern  String?
  symbol        String
  aggregate     String                    @default("none")
  label         String?
  parsePattern  String?
  parseTemplate String?
  sensorColumns Json?
  mibId         String?
  mib           MibFile?                  @relation("ManufacturerProfileMetricOverrideMib", fields: [mibId], references: [id], onDelete: SetNull)
  mibStdKey     String?
  type          String                    @default("scalar")
  transform     String?
  symbolB       String?
  order         Int                       @default(0)

  @@index([metricRowId, order])
  @@index([metricRowId, assetType])
  @@index([mibId])
  @@map("manufacturer_profile_metric_overrides")
}

/// Operator-defined custom widget (gauge / line / value / table / state / http).
model ManufacturerCustomWidget {
  id             String              @id @default(uuid())
  profileId      String
  profile        ManufacturerProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  name           String
  symbol         String?
  mibId          String?
  mib            MibFile?            @relation("ManufacturerCustomWidgetMib", fields: [mibId], references: [id])
  type           String              @default("scalar")
  widgetType     String
  httpCheck      Json?
  credentialId   String?
  credential     Credential?         @relation("ManufacturerCustomWidgetCredential", fields: [credentialId], references: [id], onDelete: SetNull)
  transform      String?
  displayOptions Json                @default("{}")
  order          Int                 @default(0)
  modelPattern   String?
  stateMap       Json?
  labelSymbol    String?
  createdBy      String?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  @@index([profileId, order])
  @@index([mibId])
  @@index([credentialId])
  @@map("manufacturer_custom_widgets")
}
```

## Notes

#### What lives in the Setting table instead

DNS, the OUI database + overrides, NTP, branding, proxy controls,
HA config and the other Server Settings scalars are `Setting` rows — see platform.md → Setting
keys in use.

#### Migrations

`20261028000004_settings_apitokens_ha` … `20261028000007_settings_firmware` add these models plus
`ApiToken.roleId` / `trustedHosts` and `Credential.createdBy`. The CHECK constraints and partial
unique indexes Prisma cannot express are hand-written SQL in those migrations — change the
migration SQL, not only the schema.
