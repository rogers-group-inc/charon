/**
 * src/api/routes/tags.ts — ZTNA tag definitions + sources.
 *
 * Mounted behind requirePermission("tags", "read"); writes require "write".
 * Editing a tag/source triggers a fleet reconcile (enqueued, dry-run by default).
 */

import { Router } from "express";
import { z } from "zod";
import { listTags, createTag, updateTag, deleteTag, addSource, removeSource } from "../../services/tagService.js";
import { reconcileAll } from "../../services/tagReconciler.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try { res.json({ tags: await listTags() }); } catch (err) { next(err); }
});

router.post("/", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1), description: z.string().optional(), color: z.string().optional() }).parse(req.body);
    res.status(201).json(await createTag(body, req.session.username));
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().optional(), description: z.string().optional(), color: z.string().optional(), enabled: z.boolean().optional() }).parse(req.body);
    const tag = await updateTag(String(req.params.id), body, req.session.username);
    void reconcileAll();
    res.json(tag);
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("tags", "write"), async (req, res, next) => {
  try { await deleteTag(String(req.params.id), req.session.username); void reconcileAll(); res.json({ ok: true }); } catch (err) { next(err); }
});

const sourceSchema = z.object({
  kind: z.enum(["directory_group", "directory_ou", "custom_group", "posture"]),
  ref: z.string().optional(),
  customGroupId: z.string().optional(),
});

router.post("/:id/sources", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const body = sourceSchema.parse(req.body);
    const src = await addSource(String(req.params.id), body, req.session.username);
    void reconcileAll();
    res.status(201).json(src);
  } catch (err) { next(err); }
});

router.delete("/sources/:sourceId", requirePermission("tags", "write"), async (req, res, next) => {
  try { await removeSource(String(req.params.sourceId), req.session.username); void reconcileAll(); res.json({ ok: true }); } catch (err) { next(err); }
});

// Manual fleet reconcile (dry-run breadcrumb until enforcement is enabled).
router.post("/reconcile", requirePermission("tags", "write"), async (_req, res, next) => {
  try { res.json(await reconcileAll()); } catch (err) { next(err); }
});

export default router;
