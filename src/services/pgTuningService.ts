/**
 * src/services/pgTuningService.ts — the PostgreSQL tuning check.
 *
 * Ported from polaris (src/services/pgTuningService.ts). Reads pg_settings and
 * compares shared_buffers / work_mem / effective_cache_size / random_page_cost
 * against recommendations sized from host RAM. Its `pgTuningNeeded` flag feeds
 * the capacity snapshot's `pg_tuning_needed` reason, and its rows feed the
 * Capacity Advisor's advisory-only levers.
 *
 * Charon adaptation: polaris triggered the check on asset/subnet/reservation
 * counts. Charon's growth drivers are enrolled endpoints and the audit log, so
 * the check engages once either crosses its threshold (80% of the size at which
 * stock PostgreSQL settings start to bite). A small install gets no advice.
 */

import { totalmem } from "node:os";
import { prisma } from "../db.js";

export const PG_TUNING_THRESHOLDS = {
  endpoints: 400,       // 80% of 500
  events: 1_600_000,    // 80% of 2,000,000 audit rows
};

export function buildPgRecommended(ram: number = totalmem()): Record<string, { min: number; unit: string; display: string }> {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  // Round to clean multiples of 8 so the values sit on the boundaries operators
  // are used to seeing in postgresql.conf (8/16/24 GB, 8/16/24 MB).
  const roundToMultipleOf = (b: number, unit: number) => Math.round(b / unit) * unit;
  const EIGHT_MB = 8 * MB;
  const EIGHT_GB = 8 * GB;

  const sharedBuffers = Math.max(
    128 * MB,
    roundToMultipleOf(ram * 0.25, EIGHT_GB) || roundToMultipleOf(ram * 0.25, EIGHT_MB),
  );
  const effectiveCache = Math.max(
    256 * MB,
    roundToMultipleOf(ram * 0.75, EIGHT_GB) || roundToMultipleOf(ram * 0.75, EIGHT_MB),
  );
  // work_mem: RAM/128, rounded to nearest 8 MB, capped at 256 MB, min 32 MB.
  const workMem = Math.max(32 * MB, Math.min(256 * MB, roundToMultipleOf(ram / 128, EIGHT_MB)));

  const fmt = (b: number) => (b >= GB ? b / GB + "GB" : b / MB + "MB");

  return {
    shared_buffers:       { min: sharedBuffers,  unit: "bytes", display: fmt(sharedBuffers) },
    work_mem:             { min: workMem,        unit: "bytes", display: fmt(workMem) },
    effective_cache_size: { min: effectiveCache, unit: "bytes", display: fmt(effectiveCache) },
    random_page_cost:     { min: -1,             unit: "cost",  display: "1.1" },
  };
}

export function parsePgBytes(val: string): number {
  const s = val.trim();
  const m = s.match(/^(\d+)\s*(kB|MB|GB|TB)?$/i);
  if (!m) return parseInt(s, 10) || 0;
  const n = parseInt(m[1], 10);
  switch ((m[2] || "").toUpperCase()) {
    case "KB": return n * 1024;
    case "MB": return n * 1024 * 1024;
    case "GB": return n * 1024 * 1024 * 1024;
    case "TB": return n * 1024 * 1024 * 1024 * 1024;
    default:   return n;
  }
}

export interface PgTuningRow {
  name: string;
  current: string;
  recommended: string;
  ok: boolean;
  /** Set via ALTER SYSTEM (postgresql.auto.conf) — a deliberate operator
   *  choice the advisor treats as OK even below its heuristic. */
  operatorOverride: boolean;
}

export function isAutoConfOverride(s: { sourcefile: string | null }): boolean {
  return !!s.sourcefile && /postgresql\.auto\.conf$/.test(s.sourcefile.replace(/\\/g, "/"));
}

export interface PgTuningResult {
  settings: PgTuningRow[];
  pgConfigFile: string | null;
  pgTuningNeeded: boolean;
}

type PgSettingRow = { name: string; setting: string; unit: string | null; sourcefile: string | null };

/** Pure: grade pg_settings rows against the RAM-sized recommendations. */
export function gradePgSettings(pgSettings: PgSettingRow[], ram?: number): PgTuningResult {
  const pgConfigFile = pgSettings.find((s) => s.name === "config_file")?.setting || null;
  const PG_RECOMMENDED = buildPgRecommended(ram);
  const settings: PgTuningRow[] = pgSettings.map((s) => {
    if (s.name === "config_file") return null;
    const rec = PG_RECOMMENDED[s.name];
    if (!rec) return null;
    const operatorOverride = isAutoConfOverride(s);
    if (s.name === "random_page_cost") {
      const val = parseFloat(s.setting);
      return { name: s.name, current: String(val), recommended: rec.display, ok: operatorOverride || val <= 1.1, operatorOverride };
    }
    let currentBytes: number;
    if (s.unit === "8kB") currentBytes = parseInt(s.setting, 10) * 8192;
    else if (s.unit === "kB") currentBytes = parseInt(s.setting, 10) * 1024;
    else currentBytes = parsePgBytes(s.setting);
    const ok = operatorOverride || currentBytes >= rec.min;
    let currentDisplay: string;
    if (currentBytes >= 1024 * 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "GB";
    else if (currentBytes >= 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024)).toFixed(0) + "MB";
    else currentDisplay = (currentBytes / 1024).toFixed(0) + "kB";
    return { name: s.name, current: currentDisplay, recommended: rec.display, ok, operatorOverride };
  }).filter((s): s is PgTuningRow => s !== null);
  return { settings, pgConfigFile, pgTuningNeeded: !settings.every((s) => s.ok) };
}

/** The tuning check, or null when no threshold is crossed (small install). */
export async function computePgTuning(): Promise<PgTuningResult | null> {
  const [endpointCount, eventEstimate] = await Promise.all([
    prisma.endpoint.count({ where: { status: { not: "revoked" } } }),
    // Planner estimate, not count(*): counting a multi-million-row audit log on
    // every Maintenance load would be the slow query this check warns about.
    prisma.$queryRawUnsafe<{ n: number }[]>("SELECT COALESCE(reltuples, 0)::float8 AS n FROM pg_class WHERE relname = 'events' LIMIT 1")
      .then((r) => Math.max(0, Number(r[0]?.n ?? 0)))
      .catch(() => 0),
  ]);
  if (endpointCount < PG_TUNING_THRESHOLDS.endpoints && eventEstimate < PG_TUNING_THRESHOLDS.events) return null;

  const pgSettings = await prisma.$queryRawUnsafe<PgSettingRow[]>(
    `SELECT name, setting, unit, sourcefile FROM pg_settings WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost', 'config_file')`,
  );
  return gradePgSettings(pgSettings);
}
