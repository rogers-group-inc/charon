/**
 * src/index.ts — Application entry point.
 *
 * Checks if the host needs first-run setup (no DATABASE_URL). If so, starts the
 * lightweight setup wizard (web/all only). The one-shot `migrate` role runs
 * migrations and exits; worker roles require a configured DB. Otherwise the
 * full app boots via app.ts.
 */

import { execFileSync } from "node:child_process";
import { getSetupState, markSetupComplete } from "./setup/detectSetup.js";
import { getRole, isMigrateOnly } from "./utils/role.js";

(async () => {
  const state = getSetupState();
  const role = getRole();

  // The one-shot migrate role: apply schema, then exit 0 so the systemd/compose
  // ordering (migrate → web/endpoint/...) is satisfied.
  if (isMigrateOnly(role)) {
    if (state !== "configured") {
      console.error("ERROR: CHARON_ROLE=migrate requires DATABASE_URL to be configured.");
      process.exit(1);
    }
    execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit" });
    console.log("Migrations applied. Exiting (one-shot migrate role).");
    process.exit(0);
  }

  // Non-web worker roles can't run the unauthenticated wizard and require the DB
  // to already be provisioned.
  if ((role === "endpoint" || role === "enforcer" || role === "worker") && state !== "configured") {
    console.error(`ERROR: CHARON_ROLE=${role} requires DATABASE_URL to be configured already.`);
    console.error("Run first-run setup on the web node (or set DATABASE_URL), then start this process.");
    process.exit(1);
  }

  if (state === "locked") {
    console.error("ERROR: DATABASE_URL is missing but this host is already configured");
    console.error("(.setup-complete is present). Restore .env or pass DATABASE_URL via the environment.");
    process.exit(1);
  }

  if (state === "needs-setup") {
    const { startSetupServer } = await import("./setup/setupServer.js");
    startSetupServer();
    return;
  }

  markSetupComplete();
  const { startApp } = await import("./app.js");
  await startApp();
})();
