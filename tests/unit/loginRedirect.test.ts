/** utils/loginRedirect.ts — the post-login landing (cookie + SAML RelayState). */
import { describe, it, expect, vi } from "vitest";
import {
  LOGIN_NEXT_COOKIE,
  rememberLoginTarget,
  peekLoginTarget,
  takeLoginTarget,
  readCookie,
  generateRelayState,
  relayStateTarget,
} from "../../src/utils/loginRedirect.ts";

function req(headers: Record<string, string>, secure = false): any {
  return { secure, get: (n: string) => headers[n.toLowerCase()] };
}

describe("loginRedirect", () => {
  it("remembers a navigation's same-origin path, not a subresource's", () => {
    const res = { cookie: vi.fn() };
    rememberLoginTarget(req({ "sec-fetch-dest": "document" }, true), res as any, "/endpoints.html?id=1");
    expect(res.cookie).toHaveBeenCalledWith(LOGIN_NEXT_COOKIE, "/endpoints.html?id=1", expect.objectContaining({ sameSite: "none", secure: true }));
    res.cookie.mockClear();
    rememberLoginTarget(req({ "sec-fetch-dest": "image" }), res as any, "/endpoints.html");
    rememberLoginTarget(req({}), res as any, "/");
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("peeks without consuming and takes with consuming; never off-origin", () => {
    const r = req({ cookie: `a=1; ${LOGIN_NEXT_COOKIE}=${encodeURIComponent("/events.html")}` });
    expect(peekLoginTarget(r)).toBe("/events.html");
    const res = { clearCookie: vi.fn() };
    expect(takeLoginTarget(r, res as any)).toBe("/events.html");
    expect(res.clearCookie).toHaveBeenCalled();
    expect(takeLoginTarget(req({ cookie: `${LOGIN_NEXT_COOKIE}=${encodeURIComponent("//evil.example")}` }), res as any)).toBe("/");
    expect(readCookie("x=%E0%A4%A", "x")).toBeNull();
  });

  it("carries a short path in RelayState and drops one that would not fit", () => {
    const rs = generateRelayState("/users.html");
    expect(relayStateTarget(rs)).toBe("/users.html");
    expect(relayStateTarget(generateRelayState(null))).toBeNull();
    expect(relayStateTarget(generateRelayState("/" + "a".repeat(200)))).toBeNull();
    expect(Buffer.byteLength(generateRelayState("/users.html"))).toBeLessThanOrEqual(80);
  });
});
