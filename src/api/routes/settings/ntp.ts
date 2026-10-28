/**
 * src/api/routes/settings/ntp.ts — Server Settings: Time & NTP tab.
 *
 * Ported from polaris (src/api/routes/serverSettings.ts and friends) to back
 * the ported public/js/server-settings-ntp.js module at the exact paths public/js/settings-api.js
 * calls. Mounted WITHOUT a router-level gate (router.ts) — every route declares
 * its own requirePermission(), because a router.use() gate here would also
 * fire for every other /server-settings path that passes through this router.
 *
 *   GET  /server-settings/ntp       serverSettingsSystem:read
 *   PUT  /server-settings/ntp       serverSettingsSystem:write  (+ chrony apply)
 *   POST /server-settings/ntp/test  serverSettingsSystem:write  (probes operator-supplied hosts)
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { AppError } from "../../../utils/errors.js";
import { logEvent } from "../../../services/eventService.js";
import {
  NTP_MAX_SERVERS,
  applyNtpToHost,
  getNtpSettings,
  isValidNtpServer,
  isValidTimezone,
  testNtpSync,
  updateNtpSettings,
} from "../../../services/ntpService.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────
// Polaris accepted any body here; Charon validates, since the servers end up in
// chrony's config on the host.

const ServerSchema = z.string().trim().min(1).max(253)
  .refine(isValidNtpServer, { message: "NTP servers must be hostnames or IP addresses" });

const NtpUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["ntp", "sntp", "nts"]).optional(),
  servers: z.array(ServerSchema).max(NTP_MAX_SERVERS).optional(),
  timezoneOverride: z.string().trim().max(64).nullable().optional()
    .refine((v) => !v || isValidTimezone(v), { message: "Unknown IANA timezone" }),
});

const NtpTestSchema = z.object({
  mode: z.enum(["ntp", "sntp", "nts"]).default("ntp"),
  servers: z.array(ServerSchema).max(NTP_MAX_SERVERS).default([]),
});

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
}

const router = Router();

router.get("/ntp", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    res.json(await getNtpSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/ntp", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const body = parse(NtpUpdateSchema, req.body);
    const saved = await updateNtpSettings({ ...body, timezoneOverride: body.timezoneOverride || null });
    const apply = await applyNtpToHost(saved);
    await logEvent({
      level: apply.applied || apply.skipped ? "info" : "warning",
      action: "setting.ntp_updated",
      resourceType: "setting",
      resourceName: "ntp",
      actor: req.session?.username,
      message: `NTP settings updated: enabled=${saved.enabled}, mode=${saved.mode}, servers=${saved.servers.length}, timezone=${saved.timezoneOverride ?? "system"} — ${apply.message}`,
      details: { settings: saved, apply },
    });
    res.json({ ...saved, apply });
  } catch (err) {
    next(err);
  }
});

// Test probes an operator-supplied host from the server — gate like the write.
router.post("/ntp/test", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    res.json(await testNtpSync(parse(NtpTestSchema, req.body)));
  } catch (err) {
    next(err);
  }
});

export default router;
