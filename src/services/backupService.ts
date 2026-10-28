/**
 * src/services/backupService.ts — database backup + restore.
 *
 * Ported from polaris (src/services/backupService.ts) to back the Maintenance
 * tab's Backup / Restore / Backup History cards. The route layer is thin:
 * validate, call, respond.
 *
 *  - `spawn` with an argv array and libpq PG* env vars (utils/pgEnv.ts) — the
 *    connection URL (password and all) never reaches argv or a shell.
 *  - Streamed pg_dump → gzip → optional AES-256-GCM cipher → file, with a
 *    no-output watchdog instead of a fixed wall-clock cap. Nothing is buffered.
 *  - pg_dump / psql resolved by the server's MAJOR (utils/pgClientTools.ts) and
 *    verified with `--version` first, so a client/server mismatch is reported
 *    as that sentence, not "see the server log".
 *  - Restore decrypts to a 0600 temp file first (GCM authenticates only at the
 *    end — psql must never run unverified SQL), then recycles the Prisma pool.
 *
 * Charon adaptations: no TimescaleDB pre/post-restore gates (Charon has no
 * hypertables); the envelope magic is "CHARONB\0"; files are 0600 in a 0700
 * dir; legacy Charon backups ("CHARONBK1" header, salt|iv|ct|tag layout) still
 * restore.
 *
 * File format:
 *   unencrypted: gzip(sql)
 *   encrypted:   "CHARONB\0" | salt(32) | iv(16) | authTag(16) | gzip(sql) ciphertext
 *
 * History lives in Setting "backup_history" (newest last, capped at 50).
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGzip, createGunzip } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve, sep } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventService.js";
import { BACKUP_DIR } from "../utils/paths.js";
import { getAppVersion } from "../utils/version.js";
import { getDirectDatabaseUrl } from "../utils/deploymentContext.js";
import { pgChildEnv } from "../utils/pgEnv.js";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "../utils/privateFiles.js";
import {
  type PgTool,
  parsePgToolMajor,
  pgMajorFromServerVersion,
  resolvePgToolPath,
  pgClientCompatible,
  describePgClientMismatch,
} from "../utils/pgClientTools.js";

const execFileAsync = promisify(execFile);

// ─── Format constants ──────────────────────────────────────────────────────

/** Magic header identifying an encrypted Charon backup (8 bytes, polaris layout). */
export const BACKUP_MAGIC = Buffer.from("CHARONB\0");
const SALT_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
/** Byte offset where the gzip ciphertext starts in an encrypted backup. */
export const ENCRYPTED_HEADER_LEN = BACKUP_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN; // 72

/** Pre-port Charon envelope: "CHARONBK1" | salt(16) | iv(12) | ct | tag(16). */
const LEGACY_MAGIC = Buffer.from("CHARONBK1");

/** Kill a pg_dump / psql child that has produced no output for this long. */
const NO_OUTPUT_TIMEOUT_MS = 10 * 60 * 1000;

/** How many history entries the Setting row retains. */
const HISTORY_LIMIT = 50;
const HISTORY_KEY = "backup_history";

export type BackupKind = "manual" | "pre-update" | "scheduled";

export interface BackupRecord {
  id: string;
  filename: string;
  size: number;
  encrypted: boolean;
  createdAt: string;
  /** Legacy flag kept for the Maintenance tab's "pre-update" badge. */
  preUpdate?: boolean;
  kind?: BackupKind;
}

// ─── Path safety ───────────────────────────────────────────────────────────

/**
 * Resolve a backup id to its on-disk path, refusing anything that escapes
 * BACKUP_DIR. Ids are server-generated (`bk-<ts>`) but the delete/download
 * routes accept them from the URL. Returns null for a traversal attempt.
 */
export function backupFilePath(id: unknown): string | null {
  const s = String(id);
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s.startsWith(".")) return null;
  const p = resolve(BACKUP_DIR, s);
  return p.startsWith(BACKUP_DIR + sep) ? p : null;
}

function requireBackupPath(id: unknown): string {
  const p = backupFilePath(id);
  if (!p) throw new AppError(400, "Invalid backup id");
  return p;
}

// ─── History (Setting row) ─────────────────────────────────────────────────

async function readHistory(): Promise<BackupRecord[]> {
  const row = await prisma.setting.findUnique({ where: { key: HISTORY_KEY } });
  return row?.value && Array.isArray(row.value) ? (row.value as unknown as BackupRecord[]) : [];
}

async function writeHistory(history: BackupRecord[]): Promise<void> {
  await prisma.setting.upsert({
    where: { key: HISTORY_KEY },
    update: { value: history as never },
    create: { key: HISTORY_KEY, value: history as never },
  });
}

/** Newest-first history, each entry carrying its resolved on-disk path and
 *  whether the file is still there to download. */
export async function listBackups(): Promise<Array<BackupRecord & { path: string | null; downloadable: boolean }>> {
  const history = await readHistory();
  return history
    .map((r) => {
      const path = backupFilePath(r.id);
      return { ...r, path, downloadable: !!path && existsSync(path) };
    })
    .reverse();
}

export async function getBackupRecord(id: string): Promise<BackupRecord | null> {
  return (await readHistory()).find((r) => r.id === id) ?? null;
}

async function appendHistory(record: BackupRecord): Promise<void> {
  const history = await readHistory();
  history.push(record);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  await writeHistory(history);
}

/** Delete a backup's file and its history entry. Throws 404 when unknown. */
export async function deleteBackup(id: string, actor?: string): Promise<BackupRecord> {
  const safePath = requireBackupPath(id);
  const history = await readHistory();
  const idx = history.findIndex((r) => r.id === id);
  if (idx === -1) throw new AppError(404, "Backup not found");

  const [removed] = history.splice(idx, 1);
  await writeHistory(history);
  if (existsSync(safePath)) unlinkSync(safePath);

  await logEvent({
    level: "warning",
    action: "server.backup.deleted",
    resourceType: "backup",
    resourceId: id,
    resourceName: removed?.filename || id,
    actor,
    message: `Database backup deleted: ${removed?.filename || id}`,
  });
  return removed!;
}

// ─── Child-process plumbing ────────────────────────────────────────────────

/**
 * Spawn a Postgres client tool with the connection supplied through PG* env
 * vars (never argv) and a no-output watchdog. Resolves on exit code 0; rejects
 * with the tail of stderr otherwise (callers log it and return a fixed string).
 */
function runPgTool(
  bin: PgTool,
  args: string[],
  opts: { connUrl: string; binPath?: string },
): { child: ReturnType<typeof spawn>; done: Promise<{ stderr: string }> } {
  const child = spawn(opts.binPath ?? bin, args, {
    env: pgChildEnv(opts.connUrl),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let lastOutputAt = Date.now();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    lastOutputAt = Date.now();
  });
  child.stdout?.on("data", () => { lastOutputAt = Date.now(); });

  let timedOut = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastOutputAt > NO_OUTPUT_TIMEOUT_MS) {
      timedOut = true;
      child.kill("SIGKILL");
    }
  }, 30_000);
  watchdog.unref();

  const done = new Promise<{ stderr: string }>((resolvePromise, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearInterval(watchdog);
      if (err.code === "ENOENT") {
        reject(new AppError(500, `${bin} was not found on this host — install the PostgreSQL client tools`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      if (code === 0) return resolvePromise({ stderr });
      if (timedOut) {
        reject(new Error(`${bin} produced no output for ${Math.round(NO_OUTPUT_TIMEOUT_MS / 60000)} minutes and was killed`));
        return;
      }
      reject(new Error(`${bin} exited with code ${code}: ${stderr.trim().slice(-2000) || "no stderr"}`));
    });
  });

  return { child, done };
}

// ─── Client tool resolution ────────────────────────────────────────────────

export interface PgToolResolution {
  tool: PgTool;
  path: string;
  source: "versioned-dir" | "path";
  clientMajor: number | null;
  serverMajor: number | null;
  compatible: boolean;
  problem: string | null;
}

async function readServerMajor(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ server_version_num: string }[]>("SHOW server_version_num");
    return pgMajorFromServerVersion(rows[0]?.server_version_num);
  } catch (err) {
    logger.warn({ err }, "backup: could not read server_version_num; scanning versioned client installs, then PATH");
    return null;
  }
}

/** Which pg_dump / psql to run, and whether it can talk to this server. */
export async function resolvePgTool(tool: PgTool): Promise<PgToolResolution> {
  const serverMajor = await readServerMajor();
  const { path, source } = resolvePgToolPath(tool, serverMajor, existsSync);

  let clientMajor: number | null = null;
  let problem: string | null = null;
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { timeout: 10_000, windowsHide: true });
    clientMajor = parsePgToolMajor(stdout);
    if (clientMajor == null) {
      problem = `${tool} --version returned something unrecognisable: ${String(stdout).trim().slice(0, 120) || "no output"}`;
    }
  } catch (err: any) {
    problem = err?.code === "ENOENT"
      ? `${tool} was not found on this host (looked for a PostgreSQL ${serverMajor ?? "?"} install and on PATH) — install the PostgreSQL client tools`
      : `${tool} --version failed: ${err?.message ?? String(err)}`;
  }
  if (problem == null && clientMajor != null && serverMajor != null && !pgClientCompatible(tool, clientMajor, serverMajor)) {
    problem = describePgClientMismatch(tool, clientMajor, serverMajor, path);
  }
  return { tool, path, source, clientMajor, serverMajor, compatible: problem == null, problem };
}

/** For the Backup History card: can this host back itself up right now? */
export async function getBackupToolingStatus(): Promise<{ ok: boolean; pgDump: PgToolResolution; psql: PgToolResolution }> {
  const [pgDump, psql] = await Promise.all([resolvePgTool("pg_dump"), resolvePgTool("psql")]);
  return { ok: pgDump.compatible && psql.compatible, pgDump, psql };
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateBackupInput {
  /** Validated passphrase, or null for an unencrypted backup. */
  password: string | null;
  kind: BackupKind;
  actor?: string;
}

export interface CreateBackupResult {
  record: BackupRecord;
  path: string;
}

/** Version-stamped download name. The Restore card parses the version back out. */
export function backupFilename(kind: BackupKind, version: string, at: Date, encrypted: boolean): string {
  const ts = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prefix = kind === "pre-update" ? "charon-pre-update" : "charon-backup";
  return `${prefix}-${version}-${ts}${encrypted ? ".enc" : ""}.gz`;
}

/** Stream a full logical backup to data/backups/ and register it in history. */
export async function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const connUrl = getDirectDatabaseUrl();
  ensurePrivateDir(BACKUP_DIR);

  const pgDump = await resolvePgTool("pg_dump");
  if (!pgDump.compatible) {
    logger.error({ pgDump }, "Database backup refused: pg_dump cannot work against this server");
    throw new AppError(500, pgDump.problem!);
  }

  const idPrefix = input.kind === "pre-update" ? "bk-pre-update" : input.kind === "scheduled" ? "bk-scheduled" : "bk";
  const backupId = `${idPrefix}-${Date.now()}`;
  const encrypted = !!input.password;
  const filename = backupFilename(input.kind, getAppVersion(), new Date(), encrypted);
  const backupFile = join(BACKUP_DIR, backupId);

  const { child, done } = runPgTool(
    "pg_dump",
    ["--no-owner", "--no-acl", "--clean", "--if-exists"],
    { connUrl, binPath: pgDump.path },
  );

  try {
    if (encrypted) {
      // pg_dump → gzip → AES-256-GCM → temp ciphertext, then the final file as
      // [magic][salt][iv][authTag][ciphertext] (the tag exists only at the end).
      const salt = randomBytes(SALT_LEN);
      const iv = randomBytes(IV_LEN);
      const key = scryptSync(input.password!, salt, 32);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertextFile = `${backupFile}.tmp-ct`;
      try {
        await Promise.all([
          pipeline(child.stdout!, createGzip(), cipher, createWriteStream(ciphertextFile, { mode: PRIVATE_FILE_MODE })),
          done,
        ]);
        const header = Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag()]);
        const out = createWriteStream(backupFile, { mode: PRIVATE_FILE_MODE });
        await new Promise<void>((res, rej) => out.write(header, (err) => (err ? rej(err) : res())));
        await pipeline(createReadStream(ciphertextFile), out);
      } finally {
        if (existsSync(ciphertextFile)) { try { unlinkSync(ciphertextFile); } catch { /* best effort */ } }
      }
    } else {
      await Promise.all([
        pipeline(child.stdout!, createGzip(), createWriteStream(backupFile, { mode: PRIVATE_FILE_MODE })),
        done,
      ]);
    }
  } catch (err: any) {
    // Never leave a truncated file behind masquerading as a usable backup.
    if (existsSync(backupFile)) { try { unlinkSync(backupFile); } catch { /* best effort */ } }
    logger.error({ err: err?.message, backupId }, "Database backup failed");
    if (err instanceof AppError) throw err;
    throw new AppError(500, "Database backup failed — see the server log for details");
  }

  const size = existsSync(backupFile) ? statSync(backupFile).size : 0;
  const record: BackupRecord = {
    id: backupId,
    filename,
    size,
    encrypted,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    ...(input.kind === "pre-update" ? { preUpdate: true } : {}),
  };

  try {
    await appendHistory(record);
  } catch (dbErr) {
    logger.warn({ err: dbErr, backupId }, "Backup created but failed to register in backup_history");
  }

  await logEvent({
    level: "info",
    action: "server.backup.created",
    resourceType: "backup",
    resourceId: backupId,
    resourceName: filename,
    actor: input.actor,
    message: `Database backup created: ${filename} (${size} bytes${encrypted ? ", encrypted" : ""}, ${input.kind})`,
    details: { kind: input.kind, size, encrypted, pgDump: pgDump.path, pgDumpMajor: pgDump.clientMajor },
  });

  return { record, path: backupFile };
}

// ─── Restore ───────────────────────────────────────────────────────────────

function readHead(filePath: string, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(filePath, "r");
  try { readSync(fd, buf, 0, len, 0); } finally { closeSync(fd); }
  return buf;
}

/** "current" = CHARONB\0 envelope; "legacy" = pre-port CHARONBK1; null = plain gzip. */
export function encryptedBackupFormat(filePath: string): "current" | "legacy" | null {
  const size = statSync(filePath).size;
  if (size > ENCRYPTED_HEADER_LEN && readHead(filePath, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) return "current";
  if (size > LEGACY_MAGIC.length + 44 && readHead(filePath, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) return "legacy";
  return null;
}

export interface RestoreBackupInput {
  /** Path to the uploaded backup file. Caller owns cleanup. */
  filePath: string;
  /** Passphrase, required when the file is encrypted. */
  password?: string | null;
}

/** Decrypt an encrypted backup to a private temp gzip file. */
async function decryptToTemp(filePath: string, format: "current" | "legacy", password: string): Promise<string> {
  ensurePrivateDir(BACKUP_DIR);
  const tmp = join(BACKUP_DIR, `.restore-dec-${Date.now()}.gz`);
  try {
    if (format === "current") {
      const header = readHead(filePath, ENCRYPTED_HEADER_LEN);
      const salt = header.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT_LEN);
      const iv = header.subarray(BACKUP_MAGIC.length + SALT_LEN, BACKUP_MAGIC.length + SALT_LEN + IV_LEN);
      const authTag = header.subarray(BACKUP_MAGIC.length + SALT_LEN + IV_LEN, ENCRYPTED_HEADER_LEN);
      const decipher = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32), iv);
      decipher.setAuthTag(authTag);
      await pipeline(
        createReadStream(filePath, { start: ENCRYPTED_HEADER_LEN }),
        decipher,
        createWriteStream(tmp, { mode: PRIVATE_FILE_MODE }),
      );
    } else {
      // Legacy layout: MAGIC(9) | salt(16) | iv(12) | ciphertext | tag(16).
      const size = statSync(filePath).size;
      const head = readHead(filePath, 37);
      const salt = head.subarray(9, 25);
      const iv = head.subarray(25, 37);
      const tagBuf = Buffer.alloc(16);
      const fd = openSync(filePath, "r");
      try { readSync(fd, tagBuf, 0, 16, size - 16); } finally { closeSync(fd); }
      const decipher = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32), iv);
      decipher.setAuthTag(tagBuf);
      await pipeline(
        createReadStream(filePath, { start: 37, end: size - 17 }),
        decipher,
        createWriteStream(tmp, { mode: PRIVATE_FILE_MODE }),
      );
    }
    return tmp;
  } catch {
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* best effort */ } }
    // GCM verification fails at final() with an opaque error; both causes look
    // the same to us and to the operator.
    throw new AppError(400, "Decryption failed — incorrect password or corrupted file");
  }
}

/** Restore a backup into the current database (single transaction). */
export async function restoreBackup(input: RestoreBackupInput): Promise<void> {
  const connUrl = getDirectDatabaseUrl();
  if (!existsSync(input.filePath)) throw new AppError(400, "Backup file not found");

  const format = encryptedBackupFormat(input.filePath);
  if (format && !input.password) {
    throw new AppError(400, "This backup is encrypted — a password is required to restore it");
  }

  // psql restores across majors (it only warns), so only "cannot run it" is fatal.
  const psql = await resolvePgTool("psql");
  if (!psql.compatible) throw new AppError(500, psql.problem!);
  if (psql.clientMajor != null && psql.serverMajor != null && psql.clientMajor < psql.serverMajor) {
    logger.warn({ psql: psql.path, clientMajor: psql.clientMajor, serverMajor: psql.serverMajor }, "restore: psql is older than the server; continuing");
  }

  let gzipSourcePath = input.filePath;
  let decryptedTempPath: string | null = null;
  if (format) {
    decryptedTempPath = await decryptToTemp(input.filePath, format, input.password!);
    gzipSourcePath = decryptedTempPath;
  }

  try {
    const { child, done } = runPgTool(
      "psql",
      ["--no-psqlrc", "--quiet", "--single-transaction", "-v", "ON_ERROR_STOP=1"],
      { connUrl, binPath: psql.path },
    );
    await Promise.all([
      pipeline(createReadStream(gzipSourcePath), createGunzip(), child.stdin!),
      done,
    ]);
  } catch (err: any) {
    logger.error({ err: err?.message }, "Database restore failed");
    if (err instanceof AppError) throw err;
    throw new AppError(500, "Restore failed — see the server log for details");
  } finally {
    // `--clean --if-exists` drops and recreates every table, so every pooled
    // connection is holding stale relation OIDs. Recycle the pool; Prisma
    // reconnects lazily. The route still tells the operator to restart, since
    // a dump from another schema version also leaves a stale generated client.
    try {
      await prisma.$disconnect();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "Could not recycle the Prisma pool after the restore — restart Charon before using it.");
    }
    if (decryptedTempPath && existsSync(decryptedTempPath)) {
      try { unlinkSync(decryptedTempPath); } catch { /* best effort */ }
    }
  }
}
