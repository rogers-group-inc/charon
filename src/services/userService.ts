/**
 * src/services/userService.ts — operator account management (the Users page).
 * Ported from polaris routes/users.ts, with the logic moved out of the route.
 *
 * Invariants:
 *   - lastAdminEquivalent: no action may leave Charon with zero users holding
 *     an admin-equivalent role (users=fullwrite AND roles=fullwrite) → 409.
 *   - Escalation: acting on an admin-equivalent ACCOUNT (reset its password,
 *     second factors, role; delete it) needs an admin-equivalent caller, and
 *     placing an account on a role needs the caller to hold every grant in it.
 *     Both checks take the caller's Request, so the ROUTE runs them
 *     (permissions.ts → assertNoPrivilegeEscalation / assertGrantWithinCaller)
 *     with the account / role this service loads.
 *   - Every change that should cut an account off (delete, new role, reset
 *     password / TOTP / passkeys) revokes its live sessions; acting on your
 *     own account keeps the session you are using.
 *   - Every mutation writes a `user.*` Event.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword } from "../utils/password.js";
import { clearLockout } from "../utils/loginLockout.js";
import { logEvent } from "./eventService.js";
import { assertPasswordMeetsPolicy } from "./passwordPolicyService.js";
import { countAdminEquivalentUsers, isAdminEquivalentRole } from "./roleService.js";
import { getOnlineUserIds, revokeUserSessions } from "./sessionRevocationService.js";

const USER_SELECT = {
  id: true,
  username: true,
  authProvider: true,
  displayName: true,
  email: true,
  lastLogin: true,
  createdAt: true,
  updatedAt: true,
  totpEnabledAt: true,
  needsRoleReview: true,
  role: { select: { id: true, name: true, color: true, isProtected: true, isBuiltIn: true } },
} as const;

export interface UserListRow {
  id: string;
  username: string;
  authProvider: string;
  displayName: string | null;
  email: string | null;
  lastLogin: Date | null;
  createdAt: Date;
  updatedAt: Date;
  needsRoleReview: boolean;
  role: { id: string; name: string; color: string | null; isProtected: boolean; isBuiltIn: boolean };
  isOnline: boolean;
  totpEnabled: boolean;
  passkeyCount: number;
}

/** Who is acting, and on which session — for Events and own-session keep. */
export interface Actor {
  userId?: string;
  username?: string;
  sessionId?: string;
}

/** The account + its role matrix, for the route's escalation checks. 404 when absent. */
export async function getUserForAction(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!user) throw new AppError(404, "User not found");
  return user;
}

/** The role a create / re-role would place an account on. 400 when absent. */
export async function getRoleForAssignment(roleId: string) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AppError(400, `Role ${roleId} not found`);
  return role;
}

/** Every operator account, with online / TOTP / passkey status. Three queries regardless of row count. */
export async function listUsers(): Promise<UserListRow[]> {
  const [users, online, passkeyCounts] = await Promise.all([
    prisma.user.findMany({ select: USER_SELECT, orderBy: { username: "asc" } }),
    getOnlineUserIds(),
    countPasskeysByUser(),
  ]);
  return users.map(({ totpEnabledAt, ...rest }) => ({
    ...rest,
    isOnline: online.has(rest.id),
    totpEnabled: !!totpEnabledAt,
    passkeyCount: passkeyCounts.get(rest.id) ?? 0,
  }));
}

async function countPasskeysByUser(): Promise<Map<string, number>> {
  const rows = await prisma.userPasskey.groupBy({ by: ["userId"], _count: { _all: true } });
  return new Map(rows.map((r) => [r.userId, r._count._all]));
}

// End the target's live sessions; keep the caller's own when acting on themselves.
async function endSessionsOf(actor: Actor, targetUserId: string): Promise<void> {
  await revokeUserSessions(targetUserId, actor.userId === targetUserId ? actor.sessionId : undefined);
}

export async function createLocalUser(
  input: { username: string; password: string; roleId: string },
  actor: Actor,
) {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) {
    throw new AppError(400, "Username must be 1-64 characters: letters, digits, dot, underscore, @ or dash");
  }
  const [existing, role] = await Promise.all([
    prisma.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } }),
    getRoleForAssignment(input.roleId),
  ]);
  if (existing) throw new AppError(409, `User "${username}" already exists`);
  await assertPasswordMeetsPolicy(input.password);

  const user = await prisma.user.create({
    data: { username, passwordHash: await hashPassword(input.password), roleId: role.id, authProvider: "local" },
    select: USER_SELECT,
  });
  await logEvent({
    action: "user.created",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: actor.username,
    message: `User "${user.username}" created with role "${role.name}"`,
  });
  return user;
}

export async function resetPassword(id: string, password: string, actor: Actor): Promise<void> {
  const user = await getUserForAction(id);
  if (user.authProvider !== "local") {
    throw new AppError(400, "Cannot reset the password of an SSO / LDAP account — the identity provider manages its credentials.");
  }
  await assertPasswordMeetsPolicy(password);
  await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
  clearLockout(user.username);
  await endSessionsOf(actor, id);
  await logEvent({
    action: "user.password_reset",
    level: "warning",
    resourceType: "user",
    resourceId: id,
    resourceName: user.username,
    actor: actor.username,
    message: `Password reset for user "${user.username}" by an administrator`,
  });
}

export async function changeRole(id: string, roleId: string, actor: Actor) {
  const [user, role] = await Promise.all([getUserForAction(id), getRoleForAssignment(roleId)]);
  if (actor.userId === user.id) throw new AppError(400, "You cannot change your own role");

  if ((await isAdminEquivalentRole(user.roleId)) && !(await isAdminEquivalentRole(role.id))) {
    if ((await countAdminEquivalentUsers(user.id)) === 0) {
      throw new AppError(409, "Cannot reassign — this is the last admin-equivalent account. Promote another user first.");
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { roleId: role.id, needsRoleReview: false },
    select: USER_SELECT,
  });
  // The account's sessions carry the OLD role's snapshot.
  await endSessionsOf(actor, id);
  await logEvent({
    action: "user.role_changed",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: actor.username,
    message: `Role for "${user.username}" changed from "${user.role.name}" to "${role.name}"`,
    details: { from: user.role.name, to: role.name },
  });
  return updated;
}

/** Clear the "new SSO account — review its role" flag without changing the role. */
export async function dismissRoleReview(id: string, actor: Actor): Promise<void> {
  const user = await getUserForAction(id);
  if (!user.needsRoleReview) return;
  await prisma.user.update({ where: { id }, data: { needsRoleReview: false } });
  await logEvent({
    action: "user.role_reviewed",
    resourceType: "user",
    resourceId: id,
    resourceName: user.username,
    actor: actor.username,
    message: `Role "${user.role.name}" for "${user.username}" confirmed`,
  });
}

/** Admin TOTP reset — the user lost their device and has no backup code. */
export async function resetTotp(id: string, actor: Actor): Promise<void> {
  const user = await getUserForAction(id);
  if (!user.totpEnabledAt && !user.totpSecret) throw new AppError(400, "Two-factor auth is not configured for this user.");
  await prisma.user.update({
    where: { id },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [], totpLastStep: null },
  });
  await endSessionsOf(actor, id);
  await logEvent({
    action: "user.totp_reset",
    level: "warning",
    resourceType: "user",
    resourceId: id,
    resourceName: user.username,
    actor: actor.username,
    message: `Two-factor auth reset for user "${user.username}" by an administrator`,
  });
}

export async function listUserPasskeys(id: string) {
  return prisma.userPasskey.findMany({
    where: { userId: id },
    select: { id: true, name: true, deviceType: true, backedUp: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Admin revoke of ALL of an account's passkeys (a lost authenticator).
 * Safe: a local account always has a password, so this only widens the way in.
 */
export async function revokePasskeys(id: string, actor: Actor): Promise<number> {
  const user = await getUserForAction(id);
  const { count } = await prisma.userPasskey.deleteMany({ where: { userId: id } });
  if (count === 0) throw new AppError(400, "This user has no passkeys registered.");
  await endSessionsOf(actor, id);
  await logEvent({
    action: "user.passkeys_revoked",
    level: "warning",
    resourceType: "user",
    resourceId: id,
    resourceName: user.username,
    actor: actor.username,
    message: `${count} passkey${count === 1 ? "" : "s"} revoked for user "${user.username}" by an administrator`,
  });
  return count;
}

export async function deleteUser(id: string, actor: Actor): Promise<void> {
  const user = await getUserForAction(id);
  if (actor.userId === user.id) throw new AppError(400, "You cannot delete your own account");
  if ((await isAdminEquivalentRole(user.roleId)) && (await countAdminEquivalentUsers(user.id)) === 0) {
    throw new AppError(409, "Cannot delete — this is the last admin-equivalent account. Promote another user first.");
  }
  await prisma.user.delete({ where: { id } }); // passkeys cascade
  await endSessionsOf(actor, id);
  await logEvent({
    action: "user.deleted",
    level: "warning",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: actor.username,
    message: `User "${user.username}" deleted (was role "${user.role.name}")`,
  });
}
