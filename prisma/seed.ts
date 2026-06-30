/**
 * prisma/seed.ts — Dev seed entry (run via tsx: `npm run db:seed`).
 *
 * Delegates to the shared seedDatabase() in src/cli/seed.ts so the dev and
 * container (compiled `node dist/cli/seed.js`) paths can't drift. Seeds built-in
 * Roles and, when CHARON_SEED_ADMIN_USER/PASSWORD are set, the first admin.
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { seedDatabase } from "../src/cli/seed.ts";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

seedDatabase(prisma)
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
