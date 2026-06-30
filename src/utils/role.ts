/**
 * src/utils/role.ts — process role model for the multi-process split.
 *
 * Charon can run as a single monolithic process (the dev default) or as a
 * fleet of specialized processes that coordinate ONLY through the shared
 * PostgreSQL + pg-boss queue (no direct process-to-process coupling):
 *
 *   • web      — 1 per DC (leader-elected). Express UI + REST API (nginx
 *                upstream). Hosts the singleton schedulers ONLY while it
 *                holds the leader advisory lock (see services/leaderElection).
 *   • endpoint — N replicas. Agent-facing comms: enrollment, telemetry
 *                WebSocket, heartbeat, posture ingestion. nginx upstream for
 *                /api/v1/agents/* + the WS upgrade path.
 *   • enforcer — N replicas. Gate push: pg-boss consumers that apply tag /
 *                policy deltas to FortiManager + FortiGate.
 *   • worker   — N replicas. Directory sync, tag reconciler, posture
 *                evaluation, integration health checks.
 *   • migrate  — 1 (one-shot). `prisma migrate deploy` at bootstrap, then exit.
 *   • all      — default when CHARON_ROLE is unset. Every capability on —
 *                single-process behavior so `npm run dev` is unaffected.
 *
 * The boot path branches on the capability booleans below, never on the role
 * string directly, so adding/retuning a role is a one-place change.
 */

import { logger } from "./logger.js";

export type CharonRole = "all" | "web" | "endpoint" | "enforcer" | "worker" | "migrate";

export interface RoleConfig {
  role: CharonRole;
  /** Express UI/API + /health + /metrics on the public listener. */
  runsHttp: boolean;
  /** Agent-facing comms: enrollment, telemetry WebSocket, posture ingestion. */
  runsAgentComms: boolean;
  /** pg-boss consumers that push tag/policy deltas to FortiManager/FortiGate. */
  runsEnforcement: boolean;
  /** pg-boss worker consumers: directory sync, tag reconciler, posture eval, health checks. */
  runsWorkers: boolean;
  /** Singleton schedulers/reconcilers — gated additionally by the leader lock at runtime. */
  runsSchedulers: boolean;
  /** One-shot startup `prisma migrate deploy` + first-run seed. */
  runsMigrations: boolean;
  /** In-process write/flush buffers (event batching, posture sample flush). */
  runsWriteBuffers: boolean;
}

const VALID_ROLES: readonly CharonRole[] = ["all", "web", "endpoint", "enforcer", "worker", "migrate"];

let cachedRole: CharonRole | null = null;

/**
 * Resolve the process role from CHARON_ROLE. Unset (or empty) ⇒ "all". An
 * unrecognized value logs a warning and falls back to "all" so a typo degrades
 * to the safe monolithic behavior rather than booting a half-dead process.
 * Cached after the first call — the role is constant for the life of the process.
 */
export function getRole(): CharonRole {
  if (cachedRole) return cachedRole;
  const raw = (process.env.CHARON_ROLE || "").trim().toLowerCase();
  if (!raw) {
    cachedRole = "all";
  } else if ((VALID_ROLES as readonly string[]).includes(raw)) {
    cachedRole = raw as CharonRole;
  } else {
    logger.warn(
      { CHARON_ROLE: raw, validRoles: VALID_ROLES },
      `Unrecognized CHARON_ROLE "${raw}"; falling back to "all" (single-process mode)`,
    );
    cachedRole = "all";
  }
  return cachedRole;
}

/**
 * Capability flags for a role. Defaults to the current process's role.
 *
 * Placement rationale:
 *   - Schedulers + migrations are pinned to web (single instance, leader-
 *     elected) so the singleton invariant is trivially satisfied; endpoint,
 *     enforcer and worker stay pure consumers.
 *   - The migrate role runs migrations only — it does the one-shot
 *     `prisma migrate deploy` and exits before any listener binds.
 */
export function roleConfig(role: CharonRole = getRole()): RoleConfig {
  const all = role === "all";
  return {
    role,
    runsHttp: all || role === "web",
    runsAgentComms: all || role === "endpoint",
    runsEnforcement: all || role === "enforcer",
    runsWorkers: all || role === "worker",
    runsSchedulers: all || role === "web",
    runsMigrations: all || role === "web" || role === "migrate",
    runsWriteBuffers: all || role === "web" || role === "endpoint",
  };
}

/** True for the one-shot migrate role, which exits after migrations run. */
export function isMigrateOnly(role: CharonRole = getRole()): boolean {
  return role === "migrate";
}

/** Test-only: clear the cached role so a test can re-resolve from env. */
export function __resetRoleForTests(): void {
  cachedRole = null;
}
