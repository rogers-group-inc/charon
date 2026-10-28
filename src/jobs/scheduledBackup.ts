/**
 * src/jobs/scheduledBackup.ts — Leader-scheduled automatic database backups.
 *
 * Ported from polaris (src/jobs/scheduledBackup.ts). Takes a backup on the
 * operator's cadence (Server Settings → Maintenance → Scheduled Backups),
 * prunes old SCHEDULED copies to the retention count, and optionally copies
 * each finished backup to an off-host directory. Default-OFF.
 *
 * Charon adaptation: instead of polaris's module-load timers on the scheduler
 * role, this follows the retentionPrune pattern — app.ts starts it from the
 * leader-election onLeader hook and stops it on loss of leadership, so an HA
 * pair (or a multi-role install) takes one backup, not one per process. Ticks
 * every 5 minutes and asks the pure isScheduledBackupDue(), so a host that was
 * down through its window backs up shortly after it regains leadership.
 */

import { logger } from "../utils/logger.js";
import { logEvent } from "../services/eventService.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { createBackup, listBackups, deleteBackup } from "../services/backupService.js";
import {
  getBackupSchedule,
  isScheduledBackupDue,
  recordScheduledBackupOutcome,
  copyBackupOffHost,
} from "../services/backupScheduleService.js";

const INTERVAL_MS = 5 * 60 * 1000;
// Boot delay so migrations and first-boot work settle before a long dump.
const FIRST_TICK_MS = 120_000;

let interval: NodeJS.Timeout | null = null;
let firstTick: NodeJS.Timeout | null = null;
let running = false;

/** Delete the oldest SCHEDULED backups beyond the retention count. Manual and
 *  pre-update backups are never touched. */
async function pruneScheduledBackups(retainCount: number): Promise<number> {
  const all = await listBackups(); // newest-first
  const scheduled = all.filter((b) => b.kind === "scheduled" || b.id.startsWith("bk-scheduled-"));
  let pruned = 0;
  for (const b of scheduled.slice(retainCount)) {
    try {
      await deleteBackup(b.id, "system:scheduled-backup");
      pruned++;
    } catch (err) {
      logger.warn({ err, backupId: b.id }, "scheduledBackup: could not prune an old scheduled backup");
    }
  }
  return pruned;
}

export async function runScheduledBackup(): Promise<void> {
  if (running) return; // a multi-GB dump can outlast a tick
  running = true;
  const end = startJobTimer("scheduledBackup");
  try {
    const schedule = await getBackupSchedule();
    if (!isScheduledBackupDue(schedule, new Date())) {
      recordJobOutcome("scheduledBackup", "success");
      return;
    }

    logger.info({ intervalHours: schedule.intervalHours, retainCount: schedule.retainCount }, "scheduledBackup: taking an automatic database backup");

    let record;
    let path: string;
    try {
      ({ record, path } = await createBackup({ password: schedule.passphrase, kind: "scheduled", actor: "system:scheduled-backup" }));
    } catch (err: any) {
      // A failing scheduled backup stays invisible until it matters — so it gets
      // an error Event and the lastError the settings card renders red.
      const detail = err?.message || String(err);
      await recordScheduledBackupOutcome({ ok: false, error: detail });
      await logEvent({
        level: "error",
        action: "server.backup.scheduled_failed",
        resourceType: "backup",
        actor: "system:scheduled-backup",
        message: `Scheduled database backup FAILED: ${detail}`,
        details: { error: detail },
      });
      logger.error({ err }, "scheduledBackup: backup failed");
      recordJobOutcome("scheduledBackup", "failure");
      return;
    }

    if (schedule.copyToDir) {
      try {
        const dest = await copyBackupOffHost(path, record.filename, schedule.copyToDir);
        logger.info({ dest }, "scheduledBackup: copied backup off-host");
      } catch (err: any) {
        await logEvent({
          level: "warning",
          action: "server.backup.offhost_copy_failed",
          resourceType: "backup",
          resourceId: record.id,
          resourceName: record.filename,
          actor: "system:scheduled-backup",
          message: `Scheduled backup succeeded but the off-host copy to ${schedule.copyToDir} failed: ${err?.message || err}`,
          details: { copyToDir: schedule.copyToDir, error: String(err?.message || err) },
        });
        logger.warn({ err, copyToDir: schedule.copyToDir }, "scheduledBackup: off-host copy failed");
      }
    }

    const pruned = await pruneScheduledBackups(schedule.retainCount);
    await recordScheduledBackupOutcome({ ok: true });
    logger.info({ backupId: record.id, sizeBytes: record.size, pruned }, "scheduledBackup: backup complete");
    recordJobOutcome("scheduledBackup", "success");
  } catch (err: any) {
    recordJobOutcome("scheduledBackup", "failure");
    logger.warn({ err: err?.message ?? String(err) }, "scheduledBackup tick failed (non-fatal)");
  } finally {
    running = false;
    end();
  }
}

/** Leader-only: start the periodic scheduled-backup check. */
export function scheduleScheduledBackups(): void {
  if (interval) return;
  firstTick = setTimeout(() => void runScheduledBackup(), FIRST_TICK_MS);
  interval = setInterval(() => void runScheduledBackup(), INTERVAL_MS);
  firstTick.unref?.();
  interval.unref?.();
}

export function stopScheduledBackups(): void {
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
  if (interval) { clearInterval(interval); interval = null; }
}
