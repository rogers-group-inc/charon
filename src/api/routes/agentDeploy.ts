/**
 * src/api/routes/agentDeploy.ts — push deployments of the Charon agent
 * (services/agentDeployService.ts), mounted at /agent-deployments.
 *
 * Reading the list needs `endpoints` read. Every action that runs commands on
 * a host as root / Administrator with a stored credential — deploy, retry /
 * reinstall, upgrade, uninstall — needs `endpoints` FULLWRITE (business rule
 * 12): `endpoints write` already covers revoking a bearer, and installing
 * software fleet-wide is a larger blast radius than that. Each run is
 * detached; the route answers 202 and the row's status reports progress.
 */

import { Router } from "express";
import { z } from "zod";
import {
  createDeployments, listDeployments, retryDeployment, startUpgrade,
  startUninstall, deleteDeployment,
} from "../../services/agentDeployService.js";
import { requirePermission } from "../middleware/permissions.js";
import { adminActionLimiter } from "../middleware/rateLimits.js";

const TargetSchema = z.object({
  host: z.string().trim().min(1).max(253),
  osPlatform: z.enum(["windows", "linux", "darwin"]),
  directoryObjectId: z.string().uuid().nullable().optional(),
});

const CreateSchema = z.object({
  targets: z.array(TargetSchema).min(1).max(2000),
  transport: z.enum(["ssh", "winrm"]),
  credentialId: z.string().uuid(),
});

const CredentialOverrideSchema = z.object({ credentialId: z.string().uuid().optional() });

const router = Router();

function actorOf(req: { session?: { username?: string } }): string {
  return req.session?.username ?? "unknown";
}

router.get("/", async (_req, res, next) => {
  try {
    res.json({ deployments: await listDeployments() });
  } catch (err) { next(err); }
});

router.post("/", requirePermission("endpoints", "fullwrite"), adminActionLimiter, async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    res.status(202).json(await createDeployments(input, actorOf(req)));
  } catch (err) { next(err); }
});

// Retry a failed install, or reinstall over an existing one (fresh single-use code).
router.post("/:id/retry", requirePermission("endpoints", "fullwrite"), adminActionLimiter, async (req, res, next) => {
  try {
    const { credentialId } = CredentialOverrideSchema.parse(req.body ?? {});
    await retryDeployment(String(req.params.id), actorOf(req), credentialId);
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/:id/upgrade", requirePermission("endpoints", "fullwrite"), adminActionLimiter, async (req, res, next) => {
  try {
    const { credentialId } = CredentialOverrideSchema.parse(req.body ?? {});
    await startUpgrade(String(req.params.id), actorOf(req), credentialId);
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/:id/uninstall", requirePermission("endpoints", "fullwrite"), adminActionLimiter, async (req, res, next) => {
  try {
    await startUninstall(String(req.params.id), actorOf(req));
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

// Forget the record (the host's agent is untouched; use uninstall for that).
router.delete("/:id", requirePermission("endpoints", "fullwrite"), async (req, res, next) => {
  try {
    await deleteDeployment(String(req.params.id), actorOf(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
