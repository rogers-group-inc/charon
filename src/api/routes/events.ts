/**
 * src/api/routes/events.ts — Audit log read surface.
 *
 * Demonstrates the gated-route pattern: mounted behind
 * requirePermission("events", "read") in router.ts. Returns a paginated,
 * newest-first slice of the Event table.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";

const router = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().optional(),
  level: z.enum(["info", "warning", "error"]).optional(),
});

router.get("/", async (req, res, next) => {
  try {
    const { limit, offset, action, level } = querySchema.parse(req.query);
    const where = {
      ...(action ? { action } : {}),
      ...(level ? { level } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.event.findMany({ where, orderBy: { timestamp: "desc" }, take: limit, skip: offset }),
      prisma.event.count({ where }),
    ]);
    res.json({ events: rows, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

export default router;
