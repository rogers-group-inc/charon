/**
 * src/jobs/endpointSilenceJob.ts — mark silent agents offline (leader, 60 s).
 *
 * An `online` Endpoint whose agent has made no bearer call for
 * `silenceWindowMs(AGENT_HEARTBEAT_INTERVAL_SEC)` becomes `offline`, with the
 * guards in utils/agentSilence.ts (no judging before this process has listened
 * a whole window; nothing changes when the whole fleet is dark — that is
 * Charon not receiving). One bounded aggregate + one updateMany per tick,
 * whatever the fleet size. Its next heartbeat marks it online again.
 */

import { prisma } from "../db.js";
import { silenceCutoff } from "../utils/agentSilence.js";
import { logEvent } from "../services/eventService.js";
import { logger } from "../utils/logger.js";

/** The cadence GET /agents/config tells agents to heartbeat at. */
export const AGENT_HEARTBEAT_INTERVAL_SEC = 60;
const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
const listeningSince = Date.now();

/** One tick (exported for tests). Returns how many endpoints went offline. */
export async function markSilentEndpoints(now = Date.now(), since = listeningSince): Promise<number> {
  const reporting = { status: { in: ["online", "offline"] as Array<"online" | "offline"> }, bearerRevokedAt: null };
  const agg = await prisma.endpoint.aggregate({ where: reporting, _max: { lastSeenAt: true }, _count: { _all: true } });
  const { cutoff, fleetDark } = silenceCutoff({
    now,
    listeningSince: since,
    intervalSeconds: AGENT_HEARTBEAT_INTERVAL_SEC,
    newestSeenAt: agg._max.lastSeenAt,
    reportingCount: agg._count._all,
  });
  if (fleetDark) {
    logger.warn("endpoint silence: no agent has reported within the window — treating it as Charon not receiving; nothing marked offline");
    return 0;
  }
  if (!cutoff) return 0;
  const res = await prisma.endpoint.updateMany({
    where: { status: "online", bearerRevokedAt: null, OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null }] },
    data: { status: "offline" },
  });
  if (res.count > 0) {
    await logEvent({ level: "warning", action: "endpoint.silent", actor: "system:silence", message: `${res.count} endpoint(s) went offline: no heartbeat since ${cutoff.toISOString()}` });
  }
  return res.count;
}

/** Leader-only (rule 5). */
export function scheduleEndpointSilence(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    markSilentEndpoints()
      .catch((err) => logger.warn({ err }, "endpoint silence tick failed"))
      .finally(() => { running = false; });
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopEndpointSilence(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
