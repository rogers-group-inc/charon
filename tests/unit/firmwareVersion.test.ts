/**
 * tests/unit/firmwareVersion.test.ts
 *
 * Ported from polaris (tests/unit/firmwareVersion.test.ts): the version and
 * image-identity rules the firmware repository stands on. The device-serial
 * cases are not ported — Charon has no inventory and no serial helpers.
 */

import { describe, it, expect } from "vitest";
import {
  parseFirmwareVersion,
  compareFirmwareVersions,
  isStrictlyNewer,
  formatFirmwareVersion,
  parseFortinetImageHeader,
  parseFortinetImageFilename,
  identifyFirmwareImage,
  IMAGE_HEADER_BYTES,
} from "../../src/utils/firmwareVersion.js";

function header(text: string): Buffer {
  // A real image has binary before and after the token; the parse must find it
  // anywhere in the first 512 bytes and ignore what follows.
  const buf = Buffer.alloc(IMAGE_HEADER_BYTES + 64, 0xff);
  buf.write("\u0000\u0001junk " + text + " more-junk", 17, "latin1");
  return buf;
}

describe("parseFirmwareVersion", () => {
  it("reads the full dotted form a device reports, with and without a build", () => {
    expect(parseFirmwareVersion("7.6.5")).toEqual({ major: 7, minor: 6, patch: 5 });
    expect(parseFirmwareVersion("v7.6.5")).toEqual({ major: 7, minor: 6, patch: 5 });
    expect(parseFirmwareVersion("FP432F-v7.6.5-build1105")).toEqual({ major: 7, minor: 6, patch: 5, build: 1105 });
    expect(parseFirmwareVersion("7.6.5,build1105")).toEqual({ major: 7, minor: 6, patch: 5, build: 1105 });
    expect(parseFirmwareVersion("v7.6.5 build 1105")).toEqual({ major: 7, minor: 6, patch: 5, build: 1105 });
  });
  it("falls back to the major+build filename shape", () => {
    expect(parseFirmwareVersion("FSW_108F_FPOE-v7-build1164-FORTINET.out")).toEqual({ major: 7, build: 1164 });
    expect(parseFirmwareVersion("v7.6-build1164")).toEqual({ major: 7, minor: 6, build: 1164 });
  });
  it("returns null for nothing version-shaped", () => {
    expect(parseFirmwareVersion("")).toBeNull();
    expect(parseFirmwareVersion(null)).toBeNull();
    expect(parseFirmwareVersion("FortiSwitch")).toBeNull();
    expect(parseFirmwareVersion("build1164")).toBeNull();
  });
});

describe("compareFirmwareVersions / isStrictlyNewer", () => {
  it("orders major, then minor, then patch, then build", () => {
    expect(compareFirmwareVersions({ major: 7, minor: 6, patch: 8, build: 1164 }, { major: 7, minor: 6, patch: 5, build: 1105 })).toBe(1);
    expect(compareFirmwareVersions({ major: 7, minor: 4, patch: 9, build: 9999 }, { major: 7, minor: 6, patch: 0, build: 1 })).toBe(-1);
    expect(compareFirmwareVersions({ major: 7, minor: 6, patch: 5, build: 1105 }, { major: 7, minor: 6, patch: 5, build: 1106 })).toBe(-1);
    expect(compareFirmwareVersions({ major: 8 }, { major: 7, minor: 6, patch: 5 })).toBe(1);
  });
  it("skips a component missing on either side rather than treating it as zero", () => {
    expect(compareFirmwareVersions({ major: 7, build: 1164 }, { major: 7, minor: 6, patch: 5, build: 1105 })).toBe(1);
    expect(compareFirmwareVersions({ major: 7, build: 1164 }, { major: 7, minor: 6, patch: 5 })).toBe(0);
  });
  it("an indeterminate comparison is never 'newer'", () => {
    expect(isStrictlyNewer({ major: 7, build: 1164 }, { major: 7, minor: 6, patch: 5 })).toBe(false);
    expect(isStrictlyNewer({ major: 7, minor: 6, patch: 5 }, { major: 7, minor: 6, patch: 5 })).toBe(false);
    expect(isStrictlyNewer({ major: 7, minor: 6, patch: 8 }, null)).toBe(false);
    expect(isStrictlyNewer(null, { major: 7, minor: 6, patch: 5 })).toBe(false);
  });
  it("formats whatever components exist", () => {
    expect(formatFirmwareVersion({ major: 7, minor: 6, patch: 8, build: 1164 })).toBe("7.6.8 build1164");
    expect(formatFirmwareVersion({ major: 7, minor: 6, patch: 8 })).toBe("7.6.8");
    expect(formatFirmwareVersion({ major: 7, build: 1164 })).toBe("7 build1164");
  });
});

describe("parseFortinetImageHeader", () => {
  it("reads a FortiSwitch header: platform, 7.06 + patch08 = 7.6.8, build, family", () => {
    expect(parseFortinetImageHeader(header("S108FF-7.06-FW-build1164-260709-patch08"))).toEqual({
      platform: "S108FF",
      version: { major: 7, minor: 6, patch: 8, build: 1164 },
      parsedFrom: "header",
      family: "switch",
      token: "S108FF-7.06-FW-build1164-260709-patch08",
    });
  });
  it("reads a FortiAP header and a header with no patch (patch 0)", () => {
    const ap = parseFortinetImageHeader(header("FP231K-7.06-AP-build1105-260519-patch05"));
    expect(ap?.platform).toBe("FP231K");
    expect(ap?.family).toBe("ap");
    expect(ap?.version).toEqual({ major: 7, minor: 6, patch: 5, build: 1105 });
    const ga = parseFortinetImageHeader(header("S548DF-7.04-FW-build0800-250101"));
    expect(ga?.version).toEqual({ major: 7, minor: 4, patch: 0, build: 800 });
  });
  it("calls an FG… platform a firewall, but not a FortiGate-VM", () => {
    expect(parseFortinetImageHeader(header("FGT60F-7.06-FW-build3401-250101-patch04"))?.family).toBe("firewall");
    expect(parseFortinetImageHeader(header("FGVM64-7.06-FW-build3401-250101-patch04"))?.family).toBe("switch");
  });
  it("only looks at the first 512 bytes", () => {
    const buf = Buffer.alloc(IMAGE_HEADER_BYTES + 200, 0x20);
    buf.write("S108FF-7.06-FW-build1164-260709-patch08", IMAGE_HEADER_BYTES + 10, "latin1");
    expect(parseFortinetImageHeader(buf)).toBeNull();
  });
  it("returns null for bytes that are not a Fortinet image", () => {
    expect(parseFortinetImageHeader(Buffer.from("PK\u0003\u0004 not firmware at all"))).toBeNull();
  });
});

describe("parseFortinetImageFilename / identifyFirmwareImage", () => {
  it("recovers major + build from the filename but NO platform", () => {
    expect(parseFortinetImageFilename("FSW_108F_FPOE-v7-build1164-FORTINET.out")).toEqual({
      platform: null,
      version: { major: 7, build: 1164 },
      parsedFrom: "filename",
      family: null,
      token: "FSW_108F_FPOE",
    });
    expect(parseFortinetImageFilename("C:\\downloads\\FAP_231F-v7-build1105-FORTINET.out")?.token).toBe("FAP_231F");
  });
  it("returns null for a name with no version in it", () => {
    expect(parseFortinetImageFilename("firmware.out")).toBeNull();
    expect(parseFortinetImageFilename("notes-v.txt")).toBeNull();
  });
  it("prefers the header and falls back to the filename", () => {
    expect(identifyFirmwareImage(header("S108FF-7.06-FW-build1164-260709-patch08"), "renamed.out")?.parsedFrom).toBe("header");
    expect(identifyFirmwareImage(Buffer.alloc(600, 0), "FSW_108F_FPOE-v7-build1164-FORTINET.out")?.parsedFrom).toBe("filename");
    expect(identifyFirmwareImage(Buffer.alloc(600, 0), "blob.bin")).toBeNull();
  });
});
