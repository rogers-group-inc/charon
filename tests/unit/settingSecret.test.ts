/** utils/settingSecret.ts — a sealed secret inside a JSON Setting row. */
import { describe, it, expect, beforeAll } from "vitest";
import { sealSettingSecret, openSettingSecret, maskSettingSecret, nextSettingSecret } from "../../src/utils/settingSecret.ts";
import { SECRET_MASK, isEncryptedEnvelope } from "../../src/utils/crypto.ts";

beforeAll(() => {
  process.env.CHARON_DATA_KEY = Buffer.alloc(32, 3).toString("base64");
});

describe("settingSecret", () => {
  it("seals, opens and masks; reads a legacy plaintext value", () => {
    const sealed = sealSettingSecret("s3cret");
    expect(isEncryptedEnvelope(sealed)).toBe(true);
    expect(openSettingSecret(sealed)).toBe("s3cret");
    expect(openSettingSecret("legacy-plain")).toBe("legacy-plain");
    expect(sealSettingSecret("")).toBe("");
    expect(maskSettingSecret(sealed)).toBe(SECRET_MASK);
    expect(maskSettingSecret("")).toBe("");
  });

  it("keeps the stored secret on an echoed mask or an omitted field; replaces or clears otherwise", () => {
    const cur = sealSettingSecret("old");
    const dest = [{ label: "server URL", current: "ldap://a", incoming: undefined }];
    expect(nextSettingSecret(cur, SECRET_MASK, dest, "bind password")).toBe(cur);
    expect(nextSettingSecret(cur, undefined, dest, "bind password")).toBe(cur);
    expect(openSettingSecret(nextSettingSecret(cur, " new ", dest, "bind password"))).toBe("new");
    expect(nextSettingSecret(cur, "", dest, "bind password")).toBe("");
  });

  it("never lets a kept secret follow a changed destination (business rule 3b)", () => {
    const cur = sealSettingSecret("old");
    expect(() =>
      nextSettingSecret(cur, SECRET_MASK, [{ label: "server URL", current: "ldap://a", incoming: "ldap://evil" }], "bind password"),
    ).toThrow(/server URL changed/);
    // Same destination re-sent verbatim is not a move.
    expect(nextSettingSecret(cur, SECRET_MASK, [{ label: "server URL", current: "ldap://a", incoming: " ldap://a " }], "x")).toBe(cur);
    // A new secret typed alongside a new destination is fine.
    expect(openSettingSecret(nextSettingSecret(cur, "fresh", [{ label: "server URL", current: "ldap://a", incoming: "ldap://b" }], "x"))).toBe("fresh");
  });
});
