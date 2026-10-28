/**
 * src/services/brandingService.ts — operator-customizable app identity.
 *
 * Ported from polaris src/services/brandingService.ts. Owns the `branding`
 * Setting row: app name, subtitle, logo URL and the logo placement flags. The
 * Customization tab (public/js/server-settings-customization.js) writes it via
 * src/api/routes/settings/customization.ts; app.js reads it (GET
 * /server-settings/branding) to paint the sidebar.
 *
 * Charon adaptations vs polaris:
 *   - Charon ships NO logo art — its default brand is the text "Charon" +
 *     subtitle — so the default logoUrl is "" and `customLogo` means "an upload
 *     under /uploads/ is in play".
 *   - No server-side "accent" compositing (polaris brandLogoService overlays
 *     the Polaris star with sharp). `logoAccent` is kept in the row for shape
 *     compatibility but always reads false.
 *   - `temperatureUnit` (polaris hardware-sensor display unit) is kept in the
 *     row for shape compatibility only; Charon has no sensors.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { prisma } from "../db.js";
import { UPLOADS_DIR } from "../utils/paths.js";
import { getAppVersion } from "../utils/version.js";

export type TemperatureUnit = "c" | "f";

export interface BrandingSettings {
  /** May be EMPTY — polaris semantics; consumers that must print a name use displayAppName. */
  appName: string;
  subtitle: string;
  /** "" = no custom logo (Charon default); else "/uploads/custom-logo.<ext>". */
  logoUrl: string;
  /** Not supported in Charon (no composited accent) — always false. */
  logoAccent: boolean;
  /** Show the custom logo on the login page. */
  logoOnLogin: boolean;
  /** Show the custom logo in the sidebar after login. */
  logoOnSidebar: boolean;
  temperatureUnit: TemperatureUnit;
}

export type BrandingView = BrandingSettings & { version: string; customLogo: boolean; logoVersion: string | null };

export const BRANDING_KEY = "branding";
export const LOGO_BASENAME = "custom-logo";
const LOGO_URL_PREFIX = "/uploads/";

export const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Charon",
  subtitle: "Zero Trust Network Access",
  logoUrl: "",
  logoAccent: false,
  logoOnLogin: true,
  logoOnSidebar: true,
  temperatureUnit: "c",
};

/** Max upload size for a logo (polaris: 5 MB). */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;
/** Longest name/subtitle kept. Polaris had no cap; Charon bounds stored text. */
export const BRANDING_TEXT_MAX = 100;

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

export type ImageExt = ".png" | ".jpg" | ".webp";

/**
 * Sniff an image's real format from its magic bytes (polaris utils/imageMagic).
 * Never trust a filename extension or the client's Content-Type: only PNG,
 * JPEG and WebP pass, so an SVG (scriptable) or HTML payload can never be
 * stored and served from /uploads.
 */
export function detectImageMagic(buf: Buffer): ImageExt | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return null;
}

/** Narrow an operator-supplied value to a unit code; anything else = Celsius. */
export function normalizeTemperatureUnit(value: unknown): TemperatureUnit {
  return String(value ?? "").trim().toLowerCase() === "f" ? "f" : "c";
}

/**
 * Read a stored/posted boolean flag, defaulting when it isn't present. Only
 * `undefined`/`null` mean "not stored" — a stored `false` must survive.
 */
export function normalizeBrandingFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value !== "false" && value !== "0" && value !== "";
  return Boolean(value);
}

/** Is a custom (uploaded) logo in play? Only our own fixed upload names count. */
export function hasCustomLogo(logoUrl: string | null | undefined): boolean {
  return typeof logoUrl === "string" && /^\/uploads\/custom-logo\.(png|jpg|webp)$/.test(logoUrl);
}

/** A non-empty name, for the surfaces that must print one. */
export function displayAppName(branding: { appName?: string | null }): string {
  return (branding.appName || "").trim() || BRANDING_DEFAULTS.appName;
}

/** Trim, strip control chars, cap length. */
export function cleanBrandingText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, BRANDING_TEXT_MAX);
}

/** Short cache-buster for the logo URL (polaris logoVersionStamp). */
export function logoVersionStamp(mtimeMs: number, size: number, appVersion: string): string {
  return createHash("sha256").update(`${mtimeMs}|${size}|${appVersion}`).digest("hex").slice(0, 12);
}

/** Merge a stored row over the defaults (polaris getBranding, minus I/O). */
export function parseBranding(raw: unknown): BrandingSettings {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const logoUrl = typeof saved.logoUrl === "string" && hasCustomLogo(saved.logoUrl) ? saved.logoUrl : BRANDING_DEFAULTS.logoUrl;
  return {
    // `!== undefined`, not `||`: an operator can deliberately blank the name.
    appName:  typeof saved.appName  === "string" ? saved.appName  : BRANDING_DEFAULTS.appName,
    subtitle: typeof saved.subtitle === "string" ? saved.subtitle : BRANDING_DEFAULTS.subtitle,
    logoUrl,
    logoAccent: false,
    logoOnLogin:   normalizeBrandingFlag(saved.logoOnLogin,   BRANDING_DEFAULTS.logoOnLogin),
    logoOnSidebar: normalizeBrandingFlag(saved.logoOnSidebar, BRANDING_DEFAULTS.logoOnSidebar),
    temperatureUnit: normalizeTemperatureUnit(saved.temperatureUnit),
  };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

const APP_VERSION: string = getAppVersion();

/** Absolute path of the logo file a stored logoUrl names, confined to UPLOADS_DIR. */
function logoFilePath(logoUrl: string): string | null {
  if (!hasCustomLogo(logoUrl)) return null;
  const root = resolve(UPLOADS_DIR);
  const p = resolve(root, basename(logoUrl.slice(LOGO_URL_PREFIX.length)));
  return p.startsWith(root + sep) ? p : null;
}

async function getLogoVersion(logoUrl: string): Promise<string | null> {
  const p = logoFilePath(logoUrl);
  if (!p) return null;
  try {
    const st = statSync(p);
    return logoVersionStamp(st.mtimeMs, st.size, APP_VERSION);
  } catch {
    return null;
  }
}

export async function getBranding(): Promise<BrandingView> {
  const row = await prisma.setting.findUnique({ where: { key: BRANDING_KEY } });
  const b = parseBranding(row?.value);
  return {
    ...b,
    customLogo: hasCustomLogo(b.logoUrl),
    logoVersion: await getLogoVersion(b.logoUrl),
    version: APP_VERSION,
  };
}

async function saveBrandingRow(next: BrandingSettings): Promise<void> {
  await prisma.setting.upsert({
    where:  { key: BRANDING_KEY },
    update: { value: next as any },
    create: { key: BRANDING_KEY, value: next as any },
  });
}

export interface BrandingPatch {
  appName?: string;
  subtitle?: string;
  logoOnLogin?: unknown;
  logoOnSidebar?: unknown;
  logoAccent?: unknown;
  temperatureUnit?: unknown;
}

/** PUT /branding — per-field fallback to the stored value (polaris semantics). */
export async function updateBranding(patch: BrandingPatch): Promise<BrandingSettings> {
  const current = parseBranding((await prisma.setting.findUnique({ where: { key: BRANDING_KEY } }))?.value);
  const updated: BrandingSettings = {
    appName:  cleanBrandingText(patch.appName,  current.appName),
    subtitle: cleanBrandingText(patch.subtitle, current.subtitle),
    logoUrl:  current.logoUrl,
    logoAccent: false,
    logoOnLogin:   normalizeBrandingFlag(patch.logoOnLogin,   current.logoOnLogin),
    logoOnSidebar: normalizeBrandingFlag(patch.logoOnSidebar, current.logoOnSidebar),
    temperatureUnit: normalizeTemperatureUnit(patch.temperatureUnit ?? current.temperatureUnit),
  };
  await saveBrandingRow(updated);
  return updated;
}

/** Remove every stored custom-logo file (any extension). */
function removeLogoFiles(): void {
  if (!existsSync(UPLOADS_DIR)) return;
  for (const f of readdirSync(UPLOADS_DIR)) {
    if (/^custom-logo\.(png|jpg|webp)$/.test(f)) {
      try { unlinkSync(join(UPLOADS_DIR, f)); } catch { /* best effort */ }
    }
  }
}

/**
 * POST /branding/logo — validate by magic bytes, write under a FIXED name
 * derived from the detected type, carry every other field forward.
 * Returns the stored filename, or null when the bytes are not PNG/JPEG/WebP.
 */
export async function setCustomLogo(buf: Buffer): Promise<string | null> {
  const ext = detectImageMagic(buf);
  if (!ext) return null;
  mkdirSync(UPLOADS_DIR, { recursive: true });
  removeLogoFiles(); // a previous upload of another type would otherwise linger
  const filename = `${LOGO_BASENAME}${ext}`;
  writeFileSync(join(UPLOADS_DIR, filename), buf);
  const current = parseBranding((await prisma.setting.findUnique({ where: { key: BRANDING_KEY } }))?.value);
  await saveBrandingRow({ ...current, logoUrl: `${LOGO_URL_PREFIX}${filename}` });
  return filename;
}

/** DELETE /branding/logo — drop the file, revert to the default (text) brand. */
export async function clearCustomLogo(): Promise<void> {
  removeLogoFiles();
  const current = parseBranding((await prisma.setting.findUnique({ where: { key: BRANDING_KEY } }))?.value);
  // Placement flags are kept (polaris): inert without a logo, restored on re-upload.
  await saveBrandingRow({ ...current, logoUrl: BRANDING_DEFAULTS.logoUrl });
}
