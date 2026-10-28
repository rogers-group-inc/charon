-- Server Settings: Credentials tab (ported from polaris).
--
-- 1. credentials.createdBy — the ownership column for the `credentials`
--    function key (write = own rows, fullwrite = any). Nullable and NOT
--    backfilled: a NULL owner is unowned, which only fullwrite may touch.
-- 2. MIB database, manufacturer aliases and the editable manufacturer
--    profiles (metric rows, scoped override rows, custom widgets). Shapes
--    follow polaris's final schema minus the per-asset parts Charon has no
--    inventory for (MibFile.assetId, asset_custom_widget_enables) and the
--    deprecated `composition` columns.

-- ─── credentials ownership ───────────────────────────────────────────────────
ALTER TABLE "credentials" ADD COLUMN "createdBy" TEXT;

-- ─── manufacturer_aliases ────────────────────────────────────────────────────
CREATE TABLE "manufacturer_aliases" (
    "id"        TEXT NOT NULL,
    "alias"     TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturer_aliases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manufacturer_aliases_alias_key" ON "manufacturer_aliases"("alias");
CREATE INDEX "manufacturer_aliases_canonical_idx" ON "manufacturer_aliases"("canonical");

-- ─── mib_files ───────────────────────────────────────────────────────────────
CREATE TABLE "mib_files" (
    "id"           TEXT NOT NULL,
    "filename"     TEXT NOT NULL,
    "moduleName"   TEXT NOT NULL,
    "manufacturer" TEXT,
    "model"        TEXT,
    "contents"     TEXT NOT NULL,
    "imports"      TEXT[] DEFAULT ARRAY[]::TEXT[],
    "size"         INTEGER NOT NULL,
    "notes"        TEXT,
    "uploadedBy"   TEXT,
    "uploadedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mib_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mib_files_manufacturer_model_moduleName_key" ON "mib_files"("manufacturer", "model", "moduleName");
CREATE INDEX "mib_files_manufacturer_model_idx" ON "mib_files"("manufacturer", "model");
CREATE INDEX "mib_files_moduleName_idx" ON "mib_files"("moduleName");

-- ─── manufacturer_profiles ───────────────────────────────────────────────────
CREATE TABLE "manufacturer_profiles" (
    "id"           TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "matchPattern" TEXT,
    "widgetLayout" JSONB,
    "createdBy"    TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturer_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manufacturer_profiles_manufacturer_key" ON "manufacturer_profiles"("manufacturer");

-- ─── manufacturer_profile_metrics ────────────────────────────────────────────
CREATE TABLE "manufacturer_profile_metrics" (
    "id"                   TEXT NOT NULL,
    "profileId"            TEXT NOT NULL,
    "metricKey"            TEXT NOT NULL,
    "defaultSymbol"        TEXT,
    "defaultAggregate"     TEXT NOT NULL DEFAULT 'none',
    "defaultLabel"         TEXT,
    "defaultParsePattern"  TEXT,
    "defaultParseTemplate" TEXT,
    "defaultSensorColumns" JSONB,
    "defaultMibId"         TEXT,
    "defaultMibStdKey"     TEXT,
    "defaultType"          TEXT NOT NULL DEFAULT 'scalar',
    "defaultTransform"     TEXT,
    "defaultSymbolB"       TEXT,

    CONSTRAINT "manufacturer_profile_metrics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manufacturer_profile_metrics_profileId_metricKey_key" ON "manufacturer_profile_metrics"("profileId", "metricKey");
CREATE INDEX "manufacturer_profile_metrics_defaultMibId_idx" ON "manufacturer_profile_metrics"("defaultMibId");
ALTER TABLE "manufacturer_profile_metrics"
    ADD CONSTRAINT "manufacturer_profile_metrics_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "manufacturer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manufacturer_profile_metrics"
    ADD CONSTRAINT "manufacturer_profile_metrics_defaultMibId_fkey"
    FOREIGN KEY ("defaultMibId") REFERENCES "mib_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── manufacturer_profile_metric_overrides ───────────────────────────────────
CREATE TABLE "manufacturer_profile_metric_overrides" (
    "id"            TEXT NOT NULL,
    "metricRowId"   TEXT NOT NULL,
    "assetType"     TEXT,
    "modelPattern"  TEXT,
    "symbol"        TEXT NOT NULL,
    "aggregate"     TEXT NOT NULL DEFAULT 'none',
    "label"         TEXT,
    "parsePattern"  TEXT,
    "parseTemplate" TEXT,
    "sensorColumns" JSONB,
    "mibId"         TEXT,
    "mibStdKey"     TEXT,
    "type"          TEXT NOT NULL DEFAULT 'scalar',
    "transform"     TEXT,
    "symbolB"       TEXT,
    "order"         INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "manufacturer_profile_metric_overrides_pkey" PRIMARY KEY ("id"),
    -- A row is scoped by a device type, a model pattern, or both — never neither.
    CONSTRAINT "manufacturer_profile_metric_overrides_scope_check"
        CHECK ("assetType" IS NOT NULL OR "modelPattern" IS NOT NULL)
);
CREATE INDEX "manufacturer_profile_metric_overrides_metricRowId_order_idx" ON "manufacturer_profile_metric_overrides"("metricRowId", "order");
CREATE INDEX "manufacturer_profile_metric_overrides_metricRowId_assetType_idx" ON "manufacturer_profile_metric_overrides"("metricRowId", "assetType");
CREATE INDEX "manufacturer_profile_metric_overrides_mibId_idx" ON "manufacturer_profile_metric_overrides"("mibId");
-- One device-type default per (metric row, type). Partial, so any number of
-- per-model exceptions may sit under the same type.
CREATE UNIQUE INDEX "mfg_profile_metric_overrides_type_default_key"
    ON "manufacturer_profile_metric_overrides"("metricRowId", "assetType")
    WHERE "modelPattern" IS NULL;
ALTER TABLE "manufacturer_profile_metric_overrides"
    ADD CONSTRAINT "manufacturer_profile_metric_overrides_metricRowId_fkey"
    FOREIGN KEY ("metricRowId") REFERENCES "manufacturer_profile_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manufacturer_profile_metric_overrides"
    ADD CONSTRAINT "manufacturer_profile_metric_overrides_mibId_fkey"
    FOREIGN KEY ("mibId") REFERENCES "mib_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── manufacturer_custom_widgets ─────────────────────────────────────────────
CREATE TABLE "manufacturer_custom_widgets" (
    "id"             TEXT NOT NULL,
    "profileId"      TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "symbol"         TEXT,
    "mibId"          TEXT,
    "type"           TEXT NOT NULL DEFAULT 'scalar',
    "widgetType"     TEXT NOT NULL,
    "httpCheck"      JSONB,
    "credentialId"   TEXT,
    "transform"      TEXT,
    "displayOptions" JSONB NOT NULL DEFAULT '{}',
    "order"          INTEGER NOT NULL DEFAULT 0,
    "modelPattern"   TEXT,
    "stateMap"       JSONB,
    "labelSymbol"    TEXT,
    "createdBy"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturer_custom_widgets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "manufacturer_custom_widgets_profileId_order_idx" ON "manufacturer_custom_widgets"("profileId", "order");
CREATE INDEX "manufacturer_custom_widgets_mibId_idx" ON "manufacturer_custom_widgets"("mibId");
CREATE INDEX "manufacturer_custom_widgets_credentialId_idx" ON "manufacturer_custom_widgets"("credentialId");
ALTER TABLE "manufacturer_custom_widgets"
    ADD CONSTRAINT "manufacturer_custom_widgets_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "manufacturer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT (Prisma's default for a required-less relation without onDelete):
-- a MIB a widget walks cannot be deleted out from under it.
ALTER TABLE "manufacturer_custom_widgets"
    ADD CONSTRAINT "manufacturer_custom_widgets_mibId_fkey"
    FOREIGN KEY ("mibId") REFERENCES "mib_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- SET NULL: losing a credential leaves the check in place, failing loudly.
ALTER TABLE "manufacturer_custom_widgets"
    ADD CONSTRAINT "manufacturer_custom_widgets_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
