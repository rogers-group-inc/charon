/**
 * src/services/ssoProvisioning.ts — shared find-or-provision for SAML / OIDC /
 * LDAP / Entra App Proxy operators (ported from polaris).
 *
 * Given a verified external profile (stable id + username hint + groups):
 *   1. Resolve the IdP groups → a role via groupMappingService (highest
 *      privilege wins).
 *   2. Match an existing user by the provider's stable-id column, or create one
 *      (collision-handled username, no password — passwordHash stays null, so
 *      the local password path can never sign this account in).
 *   3. Apply the GROUP-RESOLVED role. On an EXISTING user a login with no
 *      group match LEAVES the current role (a manual assignment is not
 *      clobbered every login); a NEW user with no match gets the built-in
 *      Read-Only role and `needsRoleReview` for an operator to look at.
 *   4. Record the normalized groups in `ssoGroups`.
 *
 * SAML and App Proxy both key on `azureOid` (the Entra object id) on purpose —
 * a user who signed in via SAML and later arrives through App Proxy lands on
 * the same account; the LAST login path owns authProvider + ssoGroups.
 *
 * A changed role takes effect immediately: this runs inside a login that
 * issues a fresh session, and other live sessions pick it up through
 * sessionRevalidate.ts within a minute.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { resolveGroupsToAccess, normalizeGroupKey } from "./groupMappingService.js";

// Cap stored groups so an IdP emitting hundreds of claims can't bloat the row.
const SSO_GROUPS_MAX = 256;
const USERNAME_SAFE_RE = /[^a-z0-9._-]/g;
export const DEFAULT_SSO_ROLE_NAME = "Read-Only";

export type ExternalProvider = "saml" | "oidc" | "ldap" | "entra-proxy";

export interface ExternalUserProfile {
  provider: ExternalProvider;
  externalIdField: "oidcSubject" | "ldapUid" | "azureOid";
  externalId: string; // OIDC sub, LDAP objectGUID hex, Entra object id — stable per user
  usernameHint: string; // preferred_username / sAMAccountName / UPN / email
  displayName?: string | null;
  email?: string | null;
  groups: string[]; // raw group claims / group DNs / group object ids
}

/** Username from a hint: email local-part, lowercased, safe characters only. */
export function deriveUsername(hint: string, provider: string, externalId: string): string {
  let username = (hint || "").split("@")[0].toLowerCase().replace(USERNAME_SAFE_RE, "");
  if (!username) username = `${provider}-${externalId.slice(0, 8)}`;
  return username.slice(0, 64);
}

export function normalizeGroupList(provider: string, groups: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    const k = normalizeGroupKey(provider, g);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= SSO_GROUPS_MAX) break;
  }
  return out;
}

/** Returns the user row (with `role`) ready for session stamping. */
export async function provisionExternalUser(profile: ExternalUserProfile) {
  const { provider, externalIdField, externalId } = profile;
  if (!externalId) throw new AppError(502, `${provider} login: missing stable user identifier`);

  const access = await resolveGroupsToAccess(provider, profile.groups);
  const ssoGroups = normalizeGroupList(provider, profile.groups);

  // A mapped role could have been deleted between resolve and now — be defensive.
  let resolvedRoleId: string | null = access.roleId;
  if (resolvedRoleId) {
    const exists = await prisma.role.findUnique({ where: { id: resolvedRoleId }, select: { id: true } });
    if (!exists) resolvedRoleId = null;
  }

  const existing = await prisma.user.findFirst({
    where: { [externalIdField]: externalId },
    include: { role: true },
  });

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        displayName: profile.displayName || existing.displayName,
        email: profile.email || existing.email,
        roleId: resolvedRoleId ?? existing.roleId,
        ssoGroups,
        authProvider: provider,
        lastLogin: new Date(),
      },
      include: { role: true },
    });
  }

  let roleId = resolvedRoleId;
  if (!roleId) {
    const fallback = await prisma.role.findUnique({ where: { name: DEFAULT_SSO_ROLE_NAME } });
    if (!fallback) {
      throw new AppError(500, `${provider} auto-provision: built-in "${DEFAULT_SSO_ROLE_NAME}" role not found — run the seed`);
    }
    roleId = fallback.id;
  }

  // Collision-handled username.
  let username = deriveUsername(profile.usernameHint, provider, externalId);
  if (await prisma.user.findUnique({ where: { username } })) {
    username = `${username}-${provider}`.slice(0, 64);
    if (await prisma.user.findUnique({ where: { username } })) username = `${provider}-${externalId.slice(0, 12)}`;
  }

  return prisma.user.create({
    data: {
      username,
      passwordHash: null,
      roleId,
      authProvider: provider,
      [externalIdField]: externalId,
      ssoGroups,
      displayName: profile.displayName || null,
      email: profile.email || null,
      lastLogin: new Date(),
      // Only an account that fell back to the default role needs a human look.
      needsRoleReview: !resolvedRoleId,
    },
    include: { role: true },
  });
}
