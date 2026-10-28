/** utils/loginLockout.ts — per-username failure counter. */
import { describe, it, expect } from "vitest";
import { isLocked, recordFailure, clearLockout, lockoutRemaining } from "../../src/utils/loginLockout.ts";

describe("login lockout", () => {
  it("locks after five failures and clears", () => {
    const name = `user-${Math.random()}`;
    for (let i = 0; i < 4; i++) expect(recordFailure(name).lockedNow).toBe(false);
    expect(recordFailure(name.toUpperCase()).lockedNow).toBe(true);
    expect(isLocked(name).locked).toBe(true);
    clearLockout(name);
    expect(isLocked(name).locked).toBe(false);
    expect(lockoutRemaining(new Date(Date.now() + 61_000))).toBe("2 minutes");
  });
});
