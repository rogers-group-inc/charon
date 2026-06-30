/**
 * prisma/seed.ts — Idempotent first-run seed.
 *
 * Seeds the built-in Roles (with their permission matrices) and, when
 * CHARON_SEED_ADMIN_USER / CHARON_SEED_ADMIN_PASSWORD are present (the first-run
 * wizard passes them), the first administrator account. Safe to re-run: roles
 * are upserted by name; the admin is created only if absent.
 *
 * Run: npm run db:seed  (or invoked by src/setup/setupRoutes.ts at finalize).
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash as argonHash, Algorithm } from "@node-rs/argon2";
import { FUNCTION_KEYS, type AccessLevel } from "../src/api/middleware/permissions.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

function matrix(fill: (key: string) => AccessLevel): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const def of FUNCTION_KEYS) out[def.key] = fill(def.key);
  return out;
}

const BUILTIN_ROLES = [
  {
    name: "Administrator",
    description: "Full control over Charon, including roles and enforcement.",
    color: "#dc2626",
    isProtected: true,
    permissions: matrix(() => "fullwrite"),
  },
  {
    name: "Operator",
    description: "Day-to-day operations: endpoints, tags, policies, integrations. Cannot manage roles or flip enforcement live.",
    color: "#2563eb",
    isProtected: false,
    permissions: matrix((k) => {
      if (k === "roles") return "none";
      if (k === "enforcement") return "read"; // viewing dry-run is fine; flipping to live requires Admin
      if (k === "users" || k === "apiTokens" || k === "serverSettingsData") return "read";
      return "write";
    }),
  },
  {
    name: "Read-Only",
    description: "View-only access to all surfaces.",
    color: "#6b7280",
    isProtected: false,
    permissions: matrix(() => "read"),
  },
];

async function main() {
  for (const r of BUILTIN_ROLES) {
    await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description, color: r.color, permissions: r.permissions, isBuiltIn: true, isProtected: r.isProtected },
      create: { name: r.name, description: r.description, color: r.color, permissions: r.permissions, isBuiltIn: true, isProtected: r.isProtected },
    });
  }
  console.log(`Seeded ${BUILTIN_ROLES.length} built-in roles.`);

  const adminUser = process.env.CHARON_SEED_ADMIN_USER?.trim();
  const adminPass = process.env.CHARON_SEED_ADMIN_PASSWORD;
  if (adminUser && adminPass) {
    const existing = await prisma.user.findUnique({ where: { username: adminUser } });
    if (existing) {
      console.log(`Admin "${adminUser}" already exists — skipping.`);
    } else {
      const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "Administrator" } });
      const passwordHash = await argonHash(adminPass, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      await prisma.user.create({
        data: { username: adminUser, passwordHash, roleId: adminRole.id, authProvider: "local", displayName: adminUser },
      });
      console.log(`Created administrator "${adminUser}".`);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
