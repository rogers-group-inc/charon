import { describe, it, expect } from "vitest";
import { evaluatePosture, type PosturePolicy } from "../../src/services/postureService.ts";

const STRICT: PosturePolicy = { requireDiskEncryption: true, requireFirewall: true, requireAntivirus: true, maxPatchAgeDays: 30 };

describe("posture evaluation", () => {
  it("unknown when no signals reported", () => {
    expect(evaluatePosture({}, STRICT)).toBe("unknown");
    expect(evaluatePosture(null, STRICT)).toBe("unknown");
  });

  it("compliant when all required signals pass", () => {
    expect(evaluatePosture({ diskEncryption: true, firewall: true, antivirus: true, patchAgeDays: 5 }, STRICT)).toBe("compliant");
  });

  it("noncompliant when a required signal fails", () => {
    expect(evaluatePosture({ diskEncryption: false, firewall: true, antivirus: true }, STRICT)).toBe("noncompliant");
    expect(evaluatePosture({ diskEncryption: true, firewall: true, antivirus: true, patchAgeDays: 90 }, STRICT)).toBe("noncompliant");
  });

  it("ignores signals the policy does not require", () => {
    const lax: PosturePolicy = { requireDiskEncryption: false, requireFirewall: false, requireAntivirus: false, maxPatchAgeDays: null };
    expect(evaluatePosture({ diskEncryption: false }, lax)).toBe("compliant");
  });
});
