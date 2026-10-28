/**
 * src/api/routes/settings/ha.ts — Server Settings: High Availability tab.
 *
 * Ported from polaris (src/api/routes/ha.ts) to back
 * public/js/server-settings-ha.js at the exact paths public/js/settings-api.js
 * calls, mapped onto charon's HA model (deploy/HA.md: PostgreSQL streaming
 * replication via deploy/setup-ha.sh + advisory-lock leader election).
 * Mounted WITHOUT a router-level gate — every route declares its own
 * requirePermission().
 *
 * Two routers, because two very different callers reach this feature:
 *
 *   haRouter        an operator with a session (mounted at /api/v1/ha). Reads
 *                   need serverSettingsSystem=read; everything that changes
 *                   the cluster config, mints a token or approves a node needs
 *                   serverSettingsSystem=FULLWRITE (charon: replication is high
 *                   blast radius — polaris used write) and logs an Event.
 *
 *   haEnrollRouter  a node being built, with no session and no bearer. It
 *                   presents a single-use token in the body, is rate limited,
 *                   and MUST be mounted at /api/v1/ha/enroll ABOVE requireAuth
 *                   in router.ts (the /agents/enroll precedent). CSRF is
 *                   exempted for exactly that path in csrf.ts.
 *
 * The unauthenticated surface is deliberately tiny: register, poll, download
 * once. It cannot enumerate anything, and every rejection of a token returns
 * the same text.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { adminActionLimiter, makeRateLimiter } from "../../middleware/rateLimits.js";
import { AppError } from "../../../utils/errors.js";
import { logEvent } from "../../../services/eventService.js";
import {
  getHaConfig,
  redactHaConfig,
  computeAdvisories,
  getClusterStatus,
  enableHa,
  disableHa,
  detectLocalAddresses,
  type HaRole,
} from "../../../services/haService.js";
import {
  mintNodeToken,
  renderNodeScriptForServer,
  renderTeardownScript,
  listEnrollments,
  approveEnrollment,
  rejectEnrollment,
  registerEnrollment,
  pollEnrollment,
  claimBundle,
} from "../../../services/haEnrollmentService.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

// These values are interpolated into generated shell scripts, so the character
// sets are part of the safety contract, not just validation.
const AddrSchema = z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9._:-]+$/, "must be an IP address or a hostname");
const NameSchema = z.string().trim().min(1).max(63).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  "must start with a letter or digit and contain only letters, digits, dots, dashes or underscores",
);
const NodeInputSchema = z.object({
  name: NameSchema,
  clusterAddr: AddrSchema,
  // Polaris's etcd-certificate SANs have no charon meaning; accepted and ignored.
  extraSans: z.array(AddrSchema).max(8).optional(),
  reachPrimaryVia: AddrSchema.optional(),
});
const GslbSchema = z.object({
  monitorIntervalSec: z.number().int().min(1).max(300).optional(),
  monitorRetries: z.number().int().min(1).max(10).optional(),
  dnsTtlSec: z.number().int().min(0).max(3600).optional(),
});
const EnableSchema = z.object({
  primary: NodeInputSchema,
  standby: NodeInputSchema,
  gslb: GslbSchema.optional(),
});
const ProbeSchema = z.object({
  standbyAddr: AddrSchema.optional(),
  gslb: GslbSchema.optional(),
});
const RoleSchema = z.enum(["primary", "standby"]);
const TokenSchema = z.object({ role: RoleSchema });

const RegisterSchema = z.object({
  token: z.string().min(1).max(128),
  nodeName: z.string().trim().max(255).optional(),
  // Fingerprints as ssh-keygen -lf prints them (SHA256:base64).
  sshHostKeyFingerprints: z.array(z.string().trim().max(128).regex(/^[A-Za-z0-9+/=:]+$/)).max(8).optional(),
});

function actorOf(req: Request): string {
  return req.session?.username || (req.apiToken ? `api:${req.apiToken.name}` : "unknown");
}

// ─── Operator router ────────────────────────────────────────────────────────

/**
 * Default export: mounted at /server-settings by router.ts. Empty — the HA tab
 * lives entirely under /api/v1/ha (charon's older GET /server-settings/ha in
 * serverSettings.ts is left in place).
 */
const router = Router();
export default router;

/** Mounted at /api/v1/ha (polaris path). */
export const haRouter = Router();

/** Everything the tab renders: config, live cluster, enrollments, local addresses. */
haRouter.get("/status", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const cfg = await getHaConfig();
    const [cluster, enrollments] = await Promise.all([getClusterStatus(cfg), listEnrollments()]);
    res.json({ config: redactHaConfig(cfg), cluster, enrollments, localAddresses: detectLocalAddresses() });
  } catch (err) {
    next(err);
  }
});

/** The guidance card's figures. Separate because it probes the network. */
haRouter.post("/advisories", requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    const body = ProbeSchema.parse(req.body ?? {});
    res.json({ advisories: await computeAdvisories(body) });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/enable", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const body = EnableSchema.parse(req.body);
    const cfg = await enableHa(body, actorOf(req));
    await logEvent({
      action: "ha.enabled",
      resourceType: "setting",
      resourceId: "ha.config",
      actor: actorOf(req),
      level: "warning",
      message: `High availability enabled — primary ${body.primary.name} (${body.primary.clusterAddr}), standby ${body.standby.name} (${body.standby.clusterAddr})`,
      details: { primary: body.primary.name, standby: body.standby.name },
    });
    res.json({ config: redactHaConfig(cfg) });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/disable", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const cfg = await disableHa(actorOf(req));
    await logEvent({
      action: "ha.disabled",
      resourceType: "setting",
      resourceId: "ha.config",
      actor: actorOf(req),
      level: "warning",
      message: "High availability disabled in configuration — replication is untouched; run the teardown script on the node to keep",
    });
    res.json({ config: redactHaConfig(cfg) });
  } catch (err) {
    next(err);
  }
});

/**
 * Mint a token and return the bootstrap script in one call — the raw token
 * exists only in this response; storing it for a later download would defeat
 * hashing it.
 */
haRouter.post("/tokens", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { role } = TokenSchema.parse(req.body);
    const minted = await mintNodeToken(role as HaRole, actorOf(req));
    const script = await renderNodeScriptForServer(role as HaRole, minted.token);
    await logEvent({
      action: "ha.token_minted",
      resourceType: "setting",
      resourceId: "ha.config",
      actor: actorOf(req),
      level: "warning",
      message: `HA bootstrap script generated for the ${role} node (${minted.nodeName})`,
      details: { role, nodeName: minted.nodeName, enrollmentId: minted.id, expiresAt: minted.expiresAt.toISOString() },
    });
    res.json({
      enrollmentId: minted.id,
      role,
      nodeName: minted.nodeName,
      expiresAt: minted.expiresAt,
      filename: script.filename,
      script: script.script,
    });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/enrollments/:id/approve", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const row = await approveEnrollment(id, actorOf(req));
    await logEvent({
      action: "ha.enrollment_approved",
      resourceType: "setting",
      resourceId: "ha.config",
      actor: actorOf(req),
      level: "warning",
      message: `HA ${row.role} node approved (registered from ${row.registeredFromIp ?? "an unknown address"}) — its bundle may now be downloaded once`,
      details: { enrollmentId: id, role: row.role, registeredFromIp: row.registeredFromIp },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/enrollments/:id/reject", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const row = await rejectEnrollment(id, actorOf(req));
    await logEvent({
      action: "ha.enrollment_rejected",
      resourceType: "setting",
      resourceId: "ha.config",
      actor: actorOf(req),
      level: "warning",
      message: `HA ${row.role} node rejected`,
      details: { enrollmentId: id, role: row.role, registeredFromIp: row.registeredFromIp },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** The teardown script. Returned as JSON so one route feeds preview and download. */
haRouter.get("/teardown-script", requirePermission("serverSettingsSystem", "fullwrite"), async (_req, res, next) => {
  try {
    res.json(renderTeardownScript());
  } catch (err) {
    next(err);
  }
});

// ─── Node router (unauthenticated) ──────────────────────────────────────────

/**
 * A node registers once then polls every 5 s for up to 30 minutes, so the
 * ceiling allows a full wait plus retries while still bounding token guessing.
 */
const haEnrollLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 400,
  message: "Too many enrollment requests. Please try again shortly.",
});

/** Mount at /api/v1/ha/enroll ABOVE requireAuth (router.ts). */
export const haEnrollRouter = Router();
haEnrollRouter.use(haEnrollLimiter);

/** Spend the token, record a pending request, return the poll handle. */
haEnrollRouter.post("/", async (req, res, next) => {
  try {
    const body = RegisterSchema.parse(req.body);
    const sourceIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const { requestId, role } = await registerEnrollment({
      token: body.token,
      nodeName: body.nodeName ?? "",
      sshHostKeyFingerprints: body.sshHostKeyFingerprints ?? [],
      sourceIp,
    });
    await logEvent({
      action: "ha.enrollment_pending",
      resourceType: "setting",
      resourceId: "ha.config",
      actor: `ha-node:${sourceIp ?? "unknown"}`,
      level: "warning",
      message: `An HA ${role} node registered from ${sourceIp ?? "an unknown address"} and is awaiting approval`,
      details: { role, nodeName: body.nodeName ?? null, sourceIp },
    });
    res.json({ requestId });
  } catch (err) {
    next(err);
  }
});

/** Poll for approval, or (`?download=1`) download the bundle once approved. */
haEnrollRouter.get("/:requestId", async (req, res, next) => {
  try {
    const requestId = String(req.params.requestId);
    if (!/^[0-9a-f]{64}$/.test(requestId)) throw new AppError(404, "Unknown enrollment request");
    res.setHeader("Cache-Control", "no-store");
    if (req.query.download === "1") {
      const sourceIp = (req.ip || req.socket.remoteAddress || null) ?? null;
      const { bundle, filename, role } = await claimBundle(requestId, sourceIp);
      await logEvent({
        action: "ha.node_enrolled",
        resourceType: "setting",
        resourceId: "ha.config",
        actor: `ha-node:${sourceIp ?? "unknown"}`,
        level: "warning",
        message: `The HA ${role} node bundle was delivered to ${sourceIp ?? "an unknown address"}`,
        details: { role, filename, sourceIp },
      });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(bundle);
    }
    res.json(await pollEnrollment(requestId));
  } catch (err) {
    next(err);
  }
});
