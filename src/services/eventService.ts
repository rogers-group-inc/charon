/**
 * src/services/eventService.ts — Append to the audit log.
 *
 * Every meaningful state change (enrollment, login, tag reconcile, enforcement
 * apply, integration edit) records an Event. Best-effort: a failed write never
 * breaks the underlying operation.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

export type EventLevel = "info" | "warning" | "error";

const LEVEL_RANK: Record<EventLevel, number> = { info: 0, warning: 1, error: 2 };

export interface EventInput {
  level?: EventLevel;
  action: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  actor?: string;
  message: string;
  details?: unknown;
}

export async function logEvent(input: EventInput): Promise<void> {
  const level = input.level ?? "info";
  try {
    await prisma.event.create({
      data: {
        level,
        levelRank: LEVEL_RANK[level],
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        resourceName: input.resourceName ?? null,
        actor: input.actor ?? null,
        message: input.message,
        details: (input.details ?? undefined) as any,
      },
    });
  } catch (err: any) {
    logger.warn({ err: err?.message, action: input.action }, "Failed to write audit Event");
  }
}
