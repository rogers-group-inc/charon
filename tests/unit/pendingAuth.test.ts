/** utils/pendingAuth.ts — a half-finished login held in the session. */
import { describe, it, expect } from "vitest";
import { setPending, peekPending, clearPending, PENDING_TTL_MS } from "../../src/utils/pendingAuth.ts";

describe("pendingAuth", () => {
  it("is purpose-scoped and expires", () => {
    const req: any = { session: {} };
    setPending(req, { userId: "u", username: "a", purpose: "mfa", methods: { totp: true, passkey: false }, mustChangePassword: false, authProvider: "local" }, 1000);
    expect(peekPending(req, "mfa", 1000 + 1)?.userId).toBe("u");
    expect(peekPending(req, "password-change", 1001)).toBeNull();
    expect(peekPending(req, "mfa", 1000 + PENDING_TTL_MS)).toBeNull();
    expect(req.session.pendingAuth).toBeUndefined();
    setPending(req, { userId: "u", username: "a", purpose: "mfa", methods: { totp: true, passkey: false }, mustChangePassword: false, authProvider: "local" });
    clearPending(req);
    expect(req.session.pendingAuth).toBeUndefined();
  });
});
