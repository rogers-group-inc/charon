/**
 * src/services/groupMappingService.ts — IdP group → Role mappings (ported from
 * polaris, minus its region/tag scoping).
 *
 * A GroupMapping maps one IdP group (scoped by `provider`) to a Charon role. At
 * SAML / OIDC / LDAP / App Proxy login the user's group claims are matched
 * against the enabled mappings for that provider and the HIGHEST-PRIVILEGE
 * matched role wins (permissions.ts → pickHighestPrivilegeRoleId).
 *
 * SECURITY: a mapping targeting an admin-equivalent role makes IdP group
 * membership a path to Charon admin. Allowed (the operator asked for it) but
 * stamped as a warning-level Event so it is auditable. The route additionally
 * refuses a mapping whose role exceeds the caller's own (assertGrantWithinCaller).
 *
 * Every write emits a `groupMapping.*` Event and invalidates the 30s
 * enabled-mappings cache the resolver reads.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";
import {
  normalizePermissions,
  isAdminEquivalentPermissions,
  pickHighestPrivilegeRoleId,
} from "../api/middleware/permissions.js";

export const GROUP_MAPPING_PROVIDERS = ["saml", "oidc", "ldap", "entra-proxy"] as const;
export type GroupMappingProvider = (typeof GROUP_MAPPING_PROVIDERS)[number];

const GROUP_KEY_MAX_LEN = 512; // LDAP DNs can be long
const DESCRIPTION_MAX = 200;

export interface GroupMappingSummary {
  id: string;
  provider: string;
  groupKey: string;
  groupLabel: string | null;
  roleId: string;
  roleName: string | null;
  enabled: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGroupMappingInput {
  provider: string;
  groupKey: string; // raw, as the operator typed it
  roleId: string;
  enabled?: boolean;
  description?: string | null;
}

export interface UpdateGroupMappingInput {
  groupKey?: string;
  roleId?: string;
  enabled?: boolean;
  description?: string | null;
}

export interface ResolvedGroupAccess {
  roleId: string | null;
  matchedGroups: string[]; // normalized keys that matched
}

export function isGroupMappingProvider(p: string): p is GroupMappingProvider {
  return (GROUP_MAPPING_PROVIDERS as readonly string[]).includes(p);
}

function assertValidProvider(p: string): GroupMappingProvider {
  if (!isGroupMappingProvider(p)) {
    throw new AppError(400, `Unknown group-mapping provider "${p}" (expected one of ${GROUP_MAPPING_PROVIDERS.join(", ")})`);
  }
  return p;
}

/**
 * Normalize a group identifier for matching. LDAP DNs and Entra group object
 * ids are case-insensitive, so they lowercase + trim; OIDC/SAML claim values
 * are case-stable, so they trim only. The SAME function runs on write (the
 * stored groupKey) and on read (incoming claims) so the two never diverge.
 * Returns "" for blanks.
 */
export function normalizeGroupKey(provider: string, raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return provider === "ldap" || provider === "entra-proxy" ? trimmed.toLowerCase() : trimmed;
}

function normalizeDescription(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (trimmed.length > DESCRIPTION_MAX) throw new AppError(400, `Description must be ≤ ${DESCRIPTION_MAX} characters`);
  return trimmed;
}

function summarize(row: {
  id: string;
  provider: string;
  groupKey: string;
  groupLabel: string | null;
  roleId: string;
  enabled: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  role?: { name: string } | null;
}): GroupMappingSummary {
  return {
    id: row.id,
    provider: row.provider,
    groupKey: row.groupKey,
    groupLabel: row.groupLabel,
    roleId: row.roleId,
    roleName: row.role?.name ?? null,
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const withRoleName = { role: { select: { name: true } } } as const;

// ─── Enabled-mappings cache (read by the login resolver) ────────────────────

const ENABLED_CACHE_TTL_MS = 30_000;
const enabledCache = new Map<string, { at: number; rows: { groupKey: string; roleId: string }[] }>();

/** Drop the enabled-mappings cache (every write; tests seeding raw rows). */
export function invalidateGroupMappingCache(): void {
  enabledCache.clear();
}

async function getEnabledMappings(provider: string) {
  const cached = enabledCache.get(provider);
  if (cached && Date.now() - cached.at < ENABLED_CACHE_TTL_MS) return cached.rows;
  const rows = await prisma.groupMapping.findMany({
    where: { provider, enabled: true },
    select: { groupKey: true, roleId: true },
  });
  enabledCache.set(provider, { at: Date.now(), rows });
  return rows;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve a user's IdP groups to a role. roleId is null when the provider is
 * unknown, no groups are supplied, or nothing matches — the caller then keeps
 * the existing role (or the default for a new account).
 */
export async function resolveGroupsToAccess(provider: string, groupNames: unknown): Promise<ResolvedGroupAccess> {
  const empty: ResolvedGroupAccess = { roleId: null, matchedGroups: [] };
  if (!isGroupMappingProvider(provider)) return empty;
  if (!Array.isArray(groupNames) || groupNames.length === 0) return empty;

  const incoming = new Set<string>();
  for (const g of groupNames) {
    const k = normalizeGroupKey(provider, g);
    if (k) incoming.add(k);
  }
  if (incoming.size === 0) return empty;

  const matched = (await getEnabledMappings(provider)).filter((m) => incoming.has(m.groupKey));
  if (matched.length === 0) return empty;

  const roleIds = [...new Set(matched.map((m) => m.roleId))];
  let roleId: string | null = roleIds[0];
  if (roleIds.length > 1) {
    const roles = await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, permissions: true } });
    roleId = pickHighestPrivilegeRoleId(roles);
  }
  return { roleId, matchedGroups: matched.map((m) => m.groupKey) };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listGroupMappings(provider?: string): Promise<GroupMappingSummary[]> {
  const rows = await prisma.groupMapping.findMany({
    where: provider ? { provider } : undefined,
    include: withRoleName,
    orderBy: [{ provider: "asc" }, { groupKey: "asc" }],
  });
  return rows.map(summarize);
}

export async function getGroupMapping(id: string): Promise<GroupMappingSummary> {
  const row = await prisma.groupMapping.findUnique({ where: { id }, include: withRoleName });
  if (!row) throw new AppError(404, `Group mapping ${id} not found`);
  return summarize(row);
}

/** The role a mapping would grant: name + matrix, for the route's grant check. Null for an unknown id. */
export async function roleGrantFor(roleId: string | null | undefined): Promise<{ name: string; permissions: unknown } | null> {
  if (!roleId) return null;
  return prisma.role.findUnique({ where: { id: roleId }, select: { name: true, permissions: true } });
}

/** What a stored mapping grants and to whom, before an edit. Null for an unknown id. */
export async function mappingGrantState(id: string): Promise<{ roleId: string; groupKey: string; groupLabel: string | null; enabled: boolean } | null> {
  return prisma.groupMapping.findUnique({ where: { id }, select: { roleId: true, groupKey: true, groupLabel: true, enabled: true } });
}

// The role's name when it grants admin-equivalent control, else null (→ warning Event).
async function adminEquivalentRoleName(roleId: string): Promise<string | null> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true, permissions: true } });
  if (!role) throw new AppError(400, `Role ${roleId} not found`);
  return isAdminEquivalentPermissions(normalizePermissions(role.permissions)) ? role.name : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

export async function createGroupMapping(input: CreateGroupMappingInput, actor?: string): Promise<GroupMappingSummary> {
  const provider = assertValidProvider(input.provider);
  const label = typeof input.groupKey === "string" ? input.groupKey.trim() : "";
  const groupKey = normalizeGroupKey(provider, input.groupKey);
  if (!groupKey) throw new AppError(400, "Group identifier is required");
  if (label.length > GROUP_KEY_MAX_LEN) throw new AppError(400, `Group identifier exceeds ${GROUP_KEY_MAX_LEN} characters`);
  if (!input.roleId) throw new AppError(400, "A role is required");
  const description = normalizeDescription(input.description);
  const adminRoleName = await adminEquivalentRoleName(input.roleId);

  let created;
  try {
    created = await prisma.groupMapping.create({
      data: { provider, groupKey, groupLabel: label || groupKey, roleId: input.roleId, enabled: input.enabled ?? true, description },
      include: withRoleName,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `A ${provider} group mapping for "${label || groupKey}" already exists`);
    throw err;
  }
  invalidateGroupMappingCache();

  await logEvent({
    action: "groupMapping.created",
    resourceType: "groupMapping",
    resourceId: created.id,
    resourceName: created.groupLabel || created.groupKey,
    actor,
    level: adminRoleName ? "warning" : "info",
    message: adminRoleName
      ? `Group mapping "${created.groupLabel}" (${provider}) created — grants ADMIN-equivalent role "${adminRoleName}" to IdP group members`
      : `Group mapping "${created.groupLabel}" (${provider}) created`,
    details: { provider, groupKey, roleId: input.roleId, enabled: created.enabled },
  });
  return summarize(created);
}

export async function updateGroupMapping(id: string, input: UpdateGroupMappingInput, actor?: string): Promise<GroupMappingSummary> {
  const before = await prisma.groupMapping.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Group mapping ${id} not found`);

  const data: { groupKey?: string; groupLabel?: string; roleId?: string; enabled?: boolean; description?: string | null } = {};
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  if (input.groupKey !== undefined) {
    const label = input.groupKey.trim();
    const nextKey = normalizeGroupKey(before.provider, input.groupKey);
    if (!nextKey) throw new AppError(400, "Group identifier is required");
    if (label.length > GROUP_KEY_MAX_LEN) throw new AppError(400, `Group identifier exceeds ${GROUP_KEY_MAX_LEN} characters`);
    if (nextKey !== before.groupKey || label !== before.groupLabel) {
      data.groupKey = nextKey;
      data.groupLabel = label || nextKey;
      diff.groupKey = { from: before.groupLabel || before.groupKey, to: label || nextKey };
    }
  }
  if (input.roleId !== undefined && input.roleId !== before.roleId) {
    data.roleId = input.roleId;
    diff.roleId = { from: before.roleId, to: input.roleId };
  }
  if (input.enabled !== undefined && input.enabled !== before.enabled) {
    data.enabled = input.enabled;
    diff.enabled = { from: before.enabled, to: input.enabled };
  }
  if (input.description !== undefined) {
    const next = normalizeDescription(input.description);
    if (next !== before.description) {
      data.description = next;
      diff.description = { from: before.description, to: next };
    }
  }

  if (Object.keys(data).length === 0) return getGroupMapping(id);

  const adminRoleName = await adminEquivalentRoleName(data.roleId ?? before.roleId);

  let updated;
  try {
    updated = await prisma.groupMapping.update({ where: { id }, data, include: withRoleName });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, `A ${before.provider} group mapping for that group already exists`);
    throw err;
  }
  invalidateGroupMappingCache();

  await logEvent({
    action: "groupMapping.updated",
    resourceType: "groupMapping",
    resourceId: updated.id,
    resourceName: updated.groupLabel || updated.groupKey,
    actor,
    level: adminRoleName ? "warning" : "info",
    message: adminRoleName
      ? `Group mapping "${updated.groupLabel}" (${updated.provider}) updated — grants ADMIN-equivalent role "${adminRoleName}" to IdP group members`
      : `Group mapping "${updated.groupLabel}" (${updated.provider}) updated`,
    details: { diff },
  });
  return summarize(updated);
}

export async function deleteGroupMapping(id: string, actor?: string): Promise<void> {
  const before = await prisma.groupMapping.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Group mapping ${id} not found`);
  await prisma.groupMapping.delete({ where: { id } });
  invalidateGroupMappingCache();

  await logEvent({
    action: "groupMapping.deleted",
    resourceType: "groupMapping",
    resourceId: id,
    resourceName: before.groupLabel || before.groupKey,
    actor,
    message: `Group mapping "${before.groupLabel || before.groupKey}" (${before.provider}) deleted`,
  });
}
