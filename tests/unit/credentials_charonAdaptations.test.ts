/**
 * tests/unit/credentials_charonAdaptations.test.ts — the pieces of the
 * Server Settings → Credentials port that differ from polaris:
 *
 *   - safeRegex: native engine + RE2-syntax contract + catastrophic-shape refusal
 *     (polaris uses re2js, which Charon does not carry);
 *   - credential secrets sealed with Charon's AES-256-GCM envelopes at rest,
 *     opened on reveal, masked at the API, mask round-trip preserving them;
 *   - the MIB-walk decode helpers (verbatim polaris logic, now exported);
 *   - the bundled standard MIBs load from the copied stdMibs/ directory.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { safeRegexProblem, compileSafeRegex, hasNestedQuantifier } from "../../src/services/credentials/safeRegex.js";
import {
  sealSecrets,
  openSecrets,
  stripSecrets,
  mergeConfigPreservingSecrets,
  CREDENTIAL_TYPES,
} from "../../src/services/credentials/credentialService.js";
import { isEncryptedEnvelope } from "../../src/utils/crypto.js";
import { SECRET_MASK } from "../../src/services/credentials/secretMask.js";
import { decodeValue, formatTimeTicks, compareIndexSuffix, findSymbolForOid } from "../../src/api/routes/settings/credentials.js";
import { listStdMibs, getStdMibStructure } from "../../src/services/credentials/stdMibLibrary.js";
import { snmpVarbindToPrintable } from "../../src/services/credentials/credentialProbeService.js";

beforeAll(() => {
  process.env.CHARON_DATA_KEY = randomBytes(32).toString("base64");
});

describe("safeRegex (Charon engine)", () => {
  it("accepts ordinary operator patterns and matches like RegExp", () => {
    expect(safeRegexProblem("^FortiSwitch\\s+(\\S+)$", { ignoreCase: true })).toBeNull();
    const re = compileSafeRegex("S(\\d+)", { ignoreCase: true });
    expect(re.exec("model s548df")).toEqual(["s548", "548"]);
    expect(re.test("nothing")).toBe(false);
    expect(re.execAll("S1 S22").map((m) => m.index)).toEqual([0, 3]);
  });

  it("refuses lookaround and backreferences (RE2 syntax contract)", () => {
    expect(safeRegexProblem("foo(?=bar)")).toMatch(/lookahead or lookbehind/);
    expect(safeRegexProblem("(?<!x)y")).toMatch(/lookahead or lookbehind/);
    expect(safeRegexProblem("(a)\\1")).toMatch(/backreference/);
  });

  it("refuses the nested-quantifier shapes at validation time", () => {
    expect(hasNestedQuantifier("(a+)+b")).toBe(true);
    expect(hasNestedQuantifier("(.*)*x")).toBe(true);
    expect(hasNestedQuantifier("(\\w+\\s?){2,}")).toBe(true);
    expect(hasNestedQuantifier("(ab)+c")).toBe(false);
    expect(hasNestedQuantifier("[(a+)+]")).toBe(false);
    expect(hasNestedQuantifier("(a+)?b")).toBe(false);
    expect(safeRegexProblem("(a+)+b")).toMatch(/repeats a group/);
  });

  it("still compiles the ported MIB parser's own fixed patterns", () => {
    expect(() => compileSafeRegex(String.raw`([A-Z][A-Za-z0-9-]*)\s+DEFINITIONS(?:\s+[A-Z-]+)*\s*::=\s*BEGIN`)).not.toThrow();
  });

  it("reports an invalid pattern in operator words", () => {
    expect(safeRegexProblem("(unclosed")).toMatch(/Invalid regex/);
  });
});

describe("credential secrets at rest", () => {
  it("seals only the type's secret fields and opens them back", () => {
    const cfg = { version: "v3", username: "mon", securityLevel: "authPriv", authProtocol: "SHA", authKey: "a-key", privProtocol: "AES", privKey: "p-key" };
    const sealed = sealSecrets("snmp", cfg);
    expect(sealed.username).toBe("mon");
    expect(isEncryptedEnvelope(sealed.authKey)).toBe(true);
    expect(isEncryptedEnvelope(sealed.privKey)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("a-key");
    expect(openSecrets("snmp", sealed)).toEqual(cfg);
  });

  it("does not double-seal and passes legacy plaintext through on open", () => {
    const once = sealSecrets("winrm", { username: "u", password: "pw" });
    expect(sealSecrets("winrm", once).password).toBe(once.password);
    expect(openSecrets("winrm", { username: "u", password: "plain" }).password).toBe("plain");
  });

  it("masks sealed secrets at the API boundary", () => {
    const sealed = sealSecrets("ssh", { username: "u", password: "pw", privateKey: "KEY", passphrase: "" });
    const out = stripSecrets({ id: "x", name: "n", type: "ssh", config: sealed, createdBy: null, createdAt: new Date(), updatedAt: new Date() });
    expect(out.config.password).toBe(SECRET_MASK);
    expect(out.config.privateKey).toBe(SECRET_MASK);
    expect(out.config.passphrase).toBe("");
    expect(out.config.username).toBe("u");
  });

  it("a resubmitted mask keeps the stored secret on merge", () => {
    const merged = mergeConfigPreservingSecrets("restapi", { baseUrl: "https://a", apiToken: "real" }, { baseUrl: "https://b", apiToken: SECRET_MASK });
    expect(merged).toEqual({ baseUrl: "https://b", apiToken: "real" });
  });

  it("covers exactly polaris's credential types", () => {
    expect([...CREDENTIAL_TYPES].sort()).toEqual(["http", "restapi", "snmp", "ssh", "winrm"]);
  });
});

describe("MIB walk decode helpers", () => {
  const sym = (name: string, fullOid: string, extra: Record<string, unknown> = {}) => ({ name, fullOid, ...extra }) as any;

  it("names an INTEGER enum and renders TimeTicks", () => {
    expect(decodeValue("1", sym("ifOperStatus", "1.3.6.1.2.1.2.2.1.8", { enumValues: [{ label: "up", value: 1 }] }), "Integer")).toBe("up(1)");
    expect(decodeValue("8640000", null, "TimeTicks")).toBe("1d 0h 0m 0s");
    expect(formatTimeTicks(6100)).toBe("1m 1s");
  });

  it("picks the longest symbol OID prefix and its index suffix", () => {
    const syms = [sym("ifTable", "1.3.6.1.2.1.2.2"), sym("ifDescr", "1.3.6.1.2.1.2.2.1.2")];
    expect(findSymbolForOid("1.3.6.1.2.1.2.2.1.2.10", syms)).toEqual({ symbol: syms[1], suffix: "10" });
    expect(findSymbolForOid("1.3.6.1.4", syms)).toBeNull();
  });

  it("orders index suffixes numerically", () => {
    expect(["10", "2", "1.5", "1.10"].sort(compareIndexSuffix)).toEqual(["1.5", "1.10", "2", "10"]);
  });

  it("prints octet strings as text, else hex", () => {
    expect(snmpVarbindToPrintable({ type: 4, value: Buffer.from("FortiGate ") })).toBe("FortiGate");
    expect(snmpVarbindToPrintable({ type: 4, value: Buffer.from([0x00, 0xab]) })).toBe("00 AB");
  });
});

describe("bundled standard MIBs", () => {
  it("load from stdMibs/ and resolve symbols", () => {
    const keys = listStdMibs().map((m) => m.key);
    expect(keys.length).toBeGreaterThan(0);
    const st = getStdMibStructure(keys[0]);
    expect(st.symbols.length).toBeGreaterThan(0);
    expect(st.symbols.some((s) => s.fullOid)).toBe(true);
  });
});
