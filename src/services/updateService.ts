/**
 * src/services/updateService.ts — in-app updater (Application Updates card).
 *
 * Ported from polaris (src/services/updateService.ts). The status shape, state
 * machine (idle / checking / available / up-to-date / applying / restarting /
 * complete / failed / disabled), the step list, the update train (nightly =
 * branch tip, release = newest release tag), the pre-update backup (fatal on
 * failure unless the operator ticked "proceed anyway"), the post-restart
 * "complete" detection and the server.update.* audit Events are polaris's.
 *
 * Charon semantics kept:
 *  - Version = package.json major.minor + git commit count; "N commits behind"
 *    compares local vs remote commit counts (git rev-list --count).
 *  - Docker: no .git tree → image mode. The check reads the published
 *    ghcr.io/rogers-group-inc/charon image's CHARON_BUILD_COMMIT_COUNT from the
 *    registry (anonymous) and compares; updating is a pull + recreate by the
 *    operator. A non-git, non-container install is "disabled".
 *  - Restart = `systemd-run --no-block systemctl restart charon.target` (the
 *    whole role set), detached so it survives this process exiting.
 *  - HA guard: when this database is in a replication pair, apply requires an
 *    explicit "this node is safe to update" (update the standby first, fail
 *    over, then this node — deploy/HA.md).
 *
 * Charon adaptations: every git/npm call is execFile with an argv array (no
 * shell); a dirty checkout is refused rather than silently reset (a dev
 * checkout's work must never be discarded by a button).
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { STATE_DIR } from "../utils/paths.js";
import { getAppVersion } from "../utils/version.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventService.js";
import { createBackup } from "./backupService.js";
import { runtimeIsContainer, hasSystemd } from "../utils/deploymentContext.js";
import { fetchImageBuildInfo } from "../utils/imageRegistry.js";

const execFileAsync = promisify(execFile);
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATUS_FILE = resolve(STATE_DIR, ".update-status.json");

export const DEFAULT_UPDATE_IMAGE = "ghcr.io/rogers-group-inc/charon:latest";

type Step = { name: string; status: "pending" | "running" | "done" | "failed"; message?: string; startedAt?: string; durationMs?: number };

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "up-to-date" | "applying" | "complete" | "failed" | "restarting" | "disabled";
  step?: string;
  steps?: Step[];
  error?: string;
  currentVersion?: string;
  latestVersion?: string;
  currentCommit?: string;
  checkoutCommit?: string;
  latestCommit?: string;
  commitsBehind?: number;
  changes?: string[];
  backupFile?: string;
  startedAt?: string;
  completedAt?: string;
  method?: string;
  train?: UpdateTrain;
  releaseTag?: string;
  note?: string;
  updateMethod?: "git" | "image";
  image?: string;
  source?: string;
  checkedAt?: string;
  /** Charon: this database is in a replication pair — apply needs confirmNode. */
  haPair?: boolean;
}

export type UpdateTrain = "nightly" | "release";

// ─── git helpers (argv only — never a shell) ─────────────────────────────────

async function git(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: APP_DIR, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return String(stdout);
}

/** Plain ref names only — release tags come from the update repo (untrusted). */
export function isSafeGitRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes("..") && !ref.endsWith(".lock");
}

export function isSafeRepoUrl(url: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@)[A-Za-z0-9@:/._~+-]+$/.test(url);
}

function configuredUpdateRepo(): string | null {
  const v = (process.env.CHARON_UPDATE_REPO || "").trim();
  if (!v) return null;
  if (!isSafeRepoUrl(v)) {
    logger.error({ repo: v }, "CHARON_UPDATE_REPO is not a plain https/ssh git URL — ignoring it");
    return null;
  }
  return v;
}

async function currentOriginUrl(): Promise<string | null> {
  try { return (await git(["remote", "get-url", "origin"], 10_000)).trim() || null; } catch { return null; }
}

export async function getUpdateRepoInfo(): Promise<{ url: string | null; source: "env" | "origin" }> {
  if (!_env.available) return { url: null, source: "origin" };
  const env = configuredUpdateRepo();
  if (env) return { url: env, source: "env" };
  return { url: await currentOriginUrl(), source: "origin" };
}

async function ensureUpdateRemote(): Promise<void> {
  const desired = configuredUpdateRepo();
  if (!desired) return;
  const current = await currentOriginUrl();
  if (current === desired) return;
  try {
    await git(current ? ["remote", "set-url", "origin", desired] : ["remote", "add", "origin", desired], 10_000);
    logger.info({ from: current, to: desired }, "In-app update: pointed origin at CHARON_UPDATE_REPO");
  } catch (err: any) {
    logger.warn({ err: err?.message, desired }, "In-app update: could not set origin — proceeding with the existing remote");
  }
}

export async function getUpdateTrain(): Promise<UpdateTrain> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "update.train" } });
    return row?.value === "release" ? "release" : "nightly";
  } catch {
    return "nightly";
  }
}

export async function setUpdateTrain(train: UpdateTrain): Promise<void> {
  const value: UpdateTrain = train === "release" ? "release" : "nightly";
  await prisma.setting.upsert({ where: { key: "update.train" }, update: { value }, create: { key: "update.train", value } });
}

export async function getSkipBackup(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: "update.skip_backup" } });
  return row?.value === true;
}

export async function setSkipBackup(skip: boolean): Promise<void> {
  await prisma.setting.upsert({ where: { key: "update.skip_backup" }, update: { value: skip }, create: { key: "update.skip_backup", value: skip } });
}

async function resolveNightlyRef(): Promise<string> {
  for (const r of ["origin/HEAD", "origin/main", "origin/master"]) {
    try { await git(["rev-parse", "--verify", "--quiet", r], 10_000); return r; } catch { /* next */ }
  }
  return "origin/HEAD";
}

async function latestReleaseTag(): Promise<string | null> {
  try {
    const tags = (await git(["tag", "--list", "--sort=-v:refname", "v[0-9]*", "[0-9]*"], 10_000))
      .split("\n").map((s) => s.trim()).filter(Boolean);
    for (const tag of tags) {
      if (isSafeGitRef(tag)) return tag;
      logger.error({ tag }, "Ignoring a release tag whose name is not a plain git ref");
    }
    return null;
  } catch {
    return null;
  }
}

function majorMinorOf(pkgVersion: string): string {
  const [major, minor] = (pkgVersion || "0.1.0").split(".");
  return `${major}.${minor ?? 0}`;
}

function readPackageMajorMinor(): string {
  try { return majorMinorOf(JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf-8")).version); } catch { return "0.1"; }
}

// The commit this process booted from — "current" is the running build, not
// whatever an interrupted update left checked out.
const _runningCommit: string | null = (() => {
  try {
    if (!existsSync(join(APP_DIR, ".git"))) return null;
    return String(execFileSync("git", ["rev-parse", "HEAD"], { cwd: APP_DIR, timeout: 5000, windowsHide: true })).trim() || null;
  } catch {
    return null;
  }
})();

async function computeTargetInfo(ref: string): Promise<{
  currentCommit: string; checkoutCommit: string; latestCommit: string;
  commitsBehind: number; changes: string[]; version: string;
}> {
  const headFull = (await git(["rev-list", "-n", "1", "HEAD"])).trim();
  const checkoutCommit = headFull.slice(0, 7);
  const base = _runningCommit ?? "HEAD";
  const currentCommit = (_runningCommit ?? headFull).slice(0, 7);
  const latestCommit = (await git(["rev-list", "-n", "1", ref])).trim().slice(0, 7);

  let commitsBehind = 0;
  let changes: string[] = [];
  if (currentCommit !== latestCommit) {
    try { commitsBehind = parseInt((await git(["rev-list", "--count", `${base}..${ref}`])).trim(), 10) || 0; } catch { /* keep 0 */ }
    try { changes = (await git(["log", "--oneline", `${base}..${ref}`])).trim().split("\n").filter(Boolean).slice(0, 200); } catch { /* none */ }
  }

  let version = "unknown";
  try {
    const pkg = JSON.parse(await git(["show", `${ref}:package.json`]));
    const count = (await git(["rev-list", "--count", ref])).trim();
    version = `${majorMinorOf(pkg.version)}.${count}`;
  } catch { /* unknown */ }

  return { currentCommit, checkoutCommit, latestCommit, commitsBehind, changes, version };
}

// ─── Environment ─────────────────────────────────────────────────────────────

const _env = (function detect(): { available: boolean; imageMode?: boolean; reason?: string; method?: string } {
  const hasGit = existsSync(join(APP_DIR, ".git"));
  if (runtimeIsContainer() && !hasGit) {
    return {
      available: false,
      imageMode: true,
      reason: "In-app updates are disabled in Docker.",
      method:
        "To update, pull the latest image and recreate the containers (docker compose pull && docker compose up -d). " +
        "Data and settings persist on the mounted state volume. In an HA pair, update the standby first, fail over, then this node.",
    };
  }
  if (!hasGit) {
    return {
      available: false,
      reason: "In-app updates are disabled — no git checkout at the install path.",
      method: "Update by reinstalling the application package (deploy/install-rhel.sh).",
    };
  }
  return { available: true };
})();

export function isUpdateMechanismAvailable(): boolean { return _env.available; }
export function isImageUpdateMode(): boolean { return Boolean(_env.imageMode); }

function disabledStatus(): UpdateStatus {
  return {
    state: "disabled",
    currentVersion: getAppVersion(),
    error: _env.reason,
    method: _env.method,
    ...(_env.imageMode ? { updateMethod: "image" as const } : {}),
  };
}

let _status: UpdateStatus = { state: "idle" };
let _applying = false;

function saveStatus(): void {
  try { writeFileSync(STATUS_FILE, JSON.stringify(_status, null, 2)); } catch (err) { logger.warn({ err }, "Failed to write update status file"); }
}

function loadStatusFromDisk(): UpdateStatus | null {
  try { return existsSync(STATUS_FILE) ? JSON.parse(readFileSync(STATUS_FILE, "utf-8")) : null; } catch { return null; }
}

/** Is this database part of a streaming-replication pair? */
export async function detectHaPair(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ standby: boolean; replicas: number }[]>(
      "SELECT pg_is_in_recovery() AS standby, (SELECT count(*)::int FROM pg_stat_replication) AS replicas",
    );
    return !!rows[0]?.standby || Number(rows[0]?.replicas ?? 0) > 0;
  } catch {
    return false;
  }
}

/** On startup: a status left at "restarting" means the update's restart worked. */
export function initUpdateStatus(): void {
  const saved = loadStatusFromDisk();
  if (saved && saved.state === "restarting") {
    saved.state = "complete";
    saved.completedAt = new Date().toISOString();
    saved.latestVersion = getAppVersion();
    saved.steps?.forEach((s) => { if (s.status === "running" || s.status === "pending") s.status = "done"; });
    _status = saved;
    saveStatus();
    logger.info({ from: saved.currentVersion, to: saved.latestVersion }, "Update completed after restart");
    void logEvent({
      level: "info",
      action: "server.update.completed",
      resourceType: "server",
      actor: "system:update",
      message: `Update completed: v${saved.currentVersion ?? "?"} → v${saved.latestVersion ?? "?"} is running`,
      details: { fromVersion: saved.currentVersion ?? null, toVersion: saved.latestVersion ?? null, toCommit: saved.latestCommit ?? null, train: saved.train ?? null },
    });
  } else if (saved && (saved.state === "complete" || saved.state === "failed")) {
    _status = saved;
  }
}

export function getUpdateStatus(): UpdateStatus {
  if (_env.imageMode) return _status.updateMethod === "image" ? { ..._status } : disabledStatus();
  if (!_env.available) return disabledStatus();
  return { ..._status, steps: _status.steps ? [..._status.steps] : undefined };
}

/** Redacted view for every signed-in user (the nav bar's update panel). */
export function getUpdateActivity(): { state: "idle" | "applying" | "restarting"; step?: string } {
  const s = getUpdateStatus();
  if (s.state !== "applying" && s.state !== "restarting") return { state: "idle" };
  const step = s.steps?.find((st) => st.status === "running")?.name || s.step;
  return step ? { state: s.state, step } : { state: s.state };
}

export function clearUpdateStatus(): void {
  _status = { state: "idle" };
  try { if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE); } catch { /* best effort */ }
}

export async function getRecentCommits(limit = 20): Promise<{ hash: string; date: string; subject: string }[]> {
  if (!_env.available) return [];
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  try {
    return (await git(["log", "-n", String(n), "--pretty=format:%h%x09%ad%x09%s", "--date=short"], 10_000))
      .split("\n").filter(Boolean).map((line) => {
        const [hash, date, ...rest] = line.split("\t");
        return { hash, date: date ?? "", subject: rest.join("\t") };
      });
  } catch {
    return [];
  }
}

/** Container install: compare this image's commit count with the published tag's. */
export async function checkImageForUpdates(fetchImpl?: typeof fetch): Promise<UpdateStatus> {
  const image = (process.env.CHARON_UPDATE_IMAGE || "").trim() || DEFAULT_UPDATE_IMAGE;
  const base = { ...disabledStatus(), updateMethod: "image" as const, image, checkedAt: new Date().toISOString() };
  const localCount = Number.parseInt(process.env.CHARON_BUILD_COMMIT_COUNT || "", 10);
  if (!Number.isFinite(localCount) || localCount <= 0) {
    return { ...base, note: "This image was built without a commit count (a local build?), so it can't be compared with the published image." };
  }
  let info;
  try {
    info = await fetchImageBuildInfo(image, fetchImpl);
  } catch (err: any) {
    logger.warn({ err: err?.message, image }, "Image update check failed");
    return { ...base, note: `Couldn't check ${image} for a newer image: ${err?.message ?? String(err)}` };
  }
  if (info.commitCount === null) return { ...base, note: `${image} doesn't say which build it is, so it can't be compared with this one.` };
  const behind = info.commitCount - localCount;
  return {
    state: behind > 0 ? "available" : "up-to-date",
    updateMethod: "image",
    image,
    checkedAt: base.checkedAt,
    currentVersion: getAppVersion(),
    latestVersion: `${readPackageMajorMinor()}.${info.commitCount}`,
    latestCommit: info.revision ? info.revision.slice(0, 7) : undefined,
    commitsBehind: Math.max(0, behind),
    method: _env.method,
    ...(info.source && /^https:\/\/github\.com\//.test(info.source) ? { source: info.source } : {}),
  };
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (_env.imageMode) return (_status = await checkImageForUpdates());
  if (!_env.available) return (_status = disabledStatus());
  if (_applying) return getUpdateStatus();

  const train = await getUpdateTrain();
  const haPair = await detectHaPair();
  _status = { state: "checking", currentVersion: getAppVersion(), train };
  try {
    await ensureUpdateRemote();
    await git(["fetch", "--all", "--tags", "--prune"], 60_000);

    let ref: string;
    let releaseTag: string | undefined;
    if (train === "release") {
      const tag = await latestReleaseTag();
      if (!tag) {
        return (_status = {
          state: "up-to-date", currentVersion: getAppVersion(), commitsBehind: 0, train, haPair,
          note: "No published releases yet. The release train will offer an update once the first release is tagged.",
        });
      }
      ref = tag;
      releaseTag = tag;
    } else {
      ref = await resolveNightlyRef();
    }

    const info = await computeTargetInfo(ref);
    if (info.currentCommit === info.latestCommit) {
      return (_status = {
        state: "up-to-date", currentVersion: getAppVersion(), currentCommit: info.currentCommit,
        checkoutCommit: info.checkoutCommit, latestCommit: info.latestCommit, latestVersion: info.version,
        commitsBehind: 0, train, releaseTag, haPair,
      });
    }
    const note = info.checkoutCommit !== info.currentCommit
      ? `This host's checkout is already at ${info.checkoutCommit}, ahead of the running build: an earlier update pulled the code but did not finish` +
        " installing, building and restarting it, so the previous version is still serving. Apply Update finishes that work."
      : undefined;
    return (_status = {
      state: "available", currentVersion: getAppVersion(), latestVersion: info.version,
      currentCommit: info.currentCommit, checkoutCommit: info.checkoutCommit, latestCommit: info.latestCommit,
      commitsBehind: info.commitsBehind, changes: info.changes, train, releaseTag, note, haPair,
    });
  } catch (err: any) {
    return (_status = { state: "failed", error: "Failed to check for updates: " + (err?.message || String(err)), currentVersion: getAppVersion(), train });
  }
}

/** Restart the whole charon.target, detached so it survives this process exiting. */
export function restartService(): void {
  spawn("systemd-run", ["--no-block", "systemctl", "restart", "charon.target"], { stdio: "ignore", detached: true }).unref();
}

function runStep(cmd: string, args: string[], timeout: number): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: APP_DIR, stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" && cmd === "npm" });
    let stderr = "";
    p.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    const t = setTimeout(() => { p.kill("SIGKILL"); rej(new Error(`${cmd} ${args.join(" ")} timed out after ${Math.round(timeout / 1000)}s`)); }, timeout);
    p.on("error", (e) => { clearTimeout(t); rej(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) res();
      else rej(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim().slice(-1500) || "no stderr"}`));
    });
  });
}

/**
 * Apply the available update in the background; the UI polls getUpdateStatus().
 * A failed pre-update backup aborts unless allowWithoutBackup (operator ticked
 * "proceed anyway") — migrations are not reversible.
 */
export async function applyUpdate(password?: string | null, allowWithoutBackup = false, actor = "system:update"): Promise<void> {
  if (!_env.available) { _status = disabledStatus(); return; }
  if (_applying) return;
  _applying = true;

  const train = await getUpdateTrain();
  const audit = {
    train, fromVersion: getAppVersion(), fromCommit: _status.currentCommit ?? null,
    toVersion: _status.latestVersion ?? null, toCommit: _status.latestCommit ?? null, allowWithoutBackup,
  };
  const pipelineStartedAt = Date.now();
  const steps: Step[] = [
    { name: "Backup database", status: "pending", message: "" },
    { name: "Pull latest code", status: "pending", message: "" },
    { name: "Install dependencies", status: "pending", message: "" },
    { name: "Generate Prisma client", status: "pending", message: "" },
    { name: "Build TypeScript", status: "pending", message: "" },
    { name: "Run migrations", status: "pending", message: "" },
    { name: "Restart service", status: "pending", message: "" },
  ];
  _status = {
    state: "applying", currentVersion: getAppVersion(), currentCommit: _status.currentCommit,
    latestVersion: _status.latestVersion, latestCommit: _status.latestCommit,
    commitsBehind: _status.commitsBehind, changes: _status.changes, train,
    startedAt: new Date().toISOString(), steps,
  };
  saveStatus();

  await logEvent({
    level: "info", action: "server.update.started", resourceType: "server", actor,
    message: `Update started (${train} train): v${audit.fromVersion}` + (audit.toVersion ? ` → v${audit.toVersion}` : "") +
      (allowWithoutBackup ? " (proceed-without-backup confirmed)" : ""),
    details: audit,
  });

  const setStep = (idx: number, status: Step["status"], message?: string) => {
    const now = Date.now();
    steps[idx].status = status;
    if (message) steps[idx].message = message;
    if (status === "running") steps[idx].startedAt = new Date(now).toISOString();
    else if (steps[idx].startedAt) steps[idx].durationMs = Math.max(0, now - Date.parse(steps[idx].startedAt!));
    _status.steps = steps;
    saveStatus();
  };
  const failUpdate = (idx: number, error: string) => {
    setStep(idx, "failed", error.slice(0, 1500));
    _status.state = "failed";
    _status.error = error;
    saveStatus();
    _applying = false;
    void logEvent({
      level: "error", action: "server.update.failed", resourceType: "server", actor,
      message: `Update failed at "${steps[idx].name}" (${Math.round((Date.now() - pipelineStartedAt) / 1000)}s into the update): ${error}`,
      details: { ...audit, step: steps[idx].name, steps: steps.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs ?? null })) },
    });
  };

  void (async () => {
    // ── 1. Backup ──
    setStep(0, "running");
    if (await getSkipBackup().catch(() => false)) {
      setStep(0, "done", "Backup skipped (disabled in settings)");
    } else {
      try {
        const { record } = await createBackup({ password: password && password.length > 0 ? password : null, kind: "pre-update", actor: "system:update" });
        _status.backupFile = record.filename;
        setStep(0, "done", `Backup created (${Math.round(record.size / 1024)} KB${record.encrypted ? ", encrypted" : ""})`);
      } catch (err: any) {
        const detail = err?.message || "pg_dump not available";
        if (!allowWithoutBackup) {
          failUpdate(0, `Pre-update backup failed: ${detail}. Fix the backup path, or re-run the update with "proceed without a backup" ticked if you accept the risk.`);
          return;
        }
        setStep(0, "failed", `Backup failed, proceeding anyway (operator override): ${detail}`);
      }
    }

    // ── 2. Pull ──
    setStep(1, "running");
    try {
      await ensureUpdateRemote();
      const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], 10_000)).trim();
      if (dirty) {
        throw new Error(`the checkout has local changes to tracked files (${dirty.split("\n").length}) — commit, stash or discard them on the host first`);
      }
      await git(["fetch", "--all", "--tags", "--prune"], 120_000);
      if (train === "release") {
        const tag = await latestReleaseTag();
        if (!tag) throw new Error("no release tag to update to");
        await git(["checkout", "--detach", tag], 60_000);
        setStep(1, "done", `Checked out ${tag}`);
      } else {
        const detached = (await git(["rev-parse", "--abbrev-ref", "HEAD"], 10_000)).trim() === "HEAD";
        if (detached) await git(["checkout", "main"], 60_000);
        await git(["pull", "--ff-only"], 120_000);
        setStep(1, "done", "Fast-forwarded");
      }
    } catch (err: any) {
      failUpdate(1, `git: ${err?.message ?? String(err)}`);
      return;
    }

    // ── 3-6. Install / generate / build / migrate ──
    const cmds: Array<[number, string, string[], number]> = [
      [2, "npm", ["ci", "--no-audit", "--no-fund"], 15 * 60_000],
      [3, "npx", ["prisma", "generate"], 5 * 60_000],
      [4, "npm", ["run", "build"], 10 * 60_000],
      [5, "npx", ["prisma", "migrate", "deploy"], 15 * 60_000],
    ];
    for (const [idx, cmd, args, timeout] of cmds) {
      setStep(idx, "running");
      try {
        await runStep(cmd, args, timeout);
        setStep(idx, "done");
      } catch (err: any) {
        failUpdate(idx, err?.message ?? String(err));
        return;
      }
    }

    // ── 7. Restart ──
    setStep(6, "running");
    if (!hasSystemd()) {
      failUpdate(6, "Built and migrated, but this host has no systemd to restart charon.target — restart the Charon processes manually to finish.");
      return;
    }
    _status.state = "restarting";
    saveStatus();
    await logEvent({
      level: "info", action: "server.update.applied", resourceType: "server", actor,
      message: `Update applied; restarting charon.target (${Math.round((Date.now() - pipelineStartedAt) / 1000)}s)`,
      details: audit,
    });
    // Let the UI poll see "restarting" before the process goes away.
    setTimeout(() => {
      try { restartService(); } catch (err: any) { logger.error({ err: err?.message }, "update: restart failed"); }
    }, 1500);
  })().catch((err) => {
    logger.error({ err }, "update pipeline crashed");
    _applying = false;
  });
}
