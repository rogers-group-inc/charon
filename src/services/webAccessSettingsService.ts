/**
 * src/services/webAccessSettingsService.ts — Server Settings → Web Server:
 * the source-IP-scoped Local Login Access setting and the IPv6 switch.
 *
 * Ported from polaris loginAccessService / ipv6GateService. (Polaris's Dash
 * wallboard setting was dropped: Charon has no /dash surface.) Each is one Setting row (JSON blob) behind a short TTL
 * cache so the request-path gate (login) costs ~one DB read per 10s.
 *
 *   loginAccessConfig — { enabled, ipScope, allowedCidrs }. enabled=false (the
 *     default) means NO restriction. Enforced on charon's operator password
 *     login (POST /auth/login + /auth/login/totp — src/api/routes/auth.ts).
 *     SAML/OIDC are never restricted. The gate FAILS OPEN on a settings read
 *     error so a DB blip can never become a lockout.
 *   ipv6Config — { enabled, setBy, installHostAddresses }. Polaris uses it to
 *     gate IPv6 discovery/monitoring; charon persists it and reports the host's
 *     routable IPv6, but nothing consumes it yet.
 */

import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ipInScope, isIpScope, normalizeAllowlist, normalizeAllowlistCidr, type IpScope } from "../utils/ipScope.js";
import { logger } from "../utils/logger.js";

// ─── tiny TTL'd Setting store (polaris settingsStore pattern) ────────────────

function settingStore<T>(key: string, ttlMs: number, parse: (raw: unknown) => T) {
  let cache: { value: T; at: number } | null = null;
  return {
    async get(): Promise<T> {
      if (cache && Date.now() - cache.at < ttlMs) return cache.value;
      const row = await prisma.setting.findUnique({ where: { key } });
      const value = parse(row?.value);
      cache = { value, at: Date.now() };
      return value;
    },
    async save(value: T): Promise<T> {
      await prisma.setting.upsert({ where: { key }, create: { key, value: value as any }, update: { value: value as any } });
      cache = { value, at: Date.now() };
      return value;
    },
    invalidate(): void { cache = null; },
  };
}

// ─── shared { enabled, ipScope, allowedCidrs } shape ─────────────────────────

export interface ScopedAccessSettings {
  enabled: boolean;
  ipScope: IpScope;
  allowedCidrs: string[];
}

export function defaultScopedAccess(): ScopedAccessSettings {
  return { enabled: false, ipScope: "rfc1918", allowedCidrs: [] };
}

/** Parse a stored row; the legacy polaris shape carries `rfc1918Only`. */
export function parseScopedAccess(raw: unknown): ScopedAccessSettings {
  const fb = defaultScopedAccess();
  if (raw == null || typeof raw !== "object") return fb;
  const r = raw as Record<string, unknown>;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : fb.enabled;
  let ipScope: IpScope = fb.ipScope;
  if (isIpScope(r.ipScope) && r.ipScope !== "loopback") ipScope = r.ipScope;
  else if (typeof r.rfc1918Only === "boolean") ipScope = r.rfc1918Only ? "rfc1918" : "all";
  const allowedCidrs: string[] = [];
  if (Array.isArray(r.allowedCidrs)) {
    for (const c of r.allowedCidrs) {
      if (typeof c !== "string") continue;
      const n = normalizeAllowlistCidr(c);
      if (n && !allowedCidrs.includes(n)) allowedCidrs.push(n);
    }
  }
  return { enabled, ipScope, allowedCidrs };
}

/**
 * Merge a partial update onto the current row, validating the CIDR list.
 * `emptyCustomMessage` is what a custom scope with no networks is refused with
 * (it would block everyone).
 */
export function mergeScopedAccess(
  current: ScopedAccessSettings,
  input: Partial<ScopedAccessSettings>,
  emptyCustomMessage: string,
): ScopedAccessSettings {
  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const ipScope: IpScope = isIpScope(input.ipScope) && input.ipScope !== "loopback" ? input.ipScope : current.ipScope;
  let allowedCidrs = current.allowedCidrs;
  if (input.allowedCidrs !== undefined) {
    if (!Array.isArray(input.allowedCidrs)) throw new AppError(400, "allowedCidrs must be an array of IPv4 CIDR strings");
    const n = normalizeAllowlist(input.allowedCidrs);
    if (!n.ok) {
      throw new AppError(
        400,
        `Invalid network in the allow-list: "${n.bad}" — use IPv4 CIDR notation (e.g. 10.0.0.0/8) or a bare address (e.g. 203.0.113.5)`,
      );
    }
    allowedCidrs = n.cidrs;
  }
  if (enabled && ipScope === "custom" && allowedCidrs.length === 0) throw new AppError(400, emptyCustomMessage);
  return { enabled, ipScope, allowedCidrs };
}

// ─── Local Login Access ──────────────────────────────────────────────────────

export const LOGIN_ACCESS_SETTING_KEY = "loginAccessConfig";
const loginStore = settingStore(LOGIN_ACCESS_SETTING_KEY, 10_000, parseScopedAccess);

export async function getLoginAccessSettings(): Promise<ScopedAccessSettings> {
  return loginStore.get();
}

/** Pure decision — also used by the route's anti-lockout guard before saving. */
export function loginSourceAllowed(ip: string, s: ScopedAccessSettings): boolean {
  if (!s.enabled) return true;
  return ipInScope(ip, s.ipScope, s.allowedCidrs);
}

/** Request-path gate. FAILS OPEN on a settings read error (see header). */
export async function isLoginSourceAllowed(ip: string): Promise<boolean> {
  try {
    return loginSourceAllowed(ip, await getLoginAccessSettings());
  } catch {
    return true;
  }
}

export async function saveLoginAccessSettings(input: Partial<ScopedAccessSettings>): Promise<ScopedAccessSettings> {
  const merged = mergeScopedAccess(
    await getLoginAccessSettings(),
    input,
    "Custom source-IP scope needs at least one network — an empty list would block local login from everywhere",
  );
  return loginStore.save(merged);
}

/** What saving `input` would store — the anti-lockout check tests this. */
export async function previewLoginAccessSettings(input: Partial<ScopedAccessSettings>): Promise<ScopedAccessSettings> {
  return mergeScopedAccess(
    await getLoginAccessSettings(),
    input,
    "Custom source-IP scope needs at least one network — an empty list would block local login from everywhere",
  );
}

// ─── IPv6 switch (persist-only in charon) ────────────────────────────────────

export interface Ipv6Config {
  enabled: boolean | null;
  setBy: "install" | "operator" | null;
  installHostAddresses: string[];
}

export interface Ipv6Status {
  enabled: boolean;
  setBy: "install" | "operator" | null;
  installHostAddresses: string[];
  hostAddresses: string[];
  hasRoute: boolean;
  dialable: boolean;
}

export function parseIpv6Config(raw: unknown): Ipv6Config {
  const r = (raw ?? {}) as { enabled?: unknown; setBy?: unknown; installHostAddresses?: unknown };
  const enabled = typeof r.enabled === "boolean" ? r.enabled : null;
  const setBy = r.setBy === "install" || r.setBy === "operator" ? r.setBy : enabled === null ? null : "operator";
  const installHostAddresses = Array.isArray(r.installHostAddresses)
    ? r.installHostAddresses.filter((a): a is string => typeof a === "string")
    : [];
  return { enabled, setBy, installHostAddresses };
}

const ipv6Store = settingStore("ipv6Config", 30_000, parseIpv6Config);

/** Global-unicast IPv6 (2000::/3) or ULA (fc00::/7); never link-local/loopback. */
export function isRoutableIpv6(ip: string): boolean {
  if (isIP(ip) !== 6) return false;
  const first = parseInt((ip.split(":")[0] || "0").padStart(4, "0").slice(0, 2), 16);
  return (first & 0xe0) === 0x20 || (first & 0xfe) === 0xfc;
}

export function routableHostIpv6(ifaces: ReturnType<typeof networkInterfaces>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      const v6 = a.family === "IPv6" || (a.family as unknown) === 6;
      if (!v6 || a.internal) continue;
      const ip = a.address.split("%")[0];
      if (isRoutableIpv6(ip) && !out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

/** Can this process route global unicast IPv6? (UDP connect; nothing is sent.) */
function hasIpv6Route(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let sock: ReturnType<typeof createSocket>;
    try { sock = createSocket("udp6"); } catch { resolve(false); return; }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("error", () => finish(false));
    try { sock.connect(9, "2000::1", () => finish(true)); } catch { finish(false); }
  });
}

export async function getIpv6Status(): Promise<Ipv6Status> {
  let config: Ipv6Config;
  try {
    config = await ipv6Store.get();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ipv6 setting read failed");
    config = { enabled: null, setBy: null, installHostAddresses: [] };
  }
  const hostAddresses = routableHostIpv6(networkInterfaces());
  // Undecided (no row) → host detection answers, as polaris's install-time decision would.
  const enabled = config.enabled ?? hostAddresses.length > 0;
  const hasRoute = await hasIpv6Route();
  return {
    enabled,
    setBy: config.setBy,
    installHostAddresses: config.installHostAddresses,
    hostAddresses,
    hasRoute,
    dialable: enabled && (hostAddresses.length > 0 || hasRoute),
  };
}

export async function setIpv6Enabled(enabled: boolean): Promise<{ before: Ipv6Status; after: Ipv6Status }> {
  const before = await getIpv6Status();
  await ipv6Store.save({ enabled, setBy: "operator", installHostAddresses: before.installHostAddresses });
  const after = await getIpv6Status();
  return { before, after };
}
