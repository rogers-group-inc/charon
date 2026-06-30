/**
 * src/api/routes/integrations.ts — Integration CRUD + test + discovery.
 *
 * Mounted behind requirePermission("integrations", "read"); writes require
 * "write". Secrets are masked on read and preserved-on-unchanged on write by
 * the service layer. Discovery is read-only (populates the DirectoryObject
 * mirror). Enforcement enable/disable lives on a separate guarded route
 * (milestone 6) gated by the "enforcement" function key — flipping a firewall
 * to live writes is higher blast radius than editing an integration.
 */

import { Router } from "express";
import { z } from "zod";
import {
  listIntegrations, getIntegration, createIntegration, updateIntegration,
  deleteIntegration, testIntegration, preflightTest, discoverDirectory,
  INTEGRATION_TYPES,
} from "../../services/integrationService.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

router.get("/types", (_req, res) => res.json({ types: INTEGRATION_TYPES }));

router.get("/", async (_req, res, next) => {
  try {
    res.json({ integrations: await listIntegrations() });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await getIntegration(String(req.params.id)));
  } catch (err) { next(err); }
});

const createSchema = z.object({
  type: z.enum(INTEGRATION_TYPES as unknown as [string, ...string[]]),
  name: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().optional(),
});

router.post("/", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    res.status(201).json(await createIntegration(input, req.session.username));
  } catch (err) { next(err); }
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  autoDiscover: z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(24).optional(),
});

router.put("/:id", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const input = updateSchema.parse(req.body);
    res.json(await updateIntegration(String(req.params.id), input, req.session.username));
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    await deleteIntegration(String(req.params.id), req.session.username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Test a SAVED integration's stored credentials.
router.post("/:id/test", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    res.json(await testIntegration(String(req.params.id)));
  } catch (err) { next(err); }
});

// Preflight test of an UNSAVED config (the configure modal's Test button).
const preflightSchema = z.object({
  type: z.enum(INTEGRATION_TYPES as unknown as [string, ...string[]]),
  config: z.record(z.unknown()),
  existingId: z.string().optional(),
});

router.post("/test", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const { type, config, existingId } = preflightSchema.parse(req.body);
    res.json(await preflightTest(type, config, existingId));
  } catch (err) { next(err); }
});

// Read-only directory discovery (AD / Entra).
router.post("/:id/discover", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    res.json(await discoverDirectory(String(req.params.id)));
  } catch (err) { next(err); }
});

export default router;
