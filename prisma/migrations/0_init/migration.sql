-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EndpointStatus" AS ENUM ('pending', 'enrolled', 'online', 'offline', 'revoked');

-- CreateEnum
CREATE TYPE "PostureState" AS ENUM ('unknown', 'compliant', 'noncompliant');

-- CreateEnum
CREATE TYPE "AuthMode" AS ENUM ('local', 'saml', 'oidc');

-- CreateEnum
CREATE TYPE "TagSourceKind" AS ENUM ('directory_group', 'directory_ou', 'custom_group', 'posture');

-- CreateEnum
CREATE TYPE "DirectoryObjectKind" AS ENUM ('user', 'group', 'ou');

-- CreateEnum
CREATE TYPE "EnforcementMode" AS ENUM ('dry_run', 'enforce');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('pending', 'in_sync', 'drift', 'error', 'dry_run');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT,
    "role_id" TEXT NOT NULL,
    "auth_provider" TEXT NOT NULL DEFAULT 'local',
    "azure_oid" TEXT,
    "oidc_subject" TEXT,
    "ldap_uid" TEXT,
    "sso_groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "display_name" TEXT,
    "email" TEXT,
    "last_login" TIMESTAMP(3),
    "totp_secret" TEXT,
    "totp_enabled_at" TIMESTAMP(3),
    "totp_backup_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "needs_role_review" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_mappings" (
    "id" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoDiscover" BOOLEAN NOT NULL DEFAULT true,
    "pollInterval" INTEGER NOT NULL DEFAULT 4,
    "enforcement_mode" "EnforcementMode" NOT NULL DEFAULT 'dry_run',
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastDiscoveryAt" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_codes" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "code_hash" TEXT NOT NULL,
    "code_prefix" TEXT NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "invitation_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoints" (
    "id" TEXT NOT NULL,
    "hostname" TEXT,
    "status" "EndpointStatus" NOT NULL DEFAULT 'pending',
    "os_platform" TEXT,
    "os_version" TEXT,
    "arch" TEXT,
    "agent_version" TEXT,
    "current_ip" TEXT,
    "current_mac" TEXT,
    "bound_user_key" TEXT,
    "bound_user_name" TEXT,
    "bound_at" TIMESTAMP(3),
    "posture" JSONB NOT NULL DEFAULT '{}',
    "posture_state" "PostureState" NOT NULL DEFAULT 'unknown',
    "posture_at" TIMESTAMP(3),
    "invitation_code_id" TEXT,
    "bearer_hash" TEXT,
    "bearer_prefix" TEXT,
    "bearer_issued_at" TIMESTAMP(3),
    "bearer_revoked_at" TIMESTAMP(3),
    "server_cert_fingerprint" TEXT,
    "additional_cert_fingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_seen_at" TIMESTAMP(3),
    "last_seen_ip" TEXT,
    "ws_connected_at" TIMESTAMP(3),
    "ws_disconnected_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_objects" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "kind" "DirectoryObjectKind" NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identifier" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "parent_ou" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "members" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rules" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_sources" (
    "id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "kind" "TagSourceKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "custom_group_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoint_tags" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "endpoint_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tag_id" TEXT NOT NULL,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enforcement_state" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_name" TEXT NOT NULL,
    "endpoint_id" TEXT,
    "desired" JSONB NOT NULL DEFAULT '{}',
    "actual" JSONB NOT NULL DEFAULT '{}',
    "status" "SyncStatus" NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "last_applied_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enforcement_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_sessions" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "user_key" TEXT NOT NULL,
    "user_name" TEXT,
    "ip" TEXT,
    "mode" "AuthMode" NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "verification_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "levelRank" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "actor" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_azure_oid_key" ON "users"("azure_oid");

-- CreateIndex
CREATE UNIQUE INDEX "users_oidc_subject_key" ON "users"("oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_ldap_uid_key" ON "users"("ldap_uid");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- CreateIndex
CREATE INDEX "group_mappings_group_key_idx" ON "group_mappings"("group_key");

-- CreateIndex
CREATE UNIQUE INDEX "group_mappings_group_key_role_id_key" ON "group_mappings"("group_key", "role_id");

-- CreateIndex
CREATE INDEX "integrations_type_idx" ON "integrations"("type");

-- CreateIndex
CREATE INDEX "integrations_enabled_idx" ON "integrations"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_name_key" ON "credentials"("name");

-- CreateIndex
CREATE INDEX "credentials_type_idx" ON "credentials"("type");

-- CreateIndex
CREATE INDEX "invitation_codes_code_prefix_idx" ON "invitation_codes"("code_prefix");

-- CreateIndex
CREATE INDEX "endpoints_status_idx" ON "endpoints"("status");

-- CreateIndex
CREATE INDEX "endpoints_bearer_prefix_idx" ON "endpoints"("bearer_prefix");

-- CreateIndex
CREATE INDEX "endpoints_current_ip_idx" ON "endpoints"("current_ip");

-- CreateIndex
CREATE INDEX "endpoints_bound_user_key_idx" ON "endpoints"("bound_user_key");

-- CreateIndex
CREATE INDEX "directory_objects_kind_idx" ON "directory_objects"("kind");

-- CreateIndex
CREATE INDEX "directory_objects_identifier_idx" ON "directory_objects"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "directory_objects_integration_id_kind_external_id_key" ON "directory_objects"("integration_id", "kind", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_groups_name_key" ON "custom_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "tag_sources_kind_ref_idx" ON "tag_sources"("kind", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "tag_sources_tag_id_kind_ref_key" ON "tag_sources"("tag_id", "kind", "ref");

-- CreateIndex
CREATE INDEX "endpoint_tags_tag_id_idx" ON "endpoint_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "endpoint_tags_endpoint_id_tag_id_key" ON "endpoint_tags"("endpoint_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_name_key" ON "policies"("name");

-- CreateIndex
CREATE INDEX "policies_tag_id_idx" ON "policies"("tag_id");

-- CreateIndex
CREATE INDEX "enforcement_state_status_idx" ON "enforcement_state"("status");

-- CreateIndex
CREATE INDEX "enforcement_state_integration_id_idx" ON "enforcement_state"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "enforcement_state_integration_id_object_type_object_name_key" ON "enforcement_state"("integration_id", "object_type", "object_name");

-- CreateIndex
CREATE INDEX "verification_sessions_endpoint_id_idx" ON "verification_sessions"("endpoint_id");

-- CreateIndex
CREATE INDEX "verification_sessions_user_key_idx" ON "verification_sessions"("user_key");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_name_key" ON "api_tokens"("name");

-- CreateIndex
CREATE INDEX "api_tokens_token_prefix_idx" ON "api_tokens"("token_prefix");

-- CreateIndex
CREATE INDEX "api_tokens_revokedAt_idx" ON "api_tokens"("revokedAt");

-- CreateIndex
CREATE INDEX "events_timestamp_idx" ON "events"("timestamp");

-- CreateIndex
CREATE INDEX "events_action_idx" ON "events"("action");

-- CreateIndex
CREATE INDEX "events_resourceType_idx" ON "events"("resourceType");

-- CreateIndex
CREATE INDEX "events_level_idx" ON "events"("level");

-- CreateIndex
CREATE INDEX "events_levelRank_timestamp_idx" ON "events"("levelRank", "timestamp");

-- CreateIndex
CREATE INDEX "events_actor_timestamp_idx" ON "events"("actor", "timestamp");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_mappings" ADD CONSTRAINT "group_mappings_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_invitation_code_id_fkey" FOREIGN KEY ("invitation_code_id") REFERENCES "invitation_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_objects" ADD CONSTRAINT "directory_objects_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_sources" ADD CONSTRAINT "tag_sources_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_sources" ADD CONSTRAINT "tag_sources_custom_group_id_fkey" FOREIGN KEY ("custom_group_id") REFERENCES "custom_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoint_tags" ADD CONSTRAINT "endpoint_tags_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoint_tags" ADD CONSTRAINT "endpoint_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_state" ADD CONSTRAINT "enforcement_state_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_state" ADD CONSTRAINT "enforcement_state_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

