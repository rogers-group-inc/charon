/**
 * src/api/middleware/permissions.ts — Dynamic-role permission resolver.
 *
 * The session carries a denormalized snapshot of the user's Role (id, name,
 * permissions, updatedAt). Each request checks `permissions[functionKey]`
 * against the required access level; the snapshot auto-refreshes when the role
 * has been edited since the snapshot was taken.
 *
 * Owns: the function-key catalogue (FUNCTION_KEYS), the access-level ordering
 * (none < read < write < fullwrite), the require/has middleware factories, the
 * session-snapshot refresh path, and bumpRoleVersion() called after role writes.
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { prisma } from "../../db.js";

export type AccessLevel = "none" | "read" | "write" | "fullwrite";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "read", "write", "fullwrite"] as const;

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };

export interface FunctionKeyDef {
  key: string;
  label: string;
  description: string;
}

// One row per top-level functional area an operator can grant/revoke. Order is
// the order the UI matrix renders. Adding a key requires seeding it on every
// existing Role + a guard on the routes it covers.
export const FUNCTION_KEYS: readonly FunctionKeyDef[] = [
  { key: "endpoints", label: "Endpoints", description: "Enrolled agents: view status/user/IP/MAC/posture/tags. Write = revoke/manage." },
  { key: "invitationCodes", label: "Invitation Codes", description: "Issue / revoke one-time agent enrollment codes." },
  { key: "tags", label: "Tags", description: "ZTNA tag definitions and their sources (directory group / OU / custom group / posture)." },
  { key: "policies", label: "Policies", description: "Charon-managed FortiGate dynamic policies (charon-*) driven by tags." },
  { key: "groups", label: "Custom Groups", description: "Custom group builder over directory members + attribute rules." },
  { key: "integrations", label: "Integrations", description: "FortiManager / FortiGate / Active Directory / Entra ID / Intune CRUD + discovery." },
  { key: "enforcement", label: "Enforcement", description: "Per-integration enforce toggle (dry-run → live Fortinet writes). High blast radius — Full Read-Write only." },
  { key: "directory", label: "Directory", description: "Discovered users / groups / OUs (read-only mirror of AD/Entra/Intune)." },
  { key: "credentials", label: "Credentials", description: "Stored connection credentials (LDAP, REST API) used by integrations." },
  { key: "events", label: "Events / Audit Log", description: "Audit log of tag/policy changes, enrollments, logins + retention settings." },
  { key: "apiTokens", label: "API Tokens", description: "Long-lived bearer tokens for external callers." },
  { key: "users", label: "Users", description: "Operator CRUD + role assignment + TOTP reset + group mapping." },
  { key: "roles", label: "Roles", description: "Manage this permission matrix itself. Full Read-Write effectively grants admin-equivalent control." },
  { key: "serverSettingsSystem", label: "Server Settings — System", description: "Identification, authentication, certificates (agent pin), High Availability." },
  { key: "serverSettingsData", label: "Server Settings — Data", description: "Backup / restore, in-app updates, retention, security tokens." },
] as const;

const FUNCTION_KEY_SET = new Set(FUNCTION_KEYS.map((f) => f.key));

export function isValidFunctionKey(key: string): boolean {
  return FUNCTION_KEY_SET.has(key);
}

export function isValidAccessLevel(level: string): level is AccessLevel {
  return level === "none" || level === "read" || level === "write" || level === "fullwrite";
}

/** Drop unknown keys + bad values, default every function-key to "none". */
export function normalizePermissions(input: unknown): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const def of FUNCTION_KEYS) {
    const v = raw[def.key];
    out[def.key] = typeof v === "string" && isValidAccessLevel(v) ? v : "none";
  }
  return out;
}

// ─── Privilege ranking (group-mapping "highest privilege wins") ─────────────

export function isAdminEquivalentPermissions(perms: Record<string, AccessLevel>): boolean {
  return perms.users === "fullwrite" && perms.roles === "fullwrite";
}

export function rankRole(permissions: unknown): number {
  const perms = normalizePermissions(permissions);
  if (isAdminEquivalentPermissions(perms)) return Number.MAX_SAFE_INTEGER;
  let sum = 0;
  for (const def of FUNCTION_KEYS) sum += ACCESS_RANK[perms[def.key] ?? "none"];
  return sum;
}

export function pickHighestPrivilegeRoleId(
  roles: readonly { id: string; permissions: unknown }[],
): string | null {
  let best: { id: string; rank: number } | null = null;
  for (const r of roles) {
    const rank = rankRole(r.permissions);
    if (best === null || rank > best.rank || (rank === best.rank && r.id < best.id)) {
      best = { id: r.id, rank };
    }
  }
  return best ? best.id : null;
}

// ─── Session snapshot ────────────────────────────────────────────────────────

export interface SessionRoleSnapshot {
  id: string;
  name: string;
  isProtected: boolean;
  permissions: Record<string, AccessLevel>;
  updatedAt: string; // ISO; compared against the cache to trigger refresh
}

const roleVersionMap = new Map<string, string>();

export function bumpRoleVersion(roleId: string, updatedAt: Date | string): void {
  const iso = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
  roleVersionMap.set(roleId, iso);
}

async function loadRoleSnapshot(roleId: string): Promise<SessionRoleSnapshot> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AppError(401, "Your role no longer exists — please log in again.");
  const updatedAtIso = role.updatedAt.toISOString();
  roleVersionMap.set(role.id, updatedAtIso);
  return {
    id: role.id,
    name: role.name,
    isProtected: role.isProtected,
    permissions: normalizePermissions(role.permissions),
    updatedAt: updatedAtIso,
  };
}

export function snapshotFromRole(role: {
  id: string;
  name: string;
  isProtected: boolean;
  permissions: unknown;
  updatedAt: Date;
}): SessionRoleSnapshot {
  const iso = role.updatedAt.toISOString();
  roleVersionMap.set(role.id, iso);
  return {
    id: role.id,
    name: role.name,
    isProtected: role.isProtected,
    permissions: normalizePermissions(role.permissions),
    updatedAt: iso,
  };
}

async function resolveSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  if (!req.session?.userId) return null;
  if (!req.session.roleId) {
    const u = await prisma.user.findUnique({
      where: { id: req.session.userId },
      include: { role: true },
    });
    if (!u) return null;
    const fresh = snapshotFromRole(u.role);
    req.session.roleId = u.roleId;
    req.session.roleSnapshot = fresh;
    req.session.role = u.role.name;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    return fresh;
  }
  const snap = req.session.roleSnapshot;
  if (snap && snap.id === req.session.roleId) {
    const cached = roleVersionMap.get(snap.id);
    if (cached && cached === snap.updatedAt) return snap; // hot path, no DB hit
    if (!cached) {
      roleVersionMap.set(snap.id, snap.updatedAt); // cold cache: trust snapshot, warm cache
      return snap;
    }
    // Cached version is newer (role edited). Fall through to refetch.
  }
  const fresh = await loadRoleSnapshot(req.session.roleId);
  req.session.roleSnapshot = fresh;
  req.session.role = fresh.name;
  await new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
  return fresh;
}

export async function ensureSessionRoleSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  return resolveSnapshot(req);
}

function rankMeets(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

// ─── Public middleware factories ───────────────────────────────────────────

export function requirePermission(functionKey: string, required: AccessLevel) {
  if (!isValidFunctionKey(functionKey)) {
    throw new Error(`requirePermission: unknown functionKey "${functionKey}"`);
  }
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const snap = await resolveSnapshot(req);
      if (!snap) return next(new AppError(403, "Forbidden — session role required"));
      const actual = snap.permissions[functionKey] ?? "none";
      if (!rankMeets(actual, required)) {
        return next(new AppError(403, `Forbidden — your role lacks ${required} access on ${functionKey}`));
      }
      req.permissionLevel = actual;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function hasPermission(req: Request, functionKey: string, required: AccessLevel): boolean {
  const snap = req.session?.roleSnapshot;
  if (!snap) return false;
  const actual = snap.permissions[functionKey] ?? "none";
  return rankMeets(actual, required);
}

/**
 * Hybrid guard: pass if either the session has at least `level` on
 * `functionKey`, OR a bearer token whose scopes include `requiredScope`.
 */
export function requireSessionOrTokenPermission(
  functionKey: string,
  level: AccessLevel,
  requiredScope: string,
) {
  if (!isValidFunctionKey(functionKey)) {
    throw new Error(`requireSessionOrTokenPermission: unknown functionKey "${functionKey}"`);
  }
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.apiToken) {
        if (req.apiToken.scopes.includes(requiredScope)) return next();
        return next(new AppError(403, `Forbidden — token "${req.apiToken.name}" lacks scope "${requiredScope}"`));
      }
      const snap = await resolveSnapshot(req);
      if (snap) {
        const actual = snap.permissions[functionKey] ?? "none";
        if (rankMeets(actual, level)) {
          req.permissionLevel = actual;
          return next();
        }
        return next(new AppError(403, `Forbidden — your role lacks ${level} access on ${functionKey}`));
      }
      next(new AppError(401, "Unauthorized — session login or bearer token required"));
    } catch (err) {
      next(err);
    }
  };
}
