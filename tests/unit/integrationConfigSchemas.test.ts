/**
 * tests/unit/integrationConfigSchemas.test.ts — the per-type config schemas in
 * src/api/routes/integrations.ts (parseConfig).
 *
 * z.object strips unknown keys. In polaris that silently dropped fields the
 * modal posted but a schema forgot (Entra's includeDisabled, FortiGate's push
 * toggles) on create while the unvalidated update path kept them. Charon parses
 * create AND update with the same schema, so these tests pin what each type keeps.
 */

import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/api/routes/integrations.js";

describe("integration config schemas", () => {
  it("keeps every field the services read, per type", () => {
    const fmg = parseConfig("fortimanager", {
      host: "10.0.0.1", port: 443, apiUser: "api", apiToken: "t", adom: "root", verifySsl: false,
      mgmtInterface: "mgmt", deviceInclude: ["br-*"], deviceExclude: [], useProxy: false,
      fortigateApiUser: "gate", fortigateApiToken: "g", fortigateVerifySsl: false,
    });
    expect(fmg).toMatchObject({ useProxy: false, fortigateApiToken: "g", mgmtInterface: "mgmt", deviceInclude: ["br-*"] });

    const entra = parseConfig("entraid", { tenantId: "t", clientId: "c", clientSecret: "s", enableIntune: true, includeDisabled: false, publishToIntune: true });
    expect(entra).toMatchObject({ enableIntune: true, includeDisabled: false, publishToIntune: true });

    const ad = parseConfig("activedirectory", { host: "dc1", bindDn: "cn=x", bindPassword: "p", baseDn: "dc=x", ouInclude: ["*OU=Staff*"], searchScope: "one" });
    expect(ad).toMatchObject({ ouInclude: ["*OU=Staff*"], searchScope: "one" });
  });

  it("strips polaris-only inventory / monitoring fields", () => {
    const fgt = parseConfig("fortigate", { host: "fw", apiToken: "t", pushReservations: true, pullSdwan: true, fortigateMonitor: {} });
    expect(fgt).toEqual({ host: "fw", apiToken: "t" });
  });

  it("refuses a host in a blocked range (SSRF guard)", () => {
    expect(() => parseConfig("fortigate", { host: "127.0.0.1" })).toThrow(/blocked range/);
    expect(() => parseConfig("fortimanager", { host: "169.254.169.254" })).toThrow(/blocked range/);
    expect(() => parseConfig("activedirectory", { host: "localhost" })).toThrow(/blocked range/);
    // An RFC1918 LAN device stays allowed.
    expect(parseConfig("fortigate", { host: "192.168.1.1" }).host).toBe("192.168.1.1");
  });

  it("does not accept a removed type", () => {
    expect(() => parseConfig("intune", {})).toThrow(/Unknown integration type/);
    expect(() => parseConfig("azurearc", {})).toThrow(/Unknown integration type/);
  });
});
