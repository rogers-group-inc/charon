/**
 * src/services/apiDocsAccessService.ts — Source-IP restriction on the API
 * DOCUMENTATION page (Server Settings → API Tokens → API Documentation Access).
 *
 * Ported from polaris. Single Setting row (`apiDocsConfig`), JSON blob. Three
 * postures — loopback / rfc1918 / custom — and deliberately NO "all": the page
 * is never offered to public networks, which is why a custom entry outside
 * RFC1918 space is refused at save time AND filtered back out on read (a
 * hand-edited Setting row must not smuggle one in). Loopback is always allowed
 * while enabled; `enabled: false` drops the page for everyone.
 *
 * Charon adaptation: charon does not (yet) serve an unauthenticated /api docs
 * page, so this setting is persisted and `isApiDocsSourceAllowed` is ready for
 * the gate that will front it, but nothing enforces it today. No settingsStore
 * cache in charon — reads go straight to the Setting row.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  RFC1918_RANGES,
  ipMatchesAllowlist,
  isLoopbackIp,
  isRfc1918Cidr,
  normalizeAllowlistCidr,
} from "../utils/ipAllowlist.js";

export const API_DOCS_SETTING_KEY = "apiDocsConfig";

export type ApiDocsIpScope = "loopback" | "rfc1918" | "custom";

function isApiDocsIpScope(v: unknown): v is ApiDocsIpScope {
  return v === "loopback" || v === "rfc1918" || v === "custom";
}

export interface ApiDocsSettings {
  enabled: boolean;
  ipScope: ApiDocsIpScope;
  allowedCidrs: string[];
}

export function defaultApiDocsSettings(): ApiDocsSettings {
  return { enabled: true, ipScope: "rfc1918", allowedCidrs: [] };
}

export function parseApiDocsSettings(raw: unknown): ApiDocsSettings {
  const fallback = defaultApiDocsSettings();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : fallback.enabled;
  const ipScope: ApiDocsIpScope = isApiDocsIpScope(r.ipScope) ? r.ipScope : fallback.ipScope;
  const allowedCidrs: string[] = [];
  if (Array.isArray(r.allowedCidrs)) {
    for (const c of r.allowedCidrs) {
      if (typeof c !== "string") continue;
      const n = normalizeAllowlistCidr(c);
      if (n && isRfc1918Cidr(n) && !allowedCidrs.includes(n)) allowedCidrs.push(n);
    }
  }
  return { enabled, ipScope, allowedCidrs };
}

export async function getApiDocsSettings(): Promise<ApiDocsSettings> {
  const row = await prisma.setting.findUnique({ where: { key: API_DOCS_SETTING_KEY } });
  return parseApiDocsSettings(row?.value);
}

/** Pure decision — also the route's "would your own address still see the docs?" warning. */
export function docsSourceAllowed(ip: string, settings: ApiDocsSettings): boolean {
  if (!settings.enabled) return false;
  if (isLoopbackIp(ip)) return true;
  if (settings.ipScope === "loopback") return false;
  if (settings.ipScope === "rfc1918") return ipMatchesAllowlist(ip, RFC1918_RANGES);
  return ipMatchesAllowlist(ip, settings.allowedCidrs);
}

/** Gate helper for the request path. FAILS CLOSED — it fronts an unauthenticated surface. */
export async function isApiDocsSourceAllowed(ip: string): Promise<boolean> {
  try {
    return docsSourceAllowed(ip, await getApiDocsSettings());
  } catch {
    return false;
  }
}

/** Merge + validate a partial update against the current settings (pure). */
export function mergeApiDocsSettings(current: ApiDocsSettings, input: Partial<ApiDocsSettings>): ApiDocsSettings {
  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const ipScope: ApiDocsIpScope = isApiDocsIpScope(input.ipScope) ? input.ipScope : current.ipScope;

  let allowedCidrs = current.allowedCidrs;
  if (input.allowedCidrs !== undefined) {
    if (!Array.isArray(input.allowedCidrs)) {
      throw new AppError(400, "allowedCidrs must be an array of IPv4 CIDR strings");
    }
    const normalized: string[] = [];
    for (const raw of input.allowedCidrs) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const n = normalizeAllowlistCidr(raw);
      if (!n) {
        throw new AppError(
          400,
          `Invalid network in the allow-list: "${raw}" — use IPv4 CIDR notation (e.g. 10.0.0.0/8) or a bare address (e.g. 10.20.30.40)`,
        );
      }
      if (!isRfc1918Cidr(n)) {
        throw new AppError(
          400,
          `Network "${raw}" is outside RFC1918 private space (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) — ` +
            "the API documentation page can only be scoped to private networks. " +
            "Loopback is always allowed and does not need an entry.",
        );
      }
      if (!normalized.includes(n)) normalized.push(n);
    }
    allowedCidrs = normalized;
  }

  // An enabled custom scope with no networks would serve loopback only while
  // READING as "custom" — almost certainly a half-built form.
  if (enabled && ipScope === "custom" && allowedCidrs.length === 0) {
    throw new AppError(
      400,
      "Custom source-IP scope needs at least one network — pick 'Loopback only' if that is the intent",
    );
  }
  return { enabled, ipScope, allowedCidrs };
}

export async function saveApiDocsSettings(input: Partial<ApiDocsSettings>): Promise<ApiDocsSettings> {
  const next = mergeApiDocsSettings(await getApiDocsSettings(), input);
  await prisma.setting.upsert({
    where: { key: API_DOCS_SETTING_KEY },
    create: { key: API_DOCS_SETTING_KEY, value: next as any },
    update: { value: next as any },
  });
  return next;
}

export function describeIpScope(scope: ApiDocsIpScope, cidrs: string[]): string {
  if (scope === "loopback") return "loopback only";
  if (scope === "rfc1918") return "RFC1918 private networks + loopback";
  return `${cidrs.join(", ")} + loopback`;
}
