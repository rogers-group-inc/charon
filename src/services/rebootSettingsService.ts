/**
 * src/services/rebootSettingsService.ts — install-wide reboot settings.
 *
 * Ported from polaris src/services/rebootSettingsService.ts (business rule
 * 115(d) there: whether a device reboot must say WHY). Single Setting row
 * (`rebootConfig`), JSON blob.
 *
 * Charon note: polaris reboots MONITORED DEVICES; Charon has no device-reboot
 * feature yet, so nothing consumes this flag today. It is stored so the
 * Customization tab's Reboots card renders and saves exactly as in polaris,
 * and is ready for an endpoint-agent reboot action if one is added.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventService.js";
import { logger } from "../utils/logger.js";

export const REBOOT_SETTING_KEY = "rebootConfig";

export interface RebootSettings {
  /** true = a reboot without a note is refused. */
  requireNote: boolean;
}

export function defaultRebootSettings(): RebootSettings {
  return { requireNote: false };
}

/** Pure — exported for tests. Anything but a literal `true` reads as off. */
export function parseRebootSettings(raw: unknown): RebootSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { requireNote: r.requireNote === true };
}

/** Fallback on a read failure is "not required" (polaris). */
export async function getRebootSettings(): Promise<RebootSettings> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: REBOOT_SETTING_KEY } });
    return parseRebootSettings(row?.value);
  } catch (err) {
    logger.warn({ err }, "reboot settings: read failed — treating the note as optional");
    return defaultRebootSettings();
  }
}

export async function saveRebootSettings(next: RebootSettings, actor: string): Promise<RebootSettings> {
  const before = await getRebootSettings();
  const saved = parseRebootSettings(next);
  await prisma.setting.upsert({
    where:  { key: REBOOT_SETTING_KEY },
    update: { value: saved as any },
    create: { key: REBOOT_SETTING_KEY, value: saved as any },
  });
  if (before.requireNote !== saved.requireNote) {
    await logEvent({
      action: "setting.reboot_updated", resourceType: "setting", resourceName: REBOOT_SETTING_KEY, actor, level: "info",
      message: saved.requireNote ? "A reboot note is now required for every reboot" : "A reboot note is now optional",
      details: { before, after: saved },
    });
  }
  return saved;
}
