/**
 * src/api/routes/authPasskeys.ts — WebAuthn passkeys for LOCAL accounts.
 * Mounted at /auth beside routes/auth.ts, before requireAuth.
 *
 *   GET  /passkeys/config            public probe: should the login page draw the button
 *   POST /passkeys/login/options     public: challenge for ANY discoverable credential
 *   POST /passkeys/login             public: verify → session (passwordless)
 *   POST /login/passkey/options      second factor, needs the "mfa" pendingAuth
 *   POST /login/passkey              second factor verify
 *   GET|POST|PATCH|DELETE /passkeys… self-service (requireSessionUser); registering
 *                                    needs the CURRENT PASSWORD (step-up)
 *   GET|PUT /passkey-settings        authentication:read / :write
 *
 * Every credential path runs the Local Login Access gate — a passkey is a
 * local credential. Ceremony state lives in utils/webauthnChallenge.ts.
 */

import { Router } from "express";
import { z } from "zod";
import * as passkeys from "../../services/passkeyService.js";
import * as authService from "../../services/authService.js";
import { requireAuth, requireSessionUser } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { passkeyCeremonyLimiter, ssoCallbackLimiter } from "../middleware/rateLimits.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { logEvent } from "../../services/eventService.js";
import { verifyPassword } from "../../utils/password.js";
import { clearLockout, isLocked, lockoutRemaining, recordFailure } from "../../utils/loginLockout.js";
import { peekPending, clearPending } from "../../utils/pendingAuth.js";
import { assertLoginSourceAllowed, ctxOf, demandPasswordChange, finishLogin } from "./auth.js";

// The assertion / attestation is validated by @simplewebauthn far more
// thoroughly than a Zod mirror could; bounded here, not described.
const AssertionSchema = z.object({ token: z.string().min(1).max(256), response: z.object({}).passthrough() });
const RegisterOptionsSchema = z.object({ currentPassword: z.string().min(1).max(1024) });
const RegisterSchema = AssertionSchema.extend({ name: z.string().max(80).optional() });
const RenameSchema = z.object({ name: z.string().min(1).max(80) });
const PasskeySettingsSchema = z.object({
  mode: z.enum(["off", "login", "second-factor", "both"]).optional(),
  rpId: z.string().max(253).optional(),
  requireUserVerification: z.boolean().optional(),
});

const router = Router();

// ─── Passwordless sign-in ───────────────────────────────────────────────────

router.get("/passkeys/config", ssoCallbackLimiter, async (req, res, next) => {
  try {
    const availability = await passkeys.getPasskeyAvailability(req);
    const anyRegistered = availability.loginEnabled ? await passkeys.anyLoginPasskeyRegistered() : false;
    res.json({ ...availability, anyRegistered });
  } catch (err) { next(err); }
});

router.post("/passkeys/login/options", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    res.json(await passkeys.startLogin(req));
  } catch (err) { next(err); }
});

router.post("/passkeys/login", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    const { token, response } = AssertionSchema.parse(req.body);
    let auth;
    try {
      auth = await passkeys.finishAuthentication({ token, response: response as never, purpose: "login" });
    } catch (err) {
      await logEvent({
        action: "auth.login.passkey_failed",
        level: "warning",
        message: "Failed passkey sign-in",
        details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, reason: (err as Error).message },
      });
      throw err;
    }
    const user = await authService.loadUserWithRole(auth.userId);
    if (!user) throw new AppError(401, "That passkey was not recognized.");
    // An assertion is not guessable: whoever holds the authenticator owns the
    // account, so it clears a lockout rather than being refused by one.
    clearLockout(user.username);
    await finishLogin(req, res, user, "passkey", `passkey "${auth.passkeyName}"`);
  } catch (err) { next(err); }
});

// ─── Passkey as the second factor ───────────────────────────────────────────

router.post("/login/passkey/options", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    const pending = peekPending(req, "mfa");
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");
    if (!pending.methods.passkey) throw new AppError(400, "This account cannot use a passkey as its second factor.");
    res.json(await passkeys.startSecondFactor(req, pending.userId));
  } catch (err) { next(err); }
});

router.post("/login/passkey", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    await assertLoginSourceAllowed(req);
    const pending = peekPending(req, "mfa");
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");
    if (!pending.methods.passkey) throw new AppError(400, "This account cannot use a passkey as its second factor.");
    const lock = isLocked(pending.username);
    if (lock.locked) throw new AppError(423, `Account temporarily locked due to too many failed attempts. Try again in ${lockoutRemaining(lock.until)}.`);
    const { token, response } = AssertionSchema.parse(req.body);
    // expectUserId binds the assertion to the account that passed the password.
    await passkeys.finishAuthentication({ token, response: response as never, purpose: "mfa", expectUserId: pending.userId });
    const user = await authService.loadUserWithRole(pending.userId);
    clearPending(req);
    if (!user) throw new AppError(401, "Session expired — please sign in again.");
    clearLockout(pending.username);
    if (pending.mustChangePassword) return demandPasswordChange(req, res, user, "passkey");
    await finishLogin(req, res, user, pending.authProvider, "local + passkey");
  } catch (err) { next(err); }
});

// ─── Self-service ───────────────────────────────────────────────────────────

router.get("/passkeys", requireSessionUser, async (req, res, next) => {
  try {
    const userId = req.session.userId!;
    const [list, availability, user] = await Promise.all([
      passkeys.listPasskeys(userId),
      passkeys.getPasskeyAvailability(req),
      prisma.user.findUnique({ where: { id: userId }, select: { authProvider: true } }),
    ]);
    res.json({ passkeys: list, availability, authProvider: user?.authProvider ?? "local" });
  } catch (err) { next(err); }
});

// STEP-UP: a stolen session must not be able to plant its own passwordless,
// second-factor-skipping way back in. A wrong password here counts against the
// same per-account lockout as a wrong password at login.
router.post("/passkeys/register/options", requireSessionUser, passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const { currentPassword } = RegisterOptionsSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { id: true, username: true, displayName: true, authProvider: true, passwordHash: true },
    });
    if (!user) throw new AppError(404, "User not found");
    if (isLocked(user.username).locked) throw new AppError(423, "Account temporarily locked due to too many failed attempts.");
    const { valid } = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      recordFailure(user.username);
      await logEvent({
        action: "auth.passkey.step_up_failed",
        level: "warning",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        actor: user.username,
        message: `Wrong password while registering a passkey for ${user.username}`,
        details: { ip: req.ip },
      });
      throw new AppError(401, "Current password is incorrect");
    }
    const { passwordHash: _hash, ...startUser } = user;
    res.json(await passkeys.startRegistration(startUser, req));
  } catch (err) { next(err); }
});

router.post("/passkeys/register", requireSessionUser, passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const { token, name, response } = RegisterSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { id: true, username: true, displayName: true, authProvider: true },
    });
    if (!user) throw new AppError(404, "User not found");
    const passkey = await passkeys.finishRegistration({ user, token, response: response as never, name: name?.trim() || "Passkey" });
    await logEvent({
      action: "user.passkey_registered",
      level: "warning",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `${user.username} registered a passkey ("${passkey.name}")`,
      details: { ...ctxOf(req), deviceType: passkey.deviceType ?? undefined },
    });
    res.status(201).json(passkey);
  } catch (err) { next(err); }
});

router.patch("/passkeys/:id", requireSessionUser, async (req, res, next) => {
  try {
    const { name } = RenameSchema.parse(req.body);
    res.json(await passkeys.renamePasskey(req.session.userId!, String(req.params.id), name));
  } catch (err) { next(err); }
});

router.delete("/passkeys/:id", requireSessionUser, async (req, res, next) => {
  try {
    const name = await passkeys.deletePasskey(req.session.userId!, String(req.params.id));
    await logEvent({
      action: "user.passkey_removed",
      level: "warning",
      resourceType: "user",
      resourceId: req.session.userId!,
      resourceName: req.session.username,
      actor: req.session.username,
      message: `${req.session.username} removed a passkey ("${name}")`,
      details: { ip: req.ip },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Passkey policy ─────────────────────────────────────────────────────────

router.get("/passkey-settings", requireAuth, requirePermission("authentication", "read"), async (req, res, next) => {
  try {
    const [settings, availability] = await Promise.all([passkeys.getPasskeySettings(), passkeys.getPasskeyAvailability(req)]);
    res.json({ settings, availability });
  } catch (err) { next(err); }
});

router.put("/passkey-settings", requireAuth, requirePermission("authentication", "write"), async (req, res, next) => {
  try {
    const input = PasskeySettingsSchema.parse(req.body ?? {});
    const before = await passkeys.getPasskeySettings();
    const updated = await passkeys.savePasskeySettings(input);
    await logEvent({
      // Off strands credentials people rely on; UV off weakens what a passkey login proves.
      level: updated.mode === "off" || !updated.requireUserVerification ? "warning" : "info",
      action: "passkey_settings.updated",
      resourceType: "setting",
      resourceName: "passkeyConfig",
      actor: req.session?.username ?? req.apiToken?.name,
      message:
        `Passkeys: mode "${updated.mode}", user verification ${updated.requireUserVerification ? "required" : "preferred"}` +
        (updated.rpId ? `, domain ${updated.rpId}` : ", domain derived from the request"),
      details: { before, after: updated },
    });
    res.json({ settings: updated, availability: await passkeys.getPasskeyAvailability(req) });
  } catch (err) { next(err); }
});

export default router;
