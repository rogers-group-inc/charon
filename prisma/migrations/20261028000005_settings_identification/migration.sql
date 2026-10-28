-- Server Settings: Identification tab (ported from polaris).
-- Asset-tag registry, device-type registry (with the built-in seeds) and
-- operator-uploaded device icons. DNS / OUI / placeholder-MAC settings live in
-- the existing "settings" key/value table and need no DDL.

-- CreateTable
CREATE TABLE "asset_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "color" TEXT NOT NULL DEFAULT '#4fc3f7',
    "asset_condition" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_tags_name_key" ON "asset_tags"("name");
CREATE INDEX "asset_tags_category_idx" ON "asset_tags"("category");

-- CreateTable
CREATE TABLE "asset_type_defs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "match_rules" JSONB,
    "match_contexts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "match_priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_type_defs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_type_defs_name_key" ON "asset_type_defs"("name");

-- CreateTable
CREATE TABLE "device_icons" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_icons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_icons_scope_key_key" ON "device_icons"("scope", "key");
CREATE INDEX "device_icons_scope_idx" ON "device_icons"("scope");

-- Seed the built-in device types (polaris BUILT_IN_SEEDS + DEFAULT_TYPE_MATCHING
-- in src/utils/assetTypeMatch.ts — keep the two in lockstep). Idempotent.
-- gen_random_uuid() is core in PostgreSQL 13+.
INSERT INTO "asset_type_defs" ("id", "name", "label", "description", "is_built_in", "is_protected", "match_rules", "match_contexts", "match_priority", "updated_at") VALUES
  (gen_random_uuid()::text, 'server', 'Server', 'Physical or virtual host running server workloads.', true, true,
    '{"op":"or","children":[{"field":"os","operator":"contains","value":"server"},{"field":"os","operator":"contains","value":"centos"},{"field":"os","operator":"contains","value":"red hat"},{"field":"os","operator":"contains","value":"rhel"},{"field":"os","operator":"contains","value":"rocky linux"},{"field":"os","operator":"contains","value":"almalinux"},{"field":"os","operator":"contains","value":"oracle linux"},{"field":"os","operator":"contains","value":"freebsd"},{"field":"os","operator":"contains","value":"openbsd"},{"field":"os","operator":"contains","value":"netbsd"},{"field":"os","operator":"contains","value":"esxi"},{"field":"os","operator":"contains","value":"vmware"}]}'::jsonb,
    ARRAY['directory'], 20, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'switch', 'Switch', 'Managed Layer-2/3 switch (FortiSwitch and other vendors).', true, true,
    '{"op":"or","children":[{"field":"any","operator":"regex","value":"\\b(fortiswitch|switch|catalyst|nexus)\\b"}]}'::jsonb,
    ARRAY['scan'], 12, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'router', 'Router', 'Routing appliance (non-firewall).', true, true,
    '{"op":"or","children":[{"field":"any","operator":"regex","value":"\\brouter\\b"}]}'::jsonb,
    ARRAY['scan'], 16, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'firewall', 'Firewall', 'Perimeter / branch firewall. FortiGates land here.', true, true,
    '{"op":"or","children":[{"field":"any","operator":"regex","value":"\\b(fortigate|firewall|palo alto|sonicwall)\\b"}]}'::jsonb,
    ARRAY['scan'], 10, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'workstation', 'Workstation', 'Desktop / laptop endpoint.', true, true,
    '{"op":"or","children":[{"field":"os","operator":"regex","value":"windows\\s+(10|11|7|8|xp|vista)"},{"field":"os","operator":"contains","value":"macos"},{"field":"os","operator":"contains","value":"mac os x"},{"field":"os","operator":"contains","value":"os x"},{"field":"os","operator":"contains","value":"linux mint"},{"field":"os","operator":"contains","value":"ubuntu"},{"field":"os","operator":"contains","value":"fedora"},{"field":"os","operator":"contains","value":"debian"},{"field":"os","operator":"contains","value":"arch linux"},{"field":"os","operator":"contains","value":"manjaro"},{"field":"os","operator":"contains","value":"pop!_os"},{"field":"os","operator":"contains","value":"elementary os"},{"field":"os","operator":"contains","value":"zorin os"}]}'::jsonb,
    ARRAY['directory'], 30, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'printer', 'Printer', 'Network printer / multi-function device.', true, true,
    '{"op":"or","children":[{"field":"any","operator":"regex","value":"\\bprinter\\b|laserjet|officejet"}]}'::jsonb,
    ARRAY['scan'], 18, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'access_point', 'Access Point', 'Wireless access point (FortiAPs and other vendors).', true, true,
    '{"op":"or","children":[{"field":"any","operator":"regex","value":"\\bfortiap\\b|access point|\\bwlan\\b|\\bwireless\\b"}]}'::jsonb,
    ARRAY['scan'], 14, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'other', 'Other', 'Default bucket for assets that do not fit the built-in categories.', true, true,
    NULL, ARRAY[]::TEXT[], 100, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'hypervisor', 'Hypervisor', 'Virtualization host (ESXi).', true, true,
    NULL, ARRAY[]::TEXT[], 100, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'container', 'Container', 'Container or containerized app.', true, true,
    NULL, ARRAY[]::TEXT[], 100, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
