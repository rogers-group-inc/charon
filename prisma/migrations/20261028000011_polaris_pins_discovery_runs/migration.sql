-- CreateTable
CREATE TABLE "discovery_runs" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "integrationName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "actor" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "totalDevices" INTEGER,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedOfflineCount" INTEGER NOT NULL DEFAULT 0,
    "skippedErrorCount" INTEGER NOT NULL DEFAULT 0,
    "activeDevices" JSONB NOT NULL DEFAULT '[]',
    "slowAlerted" BOOLEAN NOT NULL DEFAULT false,
    "slowAlertedDevices" JSONB NOT NULL DEFAULT '[]',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "workerHeartbeatAt" TIMESTAMP(3),
    "scopeDeviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ssh_host_keys" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "keyType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ssh_host_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tls_cert_pins" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pending_fingerprint" TEXT,
    "pending_subject" TEXT,
    "pending_seen_at" TIMESTAMP(3),
    "repin_until" TIMESTAMP(3),

    CONSTRAINT "tls_cert_pins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discovery_runs_integrationId_key" ON "discovery_runs"("integrationId");

-- CreateIndex
CREATE INDEX "discovery_runs_status_idx" ON "discovery_runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ssh_host_keys_host_port_key" ON "ssh_host_keys"("host", "port");

-- CreateIndex
CREATE UNIQUE INDEX "tls_cert_pins_host_port_key" ON "tls_cert_pins"("host", "port");

