import { describe, it, expect } from "vitest";
import { toPublicBranding } from "../../src/services/brandingService.js";

// GET /api/v1/branding is unauthenticated (the login page reads it), so the
// view must carry only what the login page shows.
const base = {
  appName: "Charon",
  subtitle: "Zero Trust Network Access",
  logoUrl: "/uploads/custom-logo.png",
  logoOnLogin: true,
  customLogo: true,
  logoVersion: "abc123",
};

describe("toPublicBranding", () => {
  it("exposes name, subtitle and the logo when it is opted in", () => {
    expect(toPublicBranding(base)).toEqual({
      appName: "Charon",
      subtitle: "Zero Trust Network Access",
      logoUrl: "/uploads/custom-logo.png",
      logoVersion: "abc123",
    });
  });

  it("hides the logo when 'show on login page' is off", () => {
    const v = toPublicBranding({ ...base, logoOnLogin: false });
    expect(v.logoUrl).toBeNull();
    expect(v.logoVersion).toBeNull();
  });

  it("hides the logo when none is uploaded", () => {
    expect(toPublicBranding({ ...base, customLogo: false, logoUrl: "" }).logoUrl).toBeNull();
  });

  it("falls back to the default name for a blank app name", () => {
    expect(toPublicBranding({ ...base, appName: "  " }).appName).toBe("Charon");
  });

  it("never carries the app version or sidebar flags", () => {
    const v = toPublicBranding({ ...base, version: "0.1.123", logoOnSidebar: true } as any) as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(["appName", "logoUrl", "logoVersion", "subtitle"]);
  });
});
