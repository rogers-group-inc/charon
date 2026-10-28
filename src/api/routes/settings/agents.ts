/**
 * src/api/routes/settings/agents.ts — Server Settings agent surfaces, at
 * polaris's /server-settings/agents/* paths (ported from polaris
 * serverSettings.ts; the cert-pin rotation routes stay in webServer.ts):
 *
 *   windows-ssh            the SSH Deployment card: onboarding config, the
 *                          deployment keypair, the onboarding scripts
 *   script-publish/*       publish the Windows onboarding pair to Intune
 *   ssh-host-keys          pinned SSH host keys (TOFU, business rule 11)
 *   tls-cert-pins          pinned TLS certificates + "trust the new one"
 *   server-url             the URL a deployed agent calls back to
 *   installed(-summary)    push-deployed agents + versions vs the manifest
 *   upgrade-all            upgrade every outdated push-deployed agent
 *
 * Mounted BEFORE the blanket /server-settings gate (src/api/router.ts); every
 * route declares its own requirePermission. Routes that act on hosts or a
 * customer tenant chain a second key (polaris's chained gates).
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { adminActionLimiter } from "../../middleware/rateLimits.js";
import { AppError } from "../../../utils/errors.js";

const router = Router();

function actorOf(req: { session?: { username?: string } }): string {
  return req.session?.username ?? "unknown";
}

// ─── SSH Deployment card (onboarding) ───────────────────────────────────────

const WindowsSshConfigSchema = z.object({
  // Which OS's account fields are being saved (they are kept per OS);
  // charonServerIp is shared.
  platform: z.enum(["windows", "linux"]).optional(),
  accountMode: z.enum(["existing", "create"]).optional(),
  username: z.string().max(129).optional(),
  charonServerIp: z.string().max(64).optional(),
});

router.get("/agents/windows-ssh", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { getOnboardingState } = await import("../../../services/windowsSshOnboardingService.js");
    res.json(await getOnboardingState());
  } catch (err) { next(err); }
});

router.put("/agents/windows-ssh", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const body = WindowsSshConfigSchema.parse(req.body ?? {});
    const { saveOnboardingConfig } = await import("../../../services/windowsSshOnboardingService.js");
    res.json(await saveOnboardingConfig(body, actorOf(req)));
  } catch (err) { next(err); }
});

// Chained gate: this CREATES AND MUTATES a credential (the fleet-wide
// deployment key), so it also demands credentials:write.
router.post(
  "/agents/windows-ssh/generate",
  requirePermission("serverSettingsSystem", "write"),
  requirePermission("credentials", "write"),
  adminActionLimiter,
  async (req, res, next) => {
    try {
      const { generateKeypair } = await import("../../../services/windowsSshOnboardingService.js");
      res.json(await generateKeypair(actorOf(req)));
    } catch (err) { next(err); }
  },
);

// The script as JSON (the card previews it; the browser downloads it). 400s
// when no keypair exists yet — the fix is an action on this same card.
router.get("/agents/windows-ssh/script", requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    const kind = req.query.kind === "detection" ? "detection" : "remediation";
    const platform = req.query.platform === "linux" ? "linux" : "windows";
    const { getOnboardingScript } = await import("../../../services/windowsSshOnboardingService.js");
    res.json(await getOnboardingScript(platform, kind));
  } catch (err) { next(err); }
});

// ─── Script publishing (Intune) ─────────────────────────────────────────────

router.get("/agents/script-publish/targets", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { listPublishTargets } = await import("../../../services/intunePublishService.js");
    // `arc` stays in the shape (empty) so the ported card renders; Charon has no Azure Arc.
    res.json({ intune: await listPublishTargets(), arc: [] });
  } catch (err) { next(err); }
});

// CHAINED GATE at fullwrite: this uses stored integration credentials to create
// device-management policy in a customer tenant — a script that grants
// administrative SSH. Published policies are always left UNASSIGNED.
router.post(
  "/agents/script-publish/intune",
  requirePermission("serverSettingsSystem", "write"),
  requirePermission("integrations", "fullwrite"),
  adminActionLimiter,
  async (req, res, next) => {
    try {
      const { integrationId } = z.object({ integrationId: z.string().uuid() }).parse(req.body ?? {});
      const { publishOnboardingScripts } = await import("../../../services/intunePublishService.js");
      res.json(await publishOnboardingScripts(integrationId, actorOf(req)));
    } catch (err) { next(err); }
  },
);

// ─── Pinned server identities (business rule 11) ────────────────────────────

router.get("/agents/ssh-host-keys", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { listHostKeysWithEndpoints } = await import("../../../services/sshHostKeyService.js");
    res.json({ hostKeys: await listHostKeysWithEndpoints() });
  } catch (err) { next(err); }
});

// Forgetting a pin re-opens first-use trust for that host — audited.
router.delete("/agents/ssh-host-keys/:id", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const { deleteHostKey } = await import("../../../services/sshHostKeyService.js");
    await deleteHostKey(String(req.params.id), actorOf(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Charon keeps no archive of decommissioned hosts' pins (polaris rule 123); empty list for the ported UI.
router.get("/agents/archived-host-pins", requirePermission("serverSettingsSystem", "read"), (_req, res) => {
  res.json({ archivedPins: [] });
});

router.get("/agents/tls-cert-pins", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { listCertPinsWithUsers } = await import("../../../services/tlsCertPinService.js");
    res.json({ certPins: await listCertPinsWithUsers() });
  } catch (err) { next(err); }
});

// Trust EXACTLY the changed certificate the administrator compared: the body
// names the pending fingerprint they saw; a different one presented since is a
// 409, not a silent trust.
router.post("/agents/tls-cert-pins/:id/trust", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const fingerprint = typeof req.body?.fingerprint === "string" ? req.body.fingerprint : "";
    if (!fingerprint) throw new AppError(400, "fingerprint is required — the new certificate's SHA-256 as shown");
    const { trustPendingCert } = await import("../../../services/tlsCertPinService.js");
    res.json(await trustPendingCert(String(req.params.id), fingerprint, actorOf(req)));
  } catch (err) { next(err); }
});

router.delete("/agents/tls-cert-pins/:id", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const { deleteCertPin } = await import("../../../services/tlsCertPinService.js");
    await deleteCertPin(String(req.params.id), actorOf(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Agent server URL ───────────────────────────────────────────────────────

router.get("/agents/server-url", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { prisma } = await import("../../../db.js");
    const { inferAgentServerUrl, AGENT_SERVER_URL_SETTING_KEY } = await import("../../../services/agentDeployService.js");
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
    const override = (row?.value as { url?: string } | null)?.url ?? null;
    res.json({ override, effective: await inferAgentServerUrl() });
  } catch (err) { next(err); }
});

router.put("/agents/server-url", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().max(512).nullable() }).parse(req.body ?? {});
    const { setAgentServerUrlOverride } = await import("../../../services/agentDeployService.js");
    res.json({ effective: await setAgentServerUrlOverride(url, actorOf(req)) });
  } catch (err) { next(err); }
});

// ─── Installed agents (push deployments) ────────────────────────────────────

router.get("/agents/installed-summary", requirePermission("endpoints", "read"), async (_req, res, next) => {
  try {
    const { prisma } = await import("../../../db.js");
    const { getManifest } = await import("../../../services/agentDistService.js");
    const manifest = getManifest();
    const rows = await prisma.agentDeployment.groupBy({ by: ["status"], _count: { _all: true } });
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const outdated = manifest
      ? await prisma.agentDeployment.count({ where: { status: { in: ["active", "upgrade_failed"] }, NOT: { agentVersion: manifest.version } } })
      : 0;
    res.json({ currentVersion: manifest?.version ?? null, byStatus, outdated });
  } catch (err) { next(err); }
});

router.get("/agents/installed", requirePermission("endpoints", "read"), async (_req, res, next) => {
  try {
    const { listDeployments } = await import("../../../services/agentDeployService.js");
    res.json({ agents: await listDeployments() });
  } catch (err) { next(err); }
});

// Runs installers on every outdated host: endpoints fullwrite (rule 12) on top
// of the tab's system-settings write.
router.post(
  "/agents/upgrade-all",
  requirePermission("serverSettingsSystem", "write"),
  requirePermission("endpoints", "fullwrite"),
  adminActionLimiter,
  async (req, res, next) => {
    try {
      const { upgradeAllOutdated } = await import("../../../services/agentDeployService.js");
      res.status(202).json(await upgradeAllOutdated(actorOf(req)));
    } catch (err) { next(err); }
  },
);

export default router;
