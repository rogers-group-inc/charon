/**
 * src/utils/deploymentContext.ts — "where is Charon running?"
 *
 * Ported from polaris (src/utils/deploymentContext.ts). Best-effort heuristics,
 * computed once and cached; false negatives only pick the more general help
 * text in the Maintenance tab.
 *
 *   dbIsLocal()          — does DATABASE_URL point at this same host?
 *   runtimeIsContainer() — is Charon running in Docker / Kubernetes?
 *
 * Charon adaptation: the Dockerfile sets CHARON_IN_DOCKER=1 (and
 * CHARON_STATE_DIR), so those are checked alongside /.dockerenv.
 */

import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

let cachedDbIsLocal: boolean | null = null;
let cachedRuntimeIsContainer: boolean | null = null;

function collectLocalAddresses(): Set<string> {
  const out = new Set<string>(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const addr of list) if (addr.address) out.add(addr.address.toLowerCase());
  }
  return out;
}

export function dbIsLocal(): boolean {
  if (cachedDbIsLocal !== null) return cachedDbIsLocal;
  const url = process.env.DATABASE_URL;
  if (!url) return (cachedDbIsLocal = false);
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // No host = Unix socket = local.
    cachedDbIsLocal = !host || collectLocalAddresses().has(host);
  } catch {
    cachedDbIsLocal = false;
  }
  return cachedDbIsLocal;
}

export function runtimeIsContainer(): boolean {
  if (cachedRuntimeIsContainer !== null) return cachedRuntimeIsContainer;
  if (existsSync("/.dockerenv") || process.env.CHARON_IN_DOCKER === "1" || process.env.KUBERNETES_SERVICE_HOST) {
    return (cachedRuntimeIsContainer = true);
  }
  // /proc/1/cgroup names the container runtime on Linux; anything else = bare metal.
  try {
    if (/docker|containerd|kubepods|crio/.test(readFileSync("/proc/1/cgroup", "utf8"))) {
      return (cachedRuntimeIsContainer = true);
    }
  } catch { /* not Linux / no /proc */ }
  return (cachedRuntimeIsContainer = false);
}

/** True on a host where systemd is PID 1 (RHEL install) — the only place the
 *  in-app restart can bring charon.target back. */
export function hasSystemd(): boolean {
  return existsSync("/run/systemd/system");
}

/**
 * PgBouncer-awareness (polaris src/utils/dbConnections.ts). CHARON_DB_DIRECT_URL
 * is the direct Postgres URL used by pg-boss, pg_dump/psql and
 * pg_stat_activity reads; DATABASE_URL may point at a pooler.
 */
export type DbConnectionMode = "direct" | "pgbouncer";

export function getDirectDatabaseUrl(): string {
  return process.env.CHARON_DB_DIRECT_URL || process.env.DATABASE_URL || "";
}

export function getDbConnectionMode(): DbConnectionMode {
  const app = process.env.DATABASE_URL || "";
  const direct = process.env.CHARON_DB_DIRECT_URL;
  if (direct && direct !== app) return "pgbouncer";
  if (app.includes("pgbouncer=true")) return "pgbouncer";
  return "direct";
}
