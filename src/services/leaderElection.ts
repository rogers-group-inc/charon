/**
 * src/services/leaderElection.ts — Postgres advisory-lock leader election.
 *
 * HA model: a primary/standby pair streams Postgres replication; the app layer
 * elects ONE leader via a session-level Postgres advisory lock. Only the leader
 * runs singleton schedulers + Fortinet enforcement scheduling, so a standby
 * `web` process can be up and serving read-mostly traffic without
 * double-running reconcilers (split-brain).
 *
 * Mechanism:
 *   - A dedicated long-lived pg client (NOT the Prisma pool) tries
 *     `pg_try_advisory_lock(key)`. Session-level locks are held for the life of
 *     that connection and released automatically if the process dies or the DB
 *     fails over — exactly the semantics we want for leadership.
 *   - On the standby, the primary holds the lock so the try fails; the standby
 *     retries on an interval. When the primary's DB is promoted and the old
 *     leader's connection drops, the lock frees and the standby acquires it.
 *   - Schedulers gate on isLeader(); see app.ts / jobs.ts.
 *
 * The lock key is a fixed 64-bit integer derived from a constant string so both
 * nodes contend on the same key. CHARON_LEADER_LOCK_KEY can override it for
 * test isolation.
 */

import pg from "pg";
import { logger } from "../utils/logger.js";
import { setLeader } from "../metrics.js";

// Default advisory-lock key: a stable arbitrary 64-bit-safe integer. Both nodes
// must use the same value. Postgres advisory locks take a bigint; we stay well
// inside the signed-64-bit range.
const DEFAULT_LOCK_KEY = 728_405_146; // "charon" mnemonic; arbitrary but fixed

function resolveLockKey(): number {
  const raw = process.env.CHARON_LEADER_LOCK_KEY;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  return DEFAULT_LOCK_KEY;
}

const RETRY_INTERVAL_MS = Number.parseInt(process.env.CHARON_LEADER_RETRY_MS ?? "", 10) || 10_000;

let leaderClient: pg.Client | null = null;
let leader = false;
let retryTimer: NodeJS.Timeout | null = null;
let onAcquireCb: (() => void) | null = null;
let onLoseCb: (() => void) | null = null;

/** True when this process currently holds leadership. */
export function isLeader(): boolean {
  return leader;
}

async function tryAcquire(key: number): Promise<void> {
  if (leader) return;
  // (Re)build the dedicated client if needed. A separate connection — never the
  // Prisma pool — because the lock is tied to the session (connection) lifetime.
  if (!leaderClient) {
    leaderClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    leaderClient.on("error", (err) => {
      logger.warn({ err: err?.message }, "Leader-election connection error; will re-contend");
      void demoteAndReset();
    });
    await leaderClient.connect();
  }
  const res = await leaderClient.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [key],
  );
  if (res.rows[0]?.locked) {
    leader = true;
    setLeader(true);
    logger.info({ lockKey: key }, "Acquired leadership (advisory lock) — schedulers/enforcement enabled");
    onAcquireCb?.();
  }
}

async function demoteAndReset(): Promise<void> {
  const wasLeader = leader;
  leader = false;
  setLeader(false);
  if (leaderClient) {
    try {
      await leaderClient.end();
    } catch {
      /* ignore */
    }
    leaderClient = null;
  }
  if (wasLeader) {
    logger.warn("Lost leadership — schedulers/enforcement paused on this node");
    onLoseCb?.();
  }
}

/**
 * Begin contending for leadership. Resolves once the first acquisition attempt
 * has run (the process may or may not be leader yet). Keeps retrying on an
 * interval so a standby promotes when the primary releases the lock.
 *
 * @param onAcquire called once each time this process becomes leader
 * @param onLose    called once each time this process loses leadership
 */
export async function startLeaderElection(opts?: {
  onAcquire?: () => void;
  onLose?: () => void;
}): Promise<void> {
  onAcquireCb = opts?.onAcquire ?? null;
  onLoseCb = opts?.onLose ?? null;
  const key = resolveLockKey();

  const attempt = async () => {
    try {
      await tryAcquire(key);
    } catch (err: any) {
      logger.warn({ err: err?.message }, "Leader-election attempt failed; retrying");
      await demoteAndReset();
    }
  };

  await attempt();
  retryTimer = setInterval(() => void attempt(), RETRY_INTERVAL_MS);
  // Don't keep the event loop alive solely for the election timer.
  if (typeof retryTimer.unref === "function") retryTimer.unref();
}

/** Release leadership + stop contending. Called on graceful shutdown. */
export async function stopLeaderElection(): Promise<void> {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  await demoteAndReset();
}
