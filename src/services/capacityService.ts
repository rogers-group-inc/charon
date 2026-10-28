/**
 * src/services/capacityService.ts — capacity snapshot for the Maintenance tab.
 *
 * Ported (in shape) from polaris src/services/capacityService.ts: the snapshot
 * the Database card renders — host stats + every distinct volume Charon and
 * (when co-located) PostgreSQL write to, database size + connection pool,
 * workload, and graded `reasons` with a worst-of severity.
 *
 * Charon adaptations:
 *  - No TimescaleDB, no sample tables, no cursor queue: `timescale` reports
 *    not-installed and `queue` reports pg-boss active (Charon always uses it).
 *  - `workload` is Charon's growth drivers (endpoints, tags, policies, the
 *    directory mirror, the audit log) instead of monitored assets/interfaces;
 *    the steady-state projection is the audit log at its retention window.
 *  - Reasons kept from polaris: disk_critical / disk_low / disk_watch,
 *    pg_tuning_needed, max_connections_undersized, metrics_token_unset,
 *    health_token_unset; plus data_key_unset (CHARON_DATA_KEY missing in
 *    production — stored secrets would not survive a restart).
 */

import { cpus, totalmem, freemem, loadavg } from "node:os";
import { statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { STATE_DIR, BACKUP_DIR } from "../utils/paths.js";
import { dbIsLocal } from "../utils/deploymentContext.js";
import { getSampleRetention, FOREVER } from "./sampleRetentionService.js";
import { getDatabaseSizeBreakdown } from "./dbSizeService.js";

export type Severity = "ok" | "watch" | "warning" | "critical";

export interface CapacityReason {
  severity: "watch" | "warning" | "critical";
  code: string;
  message: string;
  suggestion: string;
  family?: string;
}

export type VolumeRole = "app" | "state" | "backups" | "db";

export interface VolumeStat {
  paths: string[];
  roles: VolumeRole[];
  freeBytes: number;
  totalBytes: number;
}

export interface CapacitySnapshot {
  computedAt: string;
  severity: Severity;
  reasons: CapacityReason[];
  appHost: {
    cpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAvg: [number, number, number];
    volumes: VolumeStat[];
    dbColocated: boolean;
  };
  database: {
    sizeBytes: number;
    dataDirectory: string | null;
    timescale: { extensionInstalled: boolean; hypertableTables: string[] };
    queue: { pgbossInstalled: boolean; active: "pgboss"; persisted: "pgboss" };
    connectionPool: {
      prismaPoolSize: number;
      pgbossPoolSize: number | null;
      peakObserved: number;
      activeConnections: number;
      maxConnections: number;
    };
  };
  workload: {
    endpointCount: number;
    onlineEndpointCount: number;
    tagCount: number;
    policyCount: number;
    directoryObjectCount: number;
    eventCount: number;
    eventsPerDay: number;
    retention: { eventDays: number; sessionDays: number };
    steadyStateSizeBytes: number | null;
  };
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Severity order; also accepts the legacy color names. */
const RANK: Record<string, number> = { ok: 0, watch: 1, warning: 2, critical: 3 };

export function worstSeverity(reasons: Array<{ severity: string }>): Severity {
  let worst: Severity = "ok";
  for (const r of reasons) if ((RANK[r.severity] ?? 0) > RANK[worst]) worst = r.severity as Severity;
  return worst;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function prismaPoolSize(): number { return envInt("DATABASE_POOL_SIZE", 25); }
export function pgbossPoolSize(): number { return envInt("CHARON_PGBOSS_POOL_SIZE", 10); }

// Highest backend count this process has seen — a gauge for the pool card.
let peakObserved = 0;

// ─── Volumes ────────────────────────────────────────────────────────────────

/** Group the paths Charon writes to by filesystem (stat.dev), so a single-LV
 *  host shows one volume and a separate /var or backup mount shows its own. */
async function collectVolumes(dataDirectory: string | null): Promise<VolumeStat[]> {
  const candidates: Array<{ path: string; role: VolumeRole }> = [
    { path: PROJECT_ROOT, role: "app" },
    { path: STATE_DIR, role: "state" },
    { path: BACKUP_DIR, role: "backups" },
  ];
  if (dataDirectory) candidates.push({ path: dataDirectory, role: "db" });

  const byDev = new Map<string, VolumeStat>();
  for (const c of candidates) {
    // A missing backup dir or an unreadable 0700 PGDATA: fall back to the
    // nearest readable ancestor — statfs is filesystem-level.
    let probe = c.path;
    let dev: string | null = null;
    for (let i = 0; i < 6 && probe; i++) {
      try { dev = String(statSync(probe).dev); break; } catch { probe = dirname(probe); }
    }
    if (dev === null) continue;
    let fs;
    try { fs = await statfs(probe); } catch { continue; }
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const existing = byDev.get(dev);
    if (existing) {
      if (!existing.paths.includes(c.path)) existing.paths.push(c.path);
      if (!existing.roles.includes(c.role)) existing.roles.push(c.role);
    } else {
      byDev.set(dev, { paths: [c.path], roles: [c.role], freeBytes, totalBytes });
    }
  }
  // Lowest-free first, so the reasons read worst-first.
  return [...byDev.values()].sort((a, b) => a.freeBytes / (a.totalBytes || 1) - b.freeBytes / (b.totalBytes || 1));
}

/** Friendly label for a volume's set of roles (matches the frontend's). */
export function volumeLabel(v: Pick<VolumeStat, "roles">): string {
  const roles = v.roles;
  if (roles.length === 1) {
    if (roles[0] === "db") return "Database volume";
    if (roles[0] === "app") return "Application volume";
    if (roles[0] === "state") return "State volume";
    if (roles[0] === "backups") return "Backups volume";
  }
  if (roles.includes("db") && roles.includes("app")) return "Application + DB volume";
  if (roles.includes("db")) return "DB volume";
  return "Application volume";
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + " TB";
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

// ─── Reasons ────────────────────────────────────────────────────────────────

export interface ReasonInputs {
  volumes: VolumeStat[];
  pgTuningNeeded: boolean;
  maxConnections: number;
  recommendedMaxConnections: number | null;
  env: Record<string, string | undefined>;
}

/** Pure: grade the snapshot inputs into operator-facing reasons. */
export function computeReasons(inp: ReasonInputs): CapacityReason[] {
  const reasons: CapacityReason[] = [];

  for (const v of inp.volumes) {
    if (v.totalBytes <= 0) continue;
    const pct = v.freeBytes / v.totalBytes;
    const pathHint = v.paths[0] ? `, ${v.paths[0]}` : "";
    const label = volumeLabel(v);
    const family = `disk:${v.roles.slice().sort().join("+")}`;
    const metric = `${(pct * 100).toFixed(1)}% free — ${formatBytes(v.freeBytes)} of ${formatBytes(v.totalBytes)}${pathHint}`;
    if (pct < 0.10) {
      reasons.push({
        severity: "critical", code: "disk_critical", family,
        message: `${label} is critically full (${metric}).`,
        suggestion: v.roles.includes("db")
          ? "Free disk or expand the volume immediately — PostgreSQL refuses new writes when the volume is full."
          : "Free disk or expand the volume immediately — backups and update rollback both need headroom.",
      });
    } else if (pct < 0.20) {
      reasons.push({
        severity: "warning", code: "disk_low", family,
        message: `${label} is running low on space (${metric}).`,
        suggestion: "Plan to expand the volume soon — backups and update rollback both need headroom.",
      });
    } else if (pct < 0.30) {
      reasons.push({
        severity: "watch", code: "disk_watch", family,
        message: `${label} is getting tight (${metric}).`,
        suggestion: "Watch the trend; expand the volume before it crosses 20%.",
      });
    }
  }

  if (inp.recommendedMaxConnections && inp.maxConnections > 0 && inp.maxConnections < inp.recommendedMaxConnections) {
    reasons.push({
      severity: "warning", code: "max_connections_undersized", family: "db_max_connections",
      message:
        `PostgreSQL max_connections is below the recommended value for this deployment ` +
        `(current ${inp.maxConnections}, recommended ${inp.recommendedMaxConnections}).`,
      suggestion:
        `Set max_connections=${inp.recommendedMaxConnections} in postgresql.conf and restart PostgreSQL. ` +
        `Charon can't change this from the UI because it requires a Postgres restart.`,
    });
  }

  if (inp.pgTuningNeeded) {
    reasons.push({
      severity: "watch", code: "pg_tuning_needed", family: "pg_tuning",
      message: "PostgreSQL memory settings are below the recommendation for this host and workload.",
      suggestion: "See the Capacity Advisor's advisory-only rows; edit postgresql.conf and restart PostgreSQL to apply.",
    });
  }

  if (inp.env.NODE_ENV === "production" && !(inp.env.CHARON_DATA_KEY ?? "").trim()) {
    reasons.push({
      severity: "critical", code: "data_key_unset", family: "data_key",
      message: "CHARON_DATA_KEY is not set — stored secrets are encrypted with an ephemeral key that does not survive a restart.",
      suggestion: "Set CHARON_DATA_KEY in .env (or Key Vault) and back it up off-host; losing it makes every stored secret unrecoverable.",
    });
  }

  if (!(inp.env.METRICS_TOKEN ?? "").trim()) {
    reasons.push({
      severity: "watch", code: "metrics_token_unset", family: "metrics_token",
      message:
        "/metrics is reachable without authentication (leaks endpoint counts, job health and queue " +
        "depth — useful recon if Charon is publicly reachable).",
      suggestion:
        "Click Generate token to write METRICS_TOKEN into .env (the gate takes effect immediately — no " +
        "restart). Then update your Prometheus scrape config to send `Authorization: Bearer <token>`.",
    });
  }
  if (!(inp.env.HEALTH_TOKEN ?? "").trim()) {
    reasons.push({
      severity: "watch", code: "health_token_unset", family: "health_token",
      message: "/health is reachable without authentication (leaks only 'the app is up' but the gate is trivial to enable).",
      suggestion:
        "Click Generate token to write HEALTH_TOKEN into .env (the gate takes effect immediately — no " +
        "restart). Note: the GSLB leader probe must then send `Authorization: Bearer <token>`.",
    });
  }

  return reasons;
}

/**
 * Pure: the database size once the audit log reaches its retention window.
 * Everything that is not the audit log is assumed flat. Null when the audit
 * log is kept forever (it has no steady state) or there is no event rate yet.
 */
export function projectSteadyStateBytes(opts: {
  totalBytes: number;
  eventsTableBytes: number;
  eventRows: number;
  eventsPerDay: number;
  eventRetentionDays: number;
}): number | null {
  if (opts.eventRetentionDays === FOREVER) return null;
  const nonEvent = Math.max(0, opts.totalBytes - opts.eventsTableBytes);
  if (opts.eventRows <= 0 || opts.eventsPerDay <= 0) return opts.totalBytes;
  const bytesPerEvent = opts.eventsTableBytes / opts.eventRows;
  return Math.round(nonEvent + bytesPerEvent * opts.eventsPerDay * Math.max(0, opts.eventRetentionDays));
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  pgTuningNeeded?: boolean;
  /** From the advisor, when it has computed one. */
  recommendedMaxConnections?: number | null;
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

export async function getCapacitySnapshot(opts: SnapshotOptions = {}): Promise<CapacitySnapshot> {
  const colocated = dbIsLocal();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [
    dataDirRows, connRows, breakdown, eventsRel, retention,
    endpointCount, onlineEndpointCount, tagCount, policyCount, directoryObjectCount, eventsLastWeek,
  ] = await Promise.all([
    colocated ? safe(prisma.$queryRawUnsafe<{ data_directory: string }[]>("SHOW data_directory"), []) : Promise.resolve([]),
    safe(prisma.$queryRawUnsafe<{ active: number; max: number }[]>(`
      SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS active,
             (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max`), []),
    safe(getDatabaseSizeBreakdown(), null),
    safe(prisma.$queryRawUnsafe<{ rows: number; bytes: number }[]>(`
      SELECT GREATEST(c.reltuples, 0)::float8 AS rows,
             (pg_total_relation_size(c.oid))::float8 AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'events'`), []),
    safe(getSampleRetention(), null),
    safe(prisma.endpoint.count({ where: { status: { not: "revoked" } } }), 0),
    safe(prisma.endpoint.count({ where: { status: "online" } }), 0),
    safe(prisma.tag.count(), 0),
    safe(prisma.policy.count(), 0),
    safe(prisma.directoryObject.count(), 0),
    safe(prisma.event.count({ where: { timestamp: { gte: weekAgo } } }), 0),
  ]);

  const dataDirectory = dataDirRows[0]?.data_directory ?? null;
  const volumes = await collectVolumes(dataDirectory);
  const activeConnections = Number(connRows[0]?.active ?? 0);
  const maxConnections = Number(connRows[0]?.max ?? 0);
  peakObserved = Math.max(peakObserved, activeConnections);

  const eventRetentionDays = retention?.events.days ?? 90;
  const sessionDays = retention?.verificationSessions.days ?? 1;
  const eventsPerDay = eventsLastWeek / 7;
  const sizeBytes = breakdown?.totalBytes ?? 0;

  const reasons = computeReasons({
    volumes,
    pgTuningNeeded: !!opts.pgTuningNeeded,
    maxConnections,
    recommendedMaxConnections: opts.recommendedMaxConnections ?? null,
    env: process.env,
  });

  return {
    computedAt: new Date().toISOString(),
    severity: worstSeverity(reasons),
    reasons,
    appHost: {
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAvg: loadavg() as [number, number, number],
      volumes,
      dbColocated: colocated,
    },
    database: {
      sizeBytes,
      dataDirectory,
      timescale: { extensionInstalled: false, hypertableTables: [] },
      queue: { pgbossInstalled: true, active: "pgboss", persisted: "pgboss" },
      connectionPool: {
        prismaPoolSize: prismaPoolSize(),
        pgbossPoolSize: pgbossPoolSize(),
        peakObserved,
        activeConnections,
        maxConnections,
      },
    },
    workload: {
      endpointCount,
      onlineEndpointCount,
      tagCount,
      policyCount,
      directoryObjectCount,
      eventCount: Math.round(Number(eventsRel[0]?.rows ?? 0)),
      eventsPerDay: Math.round(eventsPerDay),
      retention: { eventDays: eventRetentionDays, sessionDays },
      steadyStateSizeBytes: breakdown
        ? projectSteadyStateBytes({
            totalBytes: sizeBytes,
            eventsTableBytes: Number(eventsRel[0]?.bytes ?? 0),
            eventRows: Number(eventsRel[0]?.rows ?? 0),
            eventsPerDay,
            eventRetentionDays,
          })
        : null,
    },
  };
}
