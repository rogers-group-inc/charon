/**
 * src/services/nginxApplyService.ts — Stage → validate → sudo-apply nginx.
 *
 * The app (unprivileged `charon` user) renders the config, writes it to a
 * staging path under the state dir, then invokes the privileged wrapper
 * (deploy/scripts/charon-nginx-apply.sh) via a scoped sudoers rule. The wrapper
 * runs `nginx -t` and only reloads on success, rolling back otherwise — so a
 * bad render can never take nginx down.
 *
 * Best-effort by design: in dev/Docker (no sudo/nginx) apply returns a clear
 * "skipped" result instead of throwing; callers that NEED a reload (Server
 * Settings → Web Server → Save & Apply) check isWrapperAvailable() first and
 * answer "not available in this deployment".
 */

import { execFile } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "../utils/paths.js";
import { renderNginxConfig, type NginxSettings } from "./nginxRenderer.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const WRAPPER = process.env.CHARON_NGINX_APPLY_SCRIPT || "/opt/charon/deploy/scripts/charon-nginx-apply.sh";

/** Where the wrapper installs the site (deploy/scripts/charon-nginx-apply.sh LIVE). */
export const LIVE_NGINX_CONF = "/etc/nginx/conf.d/charon.conf";

export interface ApplyResult {
  applied: boolean;
  skipped?: boolean;
  message: string;
  rendered: string;
}

export function isWrapperAvailable(): boolean {
  return existsSync(WRAPPER);
}

/** The live site config as nginx reads it, or null when unreadable/absent (Docker, dev). */
export async function readLiveNginxConfig(): Promise<string | null> {
  try {
    return await readFile(LIVE_NGINX_CONF, "utf8");
  } catch {
    return null;
  }
}

/**
 * Stage `contents` and run the wrapper. Returns the wrapper's exit status and
 * combined output (surfaced to the UI on failure). Throws only if the wrapper
 * is absent — callers gate on isWrapperAvailable().
 */
export async function applyNginxContents(contents: string): Promise<{ ok: boolean; output: string }> {
  if (!isWrapperAvailable()) throw new Error("nginx apply wrapper not present on this host");
  mkdirSync(STATE_DIR, { recursive: true });
  const staged = resolve(STATE_DIR, "charon.conf.staged");
  writeFileSync(staged, contents, "utf-8");
  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["-n", WRAPPER, staged], { timeout: 30_000 });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim() || "Applied and reloaded";
    logger.info({ output }, "nginx config applied");
    return { ok: true, output };
  } catch (err: any) {
    const output = [err?.stdout, err?.stderr].filter(Boolean).join("\n").trim() || err?.message || "apply failed";
    logger.error({ output }, "nginx apply failed");
    return { ok: false, output };
  }
}

export async function renderAndApply(settings: NginxSettings): Promise<ApplyResult> {
  const rendered = renderNginxConfig(settings);
  mkdirSync(STATE_DIR, { recursive: true });
  const staged = resolve(STATE_DIR, "charon.conf.staged");
  writeFileSync(staged, rendered, "utf-8");

  // No wrapper present (dev/Docker) → stage only.
  if (!isWrapperAvailable()) {
    logger.info({ staged }, "nginx apply wrapper not present — staged config only (dev/Docker)");
    return { applied: false, skipped: true, message: "Staged (no apply wrapper on this host)", rendered };
  }

  const r = await applyNginxContents(rendered);
  return r.ok
    ? { applied: true, message: r.output, rendered }
    : { applied: false, message: `Apply failed: ${r.output}`, rendered };
}
