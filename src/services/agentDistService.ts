/**
 * src/services/agentDistService.ts — Serve prebuilt agent installers.
 *
 * Unlike polaris (which compiles its Go agent in-app), Charon's Tauri agent is
 * built in CI/release and dropped under data/agents/<version>/ with a
 * manifest.json. The Maintenance tab lists the available installers and serves
 * them; the cert-pin rotation pane lives alongside (see certPinService).
 *
 * manifest.json shape:
 *   { "version": "0.1.0", "files": [ { "platform": "windows", "arch": "x64",
 *     "filename": "Charon-Agent_0.1.0_x64-setup.exe", "sha256": "…" } ] }
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_DIST_DIR } from "../utils/paths.js";

export interface AgentFile {
  platform: string;
  arch: string;
  filename: string;
  sha256?: string;
}
export interface AgentManifest {
  version: string;
  files: AgentFile[];
}

function manifestPath(): string {
  return resolve(AGENT_DIST_DIR, "manifest.json");
}

export function getManifest(): AgentManifest | null {
  try {
    if (!existsSync(manifestPath())) return null;
    return JSON.parse(readFileSync(manifestPath(), "utf-8"));
  } catch {
    return null;
  }
}

/** Resolve a requested installer to an absolute path, or null if not allowed.
 *  Only files named in the manifest are servable (no path traversal). */
export function resolveInstaller(filename: string): string | null {
  const manifest = getManifest();
  if (!manifest) return null;
  const entry = manifest.files.find((f) => f.filename === filename);
  if (!entry) return null;
  const p = resolve(AGENT_DIST_DIR, manifest.version, filename);
  return existsSync(p) ? p : null;
}

/** List installers actually present on disk under the manifest version dir. */
export function listInstallers(): { manifest: AgentManifest | null; present: string[] } {
  const manifest = getManifest();
  let present: string[] = [];
  if (manifest) {
    const dir = resolve(AGENT_DIST_DIR, manifest.version);
    try { present = readdirSync(dir); } catch { present = []; }
  }
  return { manifest, present };
}
