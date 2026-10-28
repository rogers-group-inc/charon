/**
 * Pure logic behind Server Settings → Time & NTP and → Customization
 * (ntpService, brandingService, rebootSettingsService). Ported from polaris's
 * branding / reboot-settings tests where they apply.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const ntp = await import("../../src/services/ntpService.js");
const brand = await import("../../src/services/brandingService.js");
const reboot = await import("../../src/services/rebootSettingsService.js");

describe("ntpService", () => {
  it("accepts hostnames and IP literals, rejects anything else", () => {
    for (const ok of ["pool.ntp.org", "time.google.com.", "10.0.0.1", "2001:db8::1", "ntp1"]) {
      expect(ntp.isValidNtpServer(ok)).toBe(true);
    }
    for (const bad of ["", "a b", "pool.ntp.org iburst", "x;rm -rf /", "-bad.example", "a\nserver evil"]) {
      expect(ntp.isValidNtpServer(bad)).toBe(false);
    }
  });

  it("validates IANA timezones", () => {
    expect(ntp.isValidTimezone("America/Chicago")).toBe(true);
    expect(ntp.isValidTimezone("UTC")).toBe(true);
    expect(ntp.isValidTimezone("Mars/Olympus")).toBe(false);
  });

  it("parses a stored row over defaults, dropping malformed values", () => {
    expect(ntp.parseNtpSettings(undefined)).toEqual({ enabled: false, mode: "ntp", servers: [], timezoneOverride: null });
    expect(ntp.parseNtpSettings({ enabled: true, mode: "nts", servers: ["a.example", "bad host", 3], timezoneOverride: "Nope/Zone" }))
      .toEqual({ enabled: true, mode: "nts", servers: ["a.example"], timezoneOverride: null });
    expect(ntp.parseNtpSettings({ mode: "weird", timezoneOverride: "Europe/London" }).mode).toBe("ntp");
  });

  it("renders chrony sources (nts flag only in NTS mode)", () => {
    expect(ntp.renderChronySources({ mode: "ntp", servers: ["a.example", "10.0.0.1"] }))
      .toMatch(/\nserver a\.example iburst\nserver 10\.0\.0\.1 iburst\n$/);
    expect(ntp.renderChronySources({ mode: "nts", servers: ["nts.example"] })).toContain("server nts.example iburst nts\n");
  });

  it("parses an SNTP reply and computes the offset", () => {
    const buf = Buffer.alloc(48);
    buf[0] = 0x24; // LI 0, VN 4, mode 4 (server)
    buf[1] = 2;    // stratum
    const toNtp = (ms: number, off: number) => {
      buf.writeUInt32BE(Math.floor(ms / 1000) + 2_208_988_800, off);
      buf.writeUInt32BE(Math.round(((ms % 1000) / 1000) * 0x1_0000_0000), off + 4);
    };
    const t1 = 1_700_000_000_000;
    toNtp(t1 + 1500, 32); // server receive: local clock is 1.5s behind + 0ms path
    toNtp(t1 + 1500, 40);
    const r = ntp.parseSntpReply(buf, t1, t1);
    expect(r.stratum).toBe(2);
    expect(r.offsetMs).toBeCloseTo(1500, 0);
    expect(ntp.formatOffset(r.offsetMs)).toBe("+1.500s");
    expect(ntp.formatOffset(-3)).toBe("-0.003s");
  });

  it("rejects kiss-of-death and wrong-mode replies", () => {
    const buf = Buffer.alloc(48);
    buf[0] = 0x24; buf[1] = 0; buf.write("RATE", 12, "ascii");
    expect(() => ntp.parseSntpReply(buf, 0, 0)).toThrow(/kiss-of-death \(RATE\)/);
    buf[0] = 0x23; buf[1] = 2;
    expect(() => ntp.parseSntpReply(buf, 0, 0)).toThrow(/mode/);
    expect(() => ntp.parseSntpReply(Buffer.alloc(10), 0, 0)).toThrow(/short/);
  });

  it("testNtpSync with no servers fails without probing", async () => {
    expect(await ntp.testNtpSync({ mode: "ntp", servers: [] })).toEqual({ ok: false, message: "No NTP servers configured" });
  });
});

describe("brandingService", () => {
  it("detects PNG/JPEG/WebP by magic bytes only — never SVG/HTML", () => {
    expect(brand.detectImageMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(".png");
    expect(brand.detectImageMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(".jpg");
    expect(brand.detectImageMagic(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "ascii"))).toBe(".webp");
    expect(brand.detectImageMagic(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(brand.detectImageMagic(Buffer.from("<html>"))).toBeNull();
    expect(brand.detectImageMagic(Buffer.alloc(0))).toBeNull();
  });

  it("only our own upload names count as a custom logo", () => {
    expect(brand.hasCustomLogo("/uploads/custom-logo.png")).toBe(true);
    expect(brand.hasCustomLogo("/uploads/custom-logo.webp")).toBe(true);
    expect(brand.hasCustomLogo("")).toBe(false);
    expect(brand.hasCustomLogo("/uploads/../../etc/passwd")).toBe(false);
    expect(brand.hasCustomLogo("https://evil.example/x.png")).toBe(false);
    expect(brand.hasCustomLogo("/uploads/custom-logo.svg")).toBe(false);
  });

  it("parses the stored row with polaris semantics (blank name survives, false flags survive)", () => {
    expect(brand.parseBranding(undefined)).toEqual(brand.BRANDING_DEFAULTS);
    const b = brand.parseBranding({ appName: "", subtitle: "Ops", logoUrl: "javascript:alert(1)", logoOnSidebar: false, logoAccent: true, temperatureUnit: "F" });
    expect(b.appName).toBe("");
    expect(b.subtitle).toBe("Ops");
    expect(b.logoUrl).toBe("");          // untrusted URL dropped
    expect(b.logoOnSidebar).toBe(false);
    expect(b.logoOnLogin).toBe(true);
    expect(b.logoAccent).toBe(false);    // not supported in Charon
    expect(b.temperatureUnit).toBe("f");
  });

  it("normalizes flags, text and display name", () => {
    expect(brand.normalizeBrandingFlag(undefined, true)).toBe(true);
    expect(brand.normalizeBrandingFlag(false, true)).toBe(false);
    expect(brand.normalizeBrandingFlag("false", true)).toBe(false);
    expect(brand.normalizeBrandingFlag("0", true)).toBe(false);
    expect(brand.normalizeBrandingFlag("yes", false)).toBe(true);
    expect(brand.cleanBrandingText(undefined, "keep")).toBe("keep");
    expect(brand.cleanBrandingText("  a\nb  ", "x")).toBe("a b");
    expect(brand.cleanBrandingText("x".repeat(500), "")).toHaveLength(brand.BRANDING_TEXT_MAX);
    expect(brand.displayAppName({ appName: "  " })).toBe("Charon");
    expect(brand.logoVersionStamp(1, 2, "1.0")).toMatch(/^[0-9a-f]{12}$/);
    expect(brand.logoVersionStamp(1, 2, "1.0")).not.toBe(brand.logoVersionStamp(1, 3, "1.0"));
  });
});

describe("rebootSettingsService", () => {
  it("anything but a literal true reads as off", () => {
    expect(reboot.parseRebootSettings(undefined)).toEqual({ requireNote: false });
    expect(reboot.parseRebootSettings({ requireNote: "true" })).toEqual({ requireNote: false });
    expect(reboot.parseRebootSettings({ requireNote: true })).toEqual({ requireNote: true });
  });
});
