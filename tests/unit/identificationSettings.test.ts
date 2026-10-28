/**
 * Server Settings → Identification: pure logic behind the ported routes
 * (OUI CSV parse, PTR names, tag colour + device-filter validation, device
 * icon content checks, the charon regex guard on device-type rules).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const { parseCsv, normalizeMacPrefix } = await import("../../src/services/ouiService.js");
const { ipToPtrName, isValidIpAddress } = await import("../../src/services/dnsService.js");
const { normalizeTagColor, normalizeTagCondition, readPostedTagFilter, tagFilterView } =
  await import("../../src/services/assetTagService.js");
const { validateUploadContent } = await import("../../src/services/deviceIconService.js");
const { validateMatchRules, clauseMatches } = await import("../../src/utils/assetTypeMatch.js");
const { isValidCidr, parseIpv4Range, deviceFilterConditionMeta } = await import("../../src/utils/deviceFilterCondition.js");

describe("OUI database", () => {
  it("parses the IEEE CSV, honouring quoted commas and skipping the header", () => {
    const csv = [
      "Registry,Assignment,Organization Name,Organization Address",
      'MA-L,00090F,"Fortinet, Inc.","899 Kifer Road Sunnyvale CA US 94086"',
      "MA-L,2c549a,Example Corp,Somewhere",
      "MA-L,ZZZZZZ,Bad Row,Nowhere",
      "",
    ].join("\n");
    const map = parseCsv(csv);
    expect(map.get("00090F")).toBe("Fortinet, Inc.");
    expect(map.get("2C549A")).toBe("Example Corp");
    expect(map.size).toBe(2);
  });

  it("normalizes any MAC spelling to its 3-byte prefix", () => {
    expect(normalizeMacPrefix("00:09:0f:aa:bb:cc")).toBe("00090F");
    expect(normalizeMacPrefix("00-09-0F")).toBe("00090F");
    expect(normalizeMacPrefix("0009.0faa.bbcc")).toBe("00090F");
    expect(normalizeMacPrefix("0009")).toBeNull();
  });
});

describe("DNS helpers", () => {
  it("builds PTR names for v4 and v6", () => {
    expect(ipToPtrName("8.8.4.4")).toBe("4.4.8.8.in-addr.arpa");
    expect(ipToPtrName("2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
    );
  });

  it("recognizes IP literals only", () => {
    expect(isValidIpAddress("10.0.0.1")).toBe(true);
    expect(isValidIpAddress("fd00::5")).toBe(true);
    expect(isValidIpAddress("999.1.1.1")).toBe(false);
    expect(isValidIpAddress("dns.google")).toBe(false);
  });
});

describe("asset tags", () => {
  it("accepts hex and severity colours, refuses anything else", () => {
    expect(normalizeTagColor("#ABCDEF")).toBe("#abcdef");
    expect(normalizeTagColor("#abc")).toBe("#abc");
    expect(normalizeTagColor("severity:warning")).toBe("severity:warning");
    for (const bad of ["red", "#12345", "severity:bogus", "url(x)", 7]) {
      expect(() => normalizeTagColor(bad)).toThrow();
    }
  });

  it("collapses an empty tree to null — never 'all devices'", () => {
    expect(normalizeTagCondition(null)).toBeNull();
    expect(normalizeTagCondition({ op: "and", children: [] })).toBeNull();
    expect(normalizeTagCondition({ op: "or", children: [{ op: "and", children: [] }] })).toBeNull();
  });

  it("validates fields, operators and value shapes", () => {
    const ok = { op: "and", children: [
      { field: "hostname", operator: "matches", value: "PLV*-61F-?" },
      { field: "subnet", operator: "inCidr", value: "10.20.0.0/16" },
      { field: "subnet", operator: "inRange", value: "10.0.0.10-50" },
      { field: "nativeVlan", operator: "equals", value: "30" },
    ] };
    expect(normalizeTagCondition(ok)).toEqual(ok);
    const bad = (child: unknown) => () => normalizeTagCondition({ op: "and", children: [child] });
    expect(bad({ field: "bogus", operator: "equals", value: "x" })).toThrow(/invalid/);
    expect(bad({ field: "tag", operator: "contains", value: "x" })).toThrow(/not valid for field/);
    expect(bad({ field: "subnet", operator: "inCidr", value: "10.0.0.0/99" })).toThrow(/CIDR/);
    expect(bad({ field: "nativeVlan", operator: "equals", value: "5000" })).toThrow(/VLAN/);
    expect(bad({ field: "hostname", operator: "equals", value: "x", extra: 1 })).toThrow();
  });

  it("refuses nesting deeper than the cap", () => {
    let tree: any = { op: "and", children: [{ field: "os", operator: "contains", value: "x" }] };
    for (let i = 0; i < 6; i++) tree = { op: "and", children: [tree] };
    expect(() => normalizeTagCondition(tree)).toThrow(/nest/);
  });

  it("reads a posted body: absent = untouched, legacy criteria refused", () => {
    expect(readPostedTagFilter({})).toEqual({ provided: false, condition: null });
    expect(readPostedTagFilter({ assetCondition: null })).toEqual({ provided: true, condition: null });
    expect(() => readPostedTagFilter({ criteria: { rules: [] } })).toThrow(/criteria/);
  });

  it("a stored tree that no longer validates reads as manual, not a 500", () => {
    expect(tagFilterView({ assetCondition: { op: "xor", children: [] } }).assetCondition).toBeNull();
  });

  it("publishes a builder catalog with charon's agent label", () => {
    const meta = deviceFilterConditionMeta();
    expect(meta.fields.find((f) => f.field === "agentInstalled")?.label).toBe("Charon Agent installed");
    expect(meta.fields.some((f) => f.field === "assetId")).toBe(false);
  });

  it("CIDR / range helpers", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("2001:db8::/32")).toBe(true);
    expect(isValidCidr("10.0.0.0")).toBe(false);
    expect(parseIpv4Range("10.0.0.50-10.0.0.10")).toBeNull();
    expect(parseIpv4Range("10.0.0.10-50")).toEqual({ first: "10.0.0.10", last: "10.0.0.50" });
  });
});

describe("device icon upload validation", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

  it("accepts a real PNG and a plain SVG", () => {
    expect(() => validateUploadContent({ mimeType: "image/png", data: png })).not.toThrow();
    expect(() => validateUploadContent({ mimeType: "image/svg+xml", data: svg('<rect width="1" height="1"/>') })).not.toThrow();
  });

  it("rejects a declared type the bytes contradict", () => {
    expect(() => validateUploadContent({ mimeType: "image/jpeg", data: png })).toThrow(/image\/png/);
    expect(() => validateUploadContent({ mimeType: "image/png", data: Buffer.from("GIF89a") })).toThrow();
    expect(() => validateUploadContent({ mimeType: "image/gif", data: png })).toThrow(/Unsupported/);
  });

  it("rejects active / external SVG content", () => {
    for (const body of [
      "<script>alert(1)</script>",
      '<a href="javascript:alert(1)">x</a>',
      '<rect onload="x()"/>',
      '<image href="https://example.invalid/x.png"/>',
      "<foreignObject></foreignObject>",
      "<style>@import url(x);</style>",
    ]) {
      expect(() => validateUploadContent({ mimeType: "image/svg+xml", data: svg(body) }), body).toThrow(/SVG rejected/);
    }
    expect(() => validateUploadContent({ mimeType: "image/svg+xml", data: Buffer.from("<!DOCTYPE svg><svg/>") })).toThrow();
  });

  it("enforces the size caps", () => {
    const bigSvg = svg("<g>" + "x".repeat(33 * 1024) + "</g>");
    expect(() => validateUploadContent({ mimeType: "image/svg+xml", data: bigSvg })).toThrow(/too large/);
    const bigPng = Buffer.concat([png, Buffer.alloc(257 * 1024)]);
    expect(() => validateUploadContent({ mimeType: "image/png", data: bigPng })).toThrow(/too large/);
  });
});

describe("device-type rules: charon regex guard (no RE2)", () => {
  it("refuses nested quantifiers that backtrack catastrophically", () => {
    const rules = (value: string) => ({ op: "or", children: [{ field: "os", operator: "regex", value }] });
    expect(validateMatchRules(rules("(a+)+$"))).toMatch(/nests a quantifier/);
    expect(validateMatchRules(rules("(\\w*)*x"))).toMatch(/nests a quantifier/);
    expect(validateMatchRules(rules("[unclosed"))).toMatch(/Invalid regex/);
    expect(validateMatchRules(rules("\\b(fortigate|firewall)\\b"))).toBeNull();
  });

  it("clamps the subject it evaluates against", () => {
    const hit = clauseMatches({ field: "os", operator: "regex", value: "needle" }, { os: "x".repeat(2000) + "needle" });
    expect(hit).toBe(false);
  });
});
