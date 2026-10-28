/**
 * src/utils/ipScope.ts — Source-IP scope matching for operator-settable
 * allow-lists (Local Login Access, Dash wallboard).
 *
 * Ported from polaris (src/utils/ipScope.ts + the pieces of utils/cidr.ts and
 * utils/ipAllowlist.ts it leans on). Charon has no `netmask` dependency, so the
 * IPv4 CIDR math is done inline with 32-bit integers; IPv6 containment uses
 * BigInt prefix compare exactly as polaris's ipAllowlist does.
 *
 * Fail closed everywhere: an empty/unparseable candidate IP, an empty custom
 * list, or a malformed entry matches nothing. Always match `req.ip` (trust-
 * proxy resolved) — behind nginx the raw socket peer is always 127.0.0.1.
 */

import { isIP } from "node:net";

export type IpScope = "rfc1918" | "all" | "custom" | "loopback";

export function isIpScope(v: unknown): v is IpScope {
  return v === "rfc1918" || v === "all" || v === "custom" || v === "loopback";
}

/** Unwrap IPv6-mapped IPv4 (`::ffff:10.0.0.1` → `10.0.0.1`) and lowercase. */
export function normalizeIp(ip: string): string {
  let candidate = String(ip ?? "").trim().toLowerCase();
  if (candidate.startsWith("::ffff:") && candidate.includes(".")) candidate = candidate.slice(7);
  return candidate;
}

function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function maskBits(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/**
 * Canonical IPv4 CIDR for an allow-list entry, or null if it is not one.
 * A bare address is treated as /32; host bits are cleared ("10.1.2.3/8" →
 * "10.0.0.0/8"). IPv4 only, matching polaris's normalizeAllowlistCidr.
 */
export function normalizeAllowlistCidr(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const [addr, prefixStr, extra] = (s.includes("/") ? s : `${s}/32`).split("/");
  if (extra !== undefined) return null;
  if (!/^\d{1,2}$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 32) return null;
  const n = ipv4ToInt(addr);
  if (n === null) return null;
  return `${intToIpv4((n & maskBits(prefix)) >>> 0)}/${prefix}`;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(addr);
  if (a === null || b === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const m = maskBits(prefix);
  return ((a & m) >>> 0) === ((b & m) >>> 0);
}

function expandIpv6ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let s = ip;
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4 style) → two hex groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(parseInt(g || "0", 16));
  return v;
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = prefixStr === undefined ? 128 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
  const a = expandIpv6ToBigInt(ip);
  const b = expandIpv6ToBigInt(addr);
  if (a === null || b === null) return false;
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return a >> shift === b >> shift;
}

/** True when `ip` matches at least one entry (exact address or CIDR). */
export function ipMatchesAllowlist(ip: string | undefined, entries: string[]): boolean {
  if (!ip || !Array.isArray(entries) || entries.length === 0) return false;
  const candidate = normalizeIp(ip);
  const ver = isIP(candidate);
  if (ver === 0) return false;
  for (const raw of entries) {
    const entry = normalizeIp(String(raw ?? ""));
    if (!entry) continue;
    const entryAddr = entry.split("/")[0];
    const entryVer = isIP(entryAddr);
    if (entryVer !== ver) continue;
    if (ver === 4 ? ipv4InCidr(candidate, entry.includes("/") ? entry : `${entry}/32`) : ipv6InCidr(candidate, entry)) {
      return true;
    }
  }
  return false;
}

export function isLoopbackIp(ip: string): boolean {
  const c = normalizeIp(ip);
  if (isIP(c) === 4) return ipv4InCidr(c, "127.0.0.0/8");
  if (isIP(c) === 6) return ipv6InCidr(c, "::1/128");
  return false;
}

/** RFC1918 IPv4, IPv6 ULA (fc00::/7), or loopback. */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  const c = normalizeIp(ip);
  if (isLoopbackIp(c)) return true;
  if (isIP(c) === 4) return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((r) => ipv4InCidr(c, r));
  if (isIP(c) === 6) return ipv6InCidr(c, "fc00::/7");
  return false;
}

export function ipInScope(ip: string, scope: IpScope, allowedCidrs: string[]): boolean {
  if (scope === "all") return true;
  if (scope === "custom") return ipMatchesAllowlist(ip, allowedCidrs);
  if (scope === "loopback") return isLoopbackIp(ip);
  return isPrivateOrLoopbackIp(ip);
}

/** Operator-facing one-liner for audit Event messages. */
export function describeIpScope(scope: IpScope, allowedCidrs: string[]): string {
  if (scope === "all") return "ALL source IPs";
  if (scope === "custom") return `custom source IPs: ${allowedCidrs.join(", ") || "(none)"}`;
  if (scope === "loopback") return "loopback (this host) only";
  return "RFC1918 + loopback sources only";
}

/**
 * Normalize an operator-supplied allow-list (dash / login access). Throws a
 * message naming the first bad entry so typos are rejected, never silently
 * dropped into a list that matches nothing.
 */
export function normalizeAllowlist(raw: unknown[]): { ok: true; cidrs: string[] } | { ok: false; bad: string } {
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !r.trim()) continue;
    const n = normalizeAllowlistCidr(r);
    if (!n) return { ok: false, bad: r };
    if (!out.includes(n)) out.push(n);
  }
  return { ok: true, cidrs: out };
}
