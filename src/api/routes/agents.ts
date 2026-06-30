/**
 * src/api/routes/agents.ts — Endpoint-agent protocol surface.
 *
 * Two routers (mounted in router.ts BEFORE the session/requireAuth gate):
 *   agentsEnrollRouter  — POST /enroll: public, authenticated by the one-time
 *                         invitation code in the body. Swaps it for a bearer.
 *   agentsRouter        — everything else, guarded by requireAgentBearer:
 *       POST /heartbeat — liveness + current IP/MAC; marks the endpoint online
 *       POST /posture   — posture blob → PostureState; reconcile on change
 *       GET  /config    — cert pins + active auth mode (agent self-config)
 *       POST /login     — bind {user ↔ device ↔ IP} after the dictated flow
 *       POST /logout    — clear the binding; reconcile
 *
 * Agents are programmatic clients with NO browser session — CSRF-exempt; the
 * bearer (or, for /enroll, the invitation code) is the auth.
 */

import { Router } from "express";
import { z } from "zod";
import { enroll } from "../../services/agentEnrollmentService.js";
import { ingestPosture } from "../../services/postureService.js";
import { getAgentCertPins } from "../../services/certPinService.js";
import { getActiveAuthMode, localLogin } from "../../services/authService.js";
import { bindVerification, clearBinding } from "../../services/verificationService.js";
import { requireAgentBearer } from "../middleware/auth.js";
import { prisma } from "../../db.js";
import { enqueueReconcile } from "../../jobs/tagReconcileJob.js";
import { AppError } from "../../utils/errors.js";

// ─── Public: enrollment ──────────────────────────────────────────────────────
export const agentsEnrollRouter = Router();

const enrollSchema = z.object({
  code: z.string().min(1),
  hostname: z.string().optional(),
  osPlatform: z.string().optional(),
  osVersion: z.string().optional(),
  arch: z.string().optional(),
  agentVersion: z.string().optional(),
});

agentsEnrollRouter.post("/", async (req, res, next) => {
  try {
    const input = enrollSchema.parse(req.body);
    const ip = (req.ip || req.socket.remoteAddress || null) ?? null;
    const result = await enroll(input, ip);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ─── Bearer-guarded: telemetry + control ─────────────────────────────────────
export const agentsRouter = Router();
agentsRouter.use(requireAgentBearer);

agentsRouter.post("/heartbeat", async (req, res, next) => {
  try {
    const body = z.object({ ip: z.string().optional(), mac: z.string().optional(), hostname: z.string().optional() }).parse(req.body);
    const ip = body.ip ?? (req.ip || req.socket.remoteAddress || undefined);
    await prisma.endpoint.update({
      where: { id: req.agent!.endpointId },
      data: { status: "online", lastSeenAt: new Date(), lastSeenIp: ip ?? null, currentIp: ip ?? undefined, currentMac: body.mac ?? undefined, hostname: body.hostname ?? undefined },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

agentsRouter.post("/posture", async (req, res, next) => {
  try {
    const body = z.object({ posture: z.record(z.unknown()) }).parse(req.body);
    const { state, changed } = await ingestPosture(req.agent!.endpointId, body.posture);
    if (changed) await enqueueReconcile(req.agent!.endpointId);
    res.json({ ok: true, postureState: state });
  } catch (err) { next(err); }
});

agentsRouter.get("/config", async (req, res, next) => {
  try {
    const [pins, mode] = await Promise.all([getAgentCertPins(), getActiveAuthMode()]);
    res.json({ serverCertPins: pins, authMode: mode, heartbeatIntervalSec: 60 });
  } catch (err) { next(err); }
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().optional(),
  // SAML/OIDC paths complete in the browser and bind via a separate callback;
  // local mode posts credentials here.
});

agentsRouter.post("/login", async (req, res, next) => {
  try {
    const mode = await getActiveAuthMode();
    if (mode !== "local") {
      throw new AppError(400, `Active auth mode is "${mode}" — complete the browser flow; this endpoint accepts local credentials only`);
    }
    const { username, password } = loginSchema.parse(req.body);
    if (!password) throw new AppError(400, "Password required for local login");
    const result = await localLogin(username, password);
    if (result.status === "mfa_required") return res.json({ mfaRequired: true });
    const ip = (req.ip || req.socket.remoteAddress || null) ?? null;
    await bindVerification(req.agent!.endpointId, { userKey: username, userName: result.user!.displayName ?? username, ip, mode });
    await enqueueReconcile(req.agent!.endpointId);
    res.json({ ok: true, user: username });
  } catch (err) { next(err); }
});

agentsRouter.post("/logout", async (req, res, next) => {
  try {
    await clearBinding(req.agent!.endpointId);
    await enqueueReconcile(req.agent!.endpointId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default agentsRouter;
