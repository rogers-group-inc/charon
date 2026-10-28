/**
 * src/services/capacityAdvisorService.ts — the Capacity Advisor card.
 *
 * Ported (in shape) from polaris src/services/capacityAdvisorService.ts: per
 * lever, current vs recommended, whether a change is required, and how it is
 * applied — "env" levers can be STAGED into .env (take effect on restart);
 * "advisory-only" levers need a PostgreSQL restart and are never written.
 *
 * Charon adaptation — the levers Charon actually has:
 *   DATABASE_POOL_SIZE       (env)      Prisma pool per process (src/db.ts)
 *   CHARON_PGBOSS_POOL_SIZE  (env)      pg-boss pool per process (src/jobs.ts)
 *   PG_MAX_CONNECTIONS       (advisory) sum of every process's pools + headroom
 *   PG_SHARED_BUFFERS / PG_EFFECTIVE_CACHE_SIZE / PG_WORK_MEM /
 *   PG_RANDOM_PAGE_COST      (advisory) from pgTuningService
 * No QUEUE_MODE lever and no per-cadence worker counts: Charon always runs
 * pg-boss and has no monitor cadences. Sizing is driven by enrolled endpoints
 * (telemetry + verification writes scale with them).
 */

import type { PgTuningResult } from "./pgTuningService.js";
import { buildPgRecommended } from "./pgTuningService.js";
import { setEnvVar } from "../utils/envFile.js";
import { getRole } from "../utils/role.js";

export type AdvisorLeverKey =
  | "DATABASE_POOL_SIZE"
  | "CHARON_PGBOSS_POOL_SIZE"
  | "PG_MAX_CONNECTIONS"
  | "PG_SHARED_BUFFERS"
  | "PG_EFFECTIVE_CACHE_SIZE"
  | "PG_WORK_MEM"
  | "PG_RANDOM_PAGE_COST";

export const ENV_LEVERS: ReadonlySet<string> = new Set(["DATABASE_POOL_SIZE", "CHARON_PGBOSS_POOL_SIZE"]);

export interface AdvisorRecommendation {
  key: AdvisorLeverKey;
  current: number | string | null;
  recommended: number | string;
  changeRequired: boolean;
  applyMode: "env" | "advisory-only";
  rationale: string;
  breakdown?: Record<string, number | string>;
  operatorOverride?: boolean;
}

export interface AdvisorState {
  computedAt: string;
  recommendedQueueMode: "pgboss";
  usingColdStartDefaults: boolean;
  anyChangeRequired: boolean;
  recommendations: AdvisorRecommendation[];
}

export interface AdvisorInputs {
  endpointCount: number;
  prismaPoolSize: number;
  pgbossPoolSize: number;
  maxConnections: number;
  /** Processes that each open their own pools (1 for CHARON_ROLE unset/all). */
  processCount: number;
  pgTuning: PgTuningResult | null;
}

/** Pure: Prisma pool per process for an endpoint count. */
export function recommendedPrismaPool(endpoints: number): number {
  if (endpoints <= 1000) return 25;
  if (endpoints <= 5000) return 40;
  return 60;
}

/** Pure: pg-boss pool per process for an endpoint count. */
export function recommendedPgbossPool(endpoints: number): number {
  return endpoints <= 2000 ? 10 : 20;
}

/** Connections PostgreSQL keeps for autovacuum, admin sessions, replication. */
export const MAX_CONNECTIONS_HEADROOM = 20;

/** How many app processes open pools. A split-role install runs web +
 *  endpoint + enforcer + worker (one each by default). */
export function estimateProcessCount(role: string = getRole()): number {
  const n = Number.parseInt(process.env.CHARON_ADVISOR_PROCESS_COUNT ?? "", 10);
  if (Number.isFinite(n) && n > 0) return n;
  return role === "all" ? 1 : 4;
}

/** Pure: build the advisor state. */
export function computeAdvisor(inp: AdvisorInputs, now: Date = new Date()): AdvisorState {
  const recs: AdvisorRecommendation[] = [];

  const prismaRec = Math.max(inp.prismaPoolSize, recommendedPrismaPool(inp.endpointCount));
  recs.push({
    key: "DATABASE_POOL_SIZE",
    current: inp.prismaPoolSize,
    recommended: prismaRec,
    changeRequired: inp.prismaPoolSize < recommendedPrismaPool(inp.endpointCount),
    applyMode: "env",
    rationale: "Prisma pool per Charon process, sized from enrolled endpoints (HTTP handlers + agent telemetry writes).",
    breakdown: { endpoints: inp.endpointCount },
  });

  const bossRec = Math.max(inp.pgbossPoolSize, recommendedPgbossPool(inp.endpointCount));
  recs.push({
    key: "CHARON_PGBOSS_POOL_SIZE",
    current: inp.pgbossPoolSize,
    recommended: bossRec,
    changeRequired: inp.pgbossPoolSize < recommendedPgbossPool(inp.endpointCount),
    applyMode: "env",
    rationale: "pg-boss pool per Charon process (tag reconcile / enforcement sync / directory sync queues).",
    breakdown: { endpoints: inp.endpointCount },
  });

  // max_connections must cover every process's pools at their RECOMMENDED size.
  const maxConnRec = inp.processCount * (prismaRec + bossRec) + MAX_CONNECTIONS_HEADROOM;
  recs.push({
    key: "PG_MAX_CONNECTIONS",
    current: inp.maxConnections || null,
    recommended: maxConnRec,
    changeRequired: inp.maxConnections > 0 && inp.maxConnections < maxConnRec,
    applyMode: "advisory-only",
    rationale: "Every Charon process opens a Prisma pool and a pg-boss pool against the same PostgreSQL.",
    breakdown: { processes: inp.processCount, prismaPool: prismaRec, pgbossPool: bossRec, headroom: MAX_CONNECTIONS_HEADROOM },
  });

  const pgDefaults = buildPgRecommended();
  const pgRows: Array<[AdvisorLeverKey, string, string]> = [
    ["PG_SHARED_BUFFERS", "shared_buffers", pgDefaults.shared_buffers.display],
    ["PG_EFFECTIVE_CACHE_SIZE", "effective_cache_size", pgDefaults.effective_cache_size.display],
    ["PG_WORK_MEM", "work_mem", pgDefaults.work_mem.display],
    ["PG_RANDOM_PAGE_COST", "random_page_cost", pgDefaults.random_page_cost.display],
  ];
  // Only shown once the tuning check engages (pgTuning non-null) — a small
  // install gets no PostgreSQL tuning advice, same as polaris.
  if (inp.pgTuning) {
    for (const [key, name, fallback] of pgRows) {
      const row = inp.pgTuning.settings.find((s) => s.name === name);
      recs.push({
        key,
        current: row?.current ?? null,
        recommended: row?.recommended ?? fallback,
        changeRequired: row ? !row.ok : false,
        applyMode: "advisory-only",
        rationale: `${name} sized from host RAM.`,
        operatorOverride: row?.operatorOverride ?? false,
      });
    }
  }

  return {
    computedAt: now.toISOString(),
    recommendedQueueMode: "pgboss",
    usingColdStartDefaults: false,
    anyChangeRequired: recs.some((r) => r.changeRequired && !r.operatorOverride),
    recommendations: recs,
  };
}

export interface StageResult {
  key: string;
  status: "applied" | "skipped" | "error";
  oldValue?: string | number | null;
  newValue?: string | number;
  reason?: string;
}

/** Write the selected env levers' recommended values into .env. */
export async function stageAdvisorState(
  keys: string[],
  advisor: AdvisorState,
  write: (key: string, value: string) => void = setEnvVar,
): Promise<{ results: StageResult[] }> {
  const results: StageResult[] = [];
  for (const key of keys) {
    const rec = advisor.recommendations.find((r) => r.key === key);
    if (!rec) { results.push({ key, status: "error", reason: "unknown lever" }); continue; }
    if (rec.applyMode !== "env" || !ENV_LEVERS.has(key)) {
      results.push({ key, status: "skipped", reason: "advisory-only — requires a PostgreSQL restart; apply manually" });
      continue;
    }
    if (!rec.changeRequired) { results.push({ key, status: "skipped", reason: "already at or above the recommendation" }); continue; }
    try {
      write(key, String(rec.recommended));
      results.push({ key, status: "applied", oldValue: rec.current, newValue: rec.recommended });
    } catch (err: any) {
      results.push({ key, status: "error", reason: err?.message ?? String(err) });
    }
  }
  return { results };
}
