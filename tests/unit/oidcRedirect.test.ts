/**
 * tests/unit/oidcRedirect.test.ts — OIDC redirect-URI derivation: CHARON_PUBLIC_URL
 * when set, else the origin the browser used (CHARON_PUBLIC_URL may be unset).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventService.js", () => ({ logEvent: vi.fn() }));

import { getRedirectUri } from "../../src/services/oidcAuthService.js";

const ORIGINAL = process.env.CHARON_PUBLIC_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CHARON_PUBLIC_URL;
  else process.env.CHARON_PUBLIC_URL = ORIGINAL;
});

describe("getRedirectUri", () => {
  it("prefers CHARON_PUBLIC_URL (trailing slash trimmed)", () => {
    process.env.CHARON_PUBLIC_URL = "https://charon.example.com/";
    expect(getRedirectUri("https://other.example")).toBe("https://charon.example.com/api/v1/auth/oidc/callback");
  });

  it("falls back to the request origin when CHARON_PUBLIC_URL is unset", () => {
    delete process.env.CHARON_PUBLIC_URL;
    expect(getRedirectUri("https://charon.lab:8443")).toBe("https://charon.lab:8443/api/v1/auth/oidc/callback");
  });

  it("throws when there is nothing to derive from", () => {
    delete process.env.CHARON_PUBLIC_URL;
    expect(() => getRedirectUri("")).toThrowError(/CHARON_PUBLIC_URL/);
  });
});
