/**
 * src/utils/cidr.ts — the four address helpers the ported
 * credential probe / HTTP-check code needs, copied verbatim from polaris
 * src/utils/cidr.ts (Charon has no subnet/IPAM module to host the rest).
 */

import { isIP } from "node:net";
import { isValidAllowlistEntry } from "./ipAllowlist.js";

/** Return true if the given IP address (without prefix) is a valid IPv4 or IPv6 address. */
/**
 * True for an IPv4 / IPv6 CIDR with an in-range prefix length ("10.0.0.0/8").
 * polaris accepts a dotted mask too (via netmask); Charon takes the prefix form only.
 */
export function isValidCidr(cidr: string): boolean {
  // The character class refuses an IPv6 zone index ("fe80::1%eth0/64"), which
  // Node's isIP accepts — these values are written into generated scripts.
  return typeof cidr === "string" && /^[0-9A-Fa-f:.]+\/\d{1,3}$/.test(cidr) && isValidAllowlistEntry(cidr);
}

/** True for a dotted-quad IPv4 address with every octet ≤ 255 (polaris cidr.ts). */
export function isValidIpv4(ip: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  return ip.split(".").every((octet) => parseInt(octet) <= 255);
}

export function isValidIpAddress(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (ipv4Regex.test(ip)) {
    return ip.split(".").every((octet) => parseInt(octet) <= 255);
  }
  return ipv6Regex.test(ip);
}

export function isIpv6Address(ip: string | null | undefined): boolean {
  return typeof ip === "string" && isIP(ip) === 6;
}

/** A host as it must appear inside a URL: an IPv6 literal in brackets, anything else unchanged. */
export function urlHost(host: string): string {
  return isIpv6Address(host) ? `[${host}]` : host;
}

/** A URL hostname with IPv6 brackets removed — what `http.request` and pin keys take. */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
