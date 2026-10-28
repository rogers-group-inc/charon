# Domain model — operators, roles, SSO group mapping, API tokens

## Definitions and invariants

- **Role** — a named permission set. `permissions` is a function-key → access-level JSON matrix
  (`src/api/middleware/permissions.ts → FUNCTION_KEYS`, levels none < read < write < fullwrite).
  `isProtected` blocks delete/rename of built-ins. Built-in roles (Administrator / Operator /
  Read-Only) are seeded by `src/cli/seed.ts → seedDatabase()`.
- **User** — an operator. `passwordHash` is null for SSO-only operators. `ssoGroups` caches the
  last-seen IdP group keys for re-resolution. TOTP enrollment is "in progress" when
  `totpSecret` set but `totpEnabledAt` null. `authProvider` is `local | saml | oidc | ldap`.
- **GroupMapping** — maps a normalized IdP/directory group key → a Charon Role for
  SSO-provisioned operators. Highest-privilege match wins
  (`permissions.ts → pickHighestPrivilegeRoleId()`). Unique on `(groupKey, roleId)`.
- **ApiToken** — a long-lived bearer for external callers. `tokenHash` is SHA-384 of the raw
  token (plaintext shown once at mint); lookup is prefix-indexed then constant-time compared
  (`src/services/apiTokenService.ts`).

## Schema

```prisma
model Role {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  color       String?
  permissions Json     @default("{}") // function-key → access-level matrix (see permissions.ts)
  isBuiltIn   Boolean  @default(false) @map("is_built_in")
  isProtected Boolean  @default(false) @map("is_protected")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  users         User[]
  groupMappings GroupMapping[]

  @@map("roles")
}

model User {
  id           String  @id @default(uuid())
  username     String  @unique
  passwordHash String? @map("password_hash") // null for SSO-only operators
  roleId       String  @map("role_id")
  role         Role    @relation(fields: [roleId], references: [id], onDelete: Restrict)

  authProvider String  @default("local") @map("auth_provider") // "local" | "saml" | "oidc" | "ldap"
  azureOid     String? @unique @map("azure_oid")
  oidcSubject  String? @unique @map("oidc_subject")
  ldapUid      String? @unique @map("ldap_uid")
  ssoGroups    String[] @default([]) @map("sso_groups")
  displayName  String? @map("display_name")
  email        String?
  lastLogin    DateTime? @map("last_login")

  // TOTP second factor — local accounts only.
  totpSecret      String?   @map("totp_secret")
  totpEnabledAt   DateTime? @map("totp_enabled_at")
  totpBackupCodes String[]  @default([]) @map("totp_backup_codes")

  needsRoleReview Boolean @default(false) @map("needs_role_review")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([roleId])
  @@map("users")
}

/// Maps a normalized IdP/directory group key → a Charon Role for SSO-provisioned
/// operators. Highest-privilege match wins (see permissions.ts).
model GroupMapping {
  id        String   @id @default(uuid())
  groupKey  String   @map("group_key") // normalized directory group identifier
  roleId    String   @map("role_id")
  role      Role     @relation(fields: [roleId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([groupKey, roleId])
  @@index([groupKey])
  @@map("group_mappings")
}

model ApiToken {
  id          String    @id @default(uuid())
  name        String    @unique
  tokenHash   String    @map("token_hash") // SHA-384 of the raw token
  tokenPrefix String    @map("token_prefix")
  scopes      String[]  @default([])
  createdBy   String    @map("created_by")
  createdAt   DateTime  @default(now())
  expiresAt   DateTime?
  lastUsedAt  DateTime?
  lastUsedIp  String?
  revokedAt   DateTime?
  revokedBy   String?

  @@index([tokenPrefix])
  @@index([revokedAt])
  @@map("api_tokens")
}
```

## Notes

#### Role

Sessions carry a denormalized snapshot of the Role (`SessionRoleSnapshot`); it refreshes when
the role's `updatedAt` moves past the snapshot (`permissions.ts → bumpRoleVersion()`). A role
holding `users` AND `roles` at fullwrite ranks as admin-equivalent
(`permissions.ts → isAdminEquivalentPermissions()`).

#### User

`needsRoleReview` — TODO: populate when the SSO provisioning path that sets it exists in code.
