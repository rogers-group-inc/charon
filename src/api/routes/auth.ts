/**
 * src/api/routes/auth.ts — Operator authentication routes (public).
 *
 * Session establishment for local accounts (+ TOTP). SAML/OIDC operator login
 * mounts here too once configured. GET /me returns the current session identity
 * and its effective permission matrix for the frontend to gate UI on.
 */

import { Router } from "express";
import { z } from "zod";
import { localLogin, verifyTotp, recordLogin } from "../../services/authService.js";
import { ensureSessionRoleSnapshot } from "../middleware/permissions.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { logEvent } from "../../services/eventService.js";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const result = await localLogin(username, password);
    if (result.status === "mfa_required") {
      req.session.mfaPendingUserId = result.mfaPendingUserId;
      return res.json({ mfaRequired: true });
    }
    establishSession(req, result.user!);
    await recordLogin(result.user!.id);
    await logEvent({ level: "info", action: "auth.login", actor: result.user!.username, message: `${result.user!.username} logged in (local)` });
    res.json({ ok: true, user: { username: result.user!.username, role: result.user!.role } });
  } catch (err) {
    next(err);
  }
});

const totpSchema = z.object({ code: z.string().min(1) });

router.post("/login/totp", async (req, res, next) => {
  try {
    const pendingId = req.session.mfaPendingUserId;
    if (!pendingId) throw new AppError(400, "No login in progress");
    const { code } = totpSchema.parse(req.body);
    const user = await verifyTotp(pendingId, code);
    delete req.session.mfaPendingUserId;
    establishSession(req, user);
    await recordLogin(user.id);
    await logEvent({ level: "info", action: "auth.login", actor: user.username, message: `${user.username} logged in (local + TOTP)` });
    res.json({ ok: true, user: { username: user.username, role: user.role } });
  } catch (err) {
    next(err);
  }
});

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
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    if (!user || !snap) return res.status(401).json({ error: "Not authenticated" });
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: snap.name,
      permissions: snap.permissions,
    });
  } catch (err) {
    next(err);
  }
});

function establishSession(req: import("express").Request, user: { id: string; username: string; role: string; roleId: string; snapshot: any }): void {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.roleId = user.roleId;
  req.session.roleSnapshot = user.snapshot;
  req.session.lastActivity = Date.now();
}

export default router;
