/**
 * src/api/routes/groups.ts — Custom group builder.
 *
 * Mounted behind requirePermission("groups", "read"); writes require "write".
 * GET /:id/members previews the resolved membership (explicit ∪ rule matches).
 */

import { Router } from "express";
import { z } from "zod";
import { listGroups, createGroup, updateGroup, deleteGroup, resolveGroupMembers } from "../../services/customGroupService.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

const conditionSchema = z.object({
  attr: z.string().min(1),
  op: z.enum(["eq", "neq", "contains", "in"]),
  value: z.union([z.string(), z.array(z.string())]),
});
const rulesSchema = z.object({ all: z.array(conditionSchema).optional(), any: z.array(conditionSchema).optional() });

router.get("/", async (_req, res, next) => {
  try { res.json({ groups: await listGroups() }); } catch (err) { next(err); }
});

router.get("/:id/members", async (req, res, next) => {
  try {
    const members = await resolveGroupMembers(String(req.params.id));
    res.json({ members: [...members], count: members.size });
  } catch (err) { next(err); }
});

router.post("/", requirePermission("groups", "write"), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1), description: z.string().optional(), members: z.array(z.string()).optional(), rules: rulesSchema.optional() }).parse(req.body);
    res.status(201).json(await createGroup(body, req.session.username));
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("groups", "write"), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().optional(), description: z.string().optional(), members: z.array(z.string()).optional(), rules: rulesSchema.optional() }).parse(req.body);
    res.json(await updateGroup(String(req.params.id), body, req.session.username));
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("groups", "write"), async (req, res, next) => {
  try { await deleteGroup(String(req.params.id), req.session.username); res.json({ ok: true }); } catch (err) { next(err); }
});

export default router;
