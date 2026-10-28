/**
 * tests/unit/maintenanceSettings.test.ts — pure logic behind Server Settings →
 * Maintenance + Retention (polaris port, Charon-adapted).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  parseSampleRetention, mergeSampleRetention, retentionCutoff, FOREVER, defaultSampleRetention,
} from "../../src/services/sampleRetentionService.js";
import { parseAgentEventLogConfig, mergeAgentEventLogConfig, DEFAULT_AGENT_EVENT_LOG_CONFIG } from "../../src/services/agentEventLogService.js";
import { computeReasons, projectSteadyStateBytes, worstSeverity, volumeLabel } from "../../src/services/capacityService.js";
import { computeAdvisor, stageAdvisorState, recommendedPrismaPool, MAX_CONNECTIONS_HEADROOM } from "../../src/services/capacityAdvisorService.js";
import { gradePgSettings, parsePgBytes, isAutoConfOverride, buildPgRecommended } from "../../src/services/pgTuningService.js";
import { gradeComponent, deriveTrack, compareTracks, parseDataset } from "../../src/services/platformLifecycleService.js";
import { backupFilePath, backupFilename } from "../../src/services/backupService.js";
import { parseBackupSchedule } from "../../src/services/backupScheduleService.js";
import { summarizeBuckets, parsePostgresVersion } from "../../src/services/dbSizeService.js";
import { isSafeGitRef, isSafeRepoUrl } from "../../src/services/updateService.js";

const GB = 1024 ** 3;

describe("sample retention (Charon flat windows)", () => {
  it("defaults to 90d audit events / 1d sessions", () => {
    expect(defaultSampleRetention()).toEqual({ events: { days: 90 }, verificationSessions: { days: 1 } });
  });
  it("seeds the audit window from the legacy retention.eventDays key", () => {
    expect(parseSampleRetention(null, { days: 30 }).events.days).toBe(30);
    // the new row wins over the legacy key
    expect(parseSampleRetention({ events: { days: 7 } }, { days: 30 }).events.days).toBe(7);
  });
  it("accepts −1 / 0 / 1..3650 and rejects the rest", () => {
    const cur = defaultSampleRetention();
    expect(mergeSampleRetention(cur, { verificationSessions: { days: 0 } }).verificationSessions.days).toBe(0);
    expect(mergeSampleRetention(cur, { events: { days: FOREVER } }).events.days).toBe(-1);
    expect(() => mergeSampleRetention(cur, { events: { days: 4000 } })).toThrow();
    expect(() => mergeSampleRetention(cur, { events: { days: -2 } })).toThrow();
  });
  it("refuses 0 for the audit log", () => {
    expect(() => mergeSampleRetention(defaultSampleRetention(), { events: { days: 0 } })).toThrow(/audit log/);
    expect(parseSampleRetention({ events: { days: 0 } }).events.days).toBe(90);
  });
  it("ignores polaris tiered entities it does not have", () => {
    expect(mergeSampleRetention(defaultSampleRetention(), { assets: { detail: 7 } })).toEqual(defaultSampleRetention());
  });
  it("cutoff: forever → null, 0 → now, N → N days back", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(retentionCutoff(FOREVER, now)).toBeNull();
    expect(retentionCutoff(0, now)?.toISOString()).toBe(now.toISOString());
    expect(retentionCutoff(2, now)?.toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });
});

describe("agent event-log config", () => {
  it("defaults to disabled", () => {
    expect(parseAgentEventLogConfig(undefined)).toEqual(DEFAULT_AGENT_EVENT_LOG_CONFIG);
  });
  it("clamps ranges and trims channels", () => {
    const next = mergeAgentEventLogConfig(DEFAULT_AGENT_EVENT_LOG_CONFIG, {
      enabled: true, linuxMinPriority: 99, maxPerPush: 0, windowsChannels: [" Security ", "", "x".repeat(200)],
    });
    expect(next.enabled).toBe(true);
    expect(next.linuxMinPriority).toBe(7);
    expect(next.maxPerPush).toBe(1);
    expect(next.windowsChannels).toEqual(["Security"]);
  });
});

describe("capacity reasons", () => {
  const vol = (free: number, roles: any[] = ["app"]) => ({ paths: ["/opt/charon"], roles, freeBytes: free * GB, totalBytes: 100 * GB });
  const env = { METRICS_TOKEN: "x", HEALTH_TOKEN: "y" };
  it("grades volumes on the polaris thresholds", () => {
    const codes = (free: number) => computeReasons({ volumes: [vol(free)], pgTuningNeeded: false, maxConnections: 100, recommendedMaxConnections: null, env }).map((r) => r.code);
    expect(codes(5)).toEqual(["disk_critical"]);
    expect(codes(15)).toEqual(["disk_low"]);
    expect(codes(25)).toEqual(["disk_watch"]);
    expect(codes(50)).toEqual([]);
  });
  it("flags unset tokens, a missing data key in production, and undersized max_connections", () => {
    const r = computeReasons({ volumes: [], pgTuningNeeded: true, maxConnections: 100, recommendedMaxConnections: 160, env: { NODE_ENV: "production" } });
    expect(r.map((x) => x.code).sort()).toEqual(["data_key_unset", "health_token_unset", "max_connections_undersized", "metrics_token_unset", "pg_tuning_needed"]);
    expect(worstSeverity(r)).toBe("critical");
  });
  it("labels volumes like the frontend", () => {
    expect(volumeLabel({ roles: ["db", "app"] })).toBe("Application + DB volume");
    expect(volumeLabel({ roles: ["backups"] })).toBe("Backups volume");
  });
  it("projects steady state from the audit-log rate", () => {
    expect(projectSteadyStateBytes({ totalBytes: 1000, eventsTableBytes: 400, eventRows: 100, eventsPerDay: 10, eventRetentionDays: 90 })).toBe(600 + 4 * 10 * 90);
    expect(projectSteadyStateBytes({ totalBytes: 1000, eventsTableBytes: 400, eventRows: 100, eventsPerDay: 10, eventRetentionDays: -1 })).toBeNull();
  });
});

describe("capacity advisor", () => {
  const base = { endpointCount: 100, prismaPoolSize: 25, pgbossPoolSize: 10, maxConnections: 100, processCount: 4, pgTuning: null };
  it("sizes max_connections from every process's pools + headroom", () => {
    const a = computeAdvisor(base);
    const max = a.recommendations.find((r) => r.key === "PG_MAX_CONNECTIONS")!;
    expect(max.recommended).toBe(4 * (25 + 10) + MAX_CONNECTIONS_HEADROOM);
    expect(max.changeRequired).toBe(true);
    expect(max.applyMode).toBe("advisory-only");
  });
  it("recommends bigger pools as endpoints grow", () => {
    expect(recommendedPrismaPool(500)).toBe(25);
    expect(recommendedPrismaPool(3000)).toBe(40);
    const a = computeAdvisor({ ...base, endpointCount: 3000 });
    expect(a.recommendations.find((r) => r.key === "DATABASE_POOL_SIZE")).toMatchObject({ recommended: 40, changeRequired: true, applyMode: "env" });
  });
  it("stages only env levers, and only when a change is required", async () => {
    const a = computeAdvisor({ ...base, endpointCount: 3000 });
    const written: Record<string, string> = {};
    const { results } = await stageAdvisorState(["DATABASE_POOL_SIZE", "PG_MAX_CONNECTIONS", "CHARON_PGBOSS_POOL_SIZE", "NOPE"], a, (k, v) => { written[k] = v; });
    expect(written).toEqual({ DATABASE_POOL_SIZE: "40", CHARON_PGBOSS_POOL_SIZE: "20" });
    expect(results.map((r) => r.status)).toEqual(["applied", "skipped", "applied", "error"]);
  });
});

describe("pg tuning", () => {
  it("parses pg_settings units", () => {
    expect(parsePgBytes("4GB")).toBe(4 * GB);
    expect(parsePgBytes("64kB")).toBe(64 * 1024);
    expect(isAutoConfOverride({ sourcefile: "C:\\pg\\postgresql.auto.conf" })).toBe(true);
  });
  it("flags settings below the RAM-sized recommendation and honours ALTER SYSTEM", () => {
    const ram = 32 * GB;
    expect(buildPgRecommended(ram).shared_buffers.display).toBe("8GB");
    const r = gradePgSettings([
      { name: "shared_buffers", setting: "16384", unit: "8kB", sourcefile: null }, // 128MB
      { name: "work_mem", setting: "4096", unit: "kB", sourcefile: "/var/lib/pgsql/data/postgresql.auto.conf" },
      { name: "config_file", setting: "/var/lib/pgsql/data/postgresql.conf", unit: null, sourcefile: null },
    ], ram);
    expect(r.pgConfigFile).toBe("/var/lib/pgsql/data/postgresql.conf");
    expect(r.settings.find((s) => s.name === "shared_buffers")?.ok).toBe(false);
    expect(r.settings.find((s) => s.name === "work_mem")?.ok).toBe(true);
    expect(r.pgTuningNeeded).toBe(true);
  });
});

describe("platform lifecycle grading", () => {
  const tech = {
    id: "node", label: "Node.js", charonMinimum: "20", charonTarget: "22",
    tracks: [
      { track: "18", eol: "2025-04-30" },
      { track: "20", eol: "2026-04-30" },
      { track: "22", eol: "2027-04-30" },
      { track: "24", eol: "2028-04-30" },
    ],
  };
  const now = new Date("2026-10-28T15:00:00Z");
  it("derives tracks and compares them numerically", () => {
    expect(deriveTrack("20.18.1", "major")).toBe("20");
    expect(deriveTrack("3.5.1", "major.minor")).toBe("3.5");
    expect(compareTracks("3.10", "3.9")).toBe(1);
  });
  it("covers the state table", () => {
    expect(gradeComponent(tech, "18.20.0", now).state).toBe("below_minimum");
    expect(gradeComponent(tech, "20.18.0", now)).toMatchObject({ state: "eol", severity: "critical" });
    expect(gradeComponent(tech, "22.1.0", now)).toMatchObject({ state: "current", daysUntilEol: 184 });
    expect(gradeComponent(tech, "22.1.0", new Date("2026-12-01T00:00:00Z"))).toMatchObject({ state: "aging", severity: "watch" });
    expect(gradeComponent(tech, "22.1.0", new Date("2027-03-01T00:00:00Z"))).toMatchObject({ state: "approaching_eol", severity: "warning" });
    expect(gradeComponent({ ...tech, charonTarget: "24" }, "22.1.0", now)).toMatchObject({ state: "behind_target", severity: "watch" });
    expect(gradeComponent(tech, "24.1.0", now)).toMatchObject({ state: "current", severity: "none" });
    expect(gradeComponent(tech, null, now, { installed: false }).state).toBe("not_installed");
  });
  it("treats supported:false with no date as end of life", () => {
    const ssl = { id: "openssl", label: "OpenSSL", charonMinimum: "3.0", tracks: [{ track: "3.0", eol: null, supported: false }] };
    expect(gradeComponent(ssl, "3.0.13", now).state).toBe("eol");
  });
  it("rejects a malformed dataset", () => {
    expect(() => parseDataset({ reviewedAt: "nope", technologies: [] })).toThrow();
    expect(parseDataset({ schemaVersion: 1, reviewedAt: "2026-10-28", technologies: [tech] }).technologies).toHaveLength(1);
  });
});

describe("backups", () => {
  it("contains backup ids inside BACKUP_DIR", () => {
    expect(backupFilePath("bk-pre-update-123")).not.toBeNull();
    expect(backupFilePath("../etc/passwd")).toBeNull();
    expect(backupFilePath("..")).toBeNull();
    expect(backupFilePath(".restore-dec-1.gz")).toBeNull();
  });
  it("names files so the Restore card can read the version back", () => {
    const name = backupFilename("manual", "0.1.42", new Date("2026-10-28T01:02:03Z"), true);
    expect(name).toBe("charon-backup-0.1.42-2026-10-28T01-02-03.enc.gz");
    expect(/charon-(?:backup|pre-update)-(\d+\.\d+\.\d+)-/.exec(backupFilename("pre-update", "0.1.42", new Date(), false))?.[1]).toBe("0.1.42");
  });
  it("schedule parse clamps and defaults", () => {
    const s = parseBackupSchedule({ enabled: true, intervalHours: 999, retainCount: 0, hourUtc: 30, copyToDir: "  " });
    expect(s).toMatchObject({ enabled: true, intervalHours: 168, retainCount: 1, hourUtc: null, copyToDir: null, passphrase: null });
  });
});

describe("database sizing + updater guards", () => {
  it("buckets sum to the total", () => {
    const b = summarizeBuckets([{ bucket: "charon", bytes: 10 }, { bucket: "pgboss", bytes: 5 }, { bucket: "catalog", bytes: 3 }, { bucket: "other", bytes: 2 }]);
    expect(b).toEqual({ totalBytes: 20, polarisBytes: 10, pgbossBytes: 5, catalogBytes: 3, otherBytes: 2 });
  });
  it("parses the PostgreSQL banner", () => {
    expect(parsePostgresVersion("PostgreSQL 15.13 on x86_64-pc-linux-gnu")).toBe("15.13");
  });
  it("refuses refs and repo URLs a shell or git option could act on", () => {
    expect(isSafeGitRef("v1.2.3")).toBe(true);
    expect(isSafeGitRef("--upload-pack=x")).toBe(false);
    expect(isSafeGitRef("a..b")).toBe(false);
    expect(isSafeRepoUrl("https://github.com/rogers-group-inc/charon.git")).toBe(true);
    expect(isSafeRepoUrl("https://x; rm -rf /")).toBe(false);
  });
});
