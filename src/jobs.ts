/**
 * src/jobs.ts — pg-boss scheduler/queue bootstrap.
 *
 * pg-boss is the ONLY coordination channel between roles (no direct
 * process-to-process coupling). Queues:
 *   - charon.directory-sync   — worker: pull users/groups/OUs from AD/Entra/Intune
 *   - charon.tag-reconcile    — worker: recompute an endpoint's effective tag set
 *   - charon.enforcement-sync — enforcer: apply tag/policy deltas to Fortinet
 *   - charon.posture-eval     — worker: evaluate posture → PostureState
 *   - charon.health-check     — worker: integration testConnection sweep
 *
 * Producers (schedulers) run only on the leader (web role + advisory lock).
 * Consumers run on the role that owns the work (worker / enforcer). This module
 * exposes lazy init + start/stop so app.ts can wire the right surface per role.
 */

import { PgBoss } from "pg-boss";
import type { PgBoss as PgBossType } from "pg-boss";
import { logger } from "./utils/logger.js";

export const QUEUES = {
  directorySync: "charon.directory-sync",
  tagReconcile: "charon.tag-reconcile",
  enforcementSync: "charon.enforcement-sync",
  postureEval: "charon.posture-eval",
  healthCheck: "charon.health-check",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let boss: PgBossType | null = null;
let starting: Promise<PgBossType | null> | null = null;

function poolSize(): number {
  const n = Number.parseInt(process.env.CHARON_PGBOSS_POOL_SIZE ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * Lazily start pg-boss against DATABASE_URL (or CHARON_DB_DIRECT_URL when a
 * pooler like PgBouncer fronts the app — pg-boss needs a session-level
 * connection). Returns null and stays disabled if it can't start, so the app
 * still boots; queue producers/consumers no-op until pg-boss is healthy.
 */
export async function getBoss(): Promise<PgBossType | null> {
  if (boss) return boss;
  if (starting) return starting;
  starting = (async () => {
    try {
      const connectionString = process.env.CHARON_DB_DIRECT_URL || process.env.DATABASE_URL;
      const instance = new PgBoss({ connectionString, max: poolSize() });
      instance.on("error", (err: any) => logger.warn({ err: err?.message }, "pg-boss error"));
      await instance.start();
      // pg-boss v10+ requires a queue to exist before work()/send(). Create all
      // of ours up front (idempotent) so consumers/producers never race a
      // missing-queue error.
      for (const q of Object.values(QUEUES)) {
        await instance.createQueue(q).catch((err: any) => {
          // Already-exists is fine; anything else is worth a line.
          if (!/already exists/i.test(String(err?.message))) {
            logger.warn({ err: err?.message, queue: q }, "pg-boss createQueue failed");
          }
        });
      }
      boss = instance;
      logger.info("pg-boss started");
      return boss;
    } catch (err: any) {
      logger.warn({ err: err?.message }, "pg-boss failed to start; queue features disabled");
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true }).catch(() => {});
    boss = null;
  }
}

/** Publish a job; no-op (returns null) when pg-boss isn't available. */
export async function publish(queue: QueueName, data: unknown): Promise<string | null> {
  const b = await getBoss();
  if (!b) return null;
  return b.send(queue, data as object);
}
