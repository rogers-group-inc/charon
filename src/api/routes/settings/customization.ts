/**
 * src/api/routes/settings/customization.ts — Server Settings: Customization tab.
 *
 * Ported from polaris (src/api/routes/serverSettings.ts and friends) to back
 * the ported public/js/server-settings-customization.js module at the exact paths public/js/settings-api.js
 * calls. Mounted WITHOUT a router-level gate (router.ts) — every route declares
 * its own requirePermission(), because a router.use() gate here would also
 * fire for every other /server-settings path that passes through this router.
 *
 *   GET    /server-settings/branding       any authenticated user (sidebar paints from it;
 *                                          polaris serves it unauthenticated)
 *   PUT    /server-settings/branding       serverSettingsSystem:write
 *   POST   /server-settings/branding/logo  serverSettingsSystem:write (multipart "file")
 *   DELETE /server-settings/branding/logo  serverSettingsSystem:write
 *   GET    /server-settings/reboot         serverSettingsSystem:read
 *   PUT    /server-settings/reboot         serverSettingsSystem:write
 */

import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { makeRateLimiter } from "../../middleware/rateLimits.js";
import { AppError } from "../../../utils/errors.js";
import { logEvent } from "../../../services/eventService.js";
import {
  BRANDING_TEXT_MAX,
  LOGO_MAX_BYTES,
  clearCustomLogo,
  getBranding,
  getPublicBranding,
  setCustomLogo,
  updateBranding,
} from "../../../services/brandingService.js";
import { getRebootSettings, saveRebootSettings } from "../../../services/rebootSettingsService.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Flags pass through normalizeBrandingFlag (polaris accepts "false"/"0" strings
// too), so they stay loose here; text is bounded.
const BrandingUpdateSchema = z.object({
  appName: z.string().max(BRANDING_TEXT_MAX).optional(),
  subtitle: z.string().max(BRANDING_TEXT_MAX).optional(),
  logoAccent: z.union([z.boolean(), z.string()]).nullable().optional(),
  logoOnLogin: z.union([z.boolean(), z.string()]).nullable().optional(),
  logoOnSidebar: z.union([z.boolean(), z.string()]).nullable().optional(),
  temperatureUnit: z.string().max(4).optional(),
});

const RebootSettingsSchema = z.object({ requireNote: z.boolean() }).strict();

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
}

// polaris maintenanceLimiter stand-in: file writes are cheap but unbounded otherwise.
const logoLimiter = makeRateLimiter({ windowMs: 60_000, max: 10, message: "Too many logo changes — try again in a minute" });
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES, files: 1 } });

const router = Router();

// ─── Branding ─────────────────────────────────────────────────────────────────

router.get("/branding", async (_req, res, next) => {
  try {
    res.json(await getBranding());
  } catch (err) {
    next(err);
  }
});

router.put("/branding", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const updated = await updateBranding(parse(BrandingUpdateSchema, req.body));
    await logEvent({
      level: "info",
      action: "branding.updated",
      resourceType: "setting",
      resourceName: "branding",
      actor: req.session?.username,
      message: `Branding updated: appName="${updated.appName}", subtitle="${updated.subtitle}", logoOnLogin=${updated.logoOnLogin}, logoOnSidebar=${updated.logoOnSidebar}`,
    });
    // Re-read rather than echo: the response must carry the derived fields
    // (customLogo, logoVersion) exactly as GET /branding does.
    res.json(await getBranding());
  } catch (err) {
    next(err);
  }
});

router.post("/branding/logo", logoLimiter, requirePermission("serverSettingsSystem", "write"), logoUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No file uploaded");
    // Type is decided by magic bytes only — never the filename or the client's
    // Content-Type — so SVG/HTML can never be stored and served from /uploads.
    const filename = await setCustomLogo(req.file.buffer);
    if (!filename) throw new AppError(400, "Unsupported image format — PNG, JPEG, or WebP required");
    await logEvent({
      level: "info",
      action: "branding.logo.updated",
      resourceType: "setting",
      resourceName: "branding",
      actor: req.session?.username,
      message: `Custom logo set (${filename})`,
    });
    res.json(await getBranding());
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(new AppError(413, "Logo is too large — 5 MB maximum"));
    }
    next(err);
  }
});

router.delete("/branding/logo", logoLimiter, requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    await clearCustomLogo();
    await logEvent({
      level: "info",
      action: "branding.logo.removed",
      resourceType: "setting",
      resourceName: "branding",
      actor: req.session?.username,
      message: "Custom logo removed — reverted to default",
    });
    res.json(await getBranding());
  } catch (err) {
    next(err);
  }
});

// ─── Reboots (polaris business rule 115(d)) ───────────────────────────────────
// Stored only in Charon — see rebootSettingsService for why nothing reads it yet.

router.get("/reboot", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    res.json({ reboot: await getRebootSettings() });
  } catch (err) {
    next(err);
  }
});

router.put("/reboot", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const body = parse(RebootSettingsSchema, req.body);
    res.json({ reboot: await saveRebootSettings(body, req.session?.username ?? "unknown") });
  } catch (err) {
    next(err);
  }
});

export default router;

/**
 * Mounted at /api/v1/branding BEFORE requireAuth (router.ts): the login page
 * reads the app name, subtitle and — when "show on login page" is on — the
 * custom logo before anyone signs in, as polaris's login page does. Returns
 * the trimmed PublicBranding view only (no app version, no sidebar flags).
 * Rate-limited because it is unauthenticated.
 */
export const publicBrandingRouter = Router();
const publicBrandingLimiter = makeRateLimiter({ windowMs: 60_000, max: 120, message: "Too many requests — try again in a minute" });

publicBrandingRouter.get("/", publicBrandingLimiter, async (_req, res, next) => {
  try {
    res.json(await getPublicBranding());
  } catch (err) {
    next(err);
  }
});
