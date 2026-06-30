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
 * "skipped" result instead of throwing, so the Certificates tab still works for
 * storing the cert + computing the agent pin.
 */

import { execFile } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "../utils/paths.js";
import { renderNginxConfig, type NginxSettings } from "./nginxRenderer.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const WRAPPER = process.env.CHARON_NGINX_APPLY_SCRIPT || "/opt/charon/deploy/scripts/charon-nginx-apply.sh";

export interface ApplyResult {
  applied: boolean;
  skipped?: boolean;
  message: string;
  rendered: string;
}

export async function renderAndApply(settings: NginxSettings): Promise<ApplyResult> {
  const rendered = renderNginxConfig(settings);
  const staged = resolve(STATE_DIR, "charon.conf.staged");
  writeFileSync(staged, rendered, "utf-8");

  // No wrapper present (dev/Docker) → stage only.
  if (!existsSync(WRAPPER)) {
    logger.info({ staged }, "nginx apply wrapper not present — staged config only (dev/Docker)");
    return { applied: false, skipped: true, message: "Staged (no apply wrapper on this host)", rendered };
  }

  try {
    const { stdout } = await execFileAsync("sudo", ["-n", WRAPPER, staged], { timeout: 30_000 });
    logger.info({ stdout: stdout.trim() }, "nginx config applied");
    return { applied: true, message: stdout.trim() || "Applied and reloaded", rendered };
  } catch (err: any) {
    logger.error({ err: err?.stderr || err?.message }, "nginx apply failed");
    return { applied: false, message: `Apply failed: ${err?.stderr || err?.message}`, rendered };
  }
}
