/**
 * src/api/routes/directory.ts — Read-only view of discovered directory objects.
 *
 * The mirror that custom-group rules and directory_group/OU tag sources build
 * on. Gated by requirePermission("directory", "read").
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";

const router = Router();

const querySchema = z.object({
  kind: z.enum(["user", "group", "ou"]).optional(),
  integrationId: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

router.get("/", async (req, res, next) => {
  try {
    const { kind, integrationId, q, limit } = querySchema.parse(req.query);
    const where: any = {};
    if (kind) where.kind = kind;
    if (integrationId) where.integrationId = integrationId;
    if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { identifier: { contains: q, mode: "insensitive" } }];
    const objects = await prisma.directoryObject.findMany({ where, orderBy: { name: "asc" }, take: limit });
    res.json({ objects });
  } catch (err) { next(err); }
});

export default router;
