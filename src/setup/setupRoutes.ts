/**
 * src/setup/setupRoutes.ts — First-run wizard API (Polaris-style, Charon-adapted).
 *
 * Endpoints (all unauthenticated — the wizard only runs before DATABASE_URL is
 * set, and detectSetup() locks it once a host is configured):
 *   GET  /api/setup/status          — always { needsSetup: true } while wizard is live
 *   POST /api/setup/preflight       — disk-free advisories for app/state/db volumes
 *   POST /api/setup/generate-secret — a fresh random session secret
 *   POST /api/setup/test-connection — validate a Postgres server + report version
 *   POST /api/setup/finalize        — create the DB if missing, write .env (with
 *                                     freshly generated secrets + the AES-256-GCM
 *                                     data key), run migrations, seed built-in
 *                                     roles + the first admin, then exit so the
 *                                     process manager restarts into the full app.
 *
 * SECURITY: the generated CHARON_DATA_KEY is what encrypts every at-rest secret.
 * It is written to .env and must be backed up to Key Vault — losing it makes
 * stored integration credentials unrecoverable. The DB-touching routes are
 * tightly rate-limited because the wizard is unauthenticated by design.
 */

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { statfs, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { markSetupComplete } from "./detectSetup.js";
import { ENV_FILE, STATE_DIR } from "../utils/paths.js";
import { makeRateLimiter } from "../api/middleware/rateLimits.js";
import { logger } from "../utils/logger.js";
import { defaultPasswordPolicy, passwordPolicyError } from "../utils/passwordPolicy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const router = Router();

// The wizard is unauthenticated (first-run only, guarded by the .setup-complete
// boot lock) — keep the DB-touching routes tightly rate-limited so a network
// neighbor can't use them as a connect proxy or brute-force surface.
const setupActionLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many setup attempts. Please wait 15 minutes and try again.",
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const DbConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  username: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
  ssl: z.boolean().default(false),
  sslAllowSelfSigned: z.boolean().default(false),
});

type DbConfig = z.infer<typeof DbConfigSchema>;

// The wizard runs before there is a database to hold an operator policy, so
// the first admin meets the DEFAULT policy — through the same evaluator the
// live policy uses (utils/passwordPolicy.ts), so the two cannot drift.
const passwordSchema = z
  .string()
  .max(1024, "Password must be at most 1024 characters")
  .superRefine((p, ctx) => {
    const message = passwordPolicyError(p, defaultPasswordPolicy());
    if (message) ctx.addIssue({ code: "custom", message });
  });

const FinalizeSchema = z.object({
  db: DbConfigSchema,
  admin: z.object({
    username: z.string().min(1).max(64),
    password: passwordSchema,
  }),
  app: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    sessionSecret: z.string().min(16),
  }),
});

// ─── Connection helpers ─────────────────────────────────────────────────────────

function buildPgClientOptions(db: DbConfig, database: string): pg.ClientConfig {
  // No sslmode in the connection string — pg-connection-string parses it into
  // its own ssl options that conflict with the explicit `ssl` field below in a
  // version-dependent way. Carrying TLS settings on the explicit field only is
  // unambiguous.
  const connectionString = `postgresql://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${database}`;
  const opts: pg.ClientConfig = { connectionString, connectionTimeoutMillis: 8000 };
  if (db.ssl) {
    opts.ssl = db.sslAllowSelfSigned ? { rejectUnauthorized: false } : true;
  }
  return opts;
}

function buildConnectionString(db: DbConfig): string {
  const base = `postgresql://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.database}`;
  if (!db.ssl) return base;
  // sslmode=no-verify keeps TLS but skips cert validation — recognized by
  // node-postgres (the driver @prisma/adapter-pg uses at runtime).
  return `${base}?sslmode=${db.sslAllowSelfSigned ? "no-verify" : "require"}`;
}

// ─── GET /status ────────────────────────────────────────────────────────────────

router.get("/status", (_req, res) => {
  res.json({ needsSetup: true });
});

// ─── POST /preflight ────────────────────────────────────────────────────────────
// Disk-free advisories for the volumes Charon writes to (app + state) and, when
// the DB host is local, the conventional PostgreSQL data dir. Warnings are
// advisory — a too-small /var is the most common fresh-install footgun.

const PG_DATA_DIR_CANDIDATES: string[] =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\PostgreSQL\\17\\data",
        "C:\\Program Files\\PostgreSQL\\16\\data",
        "C:\\Program Files\\PostgreSQL\\15\\data",
      ]
    : [
        "/var/lib/pgsql/data",
        "/var/lib/pgsql/17/data",
        "/var/lib/pgsql/16/data",
        "/var/lib/pgsql/15/data",
        "/var/lib/postgresql/17/main",
        "/var/lib/postgresql/16/main",
        "/var/lib/postgresql/15/main",
      ];

const RECOMMENDED_DB_FREE_GB = 50;
const RECOMMENDED_APP_FREE_GB = 5;

const PreflightSchema = z.object({ dbHost: z.string().min(1).optional() });

interface PreflightVolume {
  role: "app" | "state" | "db";
  path: string;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  recommendedMinFreeGb: number;
  meetsRecommendation: boolean;
}

async function statfsForPreflight(
  role: PreflightVolume["role"],
  path: string,
  recommendedMinFreeGb: number,
): Promise<PreflightVolume | null> {
  try {
    const fs = await statfs(path);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    const freePct = totalBytes > 0 ? freeBytes / totalBytes : 1;
    const minFreeBytes = recommendedMinFreeGb * 1024 ** 3;
    return {
      role,
      path,
      freeBytes,
      totalBytes,
      freePct,
      recommendedMinFreeGb,
      meetsRecommendation: freeBytes >= minFreeBytes,
    };
  } catch {
    return null;
  }
}

async function pickFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await stat(p);
      return p;
    } catch {
      /* not present, keep going */
    }
  }
  return null;
}

router.post("/preflight", async (req, res) => {
  try {
    const { dbHost } = PreflightSchema.parse(req.body || {});
    const isLocal = dbHost
      ? ["localhost", "127.0.0.1", "::1", ""].includes(dbHost.toLowerCase().trim())
      : true;

    const out: PreflightVolume[] = [];
    const appProbe = await statfsForPreflight("app", PROJECT_ROOT, RECOMMENDED_APP_FREE_GB);
    if (appProbe) out.push(appProbe);
    const stateProbe = await statfsForPreflight("state", STATE_DIR, RECOMMENDED_APP_FREE_GB);
    if (stateProbe) out.push(stateProbe);

    let dbCandidatePath: string | null = null;
    if (isLocal) {
      dbCandidatePath = await pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
      if (dbCandidatePath) {
        const dbProbe = await statfsForPreflight("db", dbCandidatePath, RECOMMENDED_DB_FREE_GB);
        if (dbProbe) out.push(dbProbe);
      }
    }

    // Dedupe volumes that resolve to the same filesystem (identical free+total).
    const seen = new Set<string>();
    const deduped: PreflightVolume[] = [];
    for (const v of out) {
      const key = `${v.freeBytes}|${v.totalBytes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(v);
    }

    const warnings: string[] = [];
    for (const v of deduped) {
      if (!v.meetsRecommendation) {
        const gb = (v.freeBytes / 1024 ** 3).toFixed(1);
        warnings.push(
          v.role === "db"
            ? `Database volume (${v.path}) has only ${gb} GB free — recommended ≥ ${v.recommendedMinFreeGb} GB. Event/audit history and backups grow over time; you may run out of space within months.`
            : `${v.role === "app" ? "Application" : "State"} volume (${v.path}) has only ${gb} GB free — recommended ≥ ${v.recommendedMinFreeGb} GB. Backups and update rollback both need headroom.`,
        );
      }
    }
    if (isLocal && !dbCandidatePath) {
      warnings.push(
        "PostgreSQL data directory could not be located via the standard paths — disk-free check on the DB volume was skipped.",
      );
    }
    if (!isLocal) {
      warnings.push(
        `Database host (${dbHost}) is not local — disk-free check on the DB volume was skipped. Make sure that host has at least ${RECOMMENDED_DB_FREE_GB} GB free.`,
      );
    }

    res.json({
      ok: warnings.length === 0,
      isDbLocal: isLocal,
      volumes: deduped,
      warnings,
      recommendedDbFreeGb: RECOMMENDED_DB_FREE_GB,
      recommendedAppFreeGb: RECOMMENDED_APP_FREE_GB,
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({ ok: false, message: "Invalid input", errors: err.issues });
    }
    res.status(500).json({ ok: false, message: err?.message || "Preflight check failed" });
  }
});

// ─── POST /generate-secret ──────────────────────────────────────────────────────

router.post("/generate-secret", (_req, res) => {
  res.json({ secret: randomBytes(48).toString("base64url") });
});

// ─── POST /test-connection ──────────────────────────────────────────────────────

router.post("/test-connection", setupActionLimiter, async (req, res) => {
  try {
    const db = DbConfigSchema.parse(req.body);

    // Connect to the built-in "postgres" database to test server connectivity
    // without requiring the target DB to exist yet.
    const client = new pg.Client(buildPgClientOptions(db, "postgres"));
    await client.connect();
    const versionResult = await client.query("SELECT version()");
    const version = versionResult.rows[0]?.version || "Unknown";
    const dbCheck = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db.database]);
    const dbExists = (dbCheck.rowCount ?? 0) > 0;
    await client.end();

    res.json({
      ok: true,
      version,
      databaseExists: dbExists,
      message: dbExists
        ? `Connected — ${version.split(",")[0]}`
        : `Connected — database "${db.database}" will be created during setup`,
    });
  } catch (err: any) {
    const msg =
      err?.code === "ECONNREFUSED"
        ? `Connection refused — ${req.body?.host}:${req.body?.port}`
        : err?.code === "ENOTFOUND"
          ? `Host not found — ${req.body?.host}`
          : err?.code === "ETIMEDOUT"
            ? `Connection timed out — ${req.body?.host}:${req.body?.port}`
            : err?.code === "28P01"
              ? "Authentication failed — check username and password"
              : err?.message || "Connection failed";
    res.json({ ok: false, message: msg });
  }
});

// ─── POST /finalize ─────────────────────────────────────────────────────────────

router.post("/finalize", setupActionLimiter, async (req, res) => {
  try {
    const { db, admin, app } = FinalizeSchema.parse(req.body);

    // Safety: never clobber a working config.
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
      return res.status(409).json({ ok: false, message: "Application is already configured" });
    }
    if (existsSync(ENV_FILE)) {
      return res.status(409).json({
        ok: false,
        message: ".env already exists — refusing to overwrite. Remove it to re-run setup.",
      });
    }

    // Step 1: create the target database if it doesn't exist.
    const serverClient = new pg.Client(buildPgClientOptions(db, "postgres"));
    await serverClient.connect();
    const dbCheck = await serverClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [db.database]);
    if ((dbCheck.rowCount ?? 0) === 0) {
      const safeName = db.database.replace(/"/g, '""');
      await serverClient.query(`CREATE DATABASE "${safeName}"`);
    }
    await serverClient.end();

    // Step 2: generate secrets + the at-rest data key, then write .env.
    const databaseUrl = buildConnectionString(db);
    const dataKey = randomBytes(32).toString("base64");
    const healthToken = randomBytes(24).toString("base64url");
    const metricsToken = randomBytes(24).toString("base64url");

    const envBody = [
      "# Charon configuration — generated by the first-run setup wizard.",
      "# SECURITY: this file contains secrets and the at-rest data key.",
      "#   - Never commit it (the repo is public; .gitignore blocks it).",
      "#   - Back up CHARON_DATA_KEY to Key Vault — losing it makes stored",
      "#     integration credentials unrecoverable.",
      "",
      "# Database",
      `DATABASE_URL=${databaseUrl}`,
      "",
      "# App",
      `PORT=${app.port}`,
      "NODE_ENV=production",
      "",
      "# Session secret — required when NODE_ENV=production (the server refuses",
      "# to boot without it). Regenerate to invalidate every active session.",
      `SESSION_SECRET=${app.sessionSecret}`,
      "",
      "# At-rest data key (AES-256-GCM) — encrypts every stored secret. BACK THIS",
      "# UP. Losing it makes stored integration credentials unrecoverable.",
      `CHARON_DATA_KEY=${dataKey}`,
      "",
      "# Health/metrics bearer tokens — auto-generated so these endpoints aren't",
      "# exposed open on a public deployment. Clear a value to open that endpoint.",
      `HEALTH_TOKEN=${healthToken}`,
      `METRICS_TOKEN=${metricsToken}`,
      "",
    ].join("\n");

    mkdirSync(dirname(ENV_FILE), { recursive: true });
    writeFileSync(ENV_FILE, envBody, { encoding: "utf-8" });
    try {
      const { chmodSync } = await import("node:fs");
      chmodSync(ENV_FILE, 0o600);
    } catch {
      /* best-effort on non-POSIX */
    }

    // Step 3: apply schema, then seed built-in roles + the first admin. The
    // child inherits the DB URL + data key, plus the admin creds the seed reads.
    const childEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CHARON_DATA_KEY: dataKey,
      CHARON_SEED_ADMIN_USER: admin.username,
      CHARON_SEED_ADMIN_PASSWORD: admin.password,
    };

    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: PROJECT_ROOT,
        env: childEnv,
        stdio: "pipe",
        timeout: 120000,
      });
    } catch (migrateErr: any) {
      const stderr = migrateErr?.stderr?.toString() || migrateErr?.message || "unknown error";
      return res.status(500).json({
        ok: false,
        step: "migrations",
        message: `Database migration failed: ${String(stderr).slice(0, 500)}`,
      });
    }

    try {
      // Prefer the compiled seed — the production/Docker image prunes tsx + the
      // prisma/seed.ts source. Fall back to the tsx source in a dev checkout.
      if (existsSync(resolve(PROJECT_ROOT, "dist/cli/seed.js"))) {
        execFileSync("node", ["dist/cli/seed.js"], { cwd: PROJECT_ROOT, env: childEnv, stdio: "pipe", timeout: 60000 });
      } else {
        execFileSync("node", ["--import", "tsx/esm", "prisma/seed.ts"], {
          cwd: PROJECT_ROOT,
          env: childEnv,
          stdio: "pipe",
          timeout: 60000,
        });
      }
    } catch (seedErr: any) {
      const stderr = seedErr?.stderr?.toString() || seedErr?.message || "unknown error";
      return res.status(500).json({
        ok: false,
        step: "seed",
        message: `Seeding roles + admin failed: ${String(stderr).slice(0, 500)}`,
      });
    }

    // Write the setup-complete marker so future boots refuse the wizard even if
    // .env is deleted or DATABASE_URL is cleared.
    markSetupComplete();
    logger.info("First-run setup finalized; restarting to boot the full app.");

    // Return healthToken so the wizard's post-restart poll can authenticate the
    // gated /health probe; without it every poll would 401.
    res.json({ ok: true, message: "Setup complete. The application is restarting.", healthToken });

    // Exit after the response flushes; the process manager (systemd / the
    // container restart policy) brings us back up with .env now present, so the
    // full app boots in the "configured" state.
    setTimeout(() => process.exit(0), 1500);
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({ ok: false, message: "Invalid input", errors: err.issues });
    }
    res.status(500).json({ ok: false, message: err?.message || "Setup failed" });
  }
});

export default router;
