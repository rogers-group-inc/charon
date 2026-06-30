/**
 * src/services/updateService.ts — In-app updater (git-checkout installs only).
 *
 * Stepwise pipeline mirroring polaris: Backup → git pull --ff-only → npm ci →
 * prisma generate → npm run build → prisma migrate deploy → restart. Progress
 * is written to .update-status.json (under the state dir) after each step; the
 * UI polls it every 2s. The whole charon.target is restarted via
 * `systemd-run --no-block` so the restart survives the process exiting.
 *
 * Environment detection: only a git checkout running OUTSIDE Docker can
 * self-update. Docker and RHEL-package installs get a clear "update outside the
 * app" message (pull the image / reinstall the package).
 *
 * HA NOTE: in a primary/standby pair the updater must not split-brain. The safe
 * order (update standby first, fail over via GSLB, then update the new standby)
 * is documented in deploy/HA.md; the in-app updater gates "apply" to require an
 * explicit confirmation acknowledging the node is safe to update.
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { STATE_DIR } from "../utils/paths.js";
import { getAppVersion } from "../utils/version.js";
import { logger } from "../utils/logger.js";

const STATUS_FILE = resolve(STATE_DIR, ".update-status.json");
const PROJECT_ROOT = resolve(STATE_DIR); // git checkout root == project root on RHEL installs

export type UpdateStep = "idle" | "backup" | "pull" | "ci" | "generate" | "build" | "migrate" | "restart" | "done" | "error";

export interface UpdateStatus {
  step: UpdateStep;
  message: string;
  startedAt?: string;
  updatedAt: string;
  error?: string;
}

export interface Environment {
  kind: "git" | "docker" | "package";
  canSelfUpdate: boolean;
  reason: string;
}

export function detectEnvironment(): Environment {
  if (existsSync("/.dockerenv") || process.env.CHARON_IN_DOCKER === "1") {
    return { kind: "docker", canSelfUpdate: false, reason: "Running in Docker — pull a new ghcr.io/rogers-group-inc/charon image and recreate the containers." };
  }
  if (!existsSync(resolve(PROJECT_ROOT, ".git"))) {
    return { kind: "package", canSelfUpdate: false, reason: "Not a git checkout — reinstall the RHEL package to update." };
  }
  return { kind: "git", canSelfUpdate: true, reason: "Git checkout — in-app update available." };
}

export function readStatus(): UpdateStatus {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return { step: "idle", message: "No update in progress", updatedAt: new Date().toISOString() };
  }
}

function writeStatus(s: Partial<UpdateStatus> & { step: UpdateStep; message: string }): void {
  const prev = readStatus();
  const next: UpdateStatus = { ...prev, ...s, updatedAt: new Date().toISOString() };
  writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2));
}

/** Compare local commit count to the remote to show "N commits behind". */
export async function checkForUpdate(): Promise<{ current: string; behind: number | null; environment: Environment }> {
  const environment = detectEnvironment();
  let behind: number | null = null;
  if (environment.kind === "git") {
    try {
      const remote = process.env.CHARON_UPDATE_REPO || "origin";
      execSync(`git fetch ${remote} --quiet`, { cwd: PROJECT_ROOT, timeout: 30_000 });
      const out = execSync("git rev-list --count HEAD..@{u}", { cwd: PROJECT_ROOT }).toString().trim();
      behind = Number.parseInt(out, 10) || 0;
    } catch (err: any) {
      logger.warn({ err: err?.message }, "update check: git fetch/compare failed");
    }
  }
  return { current: getAppVersion(), behind, environment };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: PROJECT_ROOT, stdio: "inherit", shell: false });
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    p.on("error", rej);
  });
}

/**
 * Run the update pipeline. Fire-and-forget: returns immediately after kicking
 * off; the UI polls readStatus(). Throws synchronously only when the
 * environment can't self-update.
 */
export async function startUpdate(opts: { backupFirst: boolean }): Promise<void> {
  const env = detectEnvironment();
  if (!env.canSelfUpdate) throw new Error(env.reason);

  writeStatus({ step: "backup", message: "Starting update…", startedAt: new Date().toISOString() });

  void (async () => {
    try {
      if (opts.backupFirst) {
        writeStatus({ step: "backup", message: "Creating backup…" });
        const { createBackup } = await import("./backupService.js");
        await createBackup();
      }
      writeStatus({ step: "pull", message: "git pull --ff-only…" });
      await run("git", ["pull", "--ff-only"]);
      writeStatus({ step: "ci", message: "npm ci…" });
      await run("npm", ["ci"]);
      writeStatus({ step: "generate", message: "prisma generate…" });
      await run("npx", ["prisma", "generate"]);
      writeStatus({ step: "build", message: "npm run build…" });
      await run("npm", ["run", "build"]);
      writeStatus({ step: "migrate", message: "prisma migrate deploy…" });
      await run("npx", ["prisma", "migrate", "deploy"]);
      writeStatus({ step: "restart", message: "Restarting charon.target…" });
      // Detach the restart so it survives this process exiting. Re-renders nginx
      // on the way back up via the unit's ExecStartPre (see deploy/systemd).
      try {
        spawn("systemd-run", ["--no-block", "systemctl", "restart", "charon.target"], { stdio: "ignore", detached: true }).unref();
      } catch (err: any) {
        logger.warn({ err: err?.message }, "update: systemd restart failed (non-systemd host?)");
      }
      writeStatus({ step: "done", message: "Update complete — restarting." });
    } catch (err: any) {
      writeStatus({ step: "error", message: "Update failed", error: err?.message });
      logger.error({ err: err?.message }, "in-app update failed");
    }
  })();
}
