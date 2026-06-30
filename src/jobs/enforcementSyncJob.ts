/**
 * src/jobs/enforcementSyncJob.ts — Enforcer consumer for tag-change deltas.
 *
 * Drains QUEUES.enforcementSync ({ endpointId, added, removed }) and applies the
 * delta to every enforcement-capable integration (dry-run unless that
 * integration's enforce toggle is ON). Runs only on the enforcer role.
 */

import { getBoss, QUEUES } from "../jobs.js";
import { applyEndpointDelta, refreshDriftCounts } from "../services/fortinetEnforcementService.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { logger } from "../utils/logger.js";

export async function registerEnforcementConsumer(): Promise<void> {
  const boss = await getBoss();
  if (!boss) {
    logger.warn("pg-boss unavailable — enforcement-sync consumer not registered");
    return;
  }
  await boss.work(QUEUES.enforcementSync, async (jobs: any) => {
    const list = Array.isArray(jobs) ? jobs : [jobs];
    for (const job of list) {
      const { endpointId, added = [], removed = [] } = job?.data ?? {};
      if (!endpointId) continue;
      const end = startJobTimer("enforcementSync");
      try {
        await applyEndpointDelta(endpointId, added, removed);
        recordJobOutcome("enforcementSync", "success");
      } catch (err: any) {
        recordJobOutcome("enforcementSync", "failure");
        logger.warn({ err: err?.message, endpointId }, "enforcement-sync job failed");
      } finally {
        end();
      }
    }
  });
  await refreshDriftCounts().catch(() => {});
}
