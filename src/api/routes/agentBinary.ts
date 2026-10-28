/**
 * src/api/routes/agentBinary.ts — PUBLIC agent installer download, mounted at
 * /agents/binary (ported from polaris GET /agents/binary/:filename).
 *
 * A Windows push install fetches its installer from here over HTTPS, pinning
 * the agent certificate pins (services/agentInstallScripts.ts →
 * Invoke-CharonPinnedDownload) and checking the SHA-256 against the manifest
 * before it runs — so the route needs no session: an installer holds no
 * secret, and only files named in the agent manifest are served (no path
 * traversal: agentDistService.resolveInstaller). Rate-limited per address,
 * since a download streams tens of MB.
 */

import { basename } from "node:path";
import { Router } from "express";
import { resolveInstaller } from "../../services/agentDistService.js";
import { makeRateLimiter } from "../middleware/rateLimits.js";

export const agentBinaryLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, message: "Too many installer requests — slow down." });

const router = Router();

router.get("/:file", agentBinaryLimiter, (req, res) => {
  const p = resolveInstaller(String(req.params.file));
  if (!p) {
    res.status(404).json({ error: "Installer not found in manifest" });
    return;
  }
  // dotfiles: "allow" — `send` otherwise 404s any path with a dot-segment, and
  // an install's state directory may sit under one. The path is already the
  // manifest allowlist's (resolveInstaller), so nothing else becomes reachable.
  res.download(p, basename(p), { dotfiles: "allow" });
});

export default router;
