/**
 * src/jobs/retentionPrune.ts — Leader-scheduled retention pruning.
 *
 * Trims the audit log and clears expired/revoked VerificationSessions to the
 * windows set on Server Settings → Retention (Setting "sampleRetention", see
 * services/sampleRetentionService.ts; the pre-port "retention.eventDays" key
 * still seeds the audit-log window). Runs on the leader (web) every 6h;
 * deletes are best-effort. −1 = keep forever.
 */

import { prisma } from "../db.js";
import { startJobTimer, recordJobOutcome } from "../metrics.js";
import { logger } from "../utils/logger.js";
import { getSampleRetention, retentionCutoff } from "../services/sampleRetentionService.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
let timer: NodeJS.Timeout | null = null;

export async function runRetentionPrune(): Promise<void> {
  const end = startJobTimer("retentionPrune");
  try {
    const retention = await getSampleRetention();
    const now = new Date();

    let events = 0;
    const eventCutoff = retentionCutoff(retention.events.days, now);
    if (eventCutoff) {
      events = (await prisma.event.deleteMany({ where: { timestamp: { lt: eventCutoff } } })).count;
    }

    let sessions = 0;
    const sessionCutoff = retentionCutoff(retention.verificationSessions.days, now);
    if (sessionCutoff) {
      sessions = (await prisma.verificationSession.deleteMany({
        where: { OR: [{ revokedAt: { lt: sessionCutoff } }, { expiresAt: { lt: sessionCutoff } }] },
      })).count;
    }

    if (events || sessions) {
      logger.info({ events, sessions, retention }, "retention prune");
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
