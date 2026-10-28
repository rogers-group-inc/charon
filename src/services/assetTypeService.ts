/**
 * src/services/assetTypeService.ts — the AssetTypeDef (device-type) registry.
 *
 * Ported from polaris (services/assetTypeService.ts + utils/assetTypes.ts).
 * CRUD over the operator-extensible registry behind the Identification tab's
 * Device Types card. Built-in rows (seeded by migration
 * 20261028000005_settings_identification with is_built_in + is_protected)
 * cannot be renamed, relabelled or deleted; their MATCHING rules stay editable.
 *
 * Charon adaptations:
 *   - Charon has no Asset inventory. Usage counts are always 0, a rename has no
 *     rows to rewrite, delete never finds a reference, and preview / apply
 *     examine an empty fleet (the card renders polaris's empty states). When
 *     charon Endpoints gain a device type, count / re-type them here.
 *   - No in-memory registry cache (polaris warms one for its discovery hot
 *     path); `isKnownAssetType` reads the table.
 */

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  validateMatchRules,
  validateMatchContexts,
  normalizeMatchRules,
  DEFAULT_TYPE_MATCHING,
  type MatchRules,
  type MatchRulesInput,
  type MatchClause,
} from "../utils/assetTypeMatch.js";

// ─── Names (polaris utils/assetTypes.ts) ───────────────────────────────────

/** The protected built-in names. Seeded by the migration; never deletable. */
export const BUILT_IN_ASSET_TYPES = [
  "server",
  "switch",
  "router",
  "firewall",
  "workstation",
  "printer",
  "access_point",
  "other",
  "hypervisor",
  "container",
] as const;

export function normalizeAssetTypeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Validate a custom type's machine name. Returns an error message, or null. */
export function validateAssetTypeName(raw: string): string | null {
  const name = normalizeAssetTypeName(raw);
  if (name.length < 2 || name.length > 32) return "Name must be 2-32 characters.";
  if (!/^[a-z0-9_-]+$/.test(name)) return "Name must contain only lowercase letters, digits, dash, and underscore.";
  if ((BUILT_IN_ASSET_TYPES as readonly string[]).includes(name)) return "Name collides with a built-in asset type.";
  return null;
}

export function validateAssetTypeLabel(raw: string): string | null {
  const label = raw.trim();
  if (label.length < 1 || label.length > 64) return "Label must be 1-64 characters.";
  return null;
}

/** Is `name` a registry row (built-in or custom)? */
export async function isKnownAssetType(name: string | null | undefined): Promise<boolean> {
  if (!name) return false;
  const row = await prisma.assetTypeDef.findUnique({ where: { name }, select: { id: true } });
  if (row) return true;
  // An empty registry (migration seed skipped) still knows the built-ins.
  return (BUILT_IN_ASSET_TYPES as readonly string[]).includes(name) && (await prisma.assetTypeDef.count()) === 0;
}

// ─── Rows ──────────────────────────────────────────────────────────────────

export interface AssetTypeRow {
  id: string;
  name: string;
  label: string;
  description: string | null;
  isBuiltIn: boolean;
  isProtected: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Always the CURRENT tree shape on the way out (legacy rows fold forward). */
  matchRules: MatchRules | null;
  matchContexts: string[];
  matchPriority: number;
  /** Live count of assets using this type — always 0 in charon (no inventory). */
  usageCount?: number;
}

function toRow<T extends { matchRules: unknown }>(row: T): T & { matchRules: MatchRules | null } {
  return { ...row, matchRules: normalizeMatchRules(row.matchRules) };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function listAssetTypes(opts: { withUsage?: boolean } = {}): Promise<AssetTypeRow[]> {
  const order = [{ isBuiltIn: "desc" as const }, { label: "asc" as const }];
  let rows = await prisma.assetTypeDef.findMany({ orderBy: order });
  // Polaris self-heals the built-ins on every boot; charon does it on the first
  // read that finds the registry empty (a restored backup / skipped seed).
  if (rows.length === 0 && (await seedBuiltInAssetTypes()).inserted > 0) {
    rows = await prisma.assetTypeDef.findMany({ orderBy: order });
  }
  if (!opts.withUsage) return rows.map(toRow);
  return rows.map((r) => ({ ...toRow(r), usageCount: 0 }));
}

export async function getAssetType(id: string): Promise<AssetTypeRow> {
  const row = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Asset type not found");
  return { ...toRow(row), usageCount: 0 };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/** Shared write-time validation for the three matching columns. */
function assertMatchingValid(input: {
  matchRules?: unknown;
  matchContexts?: unknown;
  matchPriority?: unknown;
}): void {
  const rulesErr = validateMatchRules(input.matchRules);
  if (rulesErr) throw new AppError(400, rulesErr);
  const ctxErr = validateMatchContexts(input.matchContexts);
  if (ctxErr) throw new AppError(400, ctxErr);
  if (input.matchPriority !== undefined && input.matchPriority !== null) {
    const p = input.matchPriority;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 1000) {
      throw new AppError(400, "Match priority must be a whole number between 0 and 1000.");
    }
  }
}

export async function createAssetType(input: {
  name: string;
  label: string;
  description?: string | null;
  matchRules?: MatchRulesInput | null;
  matchContexts?: string[];
  matchPriority?: number;
  createdBy?: string | null;
}): Promise<AssetTypeRow> {
  const name = normalizeAssetTypeName(input.name);
  const nameError = validateAssetTypeName(input.name);
  if (nameError) throw new AppError(400, nameError);
  const labelError = validateAssetTypeLabel(input.label);
  if (labelError) throw new AppError(400, labelError);
  assertMatchingValid(input);
  const existing = await prisma.assetTypeDef.findUnique({ where: { name } });
  if (existing) throw new AppError(409, `Asset type "${name}" already exists`);
  const rules = normalizeMatchRules(input.matchRules);
  const row = await prisma.assetTypeDef.create({
    data: {
      name,
      label: input.label.trim(),
      description: input.description?.trim() || null,
      isBuiltIn: false,
      isProtected: false,
      createdBy: input.createdBy ?? null,
      matchRules: rules ? (rules as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      matchContexts: input.matchContexts ?? [],
      ...(input.matchPriority !== undefined ? { matchPriority: input.matchPriority } : {}),
    },
  });
  return toRow(row);
}

export async function updateAssetType(
  id: string,
  input: {
    name?: string;
    label?: string;
    description?: string | null;
    matchRules?: MatchRulesInput | null;
    matchContexts?: string[];
    matchPriority?: number;
  },
): Promise<AssetTypeRow> {
  const current = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!current) throw new AppError(404, "Asset type not found");

  assertMatchingValid(input);

  // A built-in row's IDENTITY is immutable (name, label, description); its
  // MATCHING is the operator's to edit.
  const identityEdit =
    (typeof input.name === "string" && input.name !== current.name) ||
    (typeof input.label === "string" && input.label !== current.label) ||
    (input.description !== undefined && (input.description?.trim() || null) !== current.description);
  if (current.isProtected && identityEdit) {
    throw new AppError(403, "Built-in asset types cannot be renamed or relabelled. Their matching rules can still be edited.");
  }

  const data: {
    name?: string;
    label?: string;
    description?: string | null;
    matchRules?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    matchContexts?: string[];
    matchPriority?: number;
  } = {};

  if (input.matchRules !== undefined) {
    const normalized = normalizeMatchRules(input.matchRules);
    data.matchRules = normalized === null
      ? Prisma.DbNull
      : (normalized as unknown as Prisma.InputJsonValue);
  }
  if (input.matchContexts !== undefined) data.matchContexts = input.matchContexts;
  if (input.matchPriority !== undefined) data.matchPriority = input.matchPriority;

  if (typeof input.name === "string" && input.name !== current.name) {
    const next = normalizeAssetTypeName(input.name);
    const err = validateAssetTypeName(input.name);
    if (err) throw new AppError(400, err);
    const collision = await prisma.assetTypeDef.findUnique({ where: { name: next } });
    if (collision && collision.id !== id) throw new AppError(409, `Asset type "${next}" already exists`);
    data.name = next;
    // Polaris rewrites every Asset holding the old name in the same
    // transaction; charon has no assets to rewrite. Device icons keyed to the
    // old type name are left as-is, exactly as polaris leaves them.
  }

  if (typeof input.label === "string") {
    const err = validateAssetTypeLabel(input.label);
    if (err) throw new AppError(400, err);
    data.label = input.label.trim();
  }

  if (input.description !== undefined) {
    const desc = input.description?.trim() ?? "";
    data.description = desc ? desc : null;
  }

  if (Object.keys(data).length === 0) return toRow(current);

  const row = await prisma.assetTypeDef.update({ where: { id }, data });
  return toRow(row);
}

export async function deleteAssetType(id: string): Promise<{ name: string; label: string }> {
  const current = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!current) throw new AppError(404, "Asset type not found");
  if (current.isProtected) {
    throw new AppError(403, "Built-in asset types cannot be deleted.");
  }
  // Polaris refuses (409) while any Asset references the type; charon has none.
  await prisma.assetTypeDef.delete({ where: { id } });
  return { name: current.name, label: current.label };
}

/**
 * Idempotent self-heal for the built-in rows (the migration is the
 * authoritative seed). Only a row this CREATES gets the shipped matching —
 * an existing row's rules are the operator's, even when empty.
 */
const BUILT_IN_SEEDS: ReadonlyArray<{ name: string; label: string; description: string }> = [
  { name: "server",       label: "Server",       description: "Physical or virtual host running server workloads." },
  { name: "switch",       label: "Switch",       description: "Managed Layer-2/3 switch (FortiSwitch and other vendors)." },
  { name: "router",       label: "Router",       description: "Routing appliance (non-firewall)." },
  { name: "firewall",     label: "Firewall",     description: "Perimeter / branch firewall. FortiGates land here." },
  { name: "workstation",  label: "Workstation",  description: "Desktop / laptop endpoint." },
  { name: "printer",      label: "Printer",      description: "Network printer / multi-function device." },
  { name: "access_point", label: "Access Point", description: "Wireless access point (FortiAPs and other vendors)." },
  { name: "other",        label: "Other",        description: "Default bucket for assets that do not fit the built-in categories." },
  { name: "hypervisor",   label: "Hypervisor",   description: "Virtualization host (ESXi)." },
  { name: "container",    label: "Container",    description: "Container or containerized app." },
];

export async function seedBuiltInAssetTypes(): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const seed of BUILT_IN_SEEDS) {
    const existing = await prisma.assetTypeDef.findUnique({ where: { name: seed.name } });
    if (existing) continue;
    const matching = DEFAULT_TYPE_MATCHING[seed.name];
    await prisma.assetTypeDef.create({
      data: {
        name: seed.name,
        label: seed.label,
        description: seed.description,
        isBuiltIn: true,
        isProtected: true,
        ...(matching
          ? {
              matchRules: matching.rules as unknown as Prisma.InputJsonValue,
              matchContexts: matching.contexts,
              matchPriority: matching.priority,
            }
          : {}),
      },
    });
    inserted++;
  }
  return { inserted };
}

// ─── Preview + apply against existing inventory ────────────────────────────

/** One asset a preview would re-type, with the clause that claimed it. */
export interface MatchPreviewRow {
  id: string;
  hostname: string | null;
  os: string | null;
  manufacturer: string | null;
  model: string | null;
  currentType: string;
  matchedType: string;
  matchedClause: MatchClause | null;
}

export interface MatchPreviewResult {
  examined: number;
  matched: number;
  byType: { type: string; count: number }[];
  sample: MatchPreviewRow[];
  truncated: boolean;
}

/**
 * Which assets in "Other" a rule set would claim. A draft is validated exactly
 * as polaris does (so the editor's preview surfaces a bad regex), then run
 * against charon's inventory — which is empty, so the answer is always zero.
 */
export async function previewMatchRules(
  draft?: { name: string; matchRules: MatchRulesInput | null; matchContexts: string[]; matchPriority: number },
): Promise<MatchPreviewResult> {
  if (draft) {
    const err = validateMatchRules(draft.matchRules);
    if (err) throw new AppError(400, err);
  }
  return { examined: 0, matched: 0, byType: [], sample: [], truncated: false };
}

/** Re-type the assets the saved rules claim — none in charon. */
export async function applyMatchRules(): Promise<{
  updated: number;
  byType: { type: string; count: number }[];
}> {
  return { updated: 0, byType: [] };
}
