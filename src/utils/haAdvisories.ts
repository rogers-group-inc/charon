/**
 * src/utils/haAdvisories.ts — the arithmetic behind the HA tab's guidance card.
 *
 * Ported from polaris. The tab tells an operator what enabling HA will cost
 * BEFORE they enable it, using figures computed from this install: how far
 * behind the standby would be, how much WAL crosses the link, how long a
 * failover takes given their load-balancer settings, how big the standby must be.
 *
 * All pure: the service gathers raw inputs, this module turns them into
 * verdicts so the thresholds are unit-testable without a second datacenter.
 *
 * Charon adaptations: charon's HA is a primary/standby PostgreSQL streaming
 * pair plus an app-level advisory-lock leader election (deploy/HA.md) — no
 * Patroni, no etcd, no witness. So the witness/placement advisories are gone,
 * the latency bands reference streaming replication instead of etcd elections,
 * and the RTO model is "promote (manual unless Patroni/repmgr is adopted) +
 * leader-lock retry + monitor + DNS" rather than a Patroni lease.
 */

/** How a measured figure reads against its threshold. */
export type AdvisoryLevel = "ok" | "warn" | "bad" | "unknown";

export interface Advisory {
  level: AdvisoryLevel;
  /** One sentence, operator-facing. Never a bare number. */
  detail: string;
}

// ─── Latency ────────────────────────────────────────────────────────────────
// Asynchronous streaming replication tolerates latency well, but the leader
// lock's connection and the standby's catch-up both slow past ~100 ms, and past
// ~250 ms replication lag under load (and so the recovery point) grows visibly.
export const RTT_OK_MS = 100;
export const RTT_WARN_MS = 250;

export function rttAdvisory(rttMs: number | null, label: string): Advisory {
  if (rttMs === null || !Number.isFinite(rttMs)) {
    return { level: "unknown", detail: `Could not reach ${label} to measure round-trip time.` };
  }
  const ms = Math.round(rttMs);
  if (ms <= RTT_OK_MS) {
    return { level: "ok", detail: `${ms} ms round-trip to ${label} — comfortable for asynchronous streaming replication.` };
  }
  if (ms <= RTT_WARN_MS) {
    return {
      level: "warn",
      detail: `${ms} ms round-trip to ${label} — workable, but replication lag under load (and so data loss on failover) will be visibly higher.`,
    };
  }
  return {
    level: "bad",
    detail: `${ms} ms round-trip to ${label} — past the 250 ms this design is sized for. Expect the standby to fall behind under load.`,
  };
}

// ─── WAL rate ───────────────────────────────────────────────────────────────

export interface WalRate {
  /** Bytes of WAL per second across the sampled window. */
  bytesPerSec: number;
  /** Length of the window actually measured. */
  windowSec: number;
  /** Total bytes across the window. */
  totalBytes: number;
}

/**
 * WAL generation rate from pg_stat_wal (wal_bytes since stats_reset) — a
 * single cumulative counter stands in for polaris's sampled LSN ring. Null on
 * a window too short to mean anything (under ten minutes) or bad inputs.
 */
export function walRateFromCounter(walBytes: number | null, statsResetAt: Date | null, now: Date = new Date()): WalRate | null {
  if (walBytes === null || !Number.isFinite(walBytes) || walBytes < 0 || !statsResetAt) return null;
  const windowSec = (now.getTime() - statsResetAt.getTime()) / 1000;
  if (!Number.isFinite(windowSec) || windowSec < 600) return null;
  return { bytesPerSec: walBytes / windowSec, windowSec, totalBytes: walBytes };
}

/** Headroom over the measured average: bursts and catch-up after an outage. */
export const WAL_HEADROOM_FACTOR = 3;

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export function walAdvisory(rate: WalRate | null): Advisory & { recommendedMbps?: number } {
  if (!rate) {
    return {
      level: "unknown",
      detail: "Not enough write-ahead-log history yet — PostgreSQL's WAL statistics were reset too recently (or are not readable by the app's database role).",
    };
  }
  const mbps = (rate.bytesPerSec * 8) / 1_000_000;
  const recommendedMbps = Math.max(1, Math.ceil(mbps * WAL_HEADROOM_FACTOR));
  const hours = Math.round(rate.windowSec / 360) / 10;
  return {
    level: "ok",
    recommendedMbps,
    detail:
      `${formatBytes(rate.bytesPerSec)}/s of write-ahead log over the last ${hours} h ` +
      `(${formatBytes(rate.totalBytes)} total). Size the link for at least ${recommendedMbps} Mbps ` +
      `so bursts and catch-up after an outage have room.`,
  };
}

// ─── Recovery point ─────────────────────────────────────────────────────────

export function rpoAdvisory(lagBytes: number | null, rate: WalRate | null): Advisory {
  if (lagBytes === null) {
    return {
      level: "unknown",
      detail: "Replication is not running yet. Once it is, the recovery point is the replication lag at the moment of failure.",
    };
  }
  const lagSec = rate && rate.bytesPerSec > 0 ? lagBytes / rate.bytesPerSec : null;
  if (lagSec === null) {
    return { level: lagBytes > 64 * 1024 * 1024 ? "warn" : "ok", detail: `${formatBytes(lagBytes)} behind.` };
  }
  const shown = lagSec < 1 ? "under a second" : `about ${Math.round(lagSec)} s`;
  return {
    level: lagSec > 60 ? "warn" : "ok",
    detail: `If the primary died now you would lose ${shown} of database writes (${formatBytes(lagBytes)} behind).`,
  };
}

// ─── Recovery time ──────────────────────────────────────────────────────────

export interface RtoInputs {
  /** CHARON_LEADER_RETRY_MS in seconds — how soon the standby's web takes the lock. */
  leaderRetrySec: number;
  /** Load-balancer monitor interval, seconds. */
  monitorIntervalSec: number;
  /** Consecutive failures before the monitor marks the site down. */
  monitorRetries: number;
  /** DNS TTL the balancer serves, seconds. */
  dnsTtlSec: number;
}

export interface RtoEstimate {
  minSec: number;
  maxSec: number;
}

/** pg_ctl promote once someone (or Patroni/repmgr) runs it. */
export const PROMOTE_SEC = 10;

/**
 * Downtime range for an unplanned failover AFTER the standby's database is
 * promoted. The lower bound assumes the lock retry and the monitor's next
 * probe land immediately; the upper bound assumes both were just missed, plus
 * a client holding the old DNS answer.
 */
export function estimateRto(input: RtoInputs): RtoEstimate {
  const retry = Math.max(0, input.leaderRetrySec);
  const monitor = Math.max(0, input.monitorIntervalSec) * Math.max(1, input.monitorRetries);
  const dns = Math.max(0, input.dnsTtlSec);
  const minSec = Math.round(PROMOTE_SEC + Math.max(0, input.monitorIntervalSec));
  const maxSec = Math.round(PROMOTE_SEC + retry + monitor + dns);
  return { minSec, maxSec: Math.max(maxSec, minSec) };
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

export function rtoAdvisory(input: RtoInputs): Advisory & { estimate: RtoEstimate } {
  const estimate = estimateRto(input);
  return {
    level: "warn",
    estimate,
    detail:
      `Promotion is manual (pg_ctl promote — deploy/HA.md) unless Patroni or repmgr manages it, so add the time ` +
      `to notice and act. From promotion: about ${formatDuration(estimate.minSec)} to ${formatDuration(estimate.maxSec)} — ` +
      `~${PROMOTE_SEC} s to promote, up to ${input.leaderRetrySec} s for the standby to take the leader lock, then your monitor ` +
      `(${input.monitorIntervalSec} s x ${input.monitorRetries}) and a ${input.dnsTtlSec} s DNS TTL.`,
  };
}

// ─── Standby sizing ─────────────────────────────────────────────────────────

export interface SizingInputs {
  cpuCount: number | null;
  totalMemBytes: number | null;
  dbSizeBytes: number | null;
  /** wal_keep_size as bytes, when it could be resolved. */
  walKeepBytes: number | null;
}

/** Growth headroom on top of the current database size. */
export const DB_GROWTH_FACTOR = 1.3;

export function sizingAdvisory(input: SizingInputs): Advisory & { minDbVolumeBytes?: number } {
  const parts: string[] = [];
  if (input.cpuCount) parts.push(`${input.cpuCount} vCPU`);
  if (input.totalMemBytes) parts.push(`${formatBytes(input.totalMemBytes)} RAM`);
  if (!parts.length) {
    return { level: "unknown", detail: "Could not read this host's CPU and memory to size the standby against it." };
  }
  let minDbVolumeBytes: number | undefined;
  let dbNote = "";
  if (input.dbSizeBytes) {
    minDbVolumeBytes = Math.ceil(input.dbSizeBytes * DB_GROWTH_FACTOR + (input.walKeepBytes ?? 0));
    dbNote =
      ` Database volume at least ${formatBytes(minDbVolumeBytes)} ` +
      `(${formatBytes(input.dbSizeBytes)} now, plus retained write-ahead log and 30% growth).`;
  }
  return {
    level: "ok",
    minDbVolumeBytes,
    detail:
      `Match this host: ${parts.join(", ")}. After a failover the standby carries every agent alone, ` +
      `so a smaller box is a slower deployment, not a cheaper one.${dbNote}`,
  };
}

// ─── Supported install shapes ───────────────────────────────────────────────

export interface InstallShape {
  platform: string; // process.platform
  docker: boolean;
  localPgdata: boolean; // this host holds the data directory
}

export interface SupportVerdict {
  supported: boolean;
  /** Every reason it is unsupported, so the operator fixes them in one pass. */
  reasons: string[];
}

/** Can this install take the deploy/setup-ha.sh path at all? */
export function assessInstallShape(shape: InstallShape): SupportVerdict {
  const reasons: string[] = [];
  if (shape.platform !== "linux") {
    reasons.push("deploy/setup-ha.sh only supports RHEL hosts; this server is not running on Linux.");
  }
  if (shape.docker) {
    reasons.push(
      "Container installs are not covered — setup-ha.sh manages the host's postgresql-15 service and data directory. Use your orchestrator's PostgreSQL replication instead.",
    );
  }
  if (!shape.localPgdata) {
    reasons.push("The database must be local to this host. An external or managed PostgreSQL has its own failover story.");
  }
  return { supported: reasons.length === 0, reasons };
}
