/**
 * src/services/assetTagService.ts — the asset-tag registry (Identification tab).
 *
 * Ported from polaris (the /server-settings/tags* handlers in
 * api/routes/serverSettings.ts, the filter half of
 * services/tagAssignmentService.ts, utils/tagNormalize.ts normalizeTagColor
 * and mapRegionService randomTagColor). Stored in `asset_tags` — NOT charon's
 * own `Tag` (the ZTNA tag pushed to Fortinet), which this never touches.
 *
 * Charon adaptations:
 *   - No asset inventory: a tag's auto-assign device filter is validated and
 *     stored exactly as polaris does, but there is nothing to apply it to —
 *     preview reports zero matches, delete strips nothing, and a rename has no
 *     asset/block/subnet rows to rewrite. Charon Endpoints are the natural
 *     future target (the managed-sync reconcile + provenance table would be
 *     ported then).
 *   - No legacy flat `criteria` column: charon never had the pre-tree shape,
 *     so only `assetCondition` exists. A posted `criteria` is refused.
 *   - No Device Map regions or Azure Arc mirror, so polaris's reserved
 *     "Map Regions" category and `region:` / `azure:` name prefixes are not
 *     enforced here.
 */

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";
import {
  deviceFilterConditionSchema,
  deviceFilterConditionMeta,
  scopeConditionStats,
  SCOPE_CONDITION_MAX_DEPTH,
  SCOPE_CONDITION_MAX_RULES,
  type ScopeConditionGroup,
} from "../utils/deviceFilterCondition.js";
import { listAssetTypes } from "./assetTypeService.js";
import { logger } from "../utils/logger.js";

const TAG_SETTINGS_KEY = "tagSettings";

// ─── Colours (polaris utils/tagNormalize.ts + mapRegionService.ts) ──────────

export const TAG_SEVERITY_COLOR_PREFIX = "severity:";
export const TAG_COLOR_SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;
const TAG_HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Validate a posted tag colour: `#rgb` / `#rrggbb` (lower-cased) or
 * `severity:<level>`. Anything else is a 400 — the value lands in style
 * attributes, so it is never stored free-form.
 */
export function normalizeTagColor(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (TAG_HEX_COLOR_RE.test(raw)) return raw.toLowerCase();
  if (raw.startsWith(TAG_SEVERITY_COLOR_PREFIX)) {
    const level = raw.slice(TAG_SEVERITY_COLOR_PREFIX.length);
    if ((TAG_COLOR_SEVERITIES as readonly string[]).includes(level)) return raw;
  }
  throw new AppError(
    400,
    `Tag color must be a hex color (#rrggbb) or a severity reference (${TAG_COLOR_SEVERITIES.map((s) => TAG_SEVERITY_COLOR_PREFIX + s).join(", ")})`,
  );
}

const TAG_COLOR_PALETTE = [
  "#4fc3f7", "#4ade80", "#f59e0b", "#f472b6", "#a78bfa",
  "#fb923c", "#38bdf8", "#34d399", "#e879f9", "#facc15",
  "#f87171", "#2dd4bf", "#818cf8", "#c084fc",
];

export function randomTagColor(): string {
  return TAG_COLOR_PALETTE[Math.floor(Math.random() * TAG_COLOR_PALETTE.length)]!;
}

// ─── Filter shape ──────────────────────────────────────────────────────────

/**
 * Validate a POSTED condition tree against the device-filter vocabulary.
 * An empty tree collapses to null — "no filter", i.e. an ordinary manual tag.
 * It is emphatically NOT "all assets": `and([])` is true for everything.
 */
export function normalizeTagCondition(raw: unknown): ScopeConditionGroup | null {
  if (raw == null) return null;
  const parsed = deviceFilterConditionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(400, `Device filter is invalid${first ? `: ${first.message}` : ""}`);
  }
  const cond = parsed.data;
  const { depth, rules } = scopeConditionStats(cond);
  if (depth > SCOPE_CONDITION_MAX_DEPTH) {
    throw new AppError(400, `Device filter groups nest at most ${SCOPE_CONDITION_MAX_DEPTH} deep`);
  }
  if (rules > SCOPE_CONDITION_MAX_RULES) {
    throw new AppError(400, `At most ${SCOPE_CONDITION_MAX_RULES} conditions per device filter`);
  }
  return rules === 0 ? null : cond;
}

/**
 * Re-validate a STORED tree on read. One that no longer validates drops to
 * null (the tag reads as manual) rather than 500ing the tag list.
 */
function safeStoredCondition(raw: unknown): ScopeConditionGroup | null {
  if (raw == null) return null;
  const parsed = deviceFilterConditionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ issue: parsed.error.issues[0]?.message }, "assetTag: stored device filter no longer validates — treating the tag as manual");
    return null;
  }
  return parsed.data;
}

/** The fields the tag editor reads beside the stored columns (polaris tagFilterView). */
export function tagFilterView(tag: { assetCondition?: unknown }) {
  const stored = safeStoredCondition(tag.assetCondition);
  return {
    assetCondition: stored,
    assetConditionEffective: stored,
    assetFilterUnconvertible: [] as string[],
  };
}

/** The posted filter: absent key = leave as-is; null / empty tree = clear. */
export function readPostedTagFilter(body: Record<string, unknown>): { provided: boolean; condition: ScopeConditionGroup | null } {
  if (Object.prototype.hasOwnProperty.call(body, "criteria") && body.criteria != null) {
    throw new AppError(400, "The legacy flat `criteria` filter is not supported — send `assetCondition` (a condition tree).");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "assetCondition")) return { provided: false, condition: null };
  return { provided: true, condition: normalizeTagCondition(body.assetCondition) };
}

/** How the audit Event describes the filter a write left on the tag. */
function describeTagFilter(condition: ScopeConditionGroup | null): string {
  if (!condition) return "";
  const { rules } = scopeConditionStats(condition);
  return ` with an auto-assign filter (${rules} condition${rules === 1 ? "" : "s"})`;
}

function conditionJson(c: ScopeConditionGroup | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return c ? (c as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}

// ─── Registry CRUD ─────────────────────────────────────────────────────────

export async function listAssetTags() {
  const tags = await prisma.assetTag.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  return tags.map((t) => ({ ...t, ...tagFilterView(t) }));
}

export interface TagWriteInput {
  name?: unknown;
  category?: unknown;
  color?: unknown;
  assetCondition?: unknown;
  criteria?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function createAssetTag(body: TagWriteInput & Record<string, unknown>, actor?: string) {
  const name = str(body.name).trim();
  if (!name) throw new AppError(400, "Tag name is required");
  if (name.length > 100) throw new AppError(400, "Tag name must be 100 characters or fewer");

  const existing = await prisma.assetTag.findUnique({ where: { name } });
  if (existing) throw new AppError(409, `Tag "${name}" already exists`);

  const category = str(body.category).trim() || "General";
  const { condition } = readPostedTagFilter(body);

  const tag = await prisma.assetTag.create({
    data: {
      name,
      category,
      color: body.color ? normalizeTagColor(body.color) : randomTagColor(),
      assetCondition: conditionJson(condition),
    },
  });
  await logEvent({
    level: "info",
    action: "asset_tag.created",
    resourceType: "asset_tag",
    resourceId: tag.id,
    resourceName: tag.name,
    actor,
    message: `Tag created: "${tag.name}" (category ${tag.category})${describeTagFilter(condition)}`,
  });
  return tag;
}

export async function updateAssetTag(id: string, body: TagWriteInput & Record<string, unknown>, actor?: string) {
  const existing = await prisma.assetTag.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Tag not found");

  const name = (typeof body.name === "string" ? body.name : existing.name).trim();
  if (!name) throw new AppError(400, "Tag name is required");
  if (name.length > 100) throw new AppError(400, "Tag name must be 100 characters or fewer");

  const renamed = name !== existing.name;
  if (renamed) {
    const dupe = await prisma.assetTag.findUnique({ where: { name } });
    if (dupe) throw new AppError(409, `Tag "${name}" already exists`);
  }

  const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : existing.category;
  const posted = readPostedTagFilter(body);

  const tag = await prisma.assetTag.update({
    where: { id },
    data: {
      name,
      category,
      color: body.color != null ? normalizeTagColor(body.color) : existing.color,
      ...(posted.provided ? { assetCondition: conditionJson(posted.condition) } : {}),
    },
  });

  await logEvent({
    level: "info",
    action: "asset_tag.updated",
    resourceType: "asset_tag",
    resourceId: tag.id,
    resourceName: tag.name,
    actor,
    message: renamed
      ? `Tag renamed: "${existing.name}" → "${tag.name}"`
      : `Tag updated: "${tag.name}"${posted.provided ? describeTagFilter(posted.condition) : ""}`,
  });
  return tag;
}

export async function deleteAssetTag(id: string, actor?: string): Promise<void> {
  const tag = await prisma.assetTag.findUnique({ where: { id } });
  if (!tag) throw new AppError(404, "Tag not found");
  await prisma.assetTag.delete({ where: { id } });
  await logEvent({
    level: "warning",
    action: "asset_tag.deleted",
    resourceType: "asset_tag",
    resourceId: tag.id,
    resourceName: tag.name,
    actor,
    message: `Tag deleted: "${tag.name}"`,
  });
}

// ─── Settings ("Force predefined tags") ────────────────────────────────────

export async function getTagSettings(): Promise<{ enforce: boolean }> {
  const row = await prisma.setting.findUnique({ where: { key: TAG_SETTINGS_KEY } });
  const v = row?.value as { enforce?: unknown } | undefined;
  return { enforce: v?.enforce === true };
}

export async function saveTagSettings(input: { enforce?: unknown }, actor?: string): Promise<{ enforce: boolean }> {
  const value = { enforce: input.enforce === true };
  await prisma.setting.upsert({
    where: { key: TAG_SETTINGS_KEY },
    update: { value },
    create: { key: TAG_SETTINGS_KEY, value },
  });
  await logEvent({
    level: "info",
    action: "asset_tag.settings.updated",
    resourceType: "setting",
    resourceName: TAG_SETTINGS_KEY,
    actor,
    message: `Tag enforcement ${value.enforce ? "enabled" : "disabled"}`,
  });
  return value;
}

// ─── Builder vocabulary + preview ──────────────────────────────────────────

/**
 * GET /server-settings/tags/filter-schema. The value-suggestion lists polaris
 * fills from its inventory (manufacturers, models, subnets, VLANs…) are empty
 * in charon; asset types and tag names come from the registries.
 */
export async function tagFilterSchema() {
  const [assetTypes, tags] = await Promise.all([
    listAssetTypes(),
    prisma.assetTag.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    scopeCondition: deviceFilterConditionMeta(),
    options: {
      manufacturers: [] as string[],
      models: [] as string[],
      subnets: [] as { name: string; cidr: string }[],
      ipBlocks: [] as { name: string; cidr: string }[],
      interfaceNames: [] as string[],
      ssids: [] as string[],
      nativeVlans: [] as { value: string; label: string }[],
      assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
      tags: tags.map((t) => t.name),
    },
    // Charon adaptation: charon has no Device Map, so no category is
    // region-managed (the page reads null as "none").
    regionCategory: null,
  };
}

export interface TagFilterPreview {
  matchCount: number;
  portCount: number;
  sample: { id: string; hostname: string | null; ipAddress: string | null; assetType: string }[];
  diff?: { add: number; remove: number };
}

/**
 * Dry-run a tag's device filter. The tree is validated exactly as a save
 * would (so a bad value surfaces in the editor), then evaluated against
 * charon's inventory — which is empty.
 */
export async function previewTagFilter(input: { condition?: unknown; criteria?: unknown }, tagId?: string): Promise<TagFilterPreview> {
  readPostedTagFilter({ assetCondition: input.condition ?? null, criteria: input.criteria });
  return { matchCount: 0, portCount: 0, sample: [], diff: tagId ? { add: 0, remove: 0 } : undefined };
}
