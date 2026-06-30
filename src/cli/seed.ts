/**
 * src/cli/seed.ts — Compiled seed entry (runs from the production image too).
 *
 * Seeds the built-in Roles and, when CHARON_SEED_ADMIN_USER /
 * CHARON_SEED_ADMIN_PASSWORD are set, the first administrator. Idempotent.
 *
 * Two entry points share this logic:
 *   - dev:        `npm run db:seed` → prisma/seed.ts (tsx) → seedDatabase()
 *   - container:  `node dist/cli/seed.js` (no tsx needed in the prod image)
 */

import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash as argonHash, Algorithm } from "@node-rs/argon2";
import { FUNCTION_KEYS, type AccessLevel } from "../api/middleware/permissions.js";

function matrix(fill: (key: string) => AccessLevel): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const def of FUNCTION_KEYS) out[def.key] = fill(def.key);
  return out;
}

const BUILTIN_ROLES = [
  { name: "Administrator", description: "Full control over Charon, including roles and enforcement.", color: "#dc2626", isProtected: true, permissions: matrix(() => "fullwrite") },
  {
    name: "Operator",
    description: "Day-to-day operations: endpoints, tags, policies, integrations. Cannot manage roles or flip enforcement live.",
    color: "#2563eb",
    isProtected: false,
    permissions: matrix((k) => {
      if (k === "roles") return "none";
      if (k === "enforcement") return "read";
      if (k === "users" || k === "apiTokens" || k === "serverSettingsData") return "read";
      return "write";
    }),
  },
  { name: "Read-Only", description: "View-only access to all surfaces.", color: "#6b7280", isProtected: false, permissions: matrix(() => "read") },
];

export async function seedDatabase(prisma: PrismaClient): Promise<void> {
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
      const passwordHash = await argonHash(adminPass, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      await prisma.user.create({ data: { username: adminUser, passwordHash, roleId: adminRole.id, authProvider: "local", displayName: adminUser } });
      console.log(`Created administrator "${adminUser}".`);
    }
  }
}

// Run when invoked directly (node dist/cli/seed.js).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("seed.js");
if (invokedDirectly) {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
  const prisma = new PrismaClient({ adapter });
  seedDatabase(prisma)
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
