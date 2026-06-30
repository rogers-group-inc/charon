/**
 * src/api/routes/maintenance.ts — Maintenance tab backend.
 *
 * Capacity, backup/restore/history, the in-app updater, role-aware restart, and
 * prebuilt agent-installer distribution. Gated by the "serverSettingsData" key
 * (backup/restore/updates are higher-trust than the System settings).
 */

import { Router } from "express";
import { z } from "zod";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { getCapacity } from "../../services/capacityService.js";
import { listBackups, createBackup, restoreBackup } from "../../services/backupService.js";
import { checkForUpdate, startUpdate, readStatus } from "../../services/updateService.js";
import { listInstallers, resolveInstaller } from "../../services/agentDistService.js";
import { BACKUP_DIR } from "../../utils/paths.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "../../services/eventService.js";
import { logger } from "../../utils/logger.js";

const router = Router();
router.use(requirePermission("serverSettingsData", "read"));

// ─── Capacity ─────────────────────────────────────────────────────────────────
router.get("/capacity", async (_req, res, next) => {
  try { res.json(await getCapacity()); } catch (err) { next(err); }
});

// ─── Backups ──────────────────────────────────────────────────────────────────
router.get("/backups", (_req, res, next) => {
  try { res.json({ backups: listBackups() }); } catch (err) { next(err); }
});

router.post("/backups", requirePermission("serverSettingsData", "write"), async (req, res, next) => {
  try {
    const { password } = z.object({ password: z.string().min(8).optional() }).parse(req.body);
    const info = await createBackup(password);
    await logEvent({ action: "backup.created", actor: req.session.username, message: `Created ${info.encrypted ? "encrypted " : ""}backup ${info.filename}` });
    res.json({ ok: true, backup: info });
  } catch (err) { next(err); }
});

router.get("/backups/download/:file", requirePermission("serverSettingsData", "write"), (req, res, next) => {
  try {
    const file = String(req.params.file);
    if (file.includes("/") || file.includes("..")) return res.status(400).json({ error: "Invalid filename" });
    res.download(resolve(BACKUP_DIR, file));
  } catch (err) { next(err); }
});

router.post("/backups/restore", requirePermission("serverSettingsData", "fullwrite"), async (req, res, next) => {
  try {
    const { filename, password } = z.object({ filename: z.string().min(1), password: z.string().optional() }).parse(req.body);
    if (filename.includes("/") || filename.includes("..")) throw new Error("Invalid filename");
    await restoreBackup(filename, password);
    await logEvent({ level: "warning", action: "backup.restored", actor: req.session.username, message: `Restored backup ${filename}` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── In-app updater ─────────────────────────────────────────────────────────────
router.get("/update/check", async (_req, res, next) => {
  try { res.json(await checkForUpdate()); } catch (err) { next(err); }
});

router.get("/update/status", (_req, res) => res.json(readStatus()));

router.post("/update/start", requirePermission("serverSettingsData", "fullwrite"), async (req, res, next) => {
  try {
    const { backupFirst, confirmNode } = z.object({ backupFirst: z.boolean().default(true), confirmNode: z.boolean() }).parse(req.body);
    // HA guard: require explicit acknowledgement that this node is safe to
    // update (see deploy/HA.md — update the standby first, fail over, then this).
    if (!confirmNode) throw new Error("Confirm this node is safe to update (HA: update the standby first, fail over, then this node).");
    await startUpdate({ backupFirst });
    await logEvent({ level: "warning", action: "update.started", actor: req.session.username, message: "In-app update started" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Role-aware restart ─────────────────────────────────────────────────────────
router.post("/restart", requirePermission("serverSettingsData", "fullwrite"), async (req, res, next) => {
  try {
    await logEvent({ level: "warning", action: "service.restart", actor: req.session.username, message: "Operator requested charon.target restart" });
    // Restart the whole target (web + endpoint@* + enforcer@* + worker@*), detached.
    try {
      spawn("systemd-run", ["--no-block", "systemctl", "restart", "charon.target"], { stdio: "ignore", detached: true }).unref();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "restart: systemd not available");
    }
    res.json({ ok: true, message: "Restart requested" });
  } catch (err) { next(err); }
});

// ─── Agent installer distribution ───────────────────────────────────────────────
router.get("/agents", (_req, res) => res.json(listInstallers()));

router.get("/agents/download/:file", (req, res) => {
  const p = resolveInstaller(String(req.params.file));
  if (!p) return res.status(404).json({ error: "Installer not found in manifest" });
  res.download(p);
});

export default router;
