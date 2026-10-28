/**
 * src/jobs/ouiRefresh.ts — Leader-scheduled weekly IEEE OUI database refresh.
 *
 * Ported from polaris src/jobs/ouiRefresh.ts. Downloads the database on first
 * run if it was never fetched (or is stale), then weekly. Charon adaptation:
 * a start/stop pair driven by leader election (app.ts startSchedulers) rather
 * than a module-load side effect, so only the leader hits the IEEE registry.
 * A failure (no outbound internet, proxy) is logged and retried next tick —
 * the Identification tab's "Refresh Now" surfaces the same error to an admin.
 */

import { refreshOuiDatabase, getOuiStatus } from "../services/ouiService.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
let timer: NodeJS.Timeout | null = null;

export async function runOuiRefresh(): Promise<void> {
  const end = startJobTimer("ouiRefresh");
  try {
    const status = await getOuiStatus();
    // Skip if refreshed within the last 6 days (avoids duplicate refreshes on restart / failover).
    if (status.refreshedAt) {
      const age = Date.now() - new Date(status.refreshedAt).getTime();
      if (age < INTERVAL_MS - 24 * 60 * 60 * 1000) {
        recordJobOutcome("ouiRefresh", "success");
        return;
      }
    }
    const result = await refreshOuiDatabase();
    logger.info({ entries: result.entries, sizeKb: result.sizeKb }, "OUI database refreshed");
    recordJobOutcome("ouiRefresh", "success");
  } catch (err: any) {
    recordJobOutcome("ouiRefresh", "failure");
    logger.warn({ err: err?.message }, "OUI database refresh failed");
  } finally {
    end();
  }
}

/** Leader-only: run once now, then weekly. */
export function scheduleOuiRefresh(): void {
  if (timer) return;
  void runOuiRefresh();
  timer = setInterval(() => void runOuiRefresh(), INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopOuiRefresh(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
