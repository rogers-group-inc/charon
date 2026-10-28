/**
 * src/jobs/directoryDiscoveryJob.ts — scheduled directory discovery + the
 * stale-run reaper (ported from polaris discoveryScheduler / discoveryRunReaper,
 * on Charon's pg-boss + leader-election wiring).
 *
 * Leader (startSchedulers, rule 5):
 *   - scheduleDirectoryDiscovery(): every 15 min, enqueue a run for each
 *     integration that is enabled, autoDiscover, last test OK, a directory
 *     source, and due by its pollInterval (hours, measured from
 *     lastDiscoveryAt — persisted, so the interval survives restarts).
 *   - scheduleDiscoveryReaper(): every 60 s, fail any queued/running
 *     DiscoveryRun whose worker heartbeat is older than 3 min (3 missed
 *     60-second beats), so a crashed worker never wedges an integration.
 * Worker (runsWorkers):
 *   - registerDirectoryDiscoveryConsumer(): consume `charon.directory-sync`
 *     and run discovery/directoryDiscovery → runDiscovery.
 */

import { prisma } from "../db.js";
import { getBoss, QUEUES } from "../jobs.js";
import { triggerDiscovery, isDiscoveryRunning, runDiscovery, DISCOVERABLE_TYPES } from "../services/discovery/directoryDiscovery.js";
import { reapStaleRuns } from "../services/discoveryRunState.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { logger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
const REAP_STALE_AFTER_MS = 3 * 60 * 1000;

let scheduleTimer: NodeJS.Timeout | null = null;
let reapTimer: NodeJS.Timeout | null = null;
let reaping = false;

/** One scheduler tick (exported for tests). */
export async function runScheduledDiscoveries(now = Date.now()): Promise<string[]> {
  const integrations = await prisma.integration.findMany({
    where: { enabled: true, autoDiscover: true, lastTestOk: true, type: { in: [...DISCOVERABLE_TYPES] } },
    select: { id: true, name: true, pollInterval: true, lastDiscoveryAt: true },
  });
  const triggered: string[] = [];
  for (const intg of integrations) {
    // Due-check first: free, while isDiscoveryRunning is a query.
    const intervalMs = (intg.pollInterval ?? 4) * 60 * 60 * 1000;
    const lastRun = intg.lastDiscoveryAt?.getTime();
    if (lastRun !== undefined && now - lastRun < intervalMs) continue;
    if (await isDiscoveryRunning(intg.id).catch(() => false)) continue;
    try {
      if (await triggerDiscovery(intg.id, "auto-discovery")) triggered.push(intg.id);
    } catch (err) {
      logger.error({ err, integrationId: intg.id, integrationName: intg.name }, "discovery scheduler: failed to start discovery");
    }
  }
  return triggered;
}

/** Leader-only: start the 15-minute scheduled-discovery tick. */
export function scheduleDirectoryDiscovery(): void {
  if (scheduleTimer) return;
  const tick = () => {
    const end = startJobTimer("directoryDiscoveryScheduler");
    runScheduledDiscoveries()
      .then(() => recordJobOutcome("directoryDiscoveryScheduler", "success"))
      .catch((err) => {
        recordJobOutcome("directoryDiscoveryScheduler", "failure");
        logger.error({ err }, "discovery scheduler tick failed");
      })
      .finally(end);
  };
  tick();
  scheduleTimer = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof scheduleTimer.unref === "function") scheduleTimer.unref();
}

/** Leader-only: start the 60-second stale-run reaper. */
export function scheduleDiscoveryReaper(): void {
  if (reapTimer) return;
  const tick = () => {
    if (reaping) return;
    reaping = true;
    reapStaleRuns(REAP_STALE_AFTER_MS)
      .catch((err) => logger.warn({ err }, "discovery run reaper tick failed"))
      .finally(() => { reaping = false; });
  };
  tick();
  reapTimer = setInterval(tick, REAP_INTERVAL_MS);
  if (typeof reapTimer.unref === "function") reapTimer.unref();
}

export function stopDirectoryDiscoverySchedulers(): void {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  if (reapTimer) { clearInterval(reapTimer); reapTimer = null; }
}

/** Worker-only: consume discovery runs. */
export async function registerDirectoryDiscoveryConsumer(): Promise<void> {
  const boss = await getBoss();
  if (!boss) {
    logger.warn("pg-boss unavailable — directory discovery consumer not registered (runs execute in-process)");
    return;
  }
  await boss.work(QUEUES.directorySync, async (jobs: any) => {
    for (const job of Array.isArray(jobs) ? jobs : [jobs]) {
      const { integrationId, actor } = (job?.data ?? {}) as { integrationId?: string; actor?: string };
      if (!integrationId) continue;
      const end = startJobTimer("directoryDiscovery");
      try {
        await runDiscovery(integrationId, actor ?? "auto-discovery");
        recordJobOutcome("directoryDiscovery", "success");
      } catch (err: any) {
        recordJobOutcome("directoryDiscovery", "failure");
        logger.warn({ err: err?.message, integrationId }, "directory discovery job failed");
      } finally {
        end();
      }
    }
  });
}
