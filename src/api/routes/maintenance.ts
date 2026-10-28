/**
 * src/api/routes/maintenance.ts — prebuilt agent-installer distribution.
 *
 * Mounted at /server-settings/maintenance. Capacity, backup/restore/history,
 * the in-app updater and restart moved to the polaris-shaped routes in
 * src/api/routes/settings/maintenance.ts (Server Settings → Maintenance tab);
 * what remains is the Charon-only installer listing/download. Unlike polaris
 * (which builds its Go agent on the server), Charon's Tauri installers are
 * built in CI and dropped under data/agents/<version>/ with a manifest
 * (services/agentDistService.ts) — so there is no on-server Build card.
 */

import { Router } from "express";
import { listInstallers, resolveInstaller } from "../../services/agentDistService.js";
import { requirePermission } from "../middleware/permissions.js";
import { makeRateLimiter } from "../middleware/rateLimits.js";

// Both routes read the installer directory, and a download streams a file of
// tens of MB — cap a runaway script or stolen session per address.
export const installerLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, message: "Too many installer requests — slow down." });

const router = Router();
router.use(requirePermission("serverSettingsData", "read"));

router.get("/agents", installerLimiter, (_req, res) => res.json(listInstallers()));

router.get("/agents/download/:file", installerLimiter, (req, res) => {
  const p = resolveInstaller(String(req.params.file));
  if (!p) return res.status(404).json({ error: "Installer not found in manifest" });
  res.download(p);
});

export default router;
