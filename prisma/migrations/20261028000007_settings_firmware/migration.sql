-- Server Settings → Repository: the firmware image repository, ported from
-- polaris (migrations 20260925000000_firmware_repository,
-- 20261006010000_firmware_fortigate, 20261023000000_firmware_pair_per_platform),
-- folded into their final shape. Two tables:
--
--   firmware_images              one uploaded .out, filed under a
--                                manufacturer › device type › model node; its
--                                PLATFORM (the header's serial-prefix token)
--                                owns a primary / backup pair.
--   firmware_credential_bindings which device-admin login (or FortiGate API
--                                token) applies at a manufacturer, a device
--                                type, or a model.
--
-- Charon adaptations: no firmware_upgrade_runs (no Asset inventory, no
-- executor), and credential_id carries no FK — the binding references a
-- Credential loosely and treats a dangling id as stale.
--
-- The constraints below the CREATE TABLEs are the parts Prisma cannot express:
-- CHECKs and PARTIAL unique indexes. They ARE the rules, so they live here.

CREATE TABLE "firmware_images" (
    "id"            TEXT NOT NULL,
    "manufacturer"  TEXT NOT NULL,
    "asset_type"    TEXT NOT NULL,
    "model"         TEXT NOT NULL,
    "platform"      TEXT,
    "version_major" INTEGER,
    "version_minor" INTEGER,
    "version_patch" INTEGER,
    "build"         INTEGER,
    "version_label" TEXT NOT NULL,
    "parsed_from"   TEXT NOT NULL,
    "role"          TEXT NOT NULL DEFAULT 'primary',
    "filename"      TEXT NOT NULL,
    "size_bytes"    INTEGER NOT NULL,
    "sha256"        TEXT NOT NULL,
    "storage_path"  TEXT NOT NULL,
    "notes"         TEXT,
    "uploaded_by"   TEXT,
    "uploaded_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firmware_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "firmware_images_sha256_key" ON "firmware_images"("sha256");
CREATE INDEX "firmware_images_manufacturer_asset_type_platform_idx" ON "firmware_images"("manufacturer", "asset_type", "platform");
CREATE INDEX "firmware_images_manufacturer_asset_type_model_idx" ON "firmware_images"("manufacturer", "asset_type", "model");

ALTER TABLE "firmware_images"
    ADD CONSTRAINT "firmware_images_asset_type_check"
    CHECK ("asset_type" IN ('switch', 'access_point', 'firewall'));
-- 'swapping' exists only INSIDE the make-primary transaction: the partial
-- unique indexes below are checked per statement, so swapping two roles needs
-- a third value to step through. No row ever commits with it.
ALTER TABLE "firmware_images"
    ADD CONSTRAINT "firmware_images_role_check"
    CHECK ("role" IN ('primary', 'backup', 'swapping'));
-- The two-image cap: one primary and one backup per PLATFORM under a model
-- node. An image with no recognised platform (NULL) shares one pair per node.
CREATE UNIQUE INDEX "firmware_images_primary_key"
    ON "firmware_images"("manufacturer", "asset_type", "model", (COALESCE("platform", ''))) WHERE "role" = 'primary';
CREATE UNIQUE INDEX "firmware_images_backup_key"
    ON "firmware_images"("manufacturer", "asset_type", "model", (COALESCE("platform", ''))) WHERE "role" = 'backup';

CREATE TABLE "firmware_credential_bindings" (
    "id"            TEXT NOT NULL,
    "manufacturer"  TEXT NOT NULL,
    "asset_type"    TEXT,
    "model"         TEXT,
    "source"        TEXT NOT NULL DEFAULT 'credential',
    "credential_id" TEXT,
    "created_by"    TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firmware_credential_bindings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "firmware_credential_bindings_manufacturer_asset_type_model_idx" ON "firmware_credential_bindings"("manufacturer", "asset_type", "model");

-- A model node lives under a device type, and the type is one of the three.
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_scope_check"
    CHECK ("model" IS NULL OR "asset_type" IS NOT NULL);
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_type_check"
    CHECK ("asset_type" IS NULL OR "asset_type" IN ('switch', 'access_point', 'firewall'));
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_source_check"
    CHECK ("source" IN ('credential', 'integration-token'));
-- The integration's token signs in to a FortiGate and nothing else, and it is
-- not a Credential: no row to point at.
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_token_scope_check"
    CHECK ("source" = 'credential' OR ("asset_type" = 'firewall' AND "credential_id" IS NULL));
-- One binding per tree node. NULLs are distinct in a plain unique index, so
-- each scope shape gets its own partial index.
CREATE UNIQUE INDEX "firmware_bindings_manufacturer_key"
    ON "firmware_credential_bindings"("manufacturer") WHERE "asset_type" IS NULL;
CREATE UNIQUE INDEX "firmware_bindings_type_key"
    ON "firmware_credential_bindings"("manufacturer", "asset_type") WHERE "asset_type" IS NOT NULL AND "model" IS NULL;
CREATE UNIQUE INDEX "firmware_bindings_model_key"
    ON "firmware_credential_bindings"("manufacturer", "asset_type", "model") WHERE "model" IS NOT NULL;
