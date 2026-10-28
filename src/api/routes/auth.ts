/**
 * src/api/routes/auth.ts — operator sign-in and the authentication settings.
 *
 * Mounted at /auth BEFORE requireAuth (public). Each route gates itself:
 *   - login steps (password → second factor → forced change) are public, run
 *     the Local Login Access gate, and are CSRF-exempt (pre-session);
 *   - self-service (own password / TOTP) needs a signed-in session
 *     (requireSessionUser);
 *   - settings need requireAuth + authentication:read / :write.
 *
 * The route owns the SESSION — rotate the id, stamp the identity, park a
 * half-finished login in pendingAuth (utils/pendingAuth.ts). Everything else
 * is in services/authService.ts.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import * as authService from "../../services/authService.js";
import { ensureSessionRoleSnapshot, requirePermission, snapshotFromRole } from "../middleware/permissions.js";
import { requireAuth, requireSessionUser } from "../middleware/auth.js";
import { adminActionLimiter, passwordChangeLimiter, totpCodeLimiter } from "../middleware/rateLimits.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { logEvent } from "../../services/eventService.js";
import {
  isLoginSourceAllowed,
  getLoginAccessSettings,
  loginSourceAllowed,
  previewLoginAccessSettings,
  saveLoginAccessSettings,
} from "../../services/webAccessSettingsService.js";
import { describeIpScope } from "../../utils/ipScope.js";
import { revokeUserSessions } from "../../services/sessionRevocationService.js";
import { getPasswordPolicy, savePasswordPolicy } from "../../services/passwordPolicyService.js";
import { getSessionSettings, saveSessionSettings, AUTO_LOGOUT_MAX_MINUTES } from "../../services/sessionSettingsService.js";
import {
  describePasswordPolicy,
  passwordRules,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
} from "../../utils/passwordPolicy.js";
import { passwordInputSchema } from "../../utils/password.js";
import { setPending, peekPending, clearPending } from "../../utils/pendingAuth.js";
import { isLocked } from "../../utils/loginLockout.js";
import { getPasskeySettings, passkeySecondFactorEnabled, userHasPasskey } from "../../services/passkeyService.js";

// Capped: a failed login's Event carries whatever was typed, unauthenticated.
const LoginSchema = z.object({
  username: z.string().min(1, "Username is required").max(128, "Username is too long"),
  password: z.string().min(1, "Password is required").max(1024),
});
const TotpLoginSchema = z.object({ code: z.string().min(1).max(32), isBackupCode: z.boolean().optional() });
const ForcedPasswordChangeSchema = z.object({ newPassword: passwordInputSchema });
const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: passwordInputSchema });
const TotpConfirmSchema = z.object({ code: z.string().min(1).max(32) });
const TotpDisableSchema = z.object({ code: z.string().min(1).max(32), isBackupCode: z.boolean().optional() });
const PasswordPolicySchema = z.object({
  minLength: z.number().int().min(PASSWORD_MIN_LENGTH_FLOOR).max(PASSWORD_MIN_LENGTH_CEILING).optional(),
  requireLowercase: z.boolean().optional(),
  requireUppercase: z.boolean().optional(),
  requireNumber: z.boolean().optional(),
  requireSpecial: z.boolean().optional(),
  forceChangeOnLogin: z.boolean().optional(),
});
const SessionSettingsSchema = z.object({
  autoLogoutMinutes: z.number().int().min(0).max(AUTO_LOGOUT_MAX_MINUTES).optional(),
  skipLoginPage: z.boolean().optional(),
});
const AgentModeSchema = z.object({ mode: z.enum(["local", "saml", "oidc"]) });
const LoginAccessSchema = z.object({
  enabled: z.boolean().optional(),
  ipScope: z.enum(["rfc1918", "all", "custom"]).optional(),
  // CIDR validation + normalization happens in the service.
  allowedCidrs: z.array(z.string().max(64)).max(200).optional(),
});

const router = Router();

export const ctxOf = (req: Request): authService.LoginContext => ({ ip: req.ip, userAgent: req.get("user-agent") || undefined });

// ─── Session helpers ────────────────────────────────────────────────────────

/**
 * Rotate the session id (fixation defence: an id planted pre-auth must not
 * become the authenticated one). The CSRF token is carried across — the csrf
 * middleware already mirrored it into this response's cookie from the OLD
 * session, and the open page must keep working.
 */
export function regenerateSession(req: Request): Promise<void> {
  const csrfToken = req.session.csrfToken;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      if (csrfToken) req.session.csrfToken = csrfToken;
      resolve();
    });
  });
}

/** Stamp the freshly rotated session with the signed-in identity — the one home for these fields. */
export function stampLoginSession(req: Request, user: authService.UserWithRole, authProvider: string): void {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.roleId = user.roleId;
  req.session.roleSnapshot = snapshotFromRole(user.role);
  req.session.role = user.role.name;
  req.session.authProvider = authProvider;
  req.session.lastActivity = Date.now();
  req.session.checkedAt = Date.now();
}

/** Issue the session for a fully authenticated user and answer the client. */
export async function finishLogin(req: Request, res: Response, user: authService.UserWithRole, authProvider: string, method: string): Promise<void> {
  await regenerateSession(req);
  stampLoginSession(req, user, authProvider);
  await authService.recordLogin(user, method, ctxOf(req));
  res.json({ ok: true, username: user.username, role: user.role.name });
}

/** Passkeys count as a second factor when the install allows it AND the account holds one. */
async function passkeySecondFactorFor(userId: string): Promise<boolean> {
  return passkeySecondFactorEnabled(await getPasskeySettings()) && (await userHasPasskey(userId));
}

/** Every factor passed but the password fails a forced-change policy: park the session-less login. */
export async function demandPasswordChange(req: Request, res: Response, user: authService.UserWithRole, via: string): Promise<void> {
  setPending(req, {
    userId: user.id,
    username: user.username,
    purpose: "password-change",
    methods: { totp: false, passkey: false },
    mustChangePassword: true,
    authProvider: "local",
  });
  await authService.recordPasswordChangeDemanded(user, via, ctxOf(req));
  res.json({ passwordChangeRequired: true, policy: await getPasswordPolicy() });
}

// Local Login Access (Users → Authentication → Settings): optional source-IP
// scope on the LOCAL credential paths only (password incl. LDAP, TOTP, forced
// change, passkeys) — SSO is never restricted. Fails open on a settings read
// error so a DB blip is never a lockout.
export async function assertLoginSourceAllowed(req: Request): Promise<void> {
  if (!(await isLoginSourceAllowed(req.ip ?? ""))) {
    throw new AppError(403, "Local login is not permitted from this network");
  }
}

// ─── Login: password step ───────────────────────────────────────────────────

router.post("/login", async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    const { username, password } = LoginSchema.parse(req.body);
    clearPending(req);
    const result = await authService.passwordStep(username, password, ctxOf(req), passkeySecondFactorFor);
    const { user, methods, mustChangePassword } = result;

    if (methods.totp || methods.passkey) {
      setPending(req, { userId: user.id, username: user.username, purpose: "mfa", methods, mustChangePassword, authProvider: "local" });
      return res.json({ mfaRequired: true, methods });
    }
    if (mustChangePassword) return demandPasswordChange(req, res, user, "password");
    await finishLogin(req, res, user, result.authProvider, result.rehashed ? "local, rehashed" : result.authProvider);
  } catch (err) {
    next(err);
  }
});

// ─── Login: TOTP / backup-code step ─────────────────────────────────────────

router.post("/login/totp", async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    const pending = peekPending(req, "mfa");
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");
    if (!pending.methods.totp) throw new AppError(400, "This account has no authenticator app enrolled.");
    const { code, isBackupCode } = TotpLoginSchema.parse(req.body);
    let user: authService.UserWithRole;
    try {
      ({ user } = await authService.totpLoginStep(pending, code, !!isBackupCode, ctxOf(req)));
    } catch (err) {
      // Locked now (or gone): drop the half-finished login so codes can't be
      // ground against the same password-verified state once the lock expires.
      if (isLocked(pending.username).locked || (err as AppError).httpStatus !== 401) clearPending(req);
      throw err;
    }
    clearPending(req);
    if (pending.mustChangePassword) return demandPasswordChange(req, res, user, isBackupCode ? "backup_code" : "totp");
    await finishLogin(req, res, user, pending.authProvider, isBackupCode ? "local + backup code" : "local + TOTP");
  } catch (err) {
    next(err);
  }
});

// ─── Login: forced password change ──────────────────────────────────────────

router.post("/login/password-change", passwordChangeLimiter, async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    const pending = peekPending(req, "password-change");
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");
    const { newPassword } = ForcedPasswordChangeSchema.parse(req.body);
    const user = await authService.completeForcedPasswordChange(pending.userId, newPassword, ctxOf(req));
    // Cleared only after the write lands — a failed update leaves a retryable step.
    clearPending(req);
    await finishLogin(req, res, user, "local", "local, password changed");
  } catch (err) {
    next(err);
  }
});

// ─── Logout / me ────────────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  const username = req.session.username;
  req.session.destroy(() => {
    if (username) void logEvent({ level: "info", action: "auth.logout", actor: username, message: `${username} logged out` });
    res.json({ ok: true });
  });
});

router.get("/me", async (req, res, next) => {
  try {
    if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
    const snap = await ensureSessionRoleSnapshot(req);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, include: { role: { select: { color: true } } } });
    if (!user || !snap) return res.status(401).json({ error: "Not authenticated" });
    const session = await getSessionSettings();
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      authProvider: req.session.authProvider ?? user.authProvider,
      role: snap.name,
      roleColor: user.role.color,
      permissions: snap.permissions,
      totpEnabled: !!user.totpEnabledAt,
      autoLogoutMinutes: session.autoLogoutMinutes,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Self-service: own password ─────────────────────────────────────────────

router.put("/password", requireSessionUser, passwordChangeLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    const userId = req.session.userId!;
    const { username } = await authService.changeOwnPassword(userId, currentPassword, newPassword);
    // Whoever learned the old password must not keep a live cookie; this
    // session's id rotates too, with its identity carried across.
    const revoked = await revokeUserSessions(userId, req.sessionID);
    const carried = { ...req.session } as Record<string, unknown>;
    await regenerateSession(req);
    for (const [k, v] of Object.entries(carried)) {
      if (k !== "cookie") (req.session as unknown as Record<string, unknown>)[k] = v;
    }
    req.session.lastActivity = Date.now();
    await logEvent({
      action: "user.password_changed",
      resourceType: "user",
      resourceId: userId,
      resourceName: username,
      actor: username,
      message: `${username} changed their own password`,
      details: { ip: req.ip, otherSessionsRevoked: revoked },
    });
    res.json({ ok: true, otherSessionsRevoked: revoked });
  } catch (err) {
    next(err);
  }
});

// ─── Self-service: own TOTP ─────────────────────────────────────────────────

router.get("/totp/status", requireSessionUser, async (req, res, next) => {
  try {
    res.json(await authService.totpStatus(req.session.userId!));
  } catch (err) { next(err); }
});

router.post("/totp/enroll", requireSessionUser, async (req, res, next) => {
  try {
    res.json(await authService.startTotpEnrollment(req.session.userId!));
  } catch (err) { next(err); }
});

router.post("/totp/confirm", requireSessionUser, totpCodeLimiter, async (req, res, next) => {
  try {
    const { code } = TotpConfirmSchema.parse(req.body);
    res.json({ ok: true, backupCodes: await authService.confirmTotpEnrollment(req.session.userId!, code) });
  } catch (err) { next(err); }
});

router.delete("/totp", requireSessionUser, totpCodeLimiter, async (req, res, next) => {
  try {
    const { code, isBackupCode } = TotpDisableSchema.parse(req.body);
    await authService.disableOwnTotp(req.session.userId!, code, !!isBackupCode);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Password complexity policy ─────────────────────────────────────────────
// The GET is deliberately public: the setup wizard and the forced-change step
// need the rules before there is a session, and what it discloses is learnable
// by submitting one bad password anyway.

router.get("/password-policy", async (_req, res, next) => {
  try {
    const policy = await getPasswordPolicy();
    res.json({
      policy,
      rules: passwordRules(policy).map((r) => ({ key: r.key, label: r.label })),
      limits: { minLengthFloor: PASSWORD_MIN_LENGTH_FLOOR, minLengthCeiling: PASSWORD_MIN_LENGTH_CEILING },
    });
  } catch (err) { next(err); }
});

router.put("/password-policy", requireAuth, requirePermission("authentication", "write"), async (req, res, next) => {
  try {
    const input = PasswordPolicySchema.parse(req.body ?? {});
    const before = await getPasswordPolicy();
    const updated = await savePasswordPolicy(input);
    await logEvent({
      // Forcing a change interrupts every non-conforming user's next sign-in.
      level: updated.forceChangeOnLogin ? "warning" : "info",
      action: "password_policy.updated",
      resourceType: "setting",
      resourceName: "passwordPolicyConfig",
      actor: req.session?.username ?? req.apiToken?.name,
      message: `Password complexity policy: ${describePasswordPolicy(updated)}`,
      details: { before, after: updated, actorIp: req.ip },
    });
    res.json({ policy: updated });
  } catch (err) { next(err); }
});

// ─── Session settings ───────────────────────────────────────────────────────

router.get("/session-settings", requireAuth, requirePermission("authentication", "read"), async (_req, res, next) => {
  try {
    res.json(await getSessionSettings());
  } catch (err) { next(err); }
});

router.put("/session-settings", requireAuth, requirePermission("authentication", "write"), async (req, res, next) => {
  try {
    const input = SessionSettingsSchema.parse(req.body ?? {});
    const before = await getSessionSettings();
    // Lockout guard: hiding the login page bounces every visitor to SSO, so
    // turning it ON needs a working SSO provider AND a caller who is signed in
    // through SSO right now (proof the round trip works). Turning it off is
    // always allowed — that is the recovery path. ?local=1 still shows the form.
    if (input.skipLoginPage === true && !before.skipLoginPage) {
      if (req.session?.authProvider !== "saml" && req.session?.authProvider !== "oidc") {
        throw new AppError(400, "Enable “Skip login page” only while signed in through SAML or OIDC — that proves SSO works before the login page is hidden.");
      }
      if (!(await authService.ssoProviderReady())) {
        throw new AppError(400, "Configure and enable a SAML or OIDC provider before enabling “Skip login page”.");
      }
    }
    const updated = await saveSessionSettings(input);
    await logEvent({
      action: "session_settings.updated",
      resourceType: "setting",
      resourceName: "sessionConfig",
      actor: req.session?.username ?? req.apiToken?.name,
      message: `Session settings: auto-logout ${updated.autoLogoutMinutes ? `${updated.autoLogoutMinutes} min` : "off"}, skip login page ${updated.skipLoginPage ? "on" : "off"}`,
      details: { before, after: updated },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ─── Local Login Access (source-IP scope on the local credential paths) ─────

router.get("/login-access", requireAuth, requirePermission("authentication", "read"), async (req, res, next) => {
  try {
    // callerIp reveals a trust-proxy misconfiguration before the scope is relied on.
    res.json({ loginAccess: await getLoginAccessSettings(), callerIp: req.ip ?? "" });
  } catch (err) { next(err); }
});

router.put("/login-access", adminActionLimiter, requireAuth, requirePermission("authentication", "write"), async (req, res, next) => {
  try {
    const input = LoginAccessSchema.parse(req.body ?? {});
    const before = await getLoginAccessSettings();
    // Anti-lockout: refuse a scope that excludes the admin saving it.
    const prospective = await previewLoginAccessSettings(input);
    const callerIp = req.ip ?? "";
    if (prospective.enabled && !loginSourceAllowed(callerIp, prospective)) {
      throw new AppError(
        400,
        `Your own source IP (${callerIp || "unknown"}) is outside that scope — saving it would lock you out of the local login page. ` +
          "Add a network covering it, or apply the restriction from an allowed network.",
      );
    }
    const updated = await saveLoginAccessSettings(input);
    await logEvent({
      level: updated.enabled ? "warning" : "info",
      action: "login_access.updated",
      resourceType: "setting",
      resourceName: "loginAccessConfig",
      actor: req.session?.username ?? req.apiToken?.name,
      message: updated.enabled
        ? `Local login restricted to ${describeIpScope(updated.ipScope, updated.allowedCidrs)}`
        : "Local login source-IP restriction removed",
      details: { before, after: updated },
    });
    res.json({ loginAccess: updated, callerIp });
  } catch (err) { next(err); }
});

// ─── Endpoint agent sign-in mode ────────────────────────────────────────────

router.get("/agent-mode", requireAuth, requirePermission("authentication", "read"), async (_req, res, next) => {
  try {
    res.json({ mode: await authService.getActiveAuthMode() });
  } catch (err) { next(err); }
});

router.put("/agent-mode", requireAuth, requirePermission("authentication", "write"), async (req, res, next) => {
  try {
    const { mode } = AgentModeSchema.parse(req.body);
    res.json({ ok: true, mode: await authService.setAgentAuthMode(mode, req.session?.username ?? req.apiToken?.name) });
  } catch (err) { next(err); }
});

export default router;
