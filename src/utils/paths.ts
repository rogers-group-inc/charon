/**
 * src/utils/paths.ts — Resolve where Charon's persistent state lives on disk.
 *
 * Single opt-in env var: CHARON_STATE_DIR.
 *   - Unset (RHEL prod, dev): falls back to the project root, so .env,
 *     .setup-complete, data/backups/, and public/uploads/ stay where they live
 *     on a git-checkout install.
 *   - Set (Docker image): redirects all state under one directory so the
 *     container needs a single bind mount. The Dockerfile pins this to
 *     /app/state.
 *
 * Layout under STATE_DIR:
 *   .env
 *   .setup-complete
 *   data/backups/
 *   data/agents/          prebuilt Tauri installers (MSI/pkg/AppImage) + manifest
 *   public/uploads/       branding logo, etc.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STATE_DIR = process.env.CHARON_STATE_DIR
  ? resolve(process.env.CHARON_STATE_DIR)
  : PROJECT_ROOT;

export const ENV_FILE = resolve(STATE_DIR, ".env");
export const SETUP_COMPLETE_MARKER = resolve(STATE_DIR, ".setup-complete");
export const BACKUP_DIR = resolve(STATE_DIR, "data", "backups");
export const UPLOADS_DIR = resolve(STATE_DIR, "public", "uploads");

// Prebuilt endpoint-agent installers. Unlike polaris (which compiles its Go
// agent in-app), Charon's Tauri agent is built in CI/release; the release
// tarball drops per-platform installers under data/agents/<version>/ plus a
// manifest.json the Maintenance tab serves from. Preserved across self-updates.
export const AGENT_DIST_DIR = resolve(STATE_DIR, "data", "agents");
