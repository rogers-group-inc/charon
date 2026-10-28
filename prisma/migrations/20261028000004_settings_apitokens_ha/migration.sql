-- Server Settings: API Tokens (role binding + trusted hosts) + HA enrollment.

-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN "role_id" TEXT;
ALTER TABLE "api_tokens" ADD COLUMN "trusted_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "api_tokens_role_id_idx" ON "api_tokens"("role_id");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ha_enrollments" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "node_name" TEXT NOT NULL,
    "node_addr" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "request_id_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "registered_from_ip" TEXT,
    "registered_node_name" TEXT,
    "ssh_host_key_fingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "registered_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ha_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ha_enrollments_request_id_hash_key" ON "ha_enrollments"("request_id_hash");

-- CreateIndex
CREATE INDEX "ha_enrollments_token_prefix_idx" ON "ha_enrollments"("token_prefix");

-- CreateIndex
CREATE INDEX "ha_enrollments_status_idx" ON "ha_enrollments"("status");
