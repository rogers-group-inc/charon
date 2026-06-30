/**
 * src/utils/version.ts — App version derivation.
 *
 * Version format: `<major>.<minor>.<patch>` where major+minor come from
 * package.json's `version` field and patch is the git commit count, so the
 * version always identifies the exact commit running.
 *
 * Resolution order for the patch:
 *   1. CHARON_BUILD_COMMIT_COUNT env var — set by the Dockerfile from a build
 *      arg, since the runtime container has no .git directory to inspect.
 *   2. `git rev-list --count HEAD` — the RHEL prod / dev fallback where the
 *      running tree is a real git checkout.
 *   3. "0" — last-resort fallback when neither is available.
 *
 * Computed once at module load and cached, since the answer never changes for
 * the life of the process.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageMajorMinor(): { majorMinor: string; raw: string } {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../package.json", "../../../package.json"]) {
      const p = join(here, rel);
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      const raw: string = pkg.version || "0.1.0";
      const [major, minor] = raw.split(".");
      return { majorMinor: `${major}.${minor}`, raw };
    }
  } catch {}
  return { majorMinor: "0.1", raw: "0.1.0" };
}

function resolvePatch(): string {
  const baked = process.env.CHARON_BUILD_COMMIT_COUNT;
  if (baked && /^\d+$/.test(baked.trim())) return baked.trim();
  try {
    return execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "0";
  }
}

const APP_VERSION = (() => {
  const { majorMinor } = readPackageMajorMinor();
  return `${majorMinor}.${resolvePatch()}`;
})();

export function getAppVersion(): string {
  return APP_VERSION;
}
