/**
 * tests/unit/webServerSettings.test.ts — pure logic behind Server Settings →
 * Web Server: source-IP scopes, nginx proxy-config validation + rendering, the
 * dual-pin store transforms, and cert/key pair checks.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/db.ts", () => ({ prisma: {} }));

import {
  normalizeAllowlistCidr,
  ipMatchesAllowlist,
  ipInScope,
  isPrivateOrLoopbackIp,
} from "../../src/utils/ipScope.ts";
import {
  defaultProxyConfig,
  mergeProxyConfig,
  parseProxyConfig,
  validateProxyConfig,
} from "../../src/services/proxyConfigService.ts";
import { renderNginxConfig, renderHstsHeader, renderMetricsAllow } from "../../src/services/nginxRenderer.ts";
import { computeBootstrap, computeRetire, computeSwap, normalizePin, tallyPins } from "../../src/services/certPinService.ts";
import { mergeScopedAccess, parseScopedAccess, loginSourceAllowed, isRoutableIpv6 } from "../../src/services/webAccessSettingsService.ts";
import { certFacts, parseLiveCertPaths, validateCertKeyPair } from "../../src/services/webServerService.ts";

describe("ipScope", () => {
  it("normalizes allow-list CIDRs (bare → /32, host bits cleared, IPv4 only)", () => {
    expect(normalizeAllowlistCidr("203.0.113.5")).toBe("203.0.113.5/32");
    expect(normalizeAllowlistCidr("10.1.2.3/8")).toBe("10.0.0.0/8");
    expect(normalizeAllowlistCidr("10.0.0.0/33")).toBeNull();
    expect(normalizeAllowlistCidr("300.1.1.1")).toBeNull();
    expect(normalizeAllowlistCidr("2001:db8::/32")).toBeNull();
    expect(normalizeAllowlistCidr("10.0.0.0/8/1")).toBeNull();
  });

  it("matches addresses, CIDRs and IPv6-mapped IPv4; fails closed", () => {
    expect(ipMatchesAllowlist("10.4.5.6", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("::ffff:10.4.5.6", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowlist("", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("10.0.0.1", [])).toBe(false);
  });

  it("rfc1918 scope admits private + loopback only", () => {
    expect(isPrivateOrLoopbackIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.31.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.32.0.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("::1")).toBe(true);
    expect(ipInScope("8.8.8.8", "rfc1918", [])).toBe(false);
    expect(ipInScope("8.8.8.8", "all", [])).toBe(true);
    expect(ipInScope("8.8.8.8", "custom", ["8.8.8.0/24"])).toBe(true);
  });
});

describe("scoped access settings (login access / dash)", () => {
  it("defaults to unrestricted and migrates legacy rfc1918Only", () => {
    expect(parseScopedAccess(null)).toEqual({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
    expect(parseScopedAccess({ enabled: true, rfc1918Only: false }).ipScope).toBe("all");
  });

  it("rejects bad CIDRs and an empty enabled custom scope", () => {
    const cur = parseScopedAccess(null);
    expect(() => mergeScopedAccess(cur, { allowedCidrs: ["nope"] }, "x")).toThrow(/Invalid network/);
    expect(() => mergeScopedAccess(cur, { enabled: true, ipScope: "custom", allowedCidrs: [] }, "empty")).toThrow("empty");
    expect(mergeScopedAccess(cur, { enabled: true, ipScope: "custom", allowedCidrs: ["10.1.1.1/8", "10.0.0.0/8"] }, "x").allowedCidrs)
      .toEqual(["10.0.0.0/8"]);
  });

  it("login gate is open when disabled and scoped when enabled", () => {
    expect(loginSourceAllowed("8.8.8.8", { enabled: false, ipScope: "rfc1918", allowedCidrs: [] })).toBe(true);
    expect(loginSourceAllowed("8.8.8.8", { enabled: true, ipScope: "rfc1918", allowedCidrs: [] })).toBe(false);
    expect(loginSourceAllowed("10.0.0.9", { enabled: true, ipScope: "rfc1918", allowedCidrs: [] })).toBe(true);
  });

  it("counts only global-unicast / ULA IPv6 as routable", () => {
    expect(isRoutableIpv6("2001:db8::1")).toBe(true);
    expect(isRoutableIpv6("fd00::1")).toBe(true);
    expect(isRoutableIpv6("fe80::1")).toBe(false);
    expect(isRoutableIpv6("::1")).toBe(false);
  });
});

describe("proxyConfig", () => {
  it("defaults are valid and TLS 1.3 only", () => {
    const d = defaultProxyConfig();
    expect(d.tlsProtocols).toEqual(["TLSv1.3"]);
    expect(() => validateProxyConfig(d)).not.toThrow();
  });

  it("refuses TLSv1.2 (PQC-hybrid invariant) and injected protocol strings", () => {
    const d = defaultProxyConfig();
    expect(() => validateProxyConfig(mergeProxyConfig(d, { tlsProtocols: ["TLSv1.2", "TLSv1.3"] }))).toThrow(/TLS 1.3 only/);
    expect(() => validateProxyConfig(mergeProxyConfig(d, { tlsProtocols: ["TLSv1.3; include /etc/x" as any] }))).toThrow();
  });

  it("validates port, HSTS and Prometheus IPs", () => {
    const d = defaultProxyConfig();
    expect(() => validateProxyConfig(mergeProxyConfig(d, { httpsPort: 70000 }))).toThrow(/httpsPort/);
    expect(() => validateProxyConfig(mergeProxyConfig(d, { prometheusAllowIps: ["10.0.0.1; deny"] }))).toThrow(/Prometheus/);
    expect(() => validateProxyConfig(mergeProxyConfig(d, { hsts: { maxAgeSeconds: -1 } as any }))).toThrow(/maxAge/);
  });

  it("parse drops junk and falls back to defaults", () => {
    const p = parseProxyConfig({ httpsPort: "x", prometheusAllowIps: ["10.0.0.1", "bad"], tlsProtocols: [] });
    expect(p.httpsPort).toBe(443);
    expect(p.prometheusAllowIps).toEqual(["10.0.0.1"]);
    expect(p.tlsProtocols).toEqual(["TLSv1.3"]);
  });
});

describe("nginx renderer", () => {
  const base = { serverName: "charon.example.com", webPort: 3000, endpointPort: 3001, certPath: "/c.crt", keyPath: "/c.key" };

  it("renders the shipped template with no leftover tokens (defaults)", () => {
    const out = renderNginxConfig(base);
    expect(out).not.toMatch(/\{\{(?!TOKENS)\w+\}\}/);
    expect(out).toContain("listen 443 ssl;");
    expect(out).toContain("listen 443 quic reuseport;");
    expect(out).toContain("ssl_protocols TLSv1.3;");
    expect(out).toContain("ssl_ecdh_curve X25519MLKEM768");
    expect(out).toContain("deny all;");
  });

  it("toggles HTTP/3, HSTS and the metrics allow-list as whole lines", () => {
    const proxy = { ...defaultProxyConfig(), httpsPort: 8443, http3Enabled: false, prometheusAllowIps: ["10.0.0.42"] };
    proxy.hsts = { ...proxy.hsts, enabled: false };
    const out = renderNginxConfig({ ...base, proxy });
    expect(out).toContain("listen 8443 ssl;");
    expect(out).not.toContain("quic");
    expect(out).not.toContain("Strict-Transport-Security \"");
    expect(out).toContain("allow 10.0.0.42; deny all;");
    expect(renderHstsHeader({ ...defaultProxyConfig(), hsts: { enabled: true, maxAgeSeconds: 60, includeSubDomains: false, preload: true } }))
      .toContain('"max-age=60; preload"');
    expect(renderMetricsAllow(defaultProxyConfig())).toBe("deny all;");
  });

  it("refuses unsafe substitutions", () => {
    expect(() => renderNginxConfig({ ...base, serverName: "a; include /x" })).toThrow(/unsafe/);
  });

  it("matches the install-rhel.sh sed defaults byte-for-byte on the proxy lines", () => {
    // install-rhel.sh renders the same tokens with sed; keep the two in lockstep.
    const sh = readFileSync(join(__dirname, "../../deploy/install-rhel.sh"), "utf8");
    const out = renderNginxConfig(base);
    expect(sh).toContain("listen 443 quic reuseport;      # HTTP/3");
    expect(out).toContain("listen 443 quic reuseport;      # HTTP/3");
    expect(out).toContain('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always; proxy_hide_header Strict-Transport-Security;');
  });
});

describe("agent cert pins", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);

  it("normalizes sha256:/colon/upper forms", () => {
    expect(normalizePin(`sha256:${A.toUpperCase()}`)).toBe(A);
    expect(normalizePin(A.match(/../g)!.join(":"))).toBe(A);
    expect(normalizePin("abc")).toBeNull();
  });

  it("swap keeps the old canonical accepted", () => {
    expect(computeSwap({ canonical: A, staged: [B] }, B)).toEqual({ canonical: B, staged: [A] });
    expect(computeSwap({ canonical: null, staged: [B] }, B)).toEqual({ canonical: B, staged: [] });
  });

  it("bootstrap adopts the served pin only when no canonical pin exists", () => {
    expect(computeBootstrap({ canonical: null, staged: [] }, A)).toEqual({ canonical: A, staged: [] });
    expect(computeBootstrap({ canonical: null, staged: [A, B] }, A)).toEqual({ canonical: A, staged: [B] });
    // Never replaces an operator's pin, even when the served cert differs.
    expect(computeBootstrap({ canonical: B, staged: [] }, A)).toBeNull();
    expect(computeBootstrap({ canonical: A, staged: [] }, A)).toBeNull();
  });

  it("retire promotes, refuses the last pin, and reports absence", () => {
    expect(computeRetire({ canonical: B, staged: [A] }, A)).toEqual({ outcome: "retired", store: { canonical: B, staged: [] } });
    expect(computeRetire({ canonical: A, staged: [B, C] }, A).store).toEqual({ canonical: B, staged: [C] });
    expect(computeRetire({ canonical: A, staged: [] }, A).outcome).toBe("last_pin");
    expect(computeRetire({ canonical: A, staged: [] }, C).outcome).toBe("not_present");
  });

  it("tallies canonical vs staged per pin", () => {
    const t = tallyPins([
      { serverCertFingerprint: A, additionalCertFingerprints: [B] },
      { serverCertFingerprint: A, additionalCertFingerprints: [] },
      { serverCertFingerprint: null, additionalCertFingerprints: [] },
    ]);
    expect(t).toEqual([{ pin: A, canonical: 2, staged: 0 }, { pin: B, canonical: 0, staged: 1 }]);
  });
});

describe("live nginx cert paths", () => {
  it("reads ssl_certificate(_key), ignoring comments", () => {
    const conf = "# ssl_certificate /old.crt;\n    ssl_certificate     /opt/charon/state/certs/charon.crt;\n    ssl_certificate_key /opt/charon/state/certs/charon.key;\n";
    expect(parseLiveCertPaths(conf)).toEqual({
      certPath: "/opt/charon/state/certs/charon.crt",
      keyPath: "/opt/charon/state/certs/charon.key",
    });
    expect(parseLiveCertPaths(null)).toEqual({ certPath: null, keyPath: null });
  });
});

// Real cert/key pairs from the openssl CLI when it is available (CI / dev boxes).
let pair: { cert: string; key: string; otherKey: string } | null = null;
beforeAll(() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "charon-ws-"));
    const gen = (name: string) =>
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
        "-subj", "/CN=charon.test", "-addext", "subjectAltName=DNS:charon.test,IP:10.0.0.5",
        "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`),
      ], { stdio: "ignore" });
    gen("a");
    gen("b");
    pair = {
      cert: readFileSync(join(dir, "a.crt"), "utf8"),
      key: readFileSync(join(dir, "a.key"), "utf8"),
      otherKey: readFileSync(join(dir, "b.key"), "utf8"),
    };
  } catch {
    pair = null;
  }
});

describe("cert/key pair", () => {
  it("accepts a matching pair and extracts CN / SANs / pin", (ctx) => {
    if (!pair) return ctx.skip();
    expect(() => validateCertKeyPair(pair!.cert, pair!.key)).not.toThrow();
    const f = certFacts(pair!.cert);
    expect(f.cn).toBe("charon.test");
    expect(f.dnsSans).toEqual(["charon.test"]);
    expect(f.ipSans).toEqual(["10.0.0.5"]);
    expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a mismatched key", (ctx) => {
    if (!pair) return ctx.skip();
    expect(() => validateCertKeyPair(pair!.cert, pair!.otherKey)).toThrow(/does not match/);
  });
});
