/**
 * src/jobs/retentionPrune.ts — Leader-scheduled retention pruning.
 *
 * Trims the audit log to a configurable window (Setting "retention.eventDays",
 * default 90) and clears expired/old VerificationSessions. Runs on the leader
 * (web) on a daily-ish interval; deletes are batched and best-effort.
 */

import { prisma } from "../db.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
let timer: NodeJS.Timeout | null = null;

async function eventRetentionDays(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: "retention.eventDays" } });
  const v = (row?.value as { days?: number } | undefined)?.days;
  return typeof v === "number" && v > 0 ? v : 90;
}

export async function runRetentionPrune(): Promise<void> {
  const end = startJobTimer("retentionPrune");
  try {
    const days = await eventRetentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const events = await prisma.event.deleteMany({ where: { timestamp: { lt: cutoff } } });
    // Expired verification sessions older than a day are no longer needed.
    const sessionCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sessions = await prisma.verificationSession.deleteMany({
      where: { OR: [{ revokedAt: { lt: sessionCutoff } }, { expiresAt: { lt: sessionCutoff } }] },
    });
    if (events.count || sessions.count) {
      logger.info({ events: events.count, sessions: sessions.count, retentionDays: days }, "retention prune");
    }
    recordJobOutcome("retentionPrune", "success");
  } catch (err: any) {
    recordJobOutcome("retentionPrune", "failure");
    logger.warn({ err: err?.message }, "retention prune failed");
  } finally {
    end();
  }
}

/** Leader-only: start the periodic prune. */
export function scheduleRetentionPrune(): void {
  if (timer) return;
  void runRetentionPrune();
  timer = setInterval(() => void runRetentionPrune(), INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopRetentionPrune(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
