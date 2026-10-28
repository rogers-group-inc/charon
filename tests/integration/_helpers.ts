/**
 * tests/integration/_helpers.ts
 *
 * Shared scaffolding for the DB-backed integration suites (ported from polaris,
 * trimmed to the DB probe):
 *   - dbReachable: probes DATABASE_URL at module load. When the DB is
 *     unreachable, suites use `describe.skip` so vitest reports them as
 *     skipped rather than red on sandboxed / offline runs.
 *
 * Charon guard: these suites delete the rows they touch, so they only ever run
 * against a database whose name ends in `_test` (e.g. `charon_test`). Pointed at
 * a dev stack's own database they would wipe the data an operator is looking at;
 * any other name skips with a warning instead. See charon-worktree-workflow →
 * dev-environment.md for creating `charon_test`.
 */

import { describe } from "vitest";
import { prisma } from "../../src/db.js";

/** The database name in DATABASE_URL, or null when it can't be parsed. */
function databaseName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

const dbName = databaseName(process.env.DATABASE_URL);
const isTestDb = dbName !== null && dbName.endsWith("_test");

/** True when DATABASE_URL names a `*_test` database AND it answers a trivial SELECT. */
export const dbReachable: boolean = await (async () => {
  if (!process.env.DATABASE_URL) return false;
  if (!isTestDb) {
    // eslint-disable-next-line no-console
    console.warn(`[integration tests] DATABASE_URL names "${dbName ?? "?"}", not a *_test database — DB suites skip so they cannot wipe a dev database.`);
    return false;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    // Surface the real failure: without this, "DB down" and "DB up but the
    // probe crashed" look identical (suites silently skip either way).
    // eslint-disable-next-line no-console
    console.error("[integration tests] DATABASE_URL is set but the probe failed:", err);
    return false;
  }
})();

/** Use this in place of `describe` to make a suite skip cleanly when the DB is unreachable. */
export const dbDescribe: typeof describe = dbReachable ? describe : describe.skip;
