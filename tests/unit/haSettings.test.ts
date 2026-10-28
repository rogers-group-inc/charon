/**
 * High Availability tab (polaris port): advisory arithmetic, bundle encoding
 * and the generated node / teardown scripts.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("../../src/db.ts", () => ({ prisma: {} }));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  rttAdvisory,
  walRateFromCounter,
  walAdvisory,
  rpoAdvisory,
  estimateRto,
  assessInstallShape,
} from "../../src/utils/haAdvisories.ts";
import {
  serializeBundle,
  renderNodeScript,
  renderTeardownScript,
  hashRequestId,
} from "../../src/services/haEnrollmentService.ts";
import { randomReplicationPassword, parseHaConfig, type HaConfig } from "../../src/services/haService.ts";

function bashAvailable(): boolean {
  try {
    return spawnSync("bash", ["-c", "true"]).status === 0;
  } catch {
    return false;
  }
}

function bashSyntaxOk(script: string): { ok: boolean; err: string } {
  const r = spawnSync("bash", ["-n"], { input: script });
  return { ok: r.status === 0, err: String(r.stderr ?? "") };
}

const cfg: HaConfig = parseHaConfig({
  enabled: true,
  nodes: {
    primary: { name: "charon-a", clusterAddr: "10.1.0.10", sshHostKeys: [] },
    standby: { name: "charon-b", clusterAddr: "10.2.0.10", reachPrimaryVia: "192.168.50.10", sshHostKeys: [] },
  },
});
const PIN = "ab".repeat(32);

describe("haAdvisories", () => {
  it("bands round-trip time", () => {
    expect(rttAdvisory(null, "x").level).toBe("unknown");
    expect(rttAdvisory(40, "x").level).toBe("ok");
    expect(rttAdvisory(180, "x").level).toBe("warn");
    expect(rttAdvisory(400, "x").level).toBe("bad");
  });

  it("derives a WAL rate from the pg_stat_wal counter, refusing short windows", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(walRateFromCounter(1000, new Date(now.getTime() - 60_000), now)).toBeNull();
    const r = walRateFromCounter(3_600_000, new Date(now.getTime() - 3_600_000), now);
    expect(r?.bytesPerSec).toBe(1000);
    expect(walAdvisory(r).recommendedMbps).toBe(1);
    expect(walAdvisory(null).level).toBe("unknown");
  });

  it("turns lag into an RPO verdict", () => {
    expect(rpoAdvisory(null, null).level).toBe("unknown");
    expect(rpoAdvisory(1000, { bytesPerSec: 10, windowSec: 1000, totalBytes: 10000 }).level).toBe("warn");
    expect(rpoAdvisory(5, { bytesPerSec: 10, windowSec: 1000, totalBytes: 10000 }).detail).toMatch(/under a second/);
  });

  it("estimates RTO from leader retry + monitor + DNS", () => {
    const e = estimateRto({ leaderRetrySec: 10, monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 });
    expect(e.minSec).toBe(15);
    expect(e.maxSec).toBe(10 + 10 + 15 + 5);
  });

  it("refuses containers and remote databases", () => {
    expect(assessInstallShape({ platform: "linux", docker: false, localPgdata: true }).supported).toBe(true);
    const v = assessInstallShape({ platform: "linux", docker: true, localPgdata: false });
    expect(v.supported).toBe(false);
    expect(v.reasons).toHaveLength(2);
  });
});

describe("HA enrollment", () => {
  it("replication passwords are alphanumeric (setup-ha.sh interpolates them into SQL)", () => {
    const p = randomReplicationPassword();
    expect(p).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("stores the poll handle as SHA-384", () => {
    expect(hashRequestId("abc")).toHaveLength(96);
  });

  it("encodes the bundle as KEY=base64 lines in a fixed order", () => {
    const b = serializeBundle({ REPL_PASS: "s3cret", ROLE: "primary" });
    expect(b).toBe(`ROLE=${Buffer.from("primary").toString("base64")}\nREPL_PASS=${Buffer.from("s3cret").toString("base64")}\n`);
  });

  it("renders node scripts that pin the cert and call setup-ha.sh", () => {
    const tok = "charon_" + "A".repeat(43);
    const p = renderNodeScript({ role: "primary", token: tok, publicUrl: "https://charon.example.com", certPin: PIN, cfg });
    expect(p.filename).toBe("charon-ha-primary.sh");
    expect(p.script).toContain(`CERT_PIN='${PIN}'`);
    expect(p.script).toContain("--role primary --standby-ip");
    expect(p.script).toContain("CHARON_ADDR='10.1.0.10'");
    const s = renderNodeScript({ role: "standby", token: tok, publicUrl: "https://charon.example.com:8443", certPin: PIN, cfg });
    expect(s.script).toContain("--role standby --primary-ip");
    expect(s.script).toContain("CHARON_ADDR='192.168.50.10'");
    expect(s.script).toContain("CHARON_PORT='8443'");
    if (bashAvailable()) {
      for (const sc of [p.script, s.script, renderTeardownScript().script]) {
        const r = bashSyntaxOk(sc);
        expect(r.err).toBe("");
        expect(r.ok).toBe(true);
      }
    }
  }, 60_000); // spawning bash is slow on Windows dev hosts

  it("resolves the PostgreSQL major on the host instead of baking one into the teardown script", () => {
    const sc = renderTeardownScript().script;
    expect(sc).toContain("ls -d /usr/pgsql-[0-9]*");
    expect(sc).toContain("/usr/pgsql-${PG_MAJOR}/bin/pg_ctl");
    expect(sc).not.toMatch(/pgsql-\d|postgresql-\d|pgsql\/\d/);
  });

  it("refuses to interpolate unsafe values into a script", () => {
    const bad = parseHaConfig({ ...cfg, nodes: { ...cfg.nodes, primary: { ...cfg.nodes.primary!, name: "a'; rm -rf /" } } });
    expect(() => renderNodeScript({ role: "primary", token: "charon_x", publicUrl: "https://h", certPin: PIN, cfg: bad })).toThrow();
    expect(() => renderNodeScript({ role: "primary", token: "charon_x", publicUrl: "https://h", certPin: "nothex", cfg })).toThrow();
  });
});
