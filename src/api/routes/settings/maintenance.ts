/**
 * src/api/routes/settings/maintenance.ts — Server Settings: Maintenance + Retention tabs.
 *
 * Ported from polaris (src/api/routes/serverSettings.ts and friends) to back
 * the ported public/js/server-settings-maintenance.js module at the exact paths
 * public/js/settings-api.js calls. Mounted WITHOUT a router-level gate
 * (router.ts) — every route declares its own requirePermission(), because a
 * router.use() gate here would also fire for every other /server-settings path
 * that passes through this router.
 *
 * Gates (polaris → Charon keys):
 *   database / capacity-advisor / platform-lifecycle / pg-tuning / queue-mode
 *     reads ............................... serverSettingsSystem read
 *   capacity-advisor/stage (.env) ......... serverSettingsSystem write
 *   agent-event-log write ................. serverSettingsSystem write
 *   backups, schedule, updates, retention,
 *     security tokens reads/writes ........ serverSettingsData read / write
 *   restore, apply update, restart,
 *     backup-schedule (holds a passphrase) serverSettingsData fullwrite
 * Every mutation writes an audit Event.
 */

import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { requirePermission } from "../../middleware/permissions.js";
import { adminActionLimiter, makeRateLimiter } from "../../middleware/rateLimits.js";
import { logEvent } from "../../../services/eventService.js";
import { AppError } from "../../../utils/errors.js";
import { validateBackupPassword } from "../../../utils/backupPassword.js";
import { setEnvVar } from "../../../utils/envFile.js";
import { runtimeIsContainer, hasSystemd, getDbConnectionMode } from "../../../utils/deploymentContext.js";
import {
  createBackup, restoreBackup, listBackups, deleteBackup, backupFilePath, getBackupRecord, getBackupToolingStatus,
} from "../../../services/backupService.js";
import {
  getBackupScheduleMasked, saveBackupSchedule, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, MIN_RETAIN, MAX_RETAIN,
} from "../../../services/backupScheduleService.js";
import { getDatabaseInfo } from "../../../services/dbSizeService.js";
import { getCapacitySnapshot, prismaPoolSize, pgbossPoolSize } from "../../../services/capacityService.js";
import { computeAdvisor, stageAdvisorState, estimateProcessCount } from "../../../services/capacityAdvisorService.js";
import { computePgTuning } from "../../../services/pgTuningService.js";
import { getPlatformLifecycle } from "../../../services/platformLifecycleService.js";
import { getSampleRetention, updateSampleRetention } from "../../../services/sampleRetentionService.js";
import { getAgentEventLogConfig, updateAgentEventLogConfig } from "../../../services/agentEventLogService.js";
import {
  initUpdateStatus, checkForUpdates, getUpdateStatus, getUpdateActivity, getUpdateRepoInfo, applyUpdate,
  clearUpdateStatus, getUpdateTrain, setUpdateTrain, getSkipBackup, setSkipBackup, getRecentCommits,
  isUpdateMechanismAvailable, detectHaPair, restartService,
} from "../../../services/updateService.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const BackupScheduleSchema = z.object({
  enabled:       z.boolean().optional(),
  intervalHours: z.number().int().min(MIN_INTERVAL_HOURS).max(MAX_INTERVAL_HOURS).optional(),
  hourUtc:       z.number().int().min(0).max(23).nullable().optional(),
  retainCount:   z.number().int().min(MIN_RETAIN).max(MAX_RETAIN).optional(),
  passphrase:    z.string().max(512).nullable().optional(),
  copyToDir:     z.string().max(1024).nullable().optional(),
});
const BackupIdParam = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const PlatformLifecycleQuery = z.object({ refresh: z.coerce.boolean().optional() }).strict();
const QueueModeBody = z.object({ mode: z.enum(["cursor", "pgboss"]) });
const StageBody = z.object({ keys: z.array(z.string().max(64)).min(1).max(20) });
const SecurityTokenBody = z.object({ which: z.enum(["metrics", "health"]) });
const UpdateApplyBody = z.object({
  password: z.string().max(512).optional(),
  allowWithoutBackup: z.boolean().optional(),
  confirmNode: z.boolean().optional(),
}).optional();
const UpdateSettingsBody = z.object({ skipBackup: z.boolean().optional(), train: z.enum(["nightly", "release"]).optional() });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });
const AgentEventLogBody = z.object({
  enabled: z.boolean().optional(),
  minLevel: z.enum(["info", "warning", "error"]).optional(),
  windowsChannels: z.array(z.string()).max(64).optional(),
  linuxMinPriority: z.number().optional(),
  maxPerPush: z.number().optional(),
  perAssetHourlyCap: z.number().optional(),
});
const SampleRetentionBody = z.record(z.string(), z.unknown());

// Heavy endpoints (pg_dump, catalog scans): polaris's maintenanceLimiter.
const maintenanceLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, message: "Too many maintenance requests — slow down." });

const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, _file, cb) => cb(null, `charon-restore-upload-${Date.now()}-${randomBytes(4).toString("hex")}`),
  }),
});

function actor(req: Request): string | undefined {
  return req.session?.username ?? ((req as any).apiToken?.name ? `token:${(req as any).apiToken.name}` : undefined);
}

const router = Router();

// Detect a post-update restart (status "restarting" on disk → "complete").
initUpdateStatus();

// ─── Database ───────────────────────────────────────────────────────────────

router.get("/database", requirePermission("serverSettingsSystem", "read"), maintenanceLimiter, async (_req, res, next) => {
  try { res.json(await getDatabaseInfo()); } catch (err) { next(err); }
});

// ─── Backup / restore ───────────────────────────────────────────────────────
// Backups are DATABASE ONLY (pg_dump), exactly as in polaris: files under the
// state dir — firmware images (data/firmware) and branding uploads
// (public/uploads) — are not included and must be backed up with the host.

router.post("/database/backup", requirePermission("serverSettingsData", "write"), maintenanceLimiter, async (req, res, next) => {
  try {
    let password: string | null;
    try { password = validateBackupPassword(req.body?.password); } catch (e: any) { throw new AppError(400, e?.message || "Invalid backup password"); }
    const { record, path } = await createBackup({ password, kind: "manual", actor: actor(req) });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${record.filename}"`);
    res.setHeader("Content-Length", String(record.size));
    createReadStream(path).pipe(res);
  } catch (err) { next(err); }
});

router.post("/database/restore", adminActionLimiter, requirePermission("serverSettingsData", "fullwrite"), maintenanceLimiter, restoreUpload.single("file"), async (req, res, next) => {
  // multer names the temp file; require containment under tmpdir() before touching it.
  const raw: string | undefined = (req.file as any)?.path;
  const uploadedPath = raw && resolve(raw).startsWith(tmpdir() + sep) ? resolve(raw) : undefined;
  try {
    if (!req.file || !uploadedPath) throw new AppError(400, "No backup file uploaded");
    const password = typeof req.body?.password === "string" && req.body.password.length > 0 ? req.body.password : null;
    await restoreBackup({ filePath: uploadedPath, password });
    await logEvent({
      level: "warning",
      action: "server.backup.restored",
      resourceType: "backup",
      resourceName: req.file.originalname,
      actor: actor(req),
      message: `Database restored from uploaded backup: ${req.file.originalname}`,
    });
    res.json({
      ok: true,
      message: "Database restored successfully. Restart Charon now so every process picks up the restored schema.",
      restartRequired: true,
    });
  } catch (err) {
    next(err);
  } finally {
    if (uploadedPath) { try { unlinkSync(uploadedPath); } catch { /* best effort */ } }
  }
});

router.get("/database/backups", requirePermission("serverSettingsData", "read"), maintenanceLimiter, async (_req, res, next) => {
  try { res.json(await listBackups()); } catch (err) { next(err); }
});

router.get("/database/backup-tooling", requirePermission("serverSettingsData", "read"), maintenanceLimiter, async (_req, res, next) => {
  try { res.json(await getBackupToolingStatus()); } catch (err) { next(err); }
});

router.get("/database/backup-schedule", requirePermission("serverSettingsData", "read"), async (_req, res, next) => {
  try { res.json(await getBackupScheduleMasked()); } catch (err) { next(err); }
});

router.put("/database/backup-schedule", requirePermission("serverSettingsData", "fullwrite"), async (req, res, next) => {
  try {
    const input = BackupScheduleSchema.parse(req.body);
    const before = await getBackupScheduleMasked();
    const saved = await saveBackupSchedule(input);
    const pick = (s: typeof before) => ({ enabled: s.enabled, intervalHours: s.intervalHours, hourUtc: s.hourUtc, retainCount: s.retainCount, copyToDir: s.copyToDir, encrypted: !!s.passphrase });
    await logEvent({
      action: "server.backup.schedule_updated",
      resourceType: "setting",
      resourceName: "backupSchedule",
      actor: actor(req),
      message: saved.enabled
        ? `Scheduled backups enabled: every ${saved.intervalHours}h, keeping ${saved.retainCount}${saved.copyToDir ? `, copied to ${saved.copyToDir}` : ""}`
        : "Scheduled backups disabled",
      details: { before: pick(before), after: pick(saved) },
    });
    res.json(await getBackupScheduleMasked());
  } catch (err) { next(err); }
});

router.delete("/database/backups/:id", requirePermission("serverSettingsData", "write"), maintenanceLimiter, async (req, res, next) => {
  try {
    await deleteBackup(BackupIdParam.parse(String(req.params.id)), actor(req));
    res.status(204).send();
  } catch (err) { next(err); }
});

// Download is the whole database leaving the host — write tier, like backup.
router.get("/database/backups/:id/download", requirePermission("serverSettingsData", "write"), maintenanceLimiter, async (req, res, next) => {
  try {
    const id = BackupIdParam.parse(String(req.params.id));
    const filePath = backupFilePath(id);
    if (!filePath) throw new AppError(400, "Invalid backup id");
    const record = await getBackupRecord(id);
    if (!record) throw new AppError(404, "Backup not found");
    if (!existsSync(filePath)) throw new AppError(404, "Backup file no longer exists on disk");
    await logEvent({ action: "server.backup.downloaded", resourceType: "backup", resourceId: id, resourceName: record.filename, actor: actor(req), message: `Database backup downloaded: ${record.filename}` });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${record.filename}"`);
    res.setHeader("Content-Length", String(statSync(filePath).size));
    createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
});

// ─── Capacity / advisor / lifecycle ────────────────────────────────────────

async function buildAdvisorBundle() {
  const tuning = await computePgTuning().catch(() => null);
  const capacity0 = await getCapacitySnapshot({ pgTuningNeeded: tuning?.pgTuningNeeded ?? false });
  const advisor = computeAdvisor({
    endpointCount: capacity0.workload.endpointCount,
    prismaPoolSize: prismaPoolSize(),
    pgbossPoolSize: pgbossPoolSize(),
    maxConnections: capacity0.database.connectionPool.maxConnections,
    processCount: estimateProcessCount(),
    pgTuning: tuning,
  });
  const maxRec = advisor.recommendations.find((r) => r.key === "PG_MAX_CONNECTIONS");
  // Re-grade with the advisor's max_connections recommendation folded in.
  const capacity = await getCapacitySnapshot({
    pgTuningNeeded: tuning?.pgTuningNeeded ?? false,
    recommendedMaxConnections: typeof maxRec?.recommended === "number" ? maxRec.recommended : null,
  });
  return { tuning, capacity, advisor };
}

router.get("/capacity-advisor", requirePermission("serverSettingsSystem", "read"), maintenanceLimiter, async (_req, res, next) => {
  try {
    const { tuning, capacity, advisor } = await buildAdvisorBundle();
    res.json({
      advisor,
      capacity,
      // Charon records no capacity transitions (no capacityWatch job / alert hold).
      capacityTransition: null,
      pgTuning: { settings: tuning?.settings ?? [], pgConfigFile: tuning?.pgConfigFile ?? null },
      dbConnectionMode: getDbConnectionMode(),
      runtimeIsContainer: runtimeIsContainer(),
    });
  } catch (err) { next(err); }
});

router.post("/capacity-advisor/stage", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const { keys } = StageBody.parse(req.body);
    const { advisor } = await buildAdvisorBundle(); // fresh — never write a stale value
    const receipt = await stageAdvisorState(keys, advisor);
    const applied = receipt.results.filter((r) => r.status === "applied");
    const errored = receipt.results.filter((r) => r.status === "error");
    if (applied.length > 0) {
      await logEvent({
        action: "capacity_advisor.staged",
        resourceType: "system",
        actor: actor(req),
        message: `Capacity Advisor staged ${applied.length} value${applied.length === 1 ? "" : "s"} to .env (restart required)`,
        details: { staged: applied.map((r) => ({ key: r.key, old: r.oldValue, new: r.newValue })) },
      });
    }
    if (errored.length > 0) {
      await logEvent({
        level: "warning",
        action: "capacity_advisor.stage_failed",
        resourceType: "system",
        actor: actor(req),
        message: `Capacity Advisor: ${errored.length} stage operation${errored.length === 1 ? "" : "s"} failed`,
        details: { errors: errored.map((r) => ({ key: r.key, reason: r.reason })) },
      });
    }
    res.json(receipt);
  } catch (err) { next(err); }
});

router.get("/platform-lifecycle", requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    const q = PlatformLifecycleQuery.parse(req.query);
    res.json(await getPlatformLifecycle({ force: q.refresh === true }));
  } catch (err) { next(err); }
});

router.get("/pg-tuning", requirePermission("serverSettingsSystem", "read"), maintenanceLimiter, async (_req, res, next) => {
  try {
    const tuning = await computePgTuning();
    const capacity = await getCapacitySnapshot({ pgTuningNeeded: tuning?.pgTuningNeeded ?? false });
    res.json({ settings: tuning?.settings ?? [], pgConfigFile: tuning?.pgConfigFile ?? null, capacity });
  } catch (err) { next(err); }
});

// Charon always runs pg-boss — there is no cursor mode to flip to.
router.get("/queue-mode", requirePermission("serverSettingsSystem", "read"), (_req, res) => {
  res.json({ active: "pgboss", persisted: "pgboss", restartRequired: false, pgbossInstalled: true });
});

router.post("/queue-mode", requirePermission("serverSettingsData", "write"), (req, res, next) => {
  try {
    const { mode } = QueueModeBody.parse(req.body);
    if (mode !== "pgboss") throw new AppError(409, "Charon always uses the pg-boss queue; cursor mode does not exist here.");
    res.json({ ok: true, persisted: "pgboss", active: "pgboss", restartRequired: false });
  } catch (err) { next(err); }
});

// ─── Bearer tokens for /metrics and /health ────────────────────────────────
// Writes a fresh 32-byte hex value into .env and stamps process.env so the
// gate takes effect in THIS process immediately; other role processes pick it
// up on their next restart (they read .env at start).
router.post("/security-tokens/generate", requirePermission("serverSettingsData", "write"), async (req, res, next) => {
  try {
    const { which } = SecurityTokenBody.parse(req.body);
    const key = which === "metrics" ? "METRICS_TOKEN" : "HEALTH_TOKEN";
    const value = randomBytes(32).toString("hex");
    try { setEnvVar(key, value); } catch (e: any) { throw new AppError(500, `Could not write ${key} to .env: ${e?.message ?? e}`); }
    process.env[key] = value;
    await logEvent({
      action: "server.security_token.generated",
      resourceType: "setting",
      resourceName: key,
      actor: actor(req),
      message: `Bearer token generated for ${which === "metrics" ? "/metrics" : "/health"}`,
    });
    res.json({ ok: true, key });
  } catch (err) { next(err); }
});

// ─── Restart ────────────────────────────────────────────────────────────────
// Restarts the whole charon.target via systemd. Refused (409) in a container —
// the operator restarts the container from the host — and on a host without
// systemd (dev), where nothing would bring the process back.
router.post("/restart", adminActionLimiter, requirePermission("serverSettingsData", "fullwrite"), async (req, res, next) => {
  try {
    if (runtimeIsContainer()) {
      throw new AppError(409, "Charon runs in a container and does not restart itself. Restart the Charon container(s) from your container host to apply.");
    }
    if (!hasSystemd()) {
      throw new AppError(409, "In-app restart is not available in this deployment (no systemd) — restart the Charon processes manually.");
    }
    await logEvent({
      level: "warning",
      action: "server.restart.requested",
      resourceType: "server",
      actor: actor(req),
      message: `Operator-triggered restart of charon.target by ${actor(req) ?? "(unknown)"}`,
    });
    res.json({ ok: true, message: "Restarting..." });
    setTimeout(() => {
      try { restartService(); } catch { /* logged by systemd */ }
    }, 500);
  } catch (err) { next(err); }
});

// ─── Application updates ───────────────────────────────────────────────────

router.get("/updates/check", requirePermission("serverSettingsData", "read"), async (_req, res, next) => {
  try { res.json(await checkForUpdates()); } catch (err) { next(err); }
});

router.get("/updates/status", requirePermission("serverSettingsData", "read"), (_req, res) => {
  res.json(getUpdateStatus());
});

// Auth-only (no permission key): every signed-in user is told an update is
// restarting the app under them; the redacted shape carries no detail.
router.get("/updates/activity", (_req, res) => {
  res.json(getUpdateActivity());
});

router.get("/updates/repo", requirePermission("serverSettingsData", "read"), async (_req, res, next) => {
  try { res.json(await getUpdateRepoInfo()); } catch (err) { next(err); }
});

router.post("/updates/apply", adminActionLimiter, requirePermission("serverSettingsData", "fullwrite"), async (req, res, next) => {
  try {
    const body = UpdateApplyBody.parse(req.body) ?? {};
    if (!isUpdateMechanismAvailable()) throw new AppError(409, "In-app updates are disabled in this deployment.");
    const status = getUpdateStatus();
    if (status.state === "applying" || status.state === "restarting") throw new AppError(409, "An update is already in progress");
    // HA guard (deploy/HA.md): in a replication pair, update the standby first,
    // fail over, then this node — the operator must say this node is safe.
    if ((await detectHaPair()) && body.confirmNode !== true) {
      throw new AppError(409, "This node is part of an HA pair. Confirm it is safe to update (update the standby first, fail over, then this node).");
    }
    const allowWithoutBackup = body.allowWithoutBackup === true;
    if (allowWithoutBackup) {
      await logEvent({
        level: "warning",
        action: "server.update.backup_override",
        resourceType: "setting",
        actor: actor(req),
        message: "Update started with 'proceed without a backup' confirmed — a failed pre-update backup will not abort the update",
      });
    }
    await applyUpdate(body.password && body.password.length > 0 ? body.password : null, allowWithoutBackup, actor(req));
    res.json({ started: true, message: "Update started — poll /updates/status for progress" });
  } catch (err) { next(err); }
});

router.post("/updates/dismiss", requirePermission("serverSettingsData", "write"), async (req, res, next) => {
  try {
    const prev = getUpdateStatus();
    clearUpdateStatus();
    if (prev.state === "failed" || prev.state === "complete") {
      await logEvent({
        action: "server.update.dismissed",
        resourceType: "server",
        actor: actor(req),
        message: `Update status dismissed (was: ${prev.state}${prev.error ? ` — ${prev.error.slice(0, 200)}` : ""})`,
        details: { state: prev.state, error: prev.error ?? null, startedAt: prev.startedAt ?? null, completedAt: prev.completedAt ?? null },
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/updates/settings", requirePermission("serverSettingsData", "read"), async (_req, res, next) => {
  try { res.json({ skipBackup: await getSkipBackup(), train: await getUpdateTrain() }); } catch (err) { next(err); }
});

// Either/both keys; only the ones present change.
router.put("/updates/settings", requirePermission("serverSettingsData", "write"), async (req, res, next) => {
  try {
    const body = UpdateSettingsBody.parse(req.body ?? {});
    if (body.skipBackup !== undefined) {
      await setSkipBackup(body.skipBackup);
      await logEvent({
        level: body.skipBackup ? "warning" : "info",
        action: "update.settings.changed",
        resourceType: "setting",
        resourceName: "update.skip_backup",
        actor: actor(req),
        message: `Pre-update backup ${body.skipBackup ? "DISABLED — updates will apply without a safety backup" : "enabled"}`,
        details: { skipBackup: body.skipBackup },
      });
    }
    if (body.train !== undefined) {
      await setUpdateTrain(body.train);
      await logEvent({
        action: "update.settings.changed",
        resourceType: "setting",
        resourceName: "update.train",
        actor: actor(req),
        message: `Update train set to "${body.train}" (${body.train === "release" ? "published releases only" : "latest commits"})`,
        details: { train: body.train },
      });
    }
    res.json({ skipBackup: await getSkipBackup(), train: await getUpdateTrain() });
  } catch (err) { next(err); }
});

router.get("/updates/history", requirePermission("serverSettingsData", "read"), async (req, res, next) => {
  try {
    const { limit } = HistoryQuery.parse(req.query);
    res.json(await getRecentCommits(limit ?? 20));
  } catch (err) { next(err); }
});

// ─── Retention tab ─────────────────────────────────────────────────────────

router.get("/sample-retention", requirePermission("serverSettingsData", "read"), async (_req, res, next) => {
  try { res.json({ retention: await getSampleRetention() }); } catch (err) { next(err); }
});

router.put("/sample-retention", requirePermission("serverSettingsData", "write"), async (req, res, next) => {
  try {
    const before = await getSampleRetention();
    const updated = await updateSampleRetention(SampleRetentionBody.parse(req.body ?? {}));
    await logEvent({
      action: "sample_retention.updated",
      resourceType: "setting",
      resourceName: "sampleRetention",
      actor: actor(req),
      message: `Retention updated (audit events ${updated.events.days}d, verification sessions ${updated.verificationSessions.days}d)`,
      details: { before, after: updated },
    });
    res.json({ retention: updated });
  } catch (err) { next(err); }
});

router.get("/agent-event-log", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try { res.json({ config: await getAgentEventLogConfig() }); } catch (err) { next(err); }
});

router.put("/agent-event-log", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const updated = await updateAgentEventLogConfig(AgentEventLogBody.parse(req.body ?? {}));
    await logEvent({
      action: "agent_event_log.updated",
      resourceType: "setting",
      resourceName: "agentEventLog",
      actor: actor(req),
      message: `Agent OS event-log collection ${updated.enabled ? "enabled" : "disabled"} (min level: ${updated.minLevel})`,
      details: { config: updated },
    });
    res.json({ config: updated });
  } catch (err) { next(err); }
});

export default router;
