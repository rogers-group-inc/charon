-- DropIndex
DROP INDEX "group_mappings_group_key_idx";

-- DropIndex
DROP INDEX "group_mappings_group_key_role_id_key";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_last_step" INTEGER;

-- AlterTable
ALTER TABLE "group_mappings" ADD COLUMN     "description" TEXT,
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "group_label" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "user_passkeys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "aaguid" TEXT,
    "device_type" TEXT,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_passkeys_credential_id_key" ON "user_passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "user_passkeys_user_id_idx" ON "user_passkeys"("user_id");

-- CreateIndex
CREATE INDEX "group_mappings_provider_enabled_idx" ON "group_mappings"("provider", "enabled");

-- CreateIndex
CREATE INDEX "group_mappings_role_id_idx" ON "group_mappings"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_mappings_provider_group_key_key" ON "group_mappings"("provider", "group_key");

-- AddForeignKey
ALTER TABLE "user_passkeys" ADD CONSTRAINT "user_passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

