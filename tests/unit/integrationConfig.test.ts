import { describe, it, expect, beforeAll } from "vitest";
import { writeConfig, readConfigMasked, decryptConfig } from "../../src/services/integrationConfig.ts";
import { isEncryptedEnvelope, SECRET_MASK } from "../../src/utils/crypto.ts";

beforeAll(() => {
  process.env.CHARON_DATA_KEY = Buffer.alloc(32, 9).toString("base64");
});

describe("integration config secrets", () => {
  it("encrypts secret fields at rest, leaves non-secrets plaintext", () => {
    const stored = writeConfig("entraid", null, { tenantId: "t1", clientId: "c1", clientSecret: "s3cr3t" });
    expect(stored.tenantId).toBe("t1");
    expect(isEncryptedEnvelope(stored.clientSecret as string)).toBe(true);
  });

  it("masks secrets on read", () => {
    const stored = writeConfig("fortigate", null, { host: "fw", apiToken: "abc123" });
    const masked = readConfigMasked("fortigate", stored);
    expect(masked.host).toBe("fw");
    expect(masked.apiToken).toBe(SECRET_MASK);
  });

  it("preserves the stored secret when the mask is resubmitted (preserved-on-unchanged)", () => {
    const stored = writeConfig("fortigate", null, { host: "fw", apiToken: "abc123" });
    const updated = writeConfig("fortigate", stored, { host: "fw2", apiToken: SECRET_MASK });
    expect(updated.host).toBe("fw2");
    expect(updated.apiToken).toBe(stored.apiToken); // unchanged ciphertext
    expect(decryptConfig("fortigate", updated).apiToken).toBe("abc123");
  });

  it("round-trips a secret through decrypt", () => {
    const stored = writeConfig("activedirectory", null, { bindDn: "cn=svc", bindPassword: "p@ss" });
    expect(decryptConfig("activedirectory", stored).bindPassword).toBe("p@ss");
  });
});
