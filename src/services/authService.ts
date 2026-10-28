/**
 * src/services/authService.ts — operator authentication: the local password
 * step, the TOTP second factor, forced / self-service password change, TOTP
 * self-enrollment, and the agent sign-in mode. Ported from polaris auth.ts,
 * with the logic moved out of the route.
 *
 * The route (src/api/routes/auth.ts) owns the SESSION: it rotates the id,
 * stamps the identity, or parks a half-finished login in `pendingAuth`
 * (utils/pendingAuth.ts). This service owns everything else and returns an
 * outcome the route acts on.
 *
 * Invariants:
 *   - Unknown usernames cost one argon2 verify like known ones (timing).
 *   - The per-username failure counter (utils/loginLockout.ts) covers the
 *     password, LDAP and TOTP steps; it is cleared only when NO factor is
 *     still owed, so re-entering a known password cannot reset a code grind.
 *   - A forced password change is offered only after EVERY factor passed.
 *   - A TOTP code is accepted once (totpStepService.claimTotpStep).
 *   - The TOTP secret is a crypto.ts envelope at rest (rule 3).
 *
 * The agent sign-in mode (`auth.mode`) also lives here: GET
 * /api/v1/agent/auth-config returns it so the agent GUI renders the right flow.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { decryptSecret, encryptSecret, isEncryptedEnvelope } from "../utils/crypto.js";
import { isLocked, lockoutRemaining, recordFailure, clearLockout } from "../utils/loginLockout.js";
import type { PendingMethods } from "../utils/pendingAuth.js";
import { logEvent } from "./eventService.js";
import { assertPasswordMeetsPolicy, passwordNeedsPolicyChange } from "./passwordPolicyService.js";
import { verifyCodeStep, consumeBackupCode, generateSecret, generateBackupCodes, buildEnrollment } from "./totpService.js";
import { claimTotpStep } from "./totpStepService.js";
import { createSettingStore } from "./settingsStore.js";

export type AuthMode = "local" | "saml" | "oidc";

/** A user row with its role, as every login outcome carries it. */
export type UserWithRole = NonNullable<Awaited<ReturnType<typeof loadUserWithRole>>>;

export async function loadUserWithRole(id: string) {
  return prisma.user.findUnique({ where: { id }, include: { role: true } });
}

/** Request context for audit Events. */
export interface LoginContext {
  ip?: string;
  userAgent?: string;
}

// ─── Agent sign-in mode ─────────────────────────────────────────────────────

const authModeStore = createSettingStore<AuthMode>({
  key: "auth.mode",
  ttlMs: 10_000,
  parse: (raw) => {
    const v = (raw as { mode?: string } | undefined)?.mode;
    return v === "saml" || v === "oidc" ? v : "local";
  },
});

/** The agent login GUI's mode. Defaults to local until an admin picks SAML/OIDC. */
export async function getActiveAuthMode(): Promise<AuthMode> {
  return authModeStore.get();
}

export async function setAgentAuthMode(mode: AuthMode, actor?: string): Promise<AuthMode> {
  const before = await getActiveAuthMode();
  await prisma.setting.upsert({ where: { key: "auth.mode" }, create: { key: "auth.mode", value: { mode } }, update: { value: { mode } } });
  authModeStore.invalidate();
  if (before !== mode) {
    await logEvent({ action: "auth.mode.changed", actor, message: `Endpoint agent sign-in mode set to ${mode} (was ${before})` });
  }
  return mode;
}

/** Public agent-facing auth config (no secrets). Drives the agent login GUI. */
export async function getAgentAuthConfig(): Promise<{ mode: AuthMode; params: Record<string, unknown> }> {
  const mode = await getActiveAuthMode();
  return { mode, params: {} };
}

// ─── Lockout helpers ────────────────────────────────────────────────────────

async function assertNotLocked(username: string, ctx: LoginContext, step: string, userId?: string): Promise<void> {
  const lock = isLocked(username);
  if (!lock.locked) return;
  await logEvent({
    action: "auth.login.locked",
    level: "warning",
    resourceType: "user",
    resourceId: userId,
    resourceName: username,
    message: `${step} attempt on locked account "${username}"`,
    details: { ip: ctx.ip, lockedUntil: lock.until?.toISOString() },
  });
  throw new AppError(423, `Account temporarily locked due to too many failed attempts. Try again in ${lockoutRemaining(lock.until)}.`);
}

/** Count a failure; log the lockout if this one tripped it. Returns the tally. */
async function countFailure(username: string, ctx: LoginContext): Promise<{ failures: number; lockedNow: boolean }> {
  const tripped = recordFailure(username);
  if (tripped.lockedNow) {
    await logEvent({
      action: "auth.login.lockout",
      level: "warning",
      resourceType: "user",
      resourceName: username,
      message: `Account "${username}" locked after ${tripped.failures} failed attempts`,
      details: { ip: ctx.ip, lockedUntil: tripped.until?.toISOString() },
    });
  }
  return tripped;
}

// ─── Second factors ─────────────────────────────────────────────────────────

/**
 * Which second factors stand between this account and a session. Non-local
 * accounts have none — their identity provider owns MFA. The passkey half is
 * supplied by the caller (passkeyService) so this module does not depend on it.
 */
export function resolveSecondFactors(
  user: { authProvider: string; totpEnabledAt: Date | null },
  passkeySecondFactor: boolean,
): PendingMethods {
  if (user.authProvider !== "local") return { totp: false, passkey: false };
  return { totp: Boolean(user.totpEnabledAt), passkey: passkeySecondFactor };
}

/** The stored TOTP secret as base32. Accepts an envelope (current) or legacy plaintext. */
function openTotpSecret(stored: string): string {
  return isEncryptedEnvelope(stored) ? decryptSecret(stored) : stored;
}

// ─── Local password step ────────────────────────────────────────────────────

export interface PasswordStepResult {
  user: UserWithRole;
  /** Second factors still owed; both false → the session may be issued (unless mustChangePassword). */
  methods: PendingMethods;
  /** The password just accepted fails a policy that forces a change at login. */
  mustChangePassword: boolean;
  rehashed: boolean;
}

/**
 * Verify a LOCAL account's password. Throws 401 (generic) on any failure,
 * 423 when the username is locked. Does not issue anything — the route decides
 * between session, second factor and forced change from the result.
 *
 * `hasPasskeySecondFactor(user)` answers whether passkeys are a second factor
 * for this account (install policy + a registered passkey).
 */
export async function passwordStep(
  username: string,
  password: string,
  ctx: LoginContext,
  hasPasskeySecondFactor: (userId: string) => Promise<boolean>,
): Promise<PasswordStepResult> {
  await assertNotLocked(username, ctx, "Login");
  const user = await prisma.user.findUnique({ where: { username: username.trim() }, include: { role: true } });
  const stored = user?.authProvider === "local" ? user.passwordHash : null;
  // Constant time: a null stored hash still burns a dummy argon2 verify.
  const { valid, needsRehash } = await verifyPassword(password, stored);
  if (!user || !valid) {
    const tripped = await countFailure(username, ctx);
    await logEvent({
      action: "auth.login.failed",
      level: "warning",
      resourceType: "user",
      resourceName: username,
      message: `Failed local login for "${username}"`,
      details: { ip: ctx.ip, userAgent: ctx.userAgent, failures: tripped.failures },
    });
    throw new AppError(401, "Invalid username or password");
  }

  if (needsRehash) {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  }

  // The only moment the policy can be checked against the plaintext; the
  // answer rides across the second factor rather than being acted on here.
  const mustChangePassword = await passwordNeedsPolicyChange(password);
  const methods = resolveSecondFactors(user, await hasPasskeySecondFactor(user.id));
  // Cleared only when no factor is owed — see the module header.
  if (!methods.totp && !methods.passkey) clearLockout(username);
  return { user, methods, mustChangePassword, rehashed: needsRehash };
}

/**
 * Credentials-only check for the endpoint agent's local login (no session, no
 * forced change — the agent binds a user to a device, it does not sign one in
 * to the console). Same lockout and timing as the console path.
 */
export async function localLogin(
  username: string,
  password: string,
  ctx: LoginContext = {},
): Promise<{ status: "ok" | "mfa_required"; user: UserWithRole }> {
  const result = await passwordStep(username, password, ctx, async () => false);
  return { status: result.methods.totp ? "mfa_required" : "ok", user: result.user };
}

// ─── TOTP second factor (login) ─────────────────────────────────────────────

/**
 * Verify a TOTP or backup code for an account mid-login. Throws 401 on a wrong
 * code (counted against the lockout), 423 when locked. On success clears the
 * counter, persists a consumed backup code, and returns the user.
 */
export async function totpLoginStep(
  pending: { userId: string; username: string },
  code: string,
  isBackupCode: boolean,
  ctx: LoginContext,
): Promise<{ user: UserWithRole }> {
  await assertNotLocked(pending.username, ctx, "TOTP", pending.userId);
  const user = await loadUserWithRole(pending.userId);
  if (!user || !user.totpSecret || !user.totpEnabledAt) {
    throw new AppError(401, "Session expired — please sign in again.");
  }

  let verified: boolean;
  let remainingBackupCodes: string[] | null = null;
  if (isBackupCode) {
    remainingBackupCodes = await consumeBackupCode(user.totpBackupCodes, code);
    verified = remainingBackupCodes !== null;
  } else {
    const step = verifyCodeStep(openTotpSecret(user.totpSecret), code);
    verified = step !== null && (await claimTotpStep(user.id, step));
  }

  if (!verified) {
    const tripped = await countFailure(pending.username, ctx);
    await logEvent({
      action: "auth.login.totp_failed",
      level: "warning",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      message: `Failed ${isBackupCode ? "backup-code" : "TOTP"} attempt for ${user.username}`,
      details: { ip: ctx.ip, failures: tripped.failures },
    });
    throw new AppError(401, "Invalid verification code");
  }

  clearLockout(pending.username);
  if (remainingBackupCodes) {
    await prisma.user.update({ where: { id: user.id }, data: { totpBackupCodes: remainingBackupCodes } });
  }
  return { user };
}

// ─── Successful sign-in bookkeeping ─────────────────────────────────────────

/** Stamp lastLogin and write the login Event. */
export async function recordLogin(user: { id: string; username: string }, method: string, ctx: LoginContext): Promise<void> {
  await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } }).catch(() => {});
  await logEvent({
    action: "auth.login",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: user.username,
    message: `${user.username} logged in (${method})`,
    details: { ip: ctx.ip, userAgent: ctx.userAgent, method },
  });
}

export async function recordPasswordChangeDemanded(user: { id: string; username: string }, via: string, ctx: LoginContext): Promise<void> {
  await logEvent({
    action: "auth.login.password_change_required",
    level: "warning",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: user.username,
    message: `${user.username} authenticated but must set a password meeting the current complexity policy`,
    details: { ip: ctx.ip, via },
  });
}

// ─── Password changes ───────────────────────────────────────────────────────

/**
 * The last step of a login whose password failed a forced-change policy.
 * Reached only with a "password-change" pendingAuth, minted after every factor
 * passed. Returns the user for the route to issue the session to.
 */
export async function completeForcedPasswordChange(userId: string, newPassword: string, ctx: LoginContext): Promise<UserWithRole> {
  const user = await loadUserWithRole(userId);
  if (!user || user.authProvider !== "local") throw new AppError(401, "Session expired — please sign in again.");
  await assertPasswordMeetsPolicy(newPassword);
  // The policy can be relaxed while the pending step lives; re-submitting the
  // password that triggered the demand would satisfy its letter, not its point.
  const { valid: sameAsOld } = await verifyPassword(newPassword, user.passwordHash);
  if (sameAsOld) throw new AppError(400, "The new password must be different from your current one.");
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  clearLockout(user.username);
  await logEvent({
    action: "user.password_changed",
    level: "warning",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: user.username,
    message: `${user.username} set a new password to satisfy the complexity policy at login`,
    details: { ip: ctx.ip, forced: true },
  });
  return user;
}

/**
 * A local user changing their OWN password. Proves the current password; the
 * route then revokes every other session and rotates this one.
 */
export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<{ username: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found");
  if (user.authProvider !== "local") throw new AppError(400, "Your password is managed by your identity provider — change it there.");
  const { valid } = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new AppError(401, "Current password is incorrect.");
  if (currentPassword === newPassword) throw new AppError(400, "The new password must be different from the current one.");
  await assertPasswordMeetsPolicy(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
  clearLockout(user.username);
  return { username: user.username };
}

// ─── TOTP self-enrollment ───────────────────────────────────────────────────

async function loadSelf(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found");
  return user;
}

export async function totpStatus(userId: string) {
  const user = await loadSelf(userId);
  return {
    authProvider: user.authProvider,
    enabled: !!user.totpEnabledAt,
    enrolling: !!user.totpSecret && !user.totpEnabledAt,
    backupCodesRemaining: user.totpBackupCodes.length,
  };
}

/** Start (or restart) enrollment: a fresh secret, sealed at rest; the QR to scan. */
export async function startTotpEnrollment(userId: string): Promise<{ secret: string; otpauthUri: string; qrSvg: string }> {
  const user = await loadSelf(userId);
  if (user.authProvider !== "local") throw new AppError(400, "Two-factor auth is managed by your identity provider for SSO accounts.");
  if (user.totpEnabledAt) throw new AppError(409, "Two-factor auth is already enabled. Disable it before re-enrolling.");
  const secret = generateSecret();
  const { otpauthUri, qrSvg } = await buildEnrollment(secret, user.username);
  await prisma.user.update({ where: { id: userId }, data: { totpSecret: encryptSecret(secret), totpLastStep: null } });
  return { secret, otpauthUri, qrSvg };
}

/** Finish enrollment with a first code; returns the one-time backup codes. */
export async function confirmTotpEnrollment(userId: string, code: string): Promise<string[]> {
  const user = await loadSelf(userId);
  if (!user.totpSecret) throw new AppError(400, "No enrollment in progress — start by generating a QR code.");
  if (user.totpEnabledAt) throw new AppError(409, "Two-factor auth is already enabled.");
  const step = verifyCodeStep(openTotpSecret(user.totpSecret), code);
  if (step === null) throw new AppError(401, "Invalid code. Try again with a fresh value from your authenticator app.");
  const { plaintext, hashes } = await generateBackupCodes();
  // The confirming code is the first one used: record its step so it can't be replayed at login.
  await prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(), totpBackupCodes: hashes, totpLastStep: step } });
  await logEvent({
    action: "auth.totp.enrolled",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: user.username,
    message: `TOTP enabled for ${user.username}`,
  });
  return plaintext;
}

/** Self-disable. Needs a valid current code so a stolen session can't silently drop MFA. */
export async function disableOwnTotp(userId: string, code: string, isBackupCode: boolean): Promise<void> {
  const user = await loadSelf(userId);
  if (!user.totpEnabledAt || !user.totpSecret) throw new AppError(400, "Two-factor auth is not currently enabled.");
  let verified: boolean;
  if (isBackupCode) {
    verified = (await consumeBackupCode(user.totpBackupCodes, code)) !== null;
  } else {
    const step = verifyCodeStep(openTotpSecret(user.totpSecret), code);
    verified = step !== null && (await claimTotpStep(user.id, step));
  }
  if (!verified) throw new AppError(401, "Invalid code.");
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [], totpLastStep: null },
  });
  await logEvent({
    action: "auth.totp.disabled",
    level: "warning",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: user.username,
    message: `TOTP disabled for ${user.username} (self)`,
  });
}
