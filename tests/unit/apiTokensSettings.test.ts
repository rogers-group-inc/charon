/**
 * API Tokens tab (polaris port): trusted-host normalization + matching, the
 * grant-within-caller guard, and the API documentation access scope.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.ts", () => ({ prisma: {} }));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { ipMatchesAllowlist, isRfc1918Cidr, normalizeAllowlistCidr, isLoopbackIp } from "../../src/utils/ipAllowlist.ts";
import { normalizeTrustedHosts, grantExceedsCaller, MAX_TRUSTED_HOSTS } from "../../src/services/apiTokenService.ts";
import {
  mergeApiDocsSettings,
  parseApiDocsSettings,
  docsSourceAllowed,
  defaultApiDocsSettings,
} from "../../src/services/apiDocsAccessService.ts";

describe("ipAllowlist", () => {
  it("matches bare IPv4, IPv4 CIDR, IPv6 CIDR and IPv4-mapped IPv6", () => {
    expect(ipMatchesAllowlist("10.20.5.14", ["10.20.5.14"])).toBe(true);
    expect(ipMatchesAllowlist("10.20.9.1", ["10.20.0.0/16"])).toBe(true);
    expect(ipMatchesAllowlist("::ffff:10.20.9.1", ["10.20.0.0/16"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db8::5", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowlist("10.21.0.1", ["10.20.0.0/16"])).toBe(false);
  });

  it("fails closed on a missing or garbage caller address", () => {
    expect(ipMatchesAllowlist(null, ["0.0.0.0/0"])).toBe(false);
    expect(ipMatchesAllowlist("not-an-ip", ["0.0.0.0/0"])).toBe(false);
  });

  it("classifies RFC1918 and loopback", () => {
    expect(isRfc1918Cidr("10.1.0.0/16")).toBe(true);
    expect(isRfc1918Cidr("172.16.0.0/11")).toBe(false); // wider than 172.16/12
    expect(isRfc1918Cidr("8.8.8.0/24")).toBe(false);
    expect(normalizeAllowlistCidr("192.168.5.7")).toBe("192.168.5.7/32");
    expect(normalizeAllowlistCidr("192.168.5.7/24")).toBe("192.168.5.0/24");
    expect(normalizeAllowlistCidr("fe80::/10")).toBeNull();
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
  });
});

describe("normalizeTrustedHosts", () => {
  it("trims, lowercases, zeroes IPv4 host bits and de-duplicates", () => {
    expect(normalizeTrustedHosts([" 10.1.2.5/24 ", "10.1.2.0/24", "", "2001:DB8::1"])).toEqual([
      "10.1.2.0/24",
      "2001:db8::1",
    ]);
  });

  it("empty means any source", () => {
    expect(normalizeTrustedHosts(undefined)).toEqual([]);
    expect(normalizeTrustedHosts([])).toEqual([]);
  });

  it("rejects typos and over-long lists", () => {
    expect(() => normalizeTrustedHosts(["10.1.2.300"])).toThrow(/Invalid trusted host/);
    expect(() => normalizeTrustedHosts(["10.0.0.0/33"])).toThrow(/Invalid trusted host/);
    expect(() => normalizeTrustedHosts(["host.example.com"])).toThrow(/Invalid trusted host/);
    const many = Array.from({ length: MAX_TRUSTED_HOSTS + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(() => normalizeTrustedHosts(many)).toThrow(/at most/);
  });
});

describe("grantExceedsCaller", () => {
  it("lists every key where the role outranks the caller", () => {
    const caller = { apiTokens: "write", endpoints: "read" };
    expect(grantExceedsCaller({ endpoints: "read" }, caller)).toEqual([]);
    expect(grantExceedsCaller({ endpoints: "write", users: "fullwrite" }, caller)).toEqual(["endpoints", "users"]);
  });
});

describe("API docs access", () => {
  const base = defaultApiDocsSettings();

  it("refuses public networks and empty custom scopes", () => {
    expect(() => mergeApiDocsSettings(base, { ipScope: "custom", allowedCidrs: ["8.8.8.0/24"] })).toThrow(/RFC1918/);
    expect(() => mergeApiDocsSettings(base, { ipScope: "custom", allowedCidrs: [] })).toThrow(/at least one network/);
    expect(mergeApiDocsSettings(base, { ipScope: "custom", allowedCidrs: ["10.5.0.9/16"] }).allowedCidrs).toEqual(["10.5.0.0/16"]);
  });

  it("filters smuggled public CIDRs back out on read", () => {
    const parsed = parseApiDocsSettings({ enabled: true, ipScope: "all", allowedCidrs: ["1.2.3.0/24", "10.0.0.0/8"] });
    expect(parsed.ipScope).toBe("rfc1918");
    expect(parsed.allowedCidrs).toEqual(["10.0.0.0/8"]);
  });

  it("loopback is always allowed while enabled; disabled is off for everyone", () => {
    expect(docsSourceAllowed("127.0.0.1", { enabled: true, ipScope: "loopback", allowedCidrs: [] })).toBe(true);
    expect(docsSourceAllowed("10.1.1.1", { enabled: true, ipScope: "loopback", allowedCidrs: [] })).toBe(false);
    expect(docsSourceAllowed("192.168.1.1", base)).toBe(true);
    expect(docsSourceAllowed("8.8.8.8", base)).toBe(false);
    expect(docsSourceAllowed("127.0.0.1", { ...base, enabled: false })).toBe(false);
  });
});
