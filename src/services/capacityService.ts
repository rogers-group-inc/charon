/**
 * src/services/capacityService.ts — Disk + database capacity snapshot.
 *
 * Per-volume free-space (the filesystems Charon/Postgres write to) with a
 * severity pill, plus database size and a lightweight Postgres tuning advisor.
 * Feeds the Maintenance tab's capacity bars and the sidebar critical alert.
 */

import { statfs } from "node:fs/promises";
import { prisma } from "../db.js";
import { STATE_DIR, BACKUP_DIR } from "../utils/paths.js";

export type Severity = "ok" | "watch" | "warning" | "critical";

export interface VolumeUsage {
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedRatio: number;
  severity: Severity;
}

function sev(freeRatio: number): Severity {
  if (freeRatio < 0.05) return "critical";
  if (freeRatio < 0.1) return "warning";
  if (freeRatio < 0.2) return "watch";
  return "ok";
}

async function volume(label: string, path: string): Promise<VolumeUsage | null> {
  try {
    const s = await statfs(path);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 1;
    return { label, path, totalBytes, freeBytes, usedRatio: 1 - freeRatio, severity: sev(freeRatio) };
  } catch {
    return null;
  }
}

export interface CapacitySnapshot {
  volumes: VolumeUsage[];
  databaseSizeBytes: number | null;
  advisor: string[];
  severity: Severity;
}

export async function getCapacity(): Promise<CapacitySnapshot> {
  const vols = (await Promise.all([
    volume("state", STATE_DIR),
    volume("backups", BACKUP_DIR),
  ])).filter((v): v is VolumeUsage => v !== null);

  let databaseSizeBytes: number | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ size: bigint }>>("SELECT pg_database_size(current_database()) AS size");
    databaseSizeBytes = rows[0] ? Number(rows[0].size) : null;
  } catch { /* no perms / sqlite-less */ }

  const advisor: string[] = [];
  for (const v of vols) {
    if (v.severity !== "ok") advisor.push(`${v.label} volume is ${(v.usedRatio * 100).toFixed(0)}% full — free space or expand the volume.`);
  }
  if (databaseSizeBytes && databaseSizeBytes > 5 * 1024 ** 3) {
    advisor.push("Database exceeds 5 GiB — confirm event/retention pruning is active and autovacuum is keeping up.");
  }

  const order: Severity[] = ["ok", "watch", "warning", "critical"];
  const worst = vols.reduce<Severity>((acc, v) => (order.indexOf(v.severity) > order.indexOf(acc) ? v.severity : acc), "ok");

  return { volumes: vols, databaseSizeBytes, advisor, severity: worst };
}
