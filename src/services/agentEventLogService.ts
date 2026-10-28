/**
 * src/services/agentEventLogService.ts — Retention tab "Agent OS Event Log" card.
 *
 * Ported from the config half of polaris src/services/osEventLogService.ts:
 * the global master switch + curation filter for agent OS event-log collection
 * (Windows Event Log / Linux journald → audit Events), stored in
 * Setting("agentEventLog"). Default disabled; opt-in.
 *
 * Charon note: NO CONSUMER YET. The Charon (Tauri) agent does not ship OS
 * event-log entries, and there is no ingest path; this only persists the
 * operator's choice so the card works and the agent can read it once that
 * feature exists. Saving it changes nothing on the wire today.
 */

import { prisma } from "../db.js";

export interface AgentEventLogConfig {
  /** Master opt-in. Default false — nothing collected until an operator enables it. */
  enabled: boolean;
  /** Minimum severity an entry must meet to be ingested. */
  minLevel: "info" | "warning" | "error";
  /** Windows channels the agent reads. */
  windowsChannels: string[];
  /** Linux journald priority ceiling (0 emerg … 7 debug). */
  linuxMinPriority: number;
  /** Max entries accepted per push. */
  maxPerPush: number;
  /** Max audit rows written per endpoint per rolling hour. */
  perAssetHourlyCap: number;
}

export const DEFAULT_AGENT_EVENT_LOG_CONFIG: AgentEventLogConfig = {
  enabled: false,
  minLevel: "error",
  windowsChannels: ["System", "Application"],
  linuxMinPriority: 3, // err
  maxPerPush: 100,
  perAssetHourlyCap: 500,
};

const SETTING_KEY = "agentEventLog";

/** Pure: stored Setting value → fully-defaulted config (polaris verbatim). */
export function parseAgentEventLogConfig(raw: unknown): AgentEventLogConfig {
  const d = DEFAULT_AGENT_EVENT_LOG_CONFIG;
  if (!raw || typeof raw !== "object") return { ...d, windowsChannels: [...d.windowsChannels] };
  const v = raw as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    minLevel: v.minLevel === "info" || v.minLevel === "warning" || v.minLevel === "error" ? v.minLevel : d.minLevel,
    windowsChannels: Array.isArray(v.windowsChannels) ? (v.windowsChannels as unknown[]).filter((s): s is string => typeof s === "string") : [...d.windowsChannels],
    linuxMinPriority: typeof v.linuxMinPriority === "number" ? v.linuxMinPriority : d.linuxMinPriority,
    maxPerPush: typeof v.maxPerPush === "number" && v.maxPerPush > 0 ? v.maxPerPush : d.maxPerPush,
    perAssetHourlyCap: typeof v.perAssetHourlyCap === "number" && v.perAssetHourlyCap > 0 ? v.perAssetHourlyCap : d.perAssetHourlyCap,
  };
}

/** Pure: merge a partial operator update (clamping ranges) — polaris verbatim. */
export function mergeAgentEventLogConfig(current: AgentEventLogConfig, patch: Partial<AgentEventLogConfig>): AgentEventLogConfig {
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === "number" ? Math.round(v) : NaN;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    minLevel:
      patch.minLevel === "info" || patch.minLevel === "warning" || patch.minLevel === "error"
        ? patch.minLevel
        : current.minLevel,
    windowsChannels: Array.isArray(patch.windowsChannels)
      ? patch.windowsChannels
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= 128)
          .slice(0, 32)
      : current.windowsChannels,
    linuxMinPriority: patch.linuxMinPriority === undefined ? current.linuxMinPriority : clampInt(patch.linuxMinPriority, 0, 7, current.linuxMinPriority),
    maxPerPush: patch.maxPerPush === undefined ? current.maxPerPush : clampInt(patch.maxPerPush, 1, 5000, current.maxPerPush),
    perAssetHourlyCap: patch.perAssetHourlyCap === undefined ? current.perAssetHourlyCap : clampInt(patch.perAssetHourlyCap, 1, 100000, current.perAssetHourlyCap),
  };
}

export async function getAgentEventLogConfig(): Promise<AgentEventLogConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    return parseAgentEventLogConfig(row?.value);
  } catch {
    return parseAgentEventLogConfig(null);
  }
}

export async function updateAgentEventLogConfig(patch: Partial<AgentEventLogConfig>): Promise<AgentEventLogConfig> {
  const next = mergeAgentEventLogConfig(await getAgentEventLogConfig(), patch);
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as never },
    create: { key: SETTING_KEY, value: next as never },
  });
  return next;
}
