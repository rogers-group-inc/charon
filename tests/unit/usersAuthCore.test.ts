/**
 * Users + authentication port (polaris): escalation guards, password policy,
 * group-mapping resolution, pending-auth, session settings, TOTP replay, login
 * lockout, role validation and the admin-equivalence guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: {} as Record<string, any> }));
vi.mock("../../src/db.ts", () => ({ prisma }));
vi.mock("../../src/db.js", () => ({ prisma }));
vi.mock("../../src/services/eventService.ts", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/eventService.js", () => ({ logEvent: vi.fn() }));

import { TOTP, Secret } from "otpauth";
import {
  FUNCTION_KEYS,
  assertGrantWithinCaller,
  assertNoPrivilegeEscalation,
  callerIsAdminEquivalent,
  grantsBeyond,
  normalizePermissions,
} from "../../src/api/middleware/permissions.ts";
import {
  clampMinLength,
  defaultPasswordPolicy,
  describePasswordPolicy,
  evaluatePassword,
  parsePasswordPolicy,
  passwordPolicyError,
} from "../../src/utils/passwordPolicy.ts";
import { normalizeGroupKey, resolveGroupsToAccess, invalidateGroupMappingCache, isGroupMappingProvider } from "../../src/services/groupMappingService.ts";
import { setPending, peekPending, clearPending, PENDING_TTL_MS } from "../../src/utils/pendingAuth.ts";
import { parseSessionSettings, clampAutoLogout } from "../../src/services/sessionSettingsService.ts";
import { verifyCodeStep, generateSecret, consumeBackupCode, generateBackupCodes } from "../../src/services/totpService.ts";
import { claimTotpStep } from "../../src/services/totpStepService.ts";
import { isLocked, recordFailure, clearLockout, lockoutRemaining } from "../../src/utils/loginLockout.ts";
import { validateRoleName, normalizeRoleColor, assertRoleDemotionAllowed, countAdminEquivalentUsers } from "../../src/services/roleService.ts";
import { revokeUserSessions, getOnlineUserIds } from "../../src/services/sessionRevocationService.ts";
import { assertPasswordMeetsPolicy, passwordNeedsPolicyChange, invalidatePasswordPolicyCache } from "../../src/services/passwordPolicyService.ts";
import { resolveSecondFactors } from "../../src/services/authService.ts";

const all = (level: string) => Object.fromEntries(FUNCTION_KEYS.map((f) => [f.key, level]));
const ADMIN = all("fullwrite");
const OPERATOR = { ...all("write"), roles: "none", users: "write" };

function reqWith(perms: Record<string, string>): any {
  return { roleSnapshot: { id: "r", name: "r", isProtected: false, permissions: normalizePermissions(perms), updatedAt: "" } };
}

beforeEach(() => {
  for (const k of Object.keys(prisma)) delete prisma[k];
});

describe("authentication function key", () => {
  it("is in the catalogue and normalizes to none when absent", () => {
    expect(FUNCTION_KEYS.some((f) => f.key === "authentication")).toBe(true);
    expect(normalizePermissions({}).authentication).toBe("none");
  });
});

describe("escalation guards", () => {
  it("grantsBeyond lists only keys above the caller, ignoring ones the row already had", () => {
    const caller = { users: "write", tags: "read" };
    const target = { users: "write", tags: "write", roles: "read" };
    expect(grantsBeyond(caller, target).map((g) => g.key).sort()).toEqual(["roles", "tags"]);
    expect(grantsBeyond(caller, target, { tags: "write" }).map((g) => g.key)).toEqual(["roles"]);
  });

  it("callerIsAdminEquivalent reads the request's resolved snapshot first", () => {
    expect(callerIsAdminEquivalent(reqWith(ADMIN))).toBe(true);
    expect(callerIsAdminEquivalent(reqWith(OPERATOR))).toBe(false);
    expect(callerIsAdminEquivalent({ session: {} } as any)).toBe(false);
  });

  it("refuses handing out admin-equivalence to a non-admin caller", () => {
    expect(() => assertNoPrivilegeEscalation(reqWith(OPERATOR), ADMIN, "the role X")).toThrow(/admin-equivalent/);
    expect(() => assertNoPrivilegeEscalation(reqWith(ADMIN), ADMIN, "the role X")).not.toThrow();
    expect(() => assertNoPrivilegeEscalation(reqWith(OPERATOR), OPERATOR, "the role X")).not.toThrow();
  });

  it("refuses any single grant above the caller", () => {
    expect(() => assertGrantWithinCaller(reqWith(OPERATOR), { enforcement: "fullwrite" }, "the role X")).toThrow(/enforcement=fullwrite/);
    expect(() => assertGrantWithinCaller(reqWith(OPERATOR), { enforcement: "write" }, "the role X")).not.toThrow();
    // An edit is not refused for authority the role already held.
    expect(() =>
      assertGrantWithinCaller(reqWith(OPERATOR), { enforcement: "fullwrite" }, "x", { enforcement: "fullwrite" }),
    ).not.toThrow();
  });
});

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

  it("service: asserts against the stored policy and falls back to defaults on a read failure", async () => {
    invalidatePasswordPolicyCache();
    prisma.setting = { findUnique: vi.fn().mockResolvedValue({ value: { minLength: 12, forceChangeOnLogin: true } }) };
    await expect(assertPasswordMeetsPolicy("Abcdef1!")).rejects.toThrow(/at least 12/);
    expect(await passwordNeedsPolicyChange("Abcdef1!")).toBe(true);
    expect(await passwordNeedsPolicyChange("Abcdefgh123!")).toBe(false);

    invalidatePasswordPolicyCache();
    prisma.setting = { findUnique: vi.fn().mockRejectedValue(new Error("db down")) };
    await expect(assertPasswordMeetsPolicy("short")).rejects.toThrow();
    await expect(assertPasswordMeetsPolicy("Abcdef1!")).resolves.toBeUndefined();
  });
});

describe("group mappings", () => {
  it("normalizes LDAP / Entra keys case-insensitively, SAML / OIDC trimmed only", () => {
    expect(normalizeGroupKey("ldap", " CN=Ops,DC=Example ")).toBe("cn=ops,dc=example");
    expect(normalizeGroupKey("entra-proxy", "ABC-123")).toBe("abc-123");
    expect(normalizeGroupKey("oidc", " Ops ")).toBe("Ops");
    expect(normalizeGroupKey("saml", 42)).toBe("");
    expect(isGroupMappingProvider("azure")).toBe(false);
  });

  it("resolves the highest-privilege matched role", async () => {
    invalidateGroupMappingCache();
    prisma.groupMapping = {
      findMany: vi.fn().mockResolvedValue([
        { groupKey: "ops", roleId: "r-op" },
        { groupKey: "admins", roleId: "r-admin" },
        { groupKey: "other", roleId: "r-x" },
      ]),
    };
    prisma.role = {
      findMany: vi.fn().mockResolvedValue([
        { id: "r-op", permissions: OPERATOR },
        { id: "r-admin", permissions: ADMIN },
      ]),
    };
    const got = await resolveGroupsToAccess("oidc", ["ops", "admins", "unmapped"]);
    expect(got.roleId).toBe("r-admin");
    expect(got.matchedGroups.sort()).toEqual(["admins", "ops"]);
    expect(await resolveGroupsToAccess("oidc", [])).toEqual({ roleId: null, matchedGroups: [] });
    expect(await resolveGroupsToAccess("local", ["ops"])).toEqual({ roleId: null, matchedGroups: [] });
  });
});

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

describe("session settings", () => {
  it("parses with defaults and clamps the idle timeout", () => {
    expect(parseSessionSettings(null)).toEqual({ autoLogoutMinutes: 0, skipLoginPage: false });
    expect(parseSessionSettings({ autoLogoutMinutes: 5000, skipLoginPage: true })).toEqual({ autoLogoutMinutes: 1440, skipLoginPage: true });
    expect(clampAutoLogout(-3, 30)).toBe(0);
    expect(clampAutoLogout("abc", 30)).toBe(30);
  });
});

describe("TOTP", () => {
  it("returns the matched time step and rejects malformed codes", () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp: now });
    expect(verifyCodeStep(secret, code, now)).toBe(Math.floor(now / 30_000));
    expect(verifyCodeStep(secret, "12345", now)).toBeNull();
    expect(verifyCodeStep(secret, code, now + 10 * 60_000)).toBeNull();
  });

  it("claims a step once (replay refused)", async () => {
    prisma.user = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }) };
    expect(await claimTotpStep("u", 100)).toBe(true);
    expect(await claimTotpStep("u", 100)).toBe(false);
  });

  it("consumes a backup code exactly once", async () => {
    const { plaintext, hashes } = await generateBackupCodes();
    expect(plaintext).toHaveLength(10);
    const left = await consumeBackupCode(hashes, plaintext[3].toLowerCase());
    expect(left).toHaveLength(9);
    expect(await consumeBackupCode(left!, plaintext[3])).toBeNull();
  });

  it("only local accounts owe a second factor", () => {
    expect(resolveSecondFactors({ authProvider: "local", totpEnabledAt: new Date() }, false)).toEqual({ totp: true, passkey: false });
    expect(resolveSecondFactors({ authProvider: "oidc", totpEnabledAt: new Date() }, true)).toEqual({ totp: false, passkey: false });
  });
});

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

describe("roles", () => {
  it("validates names and colours", () => {
    expect(validateRoleName("  Help Desk ")).toBe("Help Desk");
    expect(() => validateRoleName("x")).toThrow();
    expect(() => validateRoleName("bad/name")).toThrow();
    expect(normalizeRoleColor("#AABBCC")).toBe("#aabbcc");
    expect(normalizeRoleColor("")).toBeNull();
    expect(() => normalizeRoleColor("red")).toThrow();
  });

  it("refuses taking admin-equivalence from the last admin role, and from a non-admin caller", async () => {
    prisma.role = { findMany: vi.fn().mockResolvedValue([{ id: "a", permissions: ADMIN }, { id: "b", permissions: OPERATOR }]) };
    prisma.user = { count: vi.fn().mockResolvedValue(0) };
    await expect(assertRoleDemotionAllowed("a", ADMIN, false, false)).rejects.toThrow(/admin-equivalent caller/);
    await expect(assertRoleDemotionAllowed("a", ADMIN, false, true)).rejects.toThrow(/leave no account/);
    await expect(assertRoleDemotionAllowed("b", OPERATOR, false, false)).resolves.toBeUndefined();
    await expect(assertRoleDemotionAllowed("a", ADMIN, true, false)).resolves.toBeUndefined();
  });

  it("counts admin-equivalent users across admin roles only", async () => {
    prisma.role = { findMany: vi.fn().mockResolvedValue([{ id: "a", permissions: ADMIN }, { id: "b", permissions: OPERATOR }]) };
    prisma.user = { count: vi.fn().mockResolvedValue(2) };
    expect(await countAdminEquivalentUsers("me")).toBe(2);
    expect(prisma.user.count.mock.calls[0][0].where).toEqual({ roleId: { in: ["a"] }, NOT: { id: "me" } });
  });
});

describe("session revocation", () => {
  it("is best effort", async () => {
    prisma.$executeRaw = vi.fn().mockResolvedValue(3);
    expect(await revokeUserSessions("u", "keep")).toBe(3);
    prisma.$executeRaw = vi.fn().mockRejectedValue(new Error("no table"));
    expect(await revokeUserSessions("u")).toBe(0);
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ uid: "a" }, { uid: null }]);
    expect([...(await getOnlineUserIds())]).toEqual(["a"]);
  });
});
