/**
 * src/services/backupService.ts — Database backup / restore.
 *
 * Backup pipeline: pg_dump → gzip → (optional) AES-256-GCM with a
 * password-derived key (scrypt). Restore reverses it: decrypt → gunzip → psql.
 * Filenames are version-stamped so an operator can match a backup to the build
 * that produced it. Encrypted backups carry a small self-describing header so
 * restore knows the salt/iv without a sidecar file.
 *
 * Requires pg_dump/psql on PATH (provided by the postgresql-client package in
 * the Docker image and by deploy/install-rhel.sh).
 */

import { spawn } from "node:child_process";
import { createGzip, createGunzip } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { createWriteStream, createReadStream, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { BACKUP_DIR } from "../utils/paths.js";
import { getAppVersion } from "../utils/version.js";
import { logger } from "../utils/logger.js";

const MAGIC = Buffer.from("CHARONBK1"); // 9-byte header magic for encrypted backups

function ensureDir(): void {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

function stamp(): string {
  // Version + content hash of timestamp-less marker; the caller passes a clock
  // value in via env-free path. We use process.hrtime for uniqueness only.
  const v = getAppVersion();
  const uniq = createHash("sha256").update(String(process.hrtime.bigint())).digest("hex").slice(0, 10);
  return `charon-${v}-${uniq}`;
}

export interface BackupInfo {
  filename: string;
  sizeBytes: number;
  encrypted: boolean;
  createdAt: string;
}

export function listBackups(): BackupInfo[] {
  ensureDir();
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".gz") || f.endsWith(".enc"))
    .map((f) => {
      const st = statSync(resolve(BACKUP_DIR, f));
      return { filename: f, sizeBytes: st.size, encrypted: f.endsWith(".enc"), createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Run pg_dump → gzip → (optional encrypt) into BACKUP_DIR. */
export async function createBackup(password?: string): Promise<BackupInfo> {
  ensureDir();
  const dbUrl = process.env.CHARON_DB_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const encrypted = !!password;
  const filename = `${stamp()}.sql.gz${encrypted ? ".enc" : ""}`;
  const outPath = resolve(BACKUP_DIR, filename);

  const dump = spawn("pg_dump", ["--no-owner", "--no-privileges", dbUrl], { stdio: ["ignore", "pipe", "pipe"] });
  dump.stderr.on("data", (d) => logger.debug({ pg_dump: d.toString().trim() }));

  const gz = createGzip();
  const out = createWriteStream(outPath);

  if (!encrypted) {
    await pipeline(dump.stdout, gz, out);
  } else {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(password!, salt), iv);
    // Header: MAGIC(9) | salt(16) | iv(12), then ciphertext, then auth tag(16).
    out.write(Buffer.concat([MAGIC, salt, iv]));
    await pipeline(dump.stdout, gz, cipher, out, { end: false });
    out.write(cipher.getAuthTag());
    out.end();
    await new Promise<void>((res, rej) => { out.on("finish", () => res()); out.on("error", rej); });
  }

  const st = statSync(outPath);
  logger.info({ filename, sizeBytes: st.size, encrypted }, "backup created");
  return { filename, sizeBytes: st.size, encrypted, createdAt: st.mtime.toISOString() };
}

/** Restore a backup file into the database (decrypt → gunzip → psql). */
export async function restoreBackup(filename: string, password?: string): Promise<void> {
  const inPath = resolve(BACKUP_DIR, filename);
  if (!existsSync(inPath)) throw new Error("Backup file not found");
  const dbUrl = process.env.CHARON_DB_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const psql = spawn("psql", [dbUrl], { stdio: ["pipe", "ignore", "pipe"] });
  psql.stderr.on("data", (d) => logger.debug({ psql: d.toString().trim() }));

  if (filename.endsWith(".enc")) {
    if (!password) throw new Error("Password required to restore an encrypted backup");
    const buf = await import("node:fs/promises").then((m) => m.readFile(inPath));
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a Charon encrypted backup");
    const salt = buf.subarray(9, 25);
    const iv = buf.subarray(25, 37);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(37, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, salt), iv);
    decipher.setAuthTag(tag);
    const gunzip = createGunzip();
    decipher.pipe(gunzip).pipe(psql.stdin);
    decipher.end(ct);
    await new Promise((res, rej) => { psql.on("close", (c) => (c === 0 ? res(null) : rej(new Error(`psql exited ${c}`)))); psql.on("error", rej); });
  } else {
    await pipeline(createReadStream(inPath), createGunzip(), psql.stdin);
    await new Promise((res, rej) => { psql.on("close", (c) => (c === 0 ? res(null) : rej(new Error(`psql exited ${c}`)))); psql.on("error", rej); });
  }
  logger.info({ filename }, "backup restored");
}
