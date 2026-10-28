/**
 * src/services/haService.ts — HA configuration, live status and guidance
 * figures for Server Settings → High Availability.
 *
 * Ported from polaris and mapped onto charon's HA model (deploy/HA.md): a
 * primary/standby PostgreSQL streaming-replication pair set up by
 * deploy/setup-ha.sh, plus app-level leader election on a Postgres advisory
 * lock (leaderElection.ts). No Patroni, no etcd, no witness.
 *
 * Owns the `ha.config` Setting: the two nodes, the load-balancer figures used
 * for the downtime estimate, and the replication credential. The credential is
 * an AES-256-GCM envelope (utils/crypto encryptSecret) — it never reaches an
 * HTTP response (redactHaConfig) and leaves the server only inside an
 * operator-approved, single-download node bundle (haEnrollmentService). It
 * lives in the database rather than only on disk so a promoted standby can
 * still re-issue a bundle to rebuild the other side.
 */

import os from "node:os";
import net from "node:net";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { promisify } from "node:util";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { encryptSecret, decryptSecret } from "../utils/crypto.js";
import { isLeader } from "./leaderElection.js";
import {
  rttAdvisory,
  walRateFromCounter,
  walAdvisory,
  rpoAdvisory,
  rtoAdvisory,
  sizingAdvisory,
  assessInstallShape,
  type Advisory,
} from "../utils/haAdvisories.js";

const execFileAsync = promisify(execFile);

export const HA_CONFIG_KEY = "ha.config";

export type HaRole = "primary" | "standby";
export const HA_ROLES: readonly HaRole[] = ["primary", "standby"] as const;

export interface HaNode {
  /** Operator label for the node (shown in status, embedded in its script). */
  name: string;
  /** Address the OTHER node reaches this one on (replication). Never the public URL. */
  clusterAddr: string;
  /** How this node reaches the PRIMARY's web port to enroll, when that differs. */
  reachPrimaryVia?: string;
  /** SSH host key fingerprints recorded at enrollment. */
  sshHostKeys: string[];
}

export interface HaGslbSettings {
  monitorIntervalSec: number;
  monitorRetries: number;
  dnsTtlSec: number;
}

export interface HaConfig {
  enabled: boolean;
  nodes: { primary?: HaNode; standby?: HaNode };
  gslb: HaGslbSettings;
  /** Replication role password, sealed (encryptSecret envelope). */
  credentials?: { replicator: { password: string } };
  enabledBy?: string;
  enabledAt?: string;
}

function defaults(): HaConfig {
  return { enabled: false, nodes: {}, gslb: { monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 } };
}

export function parseHaConfig(raw: unknown): HaConfig {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Partial<HaConfig>;
  return { ...d, ...o, nodes: { ...(o.nodes ?? {}) }, gslb: { ...d.gslb, ...(o.gslb ?? {}) } };
}

export async function getHaConfig(): Promise<HaConfig> {
  const row = await prisma.setting.findUnique({ where: { key: HA_CONFIG_KEY } });
  return parseHaConfig(row?.value);
}

async function saveHaConfig(cfg: HaConfig): Promise<void> {
  await prisma.setting.upsert({
    where: { key: HA_CONFIG_KEY },
    create: { key: HA_CONFIG_KEY, value: cfg as any },
    update: { value: cfg as any },
  });
}

/** Never let the sealed material reach an HTTP response. */
export function redactHaConfig(cfg: HaConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    nodes: cfg.nodes,
    gslb: cfg.gslb,
    enabledBy: cfg.enabledBy,
    enabledAt: cfg.enabledAt,
    credentialsPresent: Boolean(cfg.credentials?.replicator?.password),
  };
}

/** Decrypt the replication password (bundle building only). */
export function revealReplicationPassword(cfg: HaConfig): string {
  const env = cfg.credentials?.replicator?.password;
  if (!env) throw new AppError(409, "No replication credential is stored — enable high availability first.");
  return decryptSecret(env);
}

// ─── Host facts ─────────────────────────────────────────────────────────────

/** Non-loopback addresses of this host, to pre-fill the primary's row. */
export function detectLocalAddresses(): { address: string; family: string; iface: string }[] {
  const out: { address: string; family: string; iface: string }[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family !== "IPv4" && a.family !== "IPv6") continue;
      out.push({ address: a.address, family: String(a.family), iface });
    }
  }
  return out;
}

/** True when this process runs inside a container (Docker image pins CHARON_STATE_DIR). */
export function isContainer(): boolean {
  return existsSync("/.dockerenv") || Boolean(process.env.CHARON_STATE_DIR);
}

/**
 * Addresses the latency probe refuses: loopback, unspecified, link-local
 * (incl. the 169.254.169.254 metadata service). The advisory endpoint takes an
 * address from a read-only caller; it measures the network to a standby, never
 * to this host or a metadata address (polaris rule 110).
 */
function isBlockedProbeTarget(ip: string): boolean {
  const s = ip.toLowerCase();
  if (net.isIPv4(s)) {
    return s.startsWith("127.") || s.startsWith("0.") || s.startsWith("169.254.");
  }
  return s === "::" || s === "::1" || s.startsWith("fe80:") || s.startsWith("::ffff:127.") || s.startsWith("::ffff:169.254.");
}

/** Round-trip time to a host's SSH port (median of three), or null when unreachable/refused. */
export async function measureRtt(addr: string, port = 22, timeoutMs = 2000): Promise<number | null> {
  if (!addr) return null;
  let ip: string;
  try {
    ip = net.isIP(addr) ? addr : (await lookup(addr)).address;
  } catch {
    return null;
  }
  if (isBlockedProbeTarget(ip)) return null;
  const attempt = (): Promise<number | null> =>
    new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const socket = new net.Socket();
      let settled = false;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(Number(process.hrtime.bigint() - started) / 1e6));
      socket.once("timeout", () => finish(null));
      socket.once("error", () => finish(null));
      try {
        socket.connect({ port, host: ip });
      } catch {
        finish(null);
      }
    });
  const samples = (await Promise.all([attempt(), attempt(), attempt()])).filter((v): v is number => v !== null);
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

interface HostFacts {
  cpuCount: number;
  totalMemBytes: number;
  dbSizeBytes: number | null;
  pgdataLocal: boolean;
  nodeMajor: string;
  charonUid: number | null;
  chrony: string | null;
}

/** What this host can say about itself, all best-effort. */
async function probeHostFacts(): Promise<HostFacts> {
  const facts: HostFacts = {
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    dbSizeBytes: null,
    pgdataLocal: false,
    nodeMajor: process.version,
    charonUid: null,
    chrony: null,
  };
  try {
    const rows = await prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
    if (rows?.[0]?.size != null) facts.dbSizeBytes = Number(rows[0].size);
  } catch { /* role may lack the grant */ }
  try {
    const rows = await prisma.$queryRaw<{ dir: string }[]>`SELECT current_setting('data_directory') AS dir`;
    const dir = rows?.[0]?.dir;
    // A data directory this process can stat is a database on this host.
    if (dir) facts.pgdataLocal = existsSync(dir);
  } catch { /* needs pg_read_all_settings; absence is not fatal */ }
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("id", ["-u", "charon"], { timeout: 3000 });
      const uid = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(uid)) facts.charonUid = uid;
    } catch { /* not a packaged install */ }
    try {
      const { stdout } = await execFileAsync("chronyc", ["tracking"], { timeout: 3000 });
      const line = stdout.split("\n").find((l) => /System time/i.test(l));
      facts.chrony = line ? line.trim() : "synchronised";
    } catch { /* chrony may not be installed */ }
  }
  return facts;
}

async function readWalCounter(): Promise<{ walBytes: number | null; statsReset: Date | null }> {
  try {
    const rows = await prisma.$queryRaw<{ wal_bytes: unknown; stats_reset: Date | null }[]>`
      SELECT wal_bytes::bigint AS wal_bytes, stats_reset FROM pg_stat_wal`;
    const r = rows?.[0];
    if (!r || r.wal_bytes == null) return { walBytes: null, statsReset: null };
    return { walBytes: Number(r.wal_bytes as bigint), statsReset: r.stats_reset ?? null };
  } catch {
    return { walBytes: null, statsReset: null };
  }
}

/** Replication lag in bytes as the PRIMARY sees it, or null when not replicating. */
async function readReplicationLagBytes(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRaw<{ lag: bigint | null }[]>`
      SELECT MAX(pg_wal_lsn_diff(sent_lsn, replay_lsn))::bigint AS lag FROM pg_stat_replication`;
    const lag = rows?.[0]?.lag;
    return lag == null ? null : Number(lag);
  } catch {
    return null;
  }
}

export function leaderRetrySec(): number {
  const ms = Number.parseInt(process.env.CHARON_LEADER_RETRY_MS ?? "", 10) || 10_000;
  return Math.round(ms / 1000);
}

// ─── Advisories ─────────────────────────────────────────────────────────────

export interface AdvisoryInput {
  standbyAddr?: string;
  gslb?: Partial<HaGslbSettings>;
}

/** Everything the guidance card shows, computed about THIS install. */
export async function computeAdvisories(input: AdvisoryInput = {}) {
  const cfg = await getHaConfig();
  const gslb: HaGslbSettings = { ...cfg.gslb, ...(input.gslb ?? {}) };
  const standbyAddr = input.standbyAddr || cfg.nodes.standby?.clusterAddr || "";

  const [facts, wal, standbyRtt, lagBytes] = await Promise.all([
    probeHostFacts(),
    readWalCounter(),
    standbyAddr ? measureRtt(standbyAddr) : Promise.resolve(null),
    readReplicationLagBytes(),
  ]);
  const rate = walRateFromCounter(wal.walBytes, wal.statsReset);

  const latencyStandby: Advisory = standbyAddr
    ? rttAdvisory(standbyRtt, "the standby")
    : { level: "unknown", detail: "Enter the standby's cluster address to measure the round-trip time." };

  return {
    support: assessInstallShape({ platform: process.platform, docker: isContainer(), localPgdata: facts.pgdataLocal }),
    latency: { standby: latencyStandby },
    bandwidth: walAdvisory(rate),
    rpo: rpoAdvisory(lagBytes, rate),
    rto: rtoAdvisory({
      leaderRetrySec: leaderRetrySec(),
      monitorIntervalSec: gslb.monitorIntervalSec,
      monitorRetries: gslb.monitorRetries,
      dnsTtlSec: gslb.dnsTtlSec,
    }),
    standby: sizingAdvisory({
      cpuCount: facts.cpuCount,
      totalMemBytes: facts.totalMemBytes,
      dbSizeBytes: facts.dbSizeBytes,
      walKeepBytes: 1024 * 1024 * 1024, // setup-ha.sh sets wal_keep_size = 1GB
    }),
    host: {
      cpuCount: facts.cpuCount,
      totalMemBytes: facts.totalMemBytes,
      dbSizeBytes: facts.dbSizeBytes,
      nodeMajor: facts.nodeMajor,
      charonUid: facts.charonUid,
      chrony: facts.chrony,
      publicUrl: process.env.CHARON_PUBLIC_URL ?? null,
      localAddresses: detectLocalAddresses(),
    },
  };
}

// ─── Cluster status ─────────────────────────────────────────────────────────

export interface HaMember {
  name: string;
  role: string;
  state: string;
  host?: string;
  lagBytes: number | null;
  timeline: number | null;
  tags: Record<string, unknown>;
}

export interface HaClusterStatus {
  available: boolean;
  reason?: string;
  /** This node's database role: "primary" | "standby" | "unknown". */
  localRole: string;
  /** This process holds the advisory-lock leadership (schedulers/enforcement). */
  isLeader: boolean;
  /** Charon never self-promotes the database — see deploy/HA.md. */
  automaticFailover: boolean;
  members: HaMember[];
}

/**
 * Live state from THIS node's PostgreSQL: pg_is_in_recovery, and either
 * pg_stat_replication (primary) or pg_stat_wal_receiver (standby). Best-effort
 * throughout — a role without pg_monitor still gets a usable answer.
 */
export async function getClusterStatus(cfg?: HaConfig): Promise<HaClusterStatus> {
  const conf = cfg ?? (await getHaConfig());
  const leader = isLeader();
  let inRecovery: boolean | null = null;
  try {
    const rows = await prisma.$queryRaw<{ r: boolean }[]>`SELECT pg_is_in_recovery() AS r`;
    inRecovery = rows?.[0]?.r ?? null;
  } catch { /* unreachable DB is reported below */ }
  if (inRecovery === null) {
    return { available: false, reason: "Could not query this node's database", localRole: "unknown", isLeader: leader, automaticFailover: false, members: [] };
  }

  let timeline: number | null = null;
  try {
    const rows = await prisma.$queryRaw<{ tl: number }[]>`SELECT timeline_id AS tl FROM pg_control_checkpoint()`;
    timeline = rows?.[0]?.tl ?? null;
  } catch { /* needs superuser/pg_monitor */ }

  const localRole = inRecovery ? "standby" : "primary";
  const localNode = conf.nodes[localRole];
  const members: HaMember[] = [];
  let replicaLag: number | null = null;

  if (inRecovery) {
    try {
      const rows = await prisma.$queryRaw<{ lag: bigint | null }[]>`
        SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::bigint AS lag`;
      replicaLag = rows?.[0]?.lag == null ? null : Number(rows[0].lag);
    } catch { /* ignore */ }
  }
  members.push({
    name: localNode?.name || os.hostname(),
    role: localRole,
    state: "running",
    host: localNode?.clusterAddr,
    lagBytes: replicaLag,
    timeline,
    tags: { thisNode: true, leader },
  });

  if (inRecovery) {
    try {
      const rows = await prisma.$queryRaw<{ status: string; sender_host: string | null }[]>`
        SELECT status, sender_host FROM pg_stat_wal_receiver`;
      for (const r of rows ?? []) {
        members.push({
          name: conf.nodes.primary?.name || "upstream primary",
          role: "primary",
          state: r.status,
          host: r.sender_host ?? undefined,
          lagBytes: null,
          timeline: null,
          tags: {},
        });
      }
    } catch { /* needs pg_monitor for sender details */ }
  } else {
    try {
      const rows = await prisma.$queryRaw<{ name: string | null; client: string | null; state: string; lag: bigint | null }[]>`
        SELECT application_name AS name, client_addr::text AS client, state,
               pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint AS lag
        FROM pg_stat_replication`;
      for (const r of rows ?? []) {
        members.push({
          name: r.name || conf.nodes.standby?.name || "standby",
          role: "standby",
          state: r.state,
          host: r.client ?? undefined,
          lagBytes: r.lag == null ? null : Number(r.lag),
          timeline: null,
          tags: {},
        });
      }
    } catch { /* no rows visible without pg_monitor */ }
  }

  const replicating = inRecovery || members.length > 1;
  return {
    available: replicating,
    reason: replicating ? undefined : "Replication is not running on this node yet",
    localRole,
    isLeader: leader,
    automaticFailover: false,
    members,
  };
}

// ─── Enable / disable ───────────────────────────────────────────────────────

export interface NodeInput {
  name: string;
  clusterAddr: string;
  reachPrimaryVia?: string;
}

export interface EnableHaInput {
  primary: NodeInput;
  standby: NodeInput;
  gslb?: Partial<HaGslbSettings>;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 32 alphanumeric characters (~190 bits). Alphanumeric on purpose: setup-ha.sh
 * interpolates it into SQL and pg_basebackup's conninfo, so no quoting can break.
 */
export function randomReplicationPassword(): string {
  let out = "";
  for (let i = 0; i < 32; i++) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

/**
 * Record the two nodes and generate (once) the replication credential. Nothing
 * is installed and nothing restarts — the operator runs the generated scripts.
 * Re-enabling keeps the stored credential so nodes already built stay valid.
 */
export async function enableHa(input: EnableHaInput, actor: string): Promise<HaConfig> {
  const cfg = await getHaConfig();
  if (input.primary.name === input.standby.name) {
    throw new AppError(400, "The primary and the standby need different member names.");
  }
  if (input.primary.clusterAddr === input.standby.clusterAddr) {
    throw new AppError(400, "The primary and the standby need different cluster addresses.");
  }
  // setup-ha.sh writes the standby's address into pg_hba.conf as <ip>/32 (or /128).
  if (!net.isIP(input.standby.clusterAddr)) {
    throw new AppError(400, "The standby's cluster address must be an IP address — the primary's pg_hba.conf admits replication from it by address.");
  }
  const node = (n: NodeInput, prev?: HaNode): HaNode => ({
    name: n.name,
    clusterAddr: n.clusterAddr,
    ...(n.reachPrimaryVia ? { reachPrimaryVia: n.reachPrimaryVia } : {}),
    sshHostKeys: prev && prev.clusterAddr === n.clusterAddr ? prev.sshHostKeys : [],
  });
  const next: HaConfig = {
    ...cfg,
    enabled: true,
    nodes: { primary: node(input.primary, cfg.nodes.primary), standby: node(input.standby, cfg.nodes.standby) },
    gslb: { ...cfg.gslb, ...(input.gslb ?? {}) },
    credentials: cfg.credentials?.replicator?.password
      ? cfg.credentials
      : { replicator: { password: encryptSecret(randomReplicationPassword()) } },
    enabledBy: actor,
    enabledAt: new Date().toISOString(),
  };
  await saveHaConfig(next);
  return next;
}

/** Configuration only — never touches replication on either host. */
export async function disableHa(_actor: string): Promise<HaConfig> {
  const cfg = await getHaConfig();
  const next: HaConfig = { ...cfg, enabled: false };
  await saveHaConfig(next);
  // Outstanding scripts stop working the moment HA is off.
  await prisma.haEnrollment.updateMany({
    where: { status: { in: ["issued", "pending", "approved"] } },
    data: { status: "expired" },
  });
  return next;
}

/** Record the SSH host keys a delivered node presented. */
export async function rememberNodeHostKeys(role: HaRole, fingerprints: string[]): Promise<void> {
  const cfg = await getHaConfig();
  const node = cfg.nodes[role];
  if (!node) return;
  node.sshHostKeys = fingerprints.slice(0, 8);
  await saveHaConfig(cfg);
}
