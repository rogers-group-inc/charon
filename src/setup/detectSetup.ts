/**
 * src/setup/detectSetup.ts — Detect whether first-run setup is needed.
 *
 * Three states:
 *   - "configured":  DATABASE_URL is set → normal app boot
 *   - "needs-setup": DATABASE_URL missing AND no prior setup marker → show wizard
 *   - "locked":      DATABASE_URL missing BUT marker exists → refuse to run the
 *                    wizard (prevents a network attacker from reprovisioning a
 *                    previously-configured host if .env is deleted/corrupted)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SETUP_COMPLETE_MARKER } from "../utils/paths.js";

export type SetupState = "configured" | "needs-setup" | "locked";

export function getSetupState(): SetupState {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
    return "configured";
  }
  if (existsSync(SETUP_COMPLETE_MARKER)) return "locked";
  return "needs-setup";
}

/** Write the setup-complete marker if missing. Idempotent. */
export function markSetupComplete(): void {
  if (existsSync(SETUP_COMPLETE_MARKER)) return;
  try {
    mkdirSync(dirname(SETUP_COMPLETE_MARKER), { recursive: true });
    writeFileSync(
      SETUP_COMPLETE_MARKER,
      JSON.stringify({ configuredAt: new Date().toISOString() }, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    // Non-fatal: the marker is an extra safety net, not required for boot.
  }
}
