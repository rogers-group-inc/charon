# Domain model — invitation codes, endpoints, verification sessions

## Definitions and invariants

- **InvitationCode** — a one-time code that bootstraps an agent enrollment. The plaintext is
  shown once; only `codeHash` (SHA-384) is stored, prefix-indexed by `codePrefix`. Carries a
  use cap (`maxUses` / `useCount`), optional expiry and revocation. Consumed atomically
  (`src/services/invitationCodeService.ts → consumeCode()`).
- **Endpoint** — device + agent enrollment. `bearerHash` is SHA-384 only (wire format
  `charon_<base64url>`). `serverCertFingerprint` + `additionalCertFingerprints` are the agent
  pins (canonical + staged, for dual-pin rotation). `boundUserKey` is the verified directory
  identity (drives tag resolution). `posture` is the raw blob; `postureState` is the evaluated
  enum. `currentIp` / `currentMac` feed Fortinet dynamic address-group membership.
- **VerificationSession** — the short-lived `{user↔device↔IP}` binding created on a successful
  agent user login (`src/services/verificationService.ts → bindVerification()`); logout or
  expiry clears it. Retention prune removes expired/old sessions.

## Schema

```prisma
/// One-time invitation code that bootstraps an agent enrollment. The plaintext
/// is shown once at issuance; only its SHA-384 hash is stored.
model InvitationCode {
  id         String    @id @default(uuid())
  label      String? // operator note ("Q3 laptop rollout")
  codeHash   String    @map("code_hash") // SHA-384 of the one-time code
  codePrefix String    @map("code_prefix") // first chars for UI display
  maxUses    Int       @default(1) @map("max_uses")
  useCount   Int       @default(0) @map("use_count")
  expiresAt  DateTime? @map("expires_at")
  createdBy  String    @map("created_by")
  createdAt  DateTime  @default(now())
  revokedAt  DateTime? @map("revoked_at")

  endpoints Endpoint[]

  @@index([codePrefix])
  @@map("invitation_codes")
}

/// An enrolled endpoint: the device + its agent enrollment, telemetry state,
/// posture, current user binding, IP/MAC, and effective tags. Mirrors polaris's
/// ManagedAgent security model (one-time-token→bearer swap, leaf-cert pin).
model Endpoint {
  id           String         @id @default(uuid())
  hostname     String?
  status       EndpointStatus @default(pending)

  osPlatform   String? @map("os_platform") // "windows" | "macos" | "linux"
  osVersion    String? @map("os_version")
  arch         String?
  agentVersion String? @map("agent_version")

  // Current network identity (updated by telemetry). These feed Fortinet
  // dynamic address-group membership.
  currentIp  String? @map("current_ip")
  currentMac String? @map("current_mac")

  // Current verified user binding {user ↔ device ↔ IP}. boundUserKey is the
  // directory identity (UPN / sub), set on a successful agent login.
  boundUserKey  String?   @map("bound_user_key")
  boundUserName String?   @map("bound_user_name")
  boundAt       DateTime? @map("bound_at")

  // Posture: raw telemetry blob + the evaluated state.
  posture      Json         @default("{}") // OS/patch, disk encryption, AV/EDR, firewall, ...
  postureState PostureState @default(unknown) @map("posture_state")
  postureAt    DateTime?    @map("posture_at")

  // Enrollment: invitation → one-time enrollment token → long-lived bearer.
  invitationCodeId String?         @map("invitation_code_id")
  invitationCode   InvitationCode? @relation(fields: [invitationCodeId], references: [id], onDelete: SetNull)

  // Long-lived per-agent bearer, stored ONLY as SHA-384. Wire format
  // `charon_<base64url>`. Bound at issuance; rotated on revoke+re-enroll.
  bearerHash      String?   @map("bearer_hash")
  bearerPrefix    String?   @map("bearer_prefix")
  bearerIssuedAt  DateTime? @map("bearer_issued_at")
  bearerRevokedAt DateTime? @map("bearer_revoked_at")

  // Server leaf-cert pin(s) the agent trusts (SHA-256 hex). canonical + staged
  // for dual-pin rotation (agents accept old+new during rollover).
  serverCertFingerprint  String?  @map("server_cert_fingerprint")
  additionalCertFingerprints String[] @default([]) @map("additional_cert_fingerprints")

  lastSeenAt       DateTime? @map("last_seen_at")
  lastSeenIp       String?   @map("last_seen_ip")
  wsConnectedAt    DateTime? @map("ws_connected_at")
  wsDisconnectedAt DateTime? @map("ws_disconnected_at")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tags             EndpointTag[]
  enforcementState EnforcementState[]

  @@index([status])
  @@index([bearerPrefix])
  @@index([currentIp])
  @@index([boundUserKey])
  @@map("endpoints")
}

/// A short-lived verification binding {user ↔ device ↔ IP} established when a
/// user authenticates through the agent login GUI. Drives tag reconciliation.
model VerificationSession {
  id         String    @id @default(uuid())
  endpointId String    @map("endpoint_id")
  userKey    String    @map("user_key") // directory identity (UPN/sub)
  userName   String?   @map("user_name")
  ip         String?
  mode       AuthMode
  issuedAt   DateTime  @default(now()) @map("issued_at")
  expiresAt  DateTime  @map("expires_at")
  revokedAt  DateTime? @map("revoked_at")

  @@index([endpointId])
  @@index([userKey])
  @@map("verification_sessions")
}
```

## Notes

#### Endpoint.status

Set to `online` / `offline` by the telemetry WebSocket open/close
(`src/api/routes/agentsWs.ts`), `revoked` by bearer revocation
(`src/services/agentTokenService.ts → revokeBearer()`), which locks out both WS and HTTP.

#### Binding changes reconcile

Changing `boundUserKey` (login, logout, expiry) MUST trigger a tag reconcile — user-derived tags
depend on it (`charon-change-impact` → `services/verificationService.ts`).
