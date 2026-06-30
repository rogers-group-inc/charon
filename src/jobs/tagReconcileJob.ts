/**
 * src/jobs/tagReconcileJob.ts — Worker consumer for per-endpoint tag reconcile.
 *
 * The reconcile queue carries { endpointId } jobs enqueued on login/logout,
 * posture change, or directory/tag edits. The worker recomputes that endpoint's
 * effective tag set and (on change) enqueues an enforcement-sync job.
 */

import { getBoss, QUEUES, publish } from "../jobs.js";
import { reconcileEndpoint } from "../services/tagReconciler.js";
import { logger } from "../utils/logger.js";

/** Enqueue a reconcile for one endpoint (call from login/posture/etc.). */
export async function enqueueReconcile(endpointId: string): Promise<void> {
  await publish(QUEUES.tagReconcile, { endpointId }).catch(() => {});
}

export async function registerTagReconcileConsumer(): Promise<void> {
  const boss = await getBoss();
  if (!boss) {
    logger.warn("pg-boss unavailable — tag-reconcile consumer not registered");
    return;
  }
  await boss.work(QUEUES.tagReconcile, async (jobs: any) => {
    const list = Array.isArray(jobs) ? jobs : [jobs];
    for (const job of list) {
      const endpointId = job?.data?.endpointId;
      if (!endpointId) continue;
      await reconcileEndpoint(endpointId).catch((err) =>
        logger.warn({ err: err?.message, endpointId }, "tag reconcile job failed"),
      );
    }
  });
}
