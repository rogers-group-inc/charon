/**
 * tests/unit/agentInstallScripts.test.ts — the scripts a push deployment runs.
 *
 * These run as root / Administrator on customer hosts, so every substituted
 * value is allowlisted and the integrity checks are pinned here: the staged
 * installer's SHA-256 is verified before install, the Windows download accepts
 * only a pinned certificate, the preseed is root / SYSTEM only.
 */

import { describe, it, expect } from "vitest";
import {
  installerKindOf, selectInstaller, normalizeArch, parseUnixProbe, renderEnrollmentPreseed,
  unixInstallScript, unixUninstallScript, windowsInstallPs, windowsUninstallPs,
  assertInstallerFilename, assertPins, stagedInstallerName,
} from "../../src/services/agentInstallScripts.js";

const SHA = "a".repeat(64);
const PIN = "b".repeat(64);
const file = (filename: string, arch = "x64", sha256: string | undefined = SHA) => ({ platform: "x", arch, filename, sha256 });

describe("installer selection", () => {
  const manifest = [
    file("Charon Agent_0.2.0_x64_en-US.msi"),
    file("Charon Agent_0.2.0_x64-setup.exe"),
    file("charon-agent_0.2.0_amd64.deb", "amd64"),
    file("charon-agent-0.2.0-1.x86_64.rpm", "x86_64"),
    file("charon-agent_0.2.0_amd64.AppImage", "amd64"),
    file("Charon Agent_0.2.0_aarch64.dmg", "aarch64"),
  ];

  it("maps file extensions to installer kinds", () => {
    expect(installerKindOf("x.MSI")).toBe("msi");
    expect(installerKindOf("x-setup.exe")).toBe("nsis");
    expect(installerKindOf("x.AppImage")).toBe("appimage");
    expect(installerKindOf("x.zip")).toBeNull();
  });

  it("normalizes uname / PROCESSOR_ARCHITECTURE arches", () => {
    expect(normalizeArch("x86_64")).toBe("x64");
    expect(normalizeArch("AMD64")).toBe("x64");
    expect(normalizeArch("aarch64")).toBe("arm64");
    expect(normalizeArch("")).toBeNull();
  });

  it("prefers MSI on Windows, the host's package manager on Linux, then the AppImage", () => {
    expect(selectInstaller(manifest, { os: "windows", arch: "x64" })!.filename).toMatch(/\.msi$/);
    expect(selectInstaller(manifest, { os: "linux", arch: "x64", packageManagers: { dpkg: true } })!.filename).toMatch(/\.deb$/);
    expect(selectInstaller(manifest, { os: "linux", arch: "x64", packageManagers: { rpm: true } })!.filename).toMatch(/\.rpm$/);
    expect(selectInstaller(manifest, { os: "linux", arch: "x64", packageManagers: {} })!.filename).toMatch(/\.AppImage$/);
    expect(selectInstaller(manifest, { os: "darwin", arch: "arm64" })!.filename).toMatch(/\.dmg$/);
  });

  it("never selects an installer without a SHA-256, or for another arch", () => {
    expect(selectInstaller([file("a.msi", "x64", "")], { os: "windows", arch: "x64" })).toBeNull();
    expect(selectInstaller([{ platform: "windows", arch: "x64", filename: "a.msi" }], { os: "windows", arch: "x64" })).toBeNull();
    expect(selectInstaller([file("a.msi", "arm64")], { os: "windows", arch: "x64" })).toBeNull();
  });
});

describe("host probe parsing", () => {
  it("reads kernel, arch and package managers", () => {
    expect(parseUnixProbe("Linux\nx86_64\nhas-dpkg\n")).toEqual({ os: "linux", arch: "x64", dpkg: true, rpm: false });
    expect(parseUnixProbe("Darwin\narm64\n")).toEqual({ os: "darwin", arch: "arm64", dpkg: false, rpm: false });
  });
});

describe("enrollment preseed", () => {
  it("carries the URL, pins and code, and refuses a hostile URL", () => {
    const p = JSON.parse(renderEnrollmentPreseed({ serverUrl: "https://charon.example.com/", pins: [PIN], code: "charon-inv_x" }));
    expect(p).toEqual({ version: 1, serverUrl: "https://charon.example.com", pins: [PIN], code: "charon-inv_x" });
    expect(() => renderEnrollmentPreseed({ serverUrl: "https://e.com/';calc;'", pins: [PIN], code: "c" })).toThrow(/not allowed/);
  });

  it("refuses to deploy with no pin, or a malformed one", () => {
    expect(() => assertPins([])).toThrow(/No agent certificate pin/);
    expect(() => assertPins(["sha256:abc"])).toThrow(/Invalid/);
  });
});

describe("unix scripts", () => {
  it("verify the installer digest before installing, and write the preseed root-only", () => {
    const s = unixInstallScript("linux", "deb");
    const verify = s.indexOf('verify_sha256 "${INST}"');
    expect(verify).toBeGreaterThan(0);
    expect(s.indexOf("dpkg -i")).toBeGreaterThan(verify);
    expect(s).toContain('install -d -m 0700 -o root -g root "/etc/charon-agent"');
    expect(s).toContain('install -m 0600 -o root -g root "${STAGE_DIR}/enroll.json"');
    expect(s).toContain(`INST="\${STAGE_DIR}/${stagedInstallerName("deb")}"`);
  });

  it("macOS uses wheel and mounts the dmg read-only", () => {
    const s = unixInstallScript("darwin", "dmg");
    expect(s).toContain("-g wheel");
    expect(s).toContain("hdiutil attach -nobrowse -readonly");
  });

  it("refuses a kind for the wrong OS", () => {
    expect(() => unixInstallScript("linux", "dmg")).toThrow();
  });

  it("uninstall removes the package and the preseed directory", () => {
    expect(unixUninstallScript("linux")).toContain("rm -rf /opt/charon-agent /etc/charon-agent");
  });
});

describe("windows scripts", () => {
  const base = { serverUrl: "https://charon.example.com:8443", pins: [PIN], filename: "Charon Agent_0.2.0_x64_en-US.msi", sha256: SHA };

  it("downloads pinned, checks the digest, runs msiexec silently, writes the preseed", () => {
    const ps = windowsInstallPs({ ...base, preseed: "{}" });
    expect(ps).toContain(`'${PIN}'.Split(',')`);
    expect(ps).toContain("Invoke-CharonPinnedDownload");
    expect(ps).toContain("Get-FileHash -Algorithm SHA256");
    expect(ps).toContain("'/qn'");
    expect(ps).toContain("'*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'");
    expect(ps).toContain(`$preseedB64 = '${Buffer.from("{}").toString("base64")}'`);
    // The digest check comes before the installer runs.
    expect(ps.indexOf("SHA-256 mismatch")).toBeLessThan(ps.indexOf("msiexec.exe"));
  });

  it("an upgrade carries no preseed; NSIS runs with /S", () => {
    const ps = windowsInstallPs({ ...base, filename: "Charon Agent_0.2.0_x64-setup.exe" });
    expect(ps).toContain("$preseedB64 = ''");
    expect(ps).toContain("-ArgumentList '/S'");
  });

  it("refuses a file name or URL that could break out of the script", () => {
    expect(() => assertInstallerFilename("x';calc;'.msi")).toThrow();
    expect(() => windowsInstallPs({ ...base, filename: "a$(calc).msi" })).toThrow();
    expect(() => windowsInstallPs({ ...base, serverUrl: "https://e.com/`calc`" })).toThrow();
    expect(() => windowsInstallPs({ ...base, sha256: "nothex" })).toThrow();
  });

  it("uninstall finds the product's own uninstaller and removes the config", () => {
    const ps = windowsUninstallPs();
    expect(ps).toContain("DisplayName -like 'Charon Agent*'");
    expect(ps).toContain("Join-Path $env:ProgramData 'Charon'");
  });
});
