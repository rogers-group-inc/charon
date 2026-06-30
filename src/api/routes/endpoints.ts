/**
 * src/api/routes/endpoints.ts — Operator view of enrolled agents + invitations.
 *
 * Gated by requirePermission("endpoints", "read"); revoke requires "write".
 * Invitation-code issue/list/revoke is gated by the "invitationCodes" key.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { revokeBearer } from "../../services/agentTokenService.js";
import { issueCode, listCodes, revokeCode } from "../../services/invitationCodeService.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "../../services/eventService.js";

const router = Router();

// ─── Invitation codes (mounted before /:id so "invitations" isn't an id) ─────
router.get("/invitations", requirePermission("invitationCodes", "read"), async (_req, res, next) => {
  try { res.json({ codes: await listCodes() }); } catch (err) { next(err); }
});

router.post("/invitations", requirePermission("invitationCodes", "write"), async (req, res, next) => {
  try {
    const body = z.object({ label: z.string().optional(), maxUses: z.number().int().min(1).max(10000).optional(), expiresInHours: z.number().int().min(1).max(8760).optional() }).parse(req.body);
    res.status(201).json(await issueCode(body, req.session.username ?? "operator"));
  } catch (err) { next(err); }
});

router.delete("/invitations/:id", requirePermission("invitationCodes", "write"), async (req, res, next) => {
  try { await revokeCode(String(req.params.id), req.session.username ?? "operator"); res.json({ ok: true }); } catch (err) { next(err); }
});

// ─── Endpoints ────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { status, q } = z.object({ status: z.string().optional(), q: z.string().optional() }).parse(req.query);
    const where: any = {};
    if (status) where.status = status;
    if (q) where.OR = [{ hostname: { contains: q, mode: "insensitive" } }, { boundUserName: { contains: q, mode: "insensitive" } }, { currentIp: { contains: q } }];
    const endpoints = await prisma.endpoint.findMany({
      where, orderBy: { lastSeenAt: "desc" },
      include: { tags: { include: { tag: true } } },
    });
    res.json({
      endpoints: endpoints.map((e) => ({
        id: e.id, hostname: e.hostname, status: e.status, osPlatform: e.osPlatform, osVersion: e.osVersion,
        currentIp: e.currentIp, currentMac: e.currentMac, boundUserName: e.boundUserName,
        postureState: e.postureState, lastSeenAt: e.lastSeenAt, agentVersion: e.agentVersion,
        tags: e.tags.map((t) => t.tag.name),
      })),
    });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const e = await prisma.endpoint.findUnique({ where: { id: String(req.params.id) }, include: { tags: { include: { tag: true } } } });
    if (!e) throw new AppError(404, "Endpoint not found");
    const { bearerHash, ...safe } = e as any;
    res.json({ ...safe, tags: e.tags.map((t) => ({ name: t.tag.name, reasons: t.reasons })) });
  } catch (err) { next(err); }
});

router.post("/:id/revoke", requirePermission("endpoints", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const e = await prisma.endpoint.findUnique({ where: { id } });
    if (!e) throw new AppError(404, "Endpoint not found");
    await revokeBearer(id);
    await logEvent({ action: "endpoint.revoked", resourceType: "endpoint", resourceId: id, resourceName: e.hostname ?? id, actor: req.session.username, message: `Revoked endpoint "${e.hostname ?? id}"` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
