/**
 * src/utils/ipAllowlist.ts — IP / CIDR validation + matching for source-address
 * allow-lists (API token trusted hosts, API documentation access scope).
 *
 * Ported from polaris (utils/cidr.ts + utils/ipAllowlist.ts), collapsed onto
 * node:net's isIP + BlockList so IPv4 and IPv6 share one matcher. All pure.
 *
 * IPv4-mapped IPv6 addresses ("::ffff:10.1.2.3", what Node reports for an IPv4
 * client on a dual-stack socket) are unwrapped to IPv4 before matching, so an
 * operator's "10.1.2.0/24" matches them.
 */

import { BlockList, isIP } from "node:net";

/** RFC1918 private IPv4 space. */
export const RFC1918_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;

/** "::ffff:10.1.2.3" → "10.1.2.3"; anything else returned trimmed + lowercased. */
export function unwrapMappedIpv4(ip: string): string {
  const s = String(ip ?? "").trim().toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  return m ? m[1] : s;
}

/** 4 or 6 for a valid bare address, 0 otherwise. */
export function ipVersion(ip: string): 0 | 4 | 6 {
  return isIP(String(ip ?? "").trim()) as 0 | 4 | 6;
}

/** True for a bare IPv4/IPv6 address or a CIDR with an in-range prefix length. */
export function isValidAllowlistEntry(entry: string): boolean {
  const s = String(entry ?? "").trim();
  if (!s) return false;
  const slash = s.indexOf("/");
  if (slash === -1) return ipVersion(s) !== 0;
  const addr = s.slice(0, slash);
  const prefixRaw = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  const v = ipVersion(addr);
  if (v === 4) return prefix >= 0 && prefix <= 32;
  if (v === 6) return prefix >= 0 && prefix <= 128;
  return false;
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0) >>> 0;
}

function intToV4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

/** Zero the host bits of an IPv4 CIDR: "10.1.2.5/24" → "10.1.2.0/24". */
export function normalizeV4Cidr(cidr: string): string {
  const [addr, p] = cidr.split("/");
  const prefix = Number(p);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToV4(v4ToInt(addr) & mask)}/${prefix}`;
}

/**
 * IPv4-only allow-list normalization used by the API docs scope: a bare
 * address becomes /32, a CIDR gets its host bits zeroed. Null on anything
 * else (including IPv6 — the docs scope is IPv4 RFC1918 by design).
 */
export function normalizeAllowlistCidr(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!s.includes("/")) return ipVersion(s) === 4 ? `${s}/32` : null;
  if (!isValidAllowlistEntry(s) || ipVersion(s.split("/")[0]) !== 4) return null;
  return normalizeV4Cidr(s);
}

/** True when an IPv4 CIDR lies entirely inside RFC1918 space. */
export function isRfc1918Cidr(cidr: string): boolean {
  const n = normalizeAllowlistCidr(cidr);
  if (!n) return false;
  const [addr, p] = n.split("/");
  const prefix = Number(p);
  const ip = v4ToInt(addr);
  return RFC1918_RANGES.some((range) => {
    const [raddr, rp] = range.split("/");
    const rprefix = Number(rp);
    if (prefix < rprefix) return false;
    const mask = (0xffffffff << (32 - rprefix)) >>> 0;
    return (ip & mask) === (v4ToInt(raddr) & mask);
  });
}

export function isLoopbackIp(ip: string): boolean {
  const s = unwrapMappedIpv4(ip);
  if (s === "::1") return true;
  return ipVersion(s) === 4 && s.startsWith("127.");
}

/**
 * Does `ip` fall inside any entry of `list` (bare addresses or CIDRs)?
 * Fails closed: an unknown/invalid caller address never matches, and invalid
 * list entries are skipped (they are refused at save time anyway).
 */
export function ipMatchesAllowlist(ip: string | null | undefined, list: readonly string[]): boolean {
  if (!ip) return false;
  const addr = unwrapMappedIpv4(ip);
  const v = ipVersion(addr);
  if (v === 0) return false;
  const bl = new BlockList();
  for (const raw of list) {
    const entry = String(raw ?? "").trim().toLowerCase();
    if (!isValidAllowlistEntry(entry)) continue;
    if (entry.includes("/")) {
      const [a, p] = entry.split("/");
      const ev = ipVersion(a);
      bl.addSubnet(a, Number(p), ev === 6 ? "ipv6" : "ipv4");
    } else {
      bl.addAddress(entry, ipVersion(entry) === 6 ? "ipv6" : "ipv4");
    }
  }
  return bl.check(addr, v === 6 ? "ipv6" : "ipv4");
}
