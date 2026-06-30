/**
 * src/services/tagReconciler.ts — Recompute an endpoint's effective tag set.
 *
 * Triggered on login/logout, posture change, directory sync, or tag/source
 * edits. Idempotent: computes the desired EndpointTag set, diffs it against the
 * stored rows, applies the delta, and — when something changed — enqueues a
 * Fortinet enforcement-sync job (consumed by the enforcer in milestone 6;
 * dry-run by default until an integration's enforce toggle is ON + reviewed).
 *
 * Ownership-scoped by construction: only Charon's own EndpointTag/Tag rows are
 * touched here; the Fortinet side only ever writes charon-* objects.
 */

import { prisma } from "../db.js";
import { computeEffectiveTags } from "./tagService.js";
import { publish, QUEUES } from "../jobs.js";
import { logEvent } from "./eventService.js";
import { startTagReconcileTimer } from "../metrics.js";

export interface ReconcileResult {
  endpointId: string;
  added: string[]; // tag names newly held
  removed: string[]; // tag names no longer held
  unchanged: number;
}

export async function reconcileEndpoint(endpointId: string): Promise<ReconcileResult> {
  const end = startTagReconcileTimer();
  try {
    const effective = await computeEffectiveTags(endpointId);
    const desired = new Map(effective.map((e) => [e.tagId, e]));

    const existing = await prisma.endpointTag.findMany({ where: { endpointId } });
    const existingByTag = new Map(existing.map((e) => [e.tagId, e]));

    const added: string[] = [];
    const removed: string[] = [];

    // Add / update.
    for (const [tagId, eff] of desired) {
      const prev = existingByTag.get(tagId);
      if (!prev) {
        await prisma.endpointTag.create({ data: { endpointId, tagId, reasons: eff.reasons as any } });
        added.push(eff.tagName);
      } else {
        await prisma.endpointTag.update({ where: { id: prev.id }, data: { reasons: eff.reasons as any } });
      }
    }
    // Remove tags no longer held.
    for (const prev of existing) {
      if (!desired.has(prev.tagId)) {
        await prisma.endpointTag.delete({ where: { id: prev.id } });
        const tag = await prisma.tag.findUnique({ where: { id: prev.tagId } });
        removed.push(tag?.name ?? prev.tagId);
      }
    }

    if (added.length || removed.length) {
      await logEvent({
        action: "tag.reconciled",
        resourceType: "endpoint",
        resourceId: endpointId,
        message: `Reconciled endpoint tags: +[${added.join(", ")}] -[${removed.join(", ")}]`,
        details: { added, removed },
      });
      // Hand the delta to the enforcer (dry-run unless enforce is ON).
      await publish(QUEUES.enforcementSync, { endpointId, added, removed }).catch(() => {});
    }

    return { endpointId, added, removed, unchanged: desired.size - added.length };
  } finally {
    end();
  }
}

/** Reconcile every enrolled endpoint (used after a directory sync or tag edit). */
export async function reconcileAll(): Promise<{ endpoints: number }> {
  const endpoints = await prisma.endpoint.findMany({ where: { status: { in: ["enrolled", "online", "offline"] } }, select: { id: true } });
  for (const e of endpoints) {
    await reconcileEndpoint(e.id).catch(() => {});
  }
  return { endpoints: endpoints.length };
}
