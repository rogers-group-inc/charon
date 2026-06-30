/**
 * src/jobs/integrationHealthCheck.ts — Periodic integration health sweep.
 *
 * The leader (web) schedules a health-check job every 10 minutes; the worker
 * role consumes it and runs testConnection against every enabled integration,
 * stamping lastTestAt/lastTestOk (surfaced on the Integrations page). Mirrors
 * polaris's integrationConnectionTester cadence.
 *
 * Wiring: scheduleHealthChecks() runs on the leader (interval producer);
 * registerHealthCheckConsumer() runs on the worker role. Both no-op gracefully
 * when pg-boss is unavailable.
 */

import { getBoss, QUEUES, publish } from "../jobs.js";
import { runHealthChecks } from "../services/integrationService.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

/** Leader-only: enqueue a health-check job every 10 minutes. */
export function scheduleHealthChecks(): void {
  if (timer) return;
  const tick = () => void publish(QUEUES.healthCheck, { at: new Date().toISOString() }).catch(() => {});
  tick();
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopHealthChecks(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Worker-only: consume health-check jobs. */
export async function registerHealthCheckConsumer(): Promise<void> {
  const boss = await getBoss();
  if (!boss) {
    logger.warn("pg-boss unavailable — integration health-check consumer not registered");
    return;
  }
  await boss.work(QUEUES.healthCheck, async () => {
    const end = startJobTimer("integrationHealthCheck");
    try {
      await runHealthChecks();
      recordJobOutcome("integrationHealthCheck", "success");
    } catch (err: any) {
      recordJobOutcome("integrationHealthCheck", "failure");
      logger.warn({ err: err?.message }, "integration health-check job failed");
    } finally {
      end();
    }
  });
}
