/**
 * src/api/routes/serverSettings.ts — Server Settings (Certificates, HA, Auth).
 *
 * Certificates tab is the core of milestone 7: upload/rotate the nginx leaf
 * cert, view fingerprints, and surface the leaf SHA-256 as THE agent pin with
 * staged dual-pin rotation. HA tab reports leader/replication status. Auth tab
 * sets the active login mode (which also drives the agent GUI).
 *
 * Gated by requirePermission("serverSettingsSystem", ...).
 */

import { Router } from "express";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_DIR } from "../../utils/paths.js";
import { parseCert, isValidCertPem, leafPin } from "../../services/certInfo.js";
import { getPinStore, setCanonicalPin, stageNewPin, promoteStagedPin } from "../../services/certPinService.js";
import { renderAndApply } from "../../services/nginxApplyService.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "../../services/eventService.js";
import { getAppVersion } from "../../utils/version.js";

const router = Router();

const CERT_PATH = resolve(STATE_DIR, "certs", "charon.crt");
const KEY_PATH = resolve(STATE_DIR, "certs", "charon.key");

async function getSetting<T>(key: string, dflt: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T) ?? dflt;
}
async function putSetting(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value: value as any }, update: { value: value as any } });
}

// ─── Certificates ─────────────────────────────────────────────────────────────
router.get("/certificates", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const stored = await getSetting<{ pem?: string } | null>("cert.leaf", null);
    const pins = await getPinStore();
    res.json({
      current: stored?.pem ? parseCert(stored.pem) : null,
      pins,
      agentPin: pins.canonical,
      note: "The leaf SHA-256 shown here is the agent pin. Stage a new pin before rotating the cert so agents accept old+new during rollover.",
    });
  } catch (err) { next(err); }
});

const uploadSchema = z.object({ certPem: z.string().min(1), keyPem: z.string().min(1), serverName: z.string().min(1), endpointPort: z.number().int().optional(), webPort: z.number().int().optional() });

router.post("/certificates", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const body = uploadSchema.parse(req.body);
    if (!isValidCertPem(body.certPem)) throw new AppError(400, "certPem is not a valid certificate");
    const summary = parseCert(body.certPem);

    // Persist cert+key to disk (0600 key) and the cert PEM in settings for display.
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(resolve(STATE_DIR, "certs"), { recursive: true });
    writeFileSync(CERT_PATH, body.certPem, "utf-8");
    writeFileSync(KEY_PATH, body.keyPem, "utf-8");
    try { chmodSync(KEY_PATH, 0o600); } catch { /* non-POSIX */ }
    await putSetting("cert.leaf", { pem: body.certPem });

    // The leaf SHA-256 becomes the canonical agent pin.
    await setCanonicalPin(summary.sha256);

    const apply = await renderAndApply({
      serverName: body.serverName,
      webPort: body.webPort ?? 3000,
      endpointPort: body.endpointPort ?? 3001,
      certPath: CERT_PATH,
      keyPath: KEY_PATH,
    });

    await logEvent({ level: "warning", action: "cert.uploaded", actor: req.session.username, message: `Server certificate uploaded; agent pin set to ${summary.sha256Display}. nginx: ${apply.message}` });
    res.json({ ok: true, summary, agentPin: summary.sha256, nginx: { applied: apply.applied, skipped: apply.skipped, message: apply.message } });
  } catch (err) { next(err); }
});

// Stage a NEW pin ahead of a cert rotation (agents start accepting old+new).
router.post("/certificates/stage", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { certPem } = z.object({ certPem: z.string().min(1) }).parse(req.body);
    if (!isValidCertPem(certPem)) throw new AppError(400, "certPem is not a valid certificate");
    const pin = leafPin(certPem);
    await stageNewPin(pin);
    await logEvent({ action: "cert.pin.staged", actor: req.session.username, message: `Staged new agent pin ${pin}` });
    res.json({ ok: true, stagedPin: pin });
  } catch (err) { next(err); }
});

// Promote a staged pin to canonical + retire the rest (after rollover uptake).
router.post("/certificates/promote", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { pin } = z.object({ pin: z.string().min(1) }).parse(req.body);
    await promoteStagedPin(pin);
    await logEvent({ action: "cert.pin.promoted", actor: req.session.username, message: `Promoted agent pin ${pin} to canonical` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

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

// ─── Authentication mode (drives operator + agent login) ──────────────────────
router.get("/auth-mode", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const { getActiveAuthMode } = await import("../../services/authService.js");
    res.json({ mode: await getActiveAuthMode() });
  } catch (err) { next(err); }
});

router.put("/auth-mode", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { mode } = z.object({ mode: z.enum(["local", "saml", "oidc"]) }).parse(req.body);
    await putSetting("auth.mode", { mode });
    await logEvent({ action: "auth.mode.changed", actor: req.session.username, message: `Active auth mode set to ${mode}` });
    res.json({ ok: true, mode });
  } catch (err) { next(err); }
});

// ─── Identification / version ──────────────────────────────────────────────────
router.get("/identification", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    res.json({ version: getAppVersion(), name: await getSetting("identification.name", "Charon") });
  } catch (err) { next(err); }
});

export default router;
