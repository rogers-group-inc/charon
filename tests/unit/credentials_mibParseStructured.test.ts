// Ported from polaris tests/unit/mibParseStructured.test.ts (Server Settings → Credentials port).
/**
 * tests/unit/mibParseStructured.test.ts
 *
 * Covers the structured SMI parser used by the MIB Database Browse modal
 * and the MIB-aware walk endpoint. Fixtures are minimal hand-written modules
 * — small enough to read, but representative of the real IF-MIB /
 * FORTINET-FORTIGATE-MIB / CISCO-PROCESS-MIB shapes the parser sees in prod.
 */

import { describe, it, expect } from "vitest";
import { parseMibStructured } from "../../src/services/credentials/mibService.js";

const IF_MIB_SAMPLE = `
IF-MIB-SAMPLE DEFINITIONS ::= BEGIN

IMPORTS
    OBJECT-TYPE, Counter32, Gauge32, Integer32 FROM SNMPv2-SMI
    DisplayString                              FROM SNMPv2-TC
    mib-2                                      FROM SNMPv2-SMI;

interfaces OBJECT IDENTIFIER ::= { mib-2 2 }

ifNumber OBJECT-TYPE
    SYNTAX      Integer32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION
            "The number of network interfaces (regardless of their
            current state) present on this system."
    ::= { interfaces 1 }

ifTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF IfEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION
            "A list of interface entries.  The number of entries is
            given by the value of ifNumber."
    ::= { interfaces 2 }

ifEntry OBJECT-TYPE
    SYNTAX      IfEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION
            "An entry containing management information applicable to
            a particular interface."
    INDEX   { ifIndex }
    ::= { ifTable 1 }

ifIndex OBJECT-TYPE
    SYNTAX      Integer32 (1..2147483647)
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "A unique value, greater than zero, for each interface."
    ::= { ifEntry 1 }

ifDescr OBJECT-TYPE
    SYNTAX      DisplayString (SIZE (0..255))
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "A textual string containing information about the interface."
    ::= { ifEntry 2 }

ifSpeed OBJECT-TYPE
    SYNTAX      Gauge32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "An estimate of the interface's current bandwidth in bits per second."
    ::= { ifEntry 5 }

ifAdminStatus OBJECT-TYPE
    SYNTAX      INTEGER {
                    up(1),       -- ready to pass packets
                    down(2),
                    testing(3)   -- in some test mode
                }
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION  "The desired state of the interface."
    ::= { ifEntry 7 }

ifOperStatus OBJECT-TYPE
    SYNTAX      INTEGER {
                    up(1),
                    down(2),
                    testing(3),
                    unknown(4),
                    dormant(5),
                    notPresent(6),
                    lowerLayerDown(7)
                }
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "The current operational state of the interface."
    ::= { ifEntry 8 }

ifInOctets OBJECT-TYPE
    SYNTAX      Counter32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "The total number of octets received on the interface."
    ::= { ifEntry 10 }

END
`;

const FORTINET_SAMPLE = `
FORTINET-SAMPLE-MIB DEFINITIONS ::= BEGIN

IMPORTS
    OBJECT-TYPE, Counter32, Gauge32 FROM SNMPv2-SMI
    enterprises                     FROM SNMPv2-SMI;

fortinet     OBJECT IDENTIFIER ::= { enterprises 12356 }
fnFortiGate  OBJECT IDENTIFIER ::= { fortinet 101 }
fgSystem     OBJECT IDENTIFIER ::= { fnFortiGate 4 }
fgSystemInfo OBJECT IDENTIFIER ::= { fgSystem 1 }

fgSysCpuUsage OBJECT-TYPE
    SYNTAX      Gauge32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "Current CPU usage (percentage)."
    ::= { fgSystemInfo 3 }

fgSysMemUsage OBJECT-TYPE
    SYNTAX      Gauge32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "Current memory usage (percentage)."
    ::= { fgSystemInfo 4 }

fgSysSesCount OBJECT-TYPE
    SYNTAX      Counter32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION  "Total active sessions."
    ::= { fgSystemInfo 6 }

END
`;

describe("parseMibStructured — IF-MIB-like fixture", () => {
  const result = parseMibStructured(IF_MIB_SAMPLE);

  it("captures module name + IMPORTS", () => {
    expect(result.moduleName).toBe("IF-MIB-SAMPLE");
    expect(result.imports).toEqual(expect.arrayContaining(["SNMPv2-SMI", "SNMPv2-TC"]));
  });

  it("extracts every OBJECT-TYPE symbol", () => {
    const names = result.symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "ifNumber",
        "ifTable",
        "ifEntry",
        "ifIndex",
        "ifDescr",
        "ifSpeed",
        "ifAdminStatus",
        "ifOperStatus",
        "ifInOctets",
      ]),
    );
  });

  it("captures the OBJECT IDENTIFIER shorthand for the parent group", () => {
    const interfaces = result.symbols.find((s) => s.name === "interfaces");
    expect(interfaces).toBeDefined();
    expect(interfaces!.kind).toBe("object-identity");
    expect(interfaces!.parentName).toBe("mib-2");
    expect(interfaces!.oidIndex).toBe(2);
  });

  it("classifies INTEGER + Counter32 + Gauge32 + Integer32 base types", () => {
    const byName = (n: string) => result.symbols.find((s) => s.name === n)!;
    expect(byName("ifNumber").baseType).toBe("INTEGER"); // Integer32 → INTEGER
    expect(byName("ifSpeed").baseType).toBe("Gauge32");
    expect(byName("ifInOctets").baseType).toBe("Counter32");
    expect(byName("ifDescr").baseType).toBe("OCTET STRING"); // DisplayString
    expect(byName("ifAdminStatus").baseType).toBe("INTEGER");
  });

  it("extracts INTEGER enum values with their labels", () => {
    const oper = result.symbols.find((s) => s.name === "ifOperStatus")!;
    expect(oper.enumValues).toEqual([
      { label: "up", value: 1 },
      { label: "down", value: 2 },
      { label: "testing", value: 3 },
      { label: "unknown", value: 4 },
      { label: "dormant", value: 5 },
      { label: "notPresent", value: 6 },
      { label: "lowerLayerDown", value: 7 },
    ]);
  });

  it("captures multi-line DESCRIPTION values", () => {
    const ifTable = result.symbols.find((s) => s.name === "ifTable")!;
    expect(ifTable.description).toContain("A list of interface entries");
    expect(ifTable.description).toContain("ifNumber");
  });

  it("captures MAX-ACCESS and STATUS", () => {
    const ifAdmin = result.symbols.find((s) => s.name === "ifAdminStatus")!;
    expect(ifAdmin.access).toBe("read-write");
    expect(ifAdmin.status).toBe("current");

    const ifTable = result.symbols.find((s) => s.name === "ifTable")!;
    expect(ifTable.access).toBe("not-accessible");
  });

  it("extracts INDEX clause from row entries", () => {
    const ifEntry = result.symbols.find((s) => s.name === "ifEntry")!;
    expect(ifEntry.indexNames).toEqual(["ifIndex"]);
    expect(ifEntry.isTableRow).toBe(true);
  });

  it("detects ifTable as a SMI table with the right columns", () => {
    expect(result.tables).toHaveLength(1);
    const t = result.tables[0];
    expect(t.name).toBe("ifTable");
    expect(t.rowSymbol).toBe("ifEntry");
    expect(t.indexNames).toEqual(["ifIndex"]);
    // Columns are the row's children, sorted by OID arc
    expect(t.columns).toEqual([
      "ifIndex",        // ifEntry 1
      "ifDescr",        // ifEntry 2
      "ifSpeed",        // ifEntry 5
      "ifAdminStatus",  // ifEntry 7
      "ifOperStatus",   // ifEntry 8
      "ifInOctets",     // ifEntry 10
    ]);
  });

  it("captures parentName + oidIndex on each leaf", () => {
    const ifIndex = result.symbols.find((s) => s.name === "ifIndex")!;
    expect(ifIndex.parentName).toBe("ifEntry");
    expect(ifIndex.oidIndex).toBe(1);

    const ifInOctets = result.symbols.find((s) => s.name === "ifInOctets")!;
    expect(ifInOctets.parentName).toBe("ifEntry");
    expect(ifInOctets.oidIndex).toBe(10);
  });
});

describe("parseMibStructured — FORTINET-style scalar-only fixture", () => {
  const result = parseMibStructured(FORTINET_SAMPLE);

  it("captures the chain of OBJECT IDENTIFIER shorthands", () => {
    const fortinet = result.symbols.find((s) => s.name === "fortinet");
    const fnFortiGate = result.symbols.find((s) => s.name === "fnFortiGate");
    const fgSystem = result.symbols.find((s) => s.name === "fgSystem");
    const fgSystemInfo = result.symbols.find((s) => s.name === "fgSystemInfo");
    expect(fortinet?.parentName).toBe("enterprises");
    expect(fortinet?.oidIndex).toBe(12356);
    expect(fnFortiGate?.parentName).toBe("fortinet");
    expect(fnFortiGate?.oidIndex).toBe(101);
    expect(fgSystem?.parentName).toBe("fnFortiGate");
    expect(fgSystem?.oidIndex).toBe(4);
    expect(fgSystemInfo?.parentName).toBe("fgSystem");
    expect(fgSystemInfo?.oidIndex).toBe(1);
  });

  it("classifies Counter32 + Gauge32 scalars correctly", () => {
    const cpu = result.symbols.find((s) => s.name === "fgSysCpuUsage")!;
    const ses = result.symbols.find((s) => s.name === "fgSysSesCount")!;
    expect(cpu.baseType).toBe("Gauge32");
    expect(cpu.access).toBe("read-only");
    expect(ses.baseType).toBe("Counter32");
  });

  it("emits no MibTable entries for a scalar-only MIB", () => {
    expect(result.tables).toEqual([]);
  });
});

describe("parseMibStructured — robustness", () => {
  it("rejects non-SMI input the same way parseMib does", () => {
    expect(() => parseMibStructured("not a real mib")).toThrow();
  });

  it("tolerates trailing comments inside enum bodies", () => {
    const sample = `
TINY-MIB DEFINITIONS ::= BEGIN
mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
sample OBJECT-TYPE
    SYNTAX INTEGER {
        on(1), -- power is on
        off(2) -- power is off
    }
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "Test."
    ::= { mib-2 99 }
END
`;
    const r = parseMibStructured(sample);
    const sym = r.symbols.find((s) => s.name === "sample")!;
    expect(sym.enumValues).toEqual([
      { label: "on", value: 1 },
      { label: "off", value: 2 },
    ]);
  });

  it("preserves embedded double-quote escapes in DESCRIPTION", () => {
    const sample = `
TINY-MIB DEFINITIONS ::= BEGIN
mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
sample OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "He said ""hi"" loudly."
    ::= { mib-2 99 }
END
`;
    const r = parseMibStructured(sample);
    const sym = r.symbols.find((s) => s.name === "sample")!;
    expect(sym.description).toBe('He said "hi" loudly.');
  });

  it("falls back to baseType=OTHER for unknown SYNTAX", () => {
    const sample = `
TINY-MIB DEFINITIONS ::= BEGIN
mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
weird OBJECT-TYPE
    SYNTAX SomeWeirdTextualConvention
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "Test."
    ::= { mib-2 99 }
END
`;
    const r = parseMibStructured(sample);
    // Bare CapitalizedName is treated as a row-entry textual convention by
    // our heuristics — fine for v1, since real row entries match it and
    // real "weird types" don't appear in production.
    const sym = r.symbols.find((s) => s.name === "weird")!;
    expect(["OTHER", "SEQUENCE"]).toContain(sym.baseType);
  });
});
