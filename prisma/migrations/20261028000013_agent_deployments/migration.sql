-- CreateTable
CREATE TABLE "agent_deployments" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "os_platform" TEXT NOT NULL,
    "arch" TEXT,
    "transport" TEXT NOT NULL,
    "credential_id" TEXT,
    "directory_object_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "installer_filename" TEXT,
    "agent_version" TEXT,
    "invitation_code_id" TEXT,
    "endpoint_id" TEXT,
    "created_by" TEXT NOT NULL,
    "last_attempt_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployments_invitation_code_id_key" ON "agent_deployments"("invitation_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployments_endpoint_id_key" ON "agent_deployments"("endpoint_id");

-- CreateIndex
CREATE INDEX "agent_deployments_status_idx" ON "agent_deployments"("status");

-- CreateIndex
CREATE INDEX "agent_deployments_host_idx" ON "agent_deployments"("host");

-- AddForeignKey
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_invitation_code_id_fkey" FOREIGN KEY ("invitation_code_id") REFERENCES "invitation_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

