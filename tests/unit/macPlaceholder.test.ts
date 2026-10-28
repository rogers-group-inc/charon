// Ported from polaris tests/unit/macPlaceholder.test.ts (normalizePlaceholderPrefix block).
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

// Charon port: the placeholder-prefix half of polaris utils/mac.ts lives in
// services/reservationMacService.ts (isPlaceholderMac / generatePlaceholderMac
// have no charon consumer and were not ported).
const { DEFAULT_PLACEHOLDER_MAC_PREFIX, normalizePlaceholderPrefix, normalizeReservationMacSettings } =
  await import("../../src/services/reservationMacService.js");

describe("normalizePlaceholderPrefix", () => {
  it("accepts any separator form and emits colon-uppercase", () => {
    for (const raw of ["02:0f:5e", "02-0F-5E", "020f5e", "02 0f 5e", "02.0f.5e"]) {
      expect(normalizePlaceholderPrefix(raw)).toBe("02:0F:5E");
    }
  });

  it("accepts 1 through 5 octets", () => {
    expect(normalizePlaceholderPrefix("02")).toBe("02");
    expect(normalizePlaceholderPrefix("02:0F:5E:11:22")).toBe("02:0F:5E:11:22");
  });

  it("rejects 6 octets — a full MAC is not a prefix", () => {
    expect(normalizePlaceholderPrefix("02:0F:5E:11:22:33")).toBeNull();
  });

  it("rejects empty, odd-length and non-hex input", () => {
    for (const raw of ["", "   ", "0", "02:0F:5", "zz:yy:xx"]) {
      expect(normalizePlaceholderPrefix(raw)).toBeNull();
    }
  });

  it("rejects non-string input rather than coercing it", () => {
    // 42 would otherwise coerce to the hex-valid prefix "42".
    for (const raw of [null, undefined, 42, {}, ["02"], true]) {
      expect(normalizePlaceholderPrefix(raw as unknown)).toBeNull();
    }
  });

  // The load-bearing rejection: a real vendor OUI would make that vendor's
  // genuine devices look like placeholders, and adoption would overwrite them.
  // Note AA:BB:CC is NOT in this list — 0xAA has the locally-administered bit
  // set, so the IEEE cannot assign it and it is a legitimate prefix.
  it("rejects a globally administered prefix", () => {
    for (const raw of ["00:50:56", "00:0C:29", "FC:AA:14", "3C:2C:30", "D4:76:A0"]) {
      expect(normalizePlaceholderPrefix(raw)).toBeNull();
    }
  });

  it("rejects a multicast prefix", () => {
    // Bit 0 set = multicast; FortiOS will not bind it as a DHCP client identity.
    expect(normalizePlaceholderPrefix("03:0F:5E")).toBeNull();
    expect(normalizePlaceholderPrefix("01:00:5E")).toBeNull();
  });

  it("accepts every locally administered unicast first octet", () => {
    for (const raw of ["02", "06", "0A", "0E", "12", "F2", "FE"]) {
      expect(normalizePlaceholderPrefix(raw)).toBe(raw);
    }
  });

  it("the shipped default is itself valid", () => {
    expect(normalizePlaceholderPrefix(DEFAULT_PLACEHOLDER_MAC_PREFIX))
      .toBe(DEFAULT_PLACEHOLDER_MAC_PREFIX);
  });
});

describe("normalizeReservationMacSettings", () => {
  it("self-heals an unusable stored prefix to the default", () => {
    expect(normalizeReservationMacSettings({ prefix: "00:50:56" })).toEqual({ prefix: DEFAULT_PLACEHOLDER_MAC_PREFIX });
    expect(normalizeReservationMacSettings(null)).toEqual({ prefix: DEFAULT_PLACEHOLDER_MAC_PREFIX });
    expect(normalizeReservationMacSettings({ prefix: "06-aa" })).toEqual({ prefix: "06:AA" });
  });
});
