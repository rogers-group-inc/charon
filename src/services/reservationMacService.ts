/**
 * src/services/reservationMacService.ts — the install-wide placeholder-MAC prefix.
 *
 * Ported from polaris (services/reservationMacService.ts + the placeholder half
 * of utils/mac.ts). In polaris it is the OUI every MAC generated for a
 * not-yet-racked device's DHCP reservation begins with, and the ONLY thing
 * marking such a MAC as synthetic. Charon has no DHCP-reservation flow yet, so
 * the setting is stored + validated exactly as polaris does and is ready for a
 * consumer; nothing reads it today.
 *
 * Single Setting row ("reservationMacPlaceholder"), JSON blob. Charon
 * adaptation: polaris's TTL-cached createSettingStore is replaced by a direct
 * read — this is read once per settings-page load, never on a hot path.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventService.js";
import { AppError } from "../utils/errors.js";

export const RESERVATION_MAC_PLACEHOLDER_KEY = "reservationMacPlaceholder";

/** Locally administered (bit 1) + unicast (bit 0 clear) — never a vendor OUI. */
export const DEFAULT_PLACEHOLDER_MAC_PREFIX = "02:0F:5E";

/** Longest prefix we accept — a 6-octet "prefix" would be a single MAC. */
const MAX_PLACEHOLDER_PREFIX_OCTETS = 5;

export interface ReservationMacPlaceholderSettings {
  prefix: string;
}

/**
 * Normalize an operator-typed placeholder prefix to colon-separated UPPERCASE,
 * or null when it isn't usable. Accepts any separator (or none): "020f5e",
 * "02-0f-5e" and "02:0F:5E" all normalize identically.
 *
 * Rejects a prefix whose first octet is NOT locally-administered unicast:
 * pointing this at a real vendor OUI would make that vendor's genuine MACs
 * look like placeholders. Strings only — a JSON number must not slip through
 * as accidental hex.
 */
export function normalizePlaceholderPrefix(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const octets = hex.length / 2;
  if (octets > MAX_PLACEHOLDER_PREFIX_OCTETS) return null;
  const first = parseInt(hex.slice(0, 2), 16);
  // bit 1 = locally administered, bit 0 = multicast.
  if ((first & 0x02) !== 0x02 || (first & 0x01) !== 0) return null;
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Self-healing read: a stored value that no longer normalizes falls back to
 * the default rather than propagating an unusable prefix.
 */
export function normalizeReservationMacSettings(raw: unknown): ReservationMacPlaceholderSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return { prefix: normalizePlaceholderPrefix(obj.prefix) ?? DEFAULT_PLACEHOLDER_MAC_PREFIX };
}

export async function getReservationMacSettings(): Promise<ReservationMacPlaceholderSettings> {
  const row = await prisma.setting.findUnique({ where: { key: RESERVATION_MAC_PLACEHOLDER_KEY } });
  return normalizeReservationMacSettings(row?.value);
}

/**
 * Persist a new prefix. Unlike the read path, an unusable value is REJECTED
 * here rather than silently defaulted — an operator typing a vendor OUI needs
 * to hear why it can't be used.
 */
export async function saveReservationMacSettings(
  input: { prefix?: unknown },
  actor?: string,
): Promise<ReservationMacPlaceholderSettings> {
  const current = await getReservationMacSettings();
  if (input.prefix === undefined) return current;

  const prefix = normalizePlaceholderPrefix(input.prefix);
  if (!prefix) {
    throw new AppError(
      400,
      "Placeholder MAC prefix must be 1–5 hex octets whose first octet is locally administered and unicast " +
        "(e.g. 02, 06, 0A, 0E…). A globally administered prefix is rejected because it could match a real " +
        "device's factory MAC, which discovery would then be free to overwrite.",
    );
  }

  if (prefix === current.prefix) return current;

  const saved: ReservationMacPlaceholderSettings = { prefix };
  await prisma.setting.upsert({
    where: { key: RESERVATION_MAC_PLACEHOLDER_KEY },
    update: { value: { ...saved } },
    create: { key: RESERVATION_MAC_PLACEHOLDER_KEY, value: { ...saved } },
  });

  await logEvent({
    level: "info",
    action: "reservation.mac_placeholder.updated",
    resourceType: "setting",
    resourceName: RESERVATION_MAC_PLACEHOLDER_KEY,
    message: `Placeholder MAC prefix changed from ${current.prefix} to ${saved.prefix}`,
    actor: actor || "system",
    details: { previousPrefix: current.prefix, prefix: saved.prefix },
  });

  return saved;
}
