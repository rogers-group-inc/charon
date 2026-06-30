/**
 * src/db.ts — Prisma client singleton.
 *
 * Import `prisma` from this module instead of instantiating PrismaClient
 * directly, so the connection pool is shared across the process. Queries run
 * through `@prisma/adapter-pg` (a `pg.Pool`); DATABASE_POOL_SIZE tunes the
 * pool max per process — important once roles split (web + endpoint + enforcer
 * + worker each hold their own pool against the same Postgres).
 */

import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

// The driver-adapter's default pool max is 10 — undersized once you sum HTTP
// handlers + agent WS + pg-boss consumers. DATABASE_POOL_SIZE lets operators
// raise it without editing code; 25 is a safe default.
function resolveDatabasePoolSize(): number {
  const raw = process.env.DATABASE_POOL_SIZE;
  if (!raw) return 25;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 25;
  return n;
}

const g = globalThis as unknown as { prisma: PrismaClient };

function buildClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "",
    max: resolveDatabasePoolSize(),
  });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = g.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") {
  g.prisma = prisma;
}
