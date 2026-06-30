/**
 * src/api/routes/policies.ts — Charon-managed FortiGate policies (charon-*).
 * Gated by requirePermission("policies", ...).
 */

import { Router } from "express";
import { z } from "zod";
import { listPolicies, createPolicy, updatePolicy, deletePolicy } from "../../services/policyService.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

const specSchema = z.object({
  srcintf: z.string().optional(),
  dstintf: z.string().optional(),
  service: z.array(z.string()).optional(),
  action: z.enum(["accept", "deny"]).optional(),
  tagRole: z.enum(["src", "dst"]).optional(),
}).optional();

router.get("/", async (_req, res, next) => {
  try { res.json({ policies: await listPolicies() }); } catch (err) { next(err); }
});

router.post("/", requirePermission("policies", "write"), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1), tagId: z.string().min(1), description: z.string().optional(), spec: specSchema }).parse(req.body);
    res.status(201).json(await createPolicy(body, req.session.username));
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("policies", "write"), async (req, res, next) => {
  try {
    const body = z.object({ description: z.string().optional(), spec: specSchema, enabled: z.boolean().optional() }).parse(req.body);
    res.json(await updatePolicy(String(req.params.id), body, req.session.username));
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("policies", "write"), async (req, res, next) => {
  try { await deletePolicy(String(req.params.id), req.session.username); res.json({ ok: true }); } catch (err) { next(err); }
});

export default router;
