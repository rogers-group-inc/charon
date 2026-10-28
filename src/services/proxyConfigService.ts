/**
 * src/services/proxyConfigService.ts — the operator-settable nginx controls
 * (Server Settings → Web Server → nginx Proxy card).
 *
 * Ported from polaris (src/services/proxyConfigService.ts + types/proxyConfig.ts).
 * Single Setting row `proxyConfig`, JSON blob, short TTL cache. Consumed by
 * nginxRenderer (the {{TOKENS}} in deploy/nginx/charon.conf.template) and the
 * /server-settings/proxy routes.
 *
 * Charon adaptations:
 *   - TLS 1.3 ONLY. Charon's transport invariant is TLS 1.3 with the
 *     X25519MLKEM768 hybrid group (CLAUDE.md); TLSv1.2 cannot negotiate a
 *     hybrid PQC KEX, so validation refuses it rather than let a checkbox
 *     downgrade the edge. Defaults to ["TLSv1.3"].
 *   - managedMode defaults false exactly as polaris: an existing install's
 *     nginx config (rendered by install-rhel.sh) is never overwritten until an
 *     operator clicks "Adopt managed mode".
 *
 * Validation rules:
 *   - httpsPort: integer 1..65535
 *   - hsts.maxAgeSeconds: non-negative integer
 *   - tlsProtocols: exactly ["TLSv1.3"] (see above)
 *   - prometheusAllowIps: each entry must parse as IPv4 or IPv6
 */

import { isIP } from "node:net";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export type TlsProtocol = "TLSv1.2" | "TLSv1.3";

export interface ProxyConfigHsts {
  enabled: boolean;
  maxAgeSeconds: number;
  includeSubDomains: boolean;
  preload: boolean;
}

export interface ProxyConfig {
  httpsPort: number;
  hsts: ProxyConfigHsts;
  tlsProtocols: TlsProtocol[];
  http3Enabled: boolean;
  prometheusAllowIps: string[];
  managedMode: boolean;
  lastAppliedAt: string | null;
  lastAppliedHash: string | null;
}

export function defaultProxyConfig(): ProxyConfig {
  return {
    httpsPort: 443,
    // Matches the shipped template's header (max-age=1y; includeSubDomains).
    hsts: { enabled: true, maxAgeSeconds: 31536000, includeSubDomains: true, preload: false },
    tlsProtocols: ["TLSv1.3"],
    http3Enabled: true,
    prometheusAllowIps: [],
    managedMode: false,
    lastAppliedAt: null,
    lastAppliedHash: null,
  };
}

export const PROXY_SETTING_KEY = "proxyConfig";
const CACHE_TTL_MS = 5000;
let cache: { value: ProxyConfig; at: number } | null = null;

export function invalidateProxyConfigCache(): void {
  cache = null;
}

export async function getProxyConfig(): Promise<ProxyConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: PROXY_SETTING_KEY } });
  const value = parseProxyConfig(row?.value);
  cache = { value, at: Date.now() };
  return value;
}

export async function saveProxyConfig(input: Partial<ProxyConfig>): Promise<ProxyConfig> {
  const merged = mergeProxyConfig(await getProxyConfig(), input);
  validateProxyConfig(merged);
  await prisma.setting.upsert({
    where: { key: PROXY_SETTING_KEY },
    update: { value: merged as any },
    create: { key: PROXY_SETTING_KEY, value: merged as any },
  });
  invalidateProxyConfigCache();
  return merged;
}

// ─── parsing / merging / validation (pure — unit tested) ─────────────────────

export function parseProxyConfig(raw: unknown): ProxyConfig {
  const fb = defaultProxyConfig();
  if (raw == null || typeof raw !== "object") return fb;
  const r = raw as Record<string, unknown>;
  const h = (r.hsts && typeof r.hsts === "object" ? r.hsts : {}) as Record<string, unknown>;
  const protos = Array.isArray(r.tlsProtocols)
    ? (r.tlsProtocols.filter((v) => v === "TLSv1.2" || v === "TLSv1.3") as TlsProtocol[])
    : [];
  return {
    httpsPort: toPort(r.httpsPort, fb.httpsPort),
    hsts: {
      enabled: typeof h.enabled === "boolean" ? h.enabled : fb.hsts.enabled,
      maxAgeSeconds: toNonNegInt(h.maxAgeSeconds, fb.hsts.maxAgeSeconds),
      includeSubDomains: typeof h.includeSubDomains === "boolean" ? h.includeSubDomains : fb.hsts.includeSubDomains,
      preload: typeof h.preload === "boolean" ? h.preload : fb.hsts.preload,
    },
    tlsProtocols: protos.length > 0 ? protos : fb.tlsProtocols,
    http3Enabled: typeof r.http3Enabled === "boolean" ? r.http3Enabled : fb.http3Enabled,
    prometheusAllowIps: Array.isArray(r.prometheusAllowIps)
      ? r.prometheusAllowIps.filter((v): v is string => typeof v === "string" && isIP(v) !== 0)
      : fb.prometheusAllowIps,
    managedMode: typeof r.managedMode === "boolean" ? r.managedMode : fb.managedMode,
    lastAppliedAt: typeof r.lastAppliedAt === "string" ? r.lastAppliedAt : null,
    lastAppliedHash: typeof r.lastAppliedHash === "string" ? r.lastAppliedHash : null,
  };
}

function toPort(v: unknown, fb: number): number {
  if (v == null) return fb;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fb;
}

function toNonNegInt(v: unknown, fb: number): number {
  if (v == null) return fb;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fb;
}

export function mergeProxyConfig(current: ProxyConfig, input: Partial<ProxyConfig>): ProxyConfig {
  return {
    httpsPort: input.httpsPort ?? current.httpsPort,
    hsts: input.hsts ? { ...current.hsts, ...input.hsts } : current.hsts,
    tlsProtocols: input.tlsProtocols ?? current.tlsProtocols,
    http3Enabled: input.http3Enabled ?? current.http3Enabled,
    prometheusAllowIps: input.prometheusAllowIps ?? current.prometheusAllowIps,
    managedMode: input.managedMode ?? current.managedMode,
    lastAppliedAt: input.lastAppliedAt !== undefined ? input.lastAppliedAt : current.lastAppliedAt,
    lastAppliedHash: input.lastAppliedHash !== undefined ? input.lastAppliedHash : current.lastAppliedHash,
  };
}

export function validateProxyConfig(cfg: ProxyConfig): void {
  if (!Number.isInteger(cfg.httpsPort) || cfg.httpsPort < 1 || cfg.httpsPort > 65535) {
    throw new AppError(400, `httpsPort must be an integer between 1 and 65535 (got ${cfg.httpsPort})`);
  }
  if (typeof cfg.hsts !== "object" || cfg.hsts === null) throw new AppError(400, "hsts must be an object");
  if (!Number.isInteger(cfg.hsts.maxAgeSeconds) || cfg.hsts.maxAgeSeconds < 0) {
    throw new AppError(400, `hsts.maxAgeSeconds must be a non-negative integer (got ${cfg.hsts.maxAgeSeconds})`);
  }
  for (const k of ["enabled", "includeSubDomains", "preload"] as const) {
    if (typeof cfg.hsts[k] !== "boolean") throw new AppError(400, `hsts.${k} must be a boolean`);
  }
  if (typeof cfg.http3Enabled !== "boolean") throw new AppError(400, "http3Enabled must be a boolean");
  if (typeof cfg.managedMode !== "boolean") throw new AppError(400, "managedMode must be a boolean");
  // Each element lands unquoted in `ssl_protocols ...;` — allowlist, never count.
  if (!Array.isArray(cfg.tlsProtocols)) throw new AppError(400, "tlsProtocols must be an array");
  for (const proto of cfg.tlsProtocols as unknown[]) {
    if (proto !== "TLSv1.2" && proto !== "TLSv1.3") {
      throw new AppError(400, "tlsProtocols may only contain TLSv1.2 and TLSv1.3");
    }
  }
  if (!cfg.tlsProtocols.includes("TLSv1.3")) {
    throw new AppError(400, "tlsProtocols must include TLSv1.3");
  }
  // Charon: TLS 1.3 only (PQC-hybrid KEX invariant) — see the header.
  if (cfg.tlsProtocols.includes("TLSv1.2")) {
    throw new AppError(
      400,
      "Charon serves TLS 1.3 only — TLSv1.2 cannot negotiate the X25519MLKEM768 post-quantum hybrid key exchange. Untick TLSv1.2.",
    );
  }
  if (!Array.isArray(cfg.prometheusAllowIps)) {
    throw new AppError(400, "prometheusAllowIps must be an array of IP addresses");
  }
  for (const ip of cfg.prometheusAllowIps) {
    if (typeof ip !== "string" || isIP(ip) === 0) throw new AppError(400, `Invalid Prometheus allow IP: ${ip}`);
  }
}
