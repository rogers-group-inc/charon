/**
 * src/services/authService.ts — Operator authentication (local + second factor).
 *
 * Local accounts authenticate with argon2id + optional TOTP. SAML / OIDC / LDAP
 * operator login is server-configurable and reuses this same session
 * establishment path; those providers are wired in the integrations milestone.
 *
 * The SAME auth-mode config also drives the endpoint agent's login GUI — see
 * getAgentAuthConfig().
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { verifyPassword, hashPassword } from "../utils/password.js";
import { snapshotFromRole, type SessionRoleSnapshot } from "../api/middleware/permissions.js";
import * as OTPAuth from "otpauth";

export interface AuthedUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  roleId: string;
  snapshot: SessionRoleSnapshot;
}

export type AuthMode = "local" | "saml" | "oidc";

/**
 * Resolve the active operator/agent login mode from settings. Defaults to local
 * until an admin configures SAML/OIDC. This single value is what the agent's
 * GET /api/v1/agent/auth-config returns so the agent GUI renders the right flow.
 */
export async function getActiveAuthMode(): Promise<AuthMode> {
  const row = await prisma.setting.findUnique({ where: { key: "auth.mode" } });
  const v = (row?.value as { mode?: string } | undefined)?.mode;
  return v === "saml" || v === "oidc" ? v : "local";
}

/** Public agent-facing auth config (no secrets). Drives the agent login GUI. */
export async function getAgentAuthConfig(): Promise<{ mode: AuthMode; params: Record<string, unknown> }> {
  const mode = await getActiveAuthMode();
  // Only non-secret display/redirect params are exposed here. SAML/OIDC params
  // are filled in when those providers are configured.
  return { mode, params: {} };
}

interface LocalLoginResult {
  status: "ok" | "mfa_required";
  user?: AuthedUser;
  mfaPendingUserId?: string;
}

/**
 * Verify local credentials. Returns mfa_required when the account has TOTP
 * enabled; the caller then collects a code and calls verifyTotp(). Timing is
 * constant for unknown users (verifyPassword burns a dummy hash).
 */
export async function localLogin(username: string, password: string): Promise<LocalLoginResult> {
  const user = await prisma.user.findUnique({
    where: { username: username.trim() },
    include: { role: true },
  });
  const stored = user?.authProvider === "local" ? user.passwordHash : null;
  const { valid, needsRehash } = await verifyPassword(password, stored ?? null);
  if (!valid || !user) throw new AppError(401, "Invalid username or password");

  if (needsRehash) {
    void prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } })
      .catch(() => {});
  }

  if (user.totpEnabledAt && user.totpSecret) {
    return { status: "mfa_required", mfaPendingUserId: user.id };
  }
  return { status: "ok", user: projectUser(user) };
}

/** Verify a 6-digit TOTP (or a backup code) for an account mid-login. */
export async function verifyTotp(userId: string, code: string): Promise<AuthedUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user || !user.totpSecret) throw new AppError(401, "TOTP not configured");

  const totp = new OTPAuth.TOTP({
    issuer: "Charon",
    label: user.username,
    secret: OTPAuth.Secret.fromBase32(user.totpSecret),
  });
  const delta = totp.validate({ token: code.trim(), window: 1 });
  if (delta !== null) return projectUser(user);

  // Backup code fallback (stored as argon2id hashes).
  for (const hash of user.totpBackupCodes) {
    const { valid } = await verifyPassword(code.trim(), hash);
    if (valid) {
      await prisma.user.update({
        where: { id: user.id },
        data: { totpBackupCodes: user.totpBackupCodes.filter((h) => h !== hash) },
      });
      return projectUser(user);
    }
  }
  throw new AppError(401, "Invalid verification code");
}

export async function recordLogin(userId: string): Promise<void> {
  await prisma.user
    .update({ where: { id: userId }, data: { lastLogin: new Date() } })
    .catch(() => {});
}

function projectUser(user: {
  id: string;
  username: string;
  displayName: string | null;
  roleId: string;
  role: { id: string; name: string; isProtected: boolean; permissions: unknown; updatedAt: Date };
}): AuthedUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role.name,
    roleId: user.roleId,
    snapshot: snapshotFromRole(user.role),
  };
}
