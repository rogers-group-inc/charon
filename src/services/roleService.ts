/**
 * src/services/roleService.ts — CRUD over the Role table (ported from polaris).
 *
 * Built-in / protected invariants:
 *   - isProtected (Administrator): cannot be edited, renamed, or deleted.
 *   - isBuiltIn (Operator / Read-Only): can be edited, NOT deleted.
 *   - Custom roles: full edit + delete.
 *   - Delete refuses with 409 while any user holds the role or any API token
 *     is bound to it (FK Restrict would refuse anyway; this names the reason).
 *
 * Every write bumps the in-process role-version cache via bumpRoleVersion() so
 * live sessions holding the old snapshot refresh on their next request, and
 * emits a `role.*` Event with the actor + per-field diff.
 *
 * Escalation guards (assertGrantWithinCaller) live at the route — they need
 * the caller's request — but the demotion and last-admin checks are here.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";
import {
  bumpRoleVersion,
  normalizePermissions,
  isAdminEquivalentPermissions,
  FUNCTION_KEYS,
  type AccessLevel,
} from "../api/middleware/permissions.js";

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  permissions: Record<string, AccessLevel>;
  color: string | null; // `#rrggbb`, or null → frontend falls back to a neutral badge
  isBuiltIn: boolean;
  isProtected: boolean;
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  permissions: Record<string, AccessLevel>;
  color?: string | null;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permissions?: Record<string, AccessLevel>;
  color?: string | null;
}

const NAME_RE = /^[A-Za-z0-9 _-]{2,32}$/;
const DESCRIPTION_MAX = 200;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Built-in names can't be shadowed by a custom role, even with a different case
// (the DB unique index is case-sensitive; this guard is not).
const RESERVED_NAMES_LC = new Set(["administrator", "operator", "read-only"]);

export function validateRoleName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw new AppError(400, "Role name must be 2-32 characters: letters, digits, space, dash or underscore");
  }
  return trimmed;
}

function normalizeDescription(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (trimmed.length > DESCRIPTION_MAX) {
    throw new AppError(400, `Description must be ≤ ${DESCRIPTION_MAX} characters`);
  }
  return trimmed;
}

/** `#rrggbb` (case-insensitive in, lowercased out); empty/null clears it. */
export function normalizeRoleColor(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (!COLOR_RE.test(trimmed)) throw new AppError(400, "Role color must be a #rrggbb hex string");
  return trimmed.toLowerCase();
}

const withUserCount = { _count: { select: { users: true } } } as const;

function summarize(role: {
  id: string;
  name: string;
  description: string | null;
  permissions: unknown;
  color: string | null;
  isBuiltIn: boolean;
  isProtected: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { users: number };
}): RoleSummary {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: normalizePermissions(role.permissions),
    color: role.color,
    isBuiltIn: role.isBuiltIn,
    isProtected: role.isProtected,
    userCount: role._count.users,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export async function listRoles(): Promise<RoleSummary[]> {
  const rows = await prisma.role.findMany({ include: withUserCount, orderBy: { name: "asc" } });
  return rows.map(summarize);
}

export async function getRole(id: string): Promise<RoleSummary> {
  const row = await prisma.role.findUnique({ where: { id }, include: withUserCount });
  if (!row) throw new AppError(404, `Role ${id} not found`);
  return summarize(row);
}

async function nameCollides(name: string, excludeId?: string): Promise<boolean> {
  const lc = name.toLowerCase();
  const existing = await prisma.role.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { name: true },
  });
  return RESERVED_NAMES_LC.has(lc) || existing.some((r) => r.name.toLowerCase() === lc);
}

export async function createRole(input: CreateRoleInput, actor?: string): Promise<RoleSummary> {
  const name = validateRoleName(input.name);
  if (await nameCollides(name)) throw new AppError(409, `A role named "${name}" already exists`);
  const description = normalizeDescription(input.description);
  const permissions = normalizePermissions(input.permissions);
  const color = normalizeRoleColor(input.color);

  const created = await prisma.role.create({
    data: { name, description, permissions, color, isBuiltIn: false, isProtected: false },
    include: withUserCount,
  });
  bumpRoleVersion(created.id, created.updatedAt);

  await logEvent({
    action: "role.created",
    resourceType: "role",
    resourceId: created.id,
    resourceName: created.name,
    actor,
    message: `Role "${created.name}" created`,
    details: { permissions, description, color },
  });
  return summarize(created);
}

export async function updateRole(id: string, input: UpdateRoleInput, actor?: string): Promise<RoleSummary> {
  const before = await prisma.role.findUnique({ where: { id } });
  if (!before) throw new AppError(404, `Role ${id} not found`);
  if (before.isProtected) throw new AppError(403, `Role "${before.name}" is protected and cannot be edited`);

  const data: { name?: string; description?: string | null; permissions?: Record<string, AccessLevel>; color?: string | null } = {};
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  if (input.name !== undefined) {
    const next = validateRoleName(input.name);
    if (next !== before.name) {
      if (before.isBuiltIn) throw new AppError(409, `Role "${before.name}" is built-in and cannot be renamed`);
      if (await nameCollides(next, id)) throw new AppError(409, `A role named "${next}" already exists`);
      data.name = next;
      diff.name = { from: before.name, to: next };
    }
  }
  if (input.description !== undefined) {
    const next = normalizeDescription(input.description);
    if (next !== before.description) {
      data.description = next;
      diff.description = { from: before.description, to: next };
    }
  }
  if (input.permissions !== undefined) {
    const next = normalizePermissions(input.permissions);
    const prev = normalizePermissions(before.permissions);
    const changed: Record<string, { from: AccessLevel; to: AccessLevel }> = {};
    for (const def of FUNCTION_KEYS) {
      if (prev[def.key] !== next[def.key]) changed[def.key] = { from: prev[def.key], to: next[def.key] };
    }
    if (Object.keys(changed).length > 0) {
      data.permissions = next;
      diff.permissions = { from: null, to: changed };
    }
  }
  if (input.color !== undefined) {
    const next = normalizeRoleColor(input.color);
    if (next !== before.color) {
      data.color = next;
      diff.color = { from: before.color, to: next };
    }
  }

  if (Object.keys(data).length === 0) return getRole(id);

  const updated = await prisma.role.update({ where: { id }, data, include: withUserCount });
  bumpRoleVersion(updated.id, updated.updatedAt);

  await logEvent({
    action: "role.updated",
    resourceType: "role",
    resourceId: updated.id,
    resourceName: updated.name,
    actor,
    message: `Role "${updated.name}" updated`,
    details: { diff },
  });
  return summarize(updated);
}

export async function deleteRole(id: string, actor?: string): Promise<void> {
  const before = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true, apiTokens: true } } },
  });
  if (!before) throw new AppError(404, `Role ${id} not found`);
  if (before.isBuiltIn) throw new AppError(409, `Role "${before.name}" is built-in and cannot be deleted`);
  if (before._count.users > 0) {
    throw new AppError(409, `Role "${before.name}" is assigned to ${before._count.users} user(s). Reassign them first.`);
  }
  if (before._count.apiTokens > 0) {
    throw new AppError(409, `Role "${before.name}" is bound to ${before._count.apiTokens} API token(s). Delete those tokens first.`);
  }
  // Group mappings cascade with the role (schema onDelete: Cascade).
  await prisma.role.delete({ where: { id } });

  await logEvent({
    action: "role.deleted",
    resourceType: "role",
    resourceId: id,
    resourceName: before.name,
    actor,
    message: `Role "${before.name}" deleted`,
  });
}

// ─── Admin-equivalence guards ───────────────────────────────────────────────

/** IDs of every role whose matrix is admin-equivalent (users AND roles fullwrite). */
async function adminEquivalentRoleIds(excludeRoleId?: string): Promise<string[]> {
  // The matrix is JSON, so filter in JS — a handful of rows.
  const roles = await prisma.role.findMany({ select: { id: true, permissions: true } });
  return roles
    .filter((r) => r.id !== excludeRoleId)
    .filter((r) => isAdminEquivalentPermissions(normalizePermissions(r.permissions)))
    .map((r) => r.id);
}

/** Users holding an admin-equivalent role, optionally excluding one account. */
export async function countAdminEquivalentUsers(excludeUserId?: string): Promise<number> {
  const ids = await adminEquivalentRoleIds();
  if (ids.length === 0) return 0;
  return prisma.user.count({
    where: { roleId: { in: ids }, ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}) },
  });
}

export async function isAdminEquivalentRole(roleId: string): Promise<boolean> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { permissions: true } });
  return !!role && isAdminEquivalentPermissions(normalizePermissions(role.permissions));
}

/**
 * Refuse an edit that takes admin-equivalence away from a role unless the
 * caller is admin-equivalent itself (demoting every holder at once is the same
 * act as demoting each), and refuse it outright when it would leave no
 * admin-equivalent user anywhere. Throws 403 / 409.
 */
export async function assertRoleDemotionAllowed(
  roleId: string,
  currentPermissions: unknown,
  nextIsAdmin: boolean,
  callerIsAdmin: boolean,
): Promise<void> {
  const wasAdmin = isAdminEquivalentPermissions(normalizePermissions(currentPermissions));
  if (!wasAdmin || nextIsAdmin) return;
  if (!callerIsAdmin) {
    throw new AppError(
      403,
      "Forbidden — this edit takes admin-equivalent control (Full RW on both users and roles) away from every account on this role, which needs an admin-equivalent caller.",
    );
  }
  const others = await adminEquivalentRoleIds(roleId);
  const remaining = others.length ? await prisma.user.count({ where: { roleId: { in: others } } }) : 0;
  if (remaining === 0) {
    throw new AppError(409, "This edit would leave no account with admin-equivalent control. Give another account an admin-equivalent role first.");
  }
}
