/**
 * src/api/routes/serverSettings.ts — Server Settings (HA, Identification).
 *
 * HA tab reports leader/replication status. The agent sign-in mode moved to
 * Users → Authentication (routes/auth.ts → /auth/agent-mode). The original Certificates routes
 * (/certificates, /certificates/stage, /certificates/promote) moved to
 * routes/settings/webServer.ts — the polaris Web Server tab's dual-pin
 * Rotate flow (preflight → stage → swap → retire) replaces them.
 *
 * Gated by requirePermission("serverSettingsSystem", ...).
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { requirePermission } from "../middleware/permissions.js";
import { getAppVersion } from "../../utils/version.js";

const router = Router();

async function getSetting<T>(key: string, dflt: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T) ?? dflt;
}

// ─── High Availability status ────────────────────────────────────────────────
router.get("/ha", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { isLeader } = await import("../../services/leaderElection.js");
    // Replication status (best-effort) — primary exposes pg_stat_replication.
    let replication: any[] = [];
    try {
      replication = await prisma.$queryRawUnsafe(
        "SELECT client_addr::text AS client, state, sync_state, (pg_current_wal_lsn() - replay_lsn) AS lag_bytes FROM pg_stat_replication",
      );
    } catch { /* standby / no perms */ }
    res.json({ isLeader: isLeader(), publicUrl: process.env.CHARON_PUBLIC_URL ?? null, replication });
  } catch (err) { next(err); }
});

// ─── Identification / version ──────────────────────────────────────────────────
router.get("/identification", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    res.json({ version: getAppVersion(), name: await getSetting("identification.name", "Charon") });
  } catch (err) { next(err); }
});

export default router;
