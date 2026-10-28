/** utils/passwordPolicy.ts — the pure complexity rules. */
import { describe, it, expect } from "vitest";
import {
  clampMinLength,
  defaultPasswordPolicy,
  describePasswordPolicy,
  evaluatePassword,
  parsePasswordPolicy,
  passwordPolicyError,
} from "../../src/utils/passwordPolicy.ts";

describe("password policy", () => {
  it("defaults to min 8 + four classes and reports every failure", () => {
    const p = defaultPasswordPolicy();
    expect(evaluatePassword("abc", p).map((r) => r.key)).toEqual(["length", "upper", "number", "special"]);
    expect(passwordPolicyError("Abcdef1!", p)).toBeNull();
    expect(passwordPolicyError("abcdefgh1!", p)).toBe("Password must contain an uppercase letter");
  });

  it("clamps minLength to the NIST floor and the ceiling", () => {
    expect(clampMinLength(2, 8)).toBe(8);
    expect(clampMinLength(999, 8)).toBe(128);
    expect(clampMinLength("x", 12)).toBe(12);
  });

  it("parses a mangled row back to defaults, never to no rules", () => {
    expect(parsePasswordPolicy("garbage")).toEqual(defaultPasswordPolicy());
    expect(parsePasswordPolicy({ minLength: 14, requireSpecial: false }).requireSpecial).toBe(false);
    expect(describePasswordPolicy({ ...defaultPasswordPolicy(), requireSpecial: false, forceChangeOnLogin: true }))
      .toMatch(/min 8 characters, requires lowercase \+ uppercase \+ number, existing passwords must be changed/);
  });

});
