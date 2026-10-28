/**
 * src/services/backupScheduleService.ts — operator-configured automatic backups.
 *
 * Ported from polaris (src/services/backupScheduleService.ts). One
 * `backupSchedule` Setting row:
 *   enabled       — default FALSE: a new mechanism must not start writing
 *                   gigabytes on upgrade without being asked (and many sites
 *                   already back this Postgres up with an enterprise product).
 *   intervalHours — 1..168. "Every N hours since the last successful run"
 *                   survives restarts without a cron parser.
 *   hourUtc       — optional 0..23 pin so a daily run lands in a window.
 *   retainCount   — how many SCHEDULED backups to keep (1..50). Manual and
 *                   pre-update backups are never pruned by this.
 *   passphrase    — optional; encrypts scheduled backups with the same envelope
 *                   as manual ones. Charon adaptation: stored as an AES-256-GCM
 *                   at-rest envelope (utils/crypto.ts, CHARON_DATA_KEY), never
 *                   plaintext, and masked on read.
 *   copyToDir     — optional absolute path (a mounted share) each finished
 *                   backup is COPIED to — the off-host half.
 *
 * The job (src/jobs/scheduledBackup.ts) runs on the leader only.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { SECRET_MASK, encryptSecret, decryptSecret, isEncryptedEnvelope } from "../utils/crypto.js";
import { validateBackupPassword } from "../utils/backupPassword.js";
import { makeFilePrivate } from "../utils/privateFiles.js";
import { logger } from "../utils/logger.js";

export const BACKUP_SCHEDULE_SETTING_KEY = "backupSchedule";

export interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  /** Pin runs to this UTC hour (0-23), or null for "any hour". */
  hourUtc: number | null;
  retainCount: number;
  /** Passphrase for scheduled backups, or null for unencrypted. */
  passphrase: string | null;
  /** Absolute directory each finished backup is copied to, or null. */
  copyToDir: string | null;
  /** ISO timestamp of the last SUCCESSFUL scheduled run (written by the job). */
  lastRunAt: string | null;
  /** Failure message from the most recent attempt, or null when it succeeded. */
  lastError: string | null;
}

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 168;
export const MIN_RETAIN = 1;
export const MAX_RETAIN = 50;

export function defaultBackupSchedule(): BackupSchedule {
  return {
    enabled: false,
    intervalHours: 24,
    hourUtc: null,
    retainCount: 7,
    passphrase: null,
    copyToDir: null,
    lastRunAt: null,
    lastError: null,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Stored passphrase → plaintext. A row that cannot be decrypted (data key
 *  rotated/lost) reads as "no passphrase" and is logged, never thrown. */
function readPassphrase(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  if (!isEncryptedEnvelope(v)) return v;
  try {
    return decryptSecret(v);
  } catch (err: any) {
    logger.warn({ err: err?.message }, "backupSchedule: stored passphrase could not be decrypted (CHARON_DATA_KEY changed?)");
    return null;
  }
}

/** Pure: a stored Setting value → a fully-defaulted schedule. */
export function parseBackupSchedule(raw: unknown): BackupSchedule {
  const d = defaultBackupSchedule();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    intervalHours: clampInt(r.intervalHours, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, d.intervalHours),
    hourUtc: typeof r.hourUtc === "number" && r.hourUtc >= 0 && r.hourUtc <= 23 ? Math.floor(r.hourUtc) : null,
    retainCount: clampInt(r.retainCount, MIN_RETAIN, MAX_RETAIN, d.retainCount),
    passphrase: readPassphrase(r.passphrase),
    copyToDir: typeof r.copyToDir === "string" && r.copyToDir.trim().length > 0 ? r.copyToDir.trim() : null,
    lastRunAt: typeof r.lastRunAt === "string" ? r.lastRunAt : null,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
  };
}

async function load(): Promise<BackupSchedule> {
  const row = await prisma.setting.findUnique({ where: { key: BACKUP_SCHEDULE_SETTING_KEY } });
  return parseBackupSchedule(row?.value);
}

async function save(s: BackupSchedule): Promise<void> {
  const value = { ...s, passphrase: s.passphrase ? encryptSecret(s.passphrase) : null };
  await prisma.setting.upsert({
    where: { key: BACKUP_SCHEDULE_SETTING_KEY },
    update: { value: value as never },
    create: { key: BACKUP_SCHEDULE_SETTING_KEY, value: value as never },
  });
}

/** Full settings INCLUDING the passphrase — internal callers (the job) only. */
export async function getBackupSchedule(): Promise<BackupSchedule> {
  return load();
}

/** API-shaped read: the passphrase is replaced by the shared mask sentinel. */
export async function getBackupScheduleMasked(): Promise<BackupSchedule> {
  const s = await load();
  return { ...s, passphrase: s.passphrase ? SECRET_MASK : null };
}

/**
 * Merge and persist operator input. A masked passphrase round-tripped from the
 * UI preserves the stored value, an empty string clears it, and a new value is
 * strength-checked with the same floor manual backups use.
 */
export async function saveBackupSchedule(input: Partial<BackupSchedule>): Promise<BackupSchedule> {
  const current = await load();

  let passphrase = current.passphrase;
  if (input.passphrase !== undefined) {
    if (input.passphrase === null || input.passphrase === "") {
      passphrase = null;
    } else if (input.passphrase === SECRET_MASK) {
      passphrase = current.passphrase; // untouched round-trip
    } else {
      try {
        passphrase = validateBackupPassword(input.passphrase);
      } catch (e: any) {
        throw new AppError(400, e?.message || "Invalid backup passphrase");
      }
    }
  }

  let copyToDir = current.copyToDir;
  if (input.copyToDir !== undefined) {
    const raw = (input.copyToDir ?? "").trim();
    if (!raw) {
      copyToDir = null;
    } else {
      if (!isAbsolute(raw)) throw new AppError(400, "Off-host copy directory must be an absolute path");
      copyToDir = raw;
    }
  }

  const next: BackupSchedule = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    intervalHours: input.intervalHours !== undefined
      ? clampInt(input.intervalHours, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, current.intervalHours)
      : current.intervalHours,
    hourUtc: input.hourUtc !== undefined
      ? (input.hourUtc === null ? null : clampInt(input.hourUtc, 0, 23, current.hourUtc ?? 0))
      : current.hourUtc,
    retainCount: input.retainCount !== undefined
      ? clampInt(input.retainCount, MIN_RETAIN, MAX_RETAIN, current.retainCount)
      : current.retainCount,
    passphrase,
    copyToDir,
    // Run bookkeeping is owned by the job, never by operator input.
    lastRunAt: current.lastRunAt,
    lastError: current.lastError,
  };

  await save(next);
  return next;
}

/** Job-owned: record the outcome of an attempt without touching operator fields. */
export async function recordScheduledBackupOutcome(outcome: { ok: boolean; error?: string }): Promise<void> {
  const current = await load();
  await save({
    ...current,
    lastRunAt: outcome.ok ? new Date().toISOString() : current.lastRunAt,
    lastError: outcome.ok ? null : (outcome.error ?? "unknown error").slice(0, 500),
  });
}

/**
 * Is a scheduled backup due now? Pure (polaris verbatim):
 *   - disabled → never due
 *   - never run → due immediately
 *   - otherwise due once intervalHours have elapsed since the last SUCCESS
 *   - when hourUtc is pinned, an otherwise-due run waits for that hour, unless
 *     it is overdue by a whole extra interval (the hour keeps being missed)
 */
export function isScheduledBackupDue(schedule: BackupSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;

  const last = new Date(schedule.lastRunAt).getTime();
  if (!Number.isFinite(last)) return true;
  const elapsedHours = (now.getTime() - last) / 3_600_000;
  if (elapsedHours < schedule.intervalHours) return false;

  if (schedule.hourUtc !== null && now.getUTCHours() !== schedule.hourUtc) {
    return elapsedHours >= schedule.intervalHours * 2;
  }
  return true;
}

/** Copy a finished backup to the off-host directory. Best-effort; caller logs. */
export async function copyBackupOffHost(sourcePath: string, filename: string, copyToDir: string): Promise<string> {
  if (!existsSync(sourcePath)) throw new Error(`backup file ${sourcePath} vanished before the off-host copy`);
  await mkdir(copyToDir, { recursive: true });
  const dest = join(copyToDir, filename);
  await copyFile(sourcePath, dest);
  makeFilePrivate(dest);
  return dest;
}
