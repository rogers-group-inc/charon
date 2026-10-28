/**
 * services/ssoProvisioning.ts — find-or-provision for SAML / OIDC / LDAP / App
 * Proxy, and services/ssoProbe.ts's SSRF guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: {} as Record<string, any> }));
vi.mock("../../src/db.ts", () => ({ prisma }));
vi.mock("../../src/db.js", () => ({ prisma }));
vi.mock("../../src/services/eventService.js", () => ({ logEvent: vi.fn() }));

import { provisionExternalUser, deriveUsername, normalizeGroupList } from "../../src/services/ssoProvisioning.ts";
import { invalidateGroupMappingCache } from "../../src/services/groupMappingService.ts";
import { probeIdpUrl } from "../../src/services/ssoProbe.ts";

const READ_ONLY = { id: "r-ro", name: "Read-Only" };

beforeEach(() => {
  for (const k of Object.keys(prisma)) delete prisma[k];
  invalidateGroupMappingCache();
  prisma.groupMapping = { findMany: vi.fn().mockResolvedValue([{ groupKey: "cn=ops,dc=x", roleId: "r-op" }]) };
  prisma.role = {
    findUnique: vi.fn(async ({ where }: any) => (where.name === "Read-Only" ? READ_ONLY : where.id ? { id: where.id } : null)),
    findMany: vi.fn().mockResolvedValue([]),
  };
  prisma.user = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(async ({ data }: any) => ({ id: "new", ...data })),
    update: vi.fn(async ({ data }: any) => ({ id: "old", ...data })),
  };
});

describe("ssoProvisioning", () => {
  it("derives a safe username", () => {
    expect(deriveUsername("Jane.Doe@Example.com", "oidc", "abc")).toBe("jane.doe");
    expect(deriveUsername("", "ldap", "12345678abcd")).toBe("ldap-12345678");
    expect(normalizeGroupList("ldap", ["CN=Ops", "cn=ops", " ", "CN=Dev"])).toEqual(["cn=ops", "cn=dev"]);
  });

  it("creates a mapped account on its mapped role, no password, no review flag", async () => {
    const u = await provisionExternalUser({
      provider: "ldap", externalIdField: "ldapUid", externalId: "guid-1", usernameHint: "jdoe", groups: ["CN=Ops,DC=X"],
    });
    expect(u.roleId).toBe("r-op");
    expect(u.passwordHash).toBeNull();
    expect(u.needsRoleReview).toBe(false);
    expect(u.ssoGroups).toEqual(["cn=ops,dc=x"]);
  });

  it("falls back to Read-Only + needsRoleReview when no group maps", async () => {
    const u = await provisionExternalUser({ provider: "oidc", externalIdField: "oidcSubject", externalId: "sub-1", usernameHint: "x@y", groups: [] });
    expect(u.roleId).toBe("r-ro");
    expect(u.needsRoleReview).toBe(true);
  });

  it("keeps an existing user's role when nothing maps, and suffixes a colliding new username", async () => {
    prisma.user.findFirst = vi.fn().mockResolvedValue({ id: "old", roleId: "r-manual", displayName: null, email: null, role: {} });
    const kept = await provisionExternalUser({ provider: "saml", externalIdField: "azureOid", externalId: "oid", usernameHint: "a@b", groups: [] });
    expect(kept.roleId).toBe("r-manual");

    prisma.user.findFirst = vi.fn().mockResolvedValue(null);
    prisma.user.findUnique = vi.fn().mockResolvedValueOnce({ id: "taken" }).mockResolvedValueOnce(null);
    const made = await provisionExternalUser({ provider: "saml", externalIdField: "azureOid", externalId: "oid2", usernameHint: "admin@corp", groups: [] });
    expect(made.username).toBe("admin-saml");
  });

  it("refuses a profile with no stable id", async () => {
    await expect(provisionExternalUser({ provider: "oidc", externalIdField: "oidcSubject", externalId: "", usernameHint: "x", groups: [] }))
      .rejects.toThrow(/missing stable user identifier/);
  });
});

describe("ssoProbe", () => {
  it("refuses non-http schemes and blocked hosts without connecting", async () => {
    expect((await probeIdpUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await probeIdpUrl("http://169.254.169.254/latest")).message).toMatch(/blocked range/);
    expect((await probeIdpUrl("not a url")).ok).toBe(false);
  });
});
