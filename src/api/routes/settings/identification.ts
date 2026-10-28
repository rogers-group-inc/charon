/**
 * src/api/routes/settings/identification.ts — Server Settings: Identification tab (DNS, OUI, tags, device icons, device types).
 *
 * Ported from polaris (src/api/routes/serverSettings.ts /tags* /dns* /oui*
 * /reservation-mac, plus api/routes/deviceIcons.ts and assetTypes.ts) to back
 * the ported public/js/server-settings-identification.js module at the exact
 * paths public/js/settings-api.js calls. Mounted WITHOUT a router-level gate
 * (router.ts) — every route declares its own requirePermission(), because a
 * router.use() gate here would also fire for every other /server-settings
 * path that passes through this router.
 *
 * Gates (charon adaptation): polaris gates the tag/DNS/OUI routes on
 * serverSettingsSystem and the icon/type registries on `assets` /
 * `deviceIcons`, keys charon does not have — every route here is
 * serverSettingsSystem read (GET) / write (mutations and outbound probes).
 *
 * Charon has no asset inventory: anything polaris counts or rewrites on
 * Asset rows (OUI-override rewrites, tag auto-assign, type usage, rule
 * apply) reports zero — see the services for the per-feature notes.
 */

import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { AppError } from "../../../utils/errors.js";
import { logEvent } from "../../../services/eventService.js";
import {
  getDnsSettings,
  updateDnsSettings,
  createResolver,
  parseDnsTestTarget,
  type DnsSettings,
} from "../../../services/dnsService.js";
import {
  getOuiStatus,
  refreshOuiDatabase,
  getOuiOverrides,
  setOuiOverride,
  deleteOuiOverride,
  lookupOuiDetailed,
} from "../../../services/ouiService.js";
import { getReservationMacSettings, saveReservationMacSettings } from "../../../services/reservationMacService.js";
import {
  listAssetTags,
  createAssetTag,
  updateAssetTag,
  deleteAssetTag,
  getTagSettings,
  saveTagSettings,
  tagFilterSchema,
  previewTagFilter,
} from "../../../services/assetTagService.js";
import {
  uploadIcon,
  listIcons,
  getIconImage,
  deleteIcon,
  updateIconKey,
} from "../../../services/deviceIconService.js";
import * as assetTypeService from "../../../services/assetTypeService.js";
import {
  MATCH_FIELDS,
  MATCH_OPS,
  MATCH_GROUP_OPS,
  MATCH_CONTEXTS,
  MATCH_MAX_LEAVES,
  AUTHORITATIVE_TYPE_SOURCES,
  matchConditionMeta,
  type MatchGroup,
} from "../../../utils/assetTypeMatch.js";

// ─── Schemas ───────────────────────────────────────────────────────────────

const DnsBodySchema = z.object({
  servers: z.array(z.string().max(255)).max(32).optional(),
  mode: z.enum(["standard", "dot", "doh"]).optional(),
  dohUrl: z.string().max(2048).optional(),
  verifyTls: z.boolean().optional(),
  testIp: z.string().max(2048).optional(),
});

// The prefix must be a plain string before anything reads it.
const OuiOverrideSchema = z.object({
  prefix: z.string().trim().min(1, "prefix is required").max(32),
  manufacturer: z.string().trim().min(1, "manufacturer is required").max(255),
  device: z.string().trim().max(255).nullish(),
});

const TagBodySchema = z.object({
  name: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  color: z.string().max(64).nullish(),
  assetCondition: z.unknown().optional(),
  criteria: z.unknown().optional(),
});

const TagSettingsSchema = z.object({ enforce: z.boolean().optional() });

const TagPreviewSchema = z.object({
  tagId: z.string().max(64).optional(),
  assetCondition: z.unknown().optional(),
  criteria: z.unknown().optional(),
});

const ReservationMacSchema = z.object({ prefix: z.unknown().optional() });

// PUT /device-icons/:id — re-key an icon; the image is untouched.
const UpdateIconKeySchema = z.object({
  scope:        z.enum(["manufacturer-type", "manufacturer-model"]),
  manufacturer: z.string().trim().min(1, "Manufacturer is required").max(200),
  typeOrModel:  z.string().trim().min(1, "Asset type or model is required").max(200),
});

// Asset types. Shape only — semantic rules (regex compiles, leaf count,
// nesting depth) live in utils/assetTypeMatch.validateMatchRules.
const ClauseSchema = z.object({
  field:    z.enum(MATCH_FIELDS),
  operator: z.enum(MATCH_OPS).optional(),
  op:       z.enum(MATCH_OPS).optional(),
  value:    z.string().min(1).max(200),
  negate:   z.boolean().optional(),
}).refine((c) => c.operator || c.op, { message: "condition needs an operator" });

const GroupSchema: z.ZodType<MatchGroup> = z.lazy(() =>
  z.object({
    op: z.enum(MATCH_GROUP_OPS),
    children: z.array(z.union([ClauseSchema, GroupSchema])).max(50),
  }).strict(),
) as z.ZodType<MatchGroup>;

const LegacyClauseListSchema = z
  .object({ clauses: z.array(ClauseSchema).max(MATCH_MAX_LEAVES) })
  .strict();

const MatchRulesSchema = z.union([GroupSchema, LegacyClauseListSchema]).nullable();
const MatchContextsSchema = z.array(z.enum(MATCH_CONTEXTS)).max(MATCH_CONTEXTS.length);
const MatchPrioritySchema = z.number().int().min(0).max(1000);

const AssetTypeCreateSchema = z.object({
  name:          z.string().min(2).max(32),
  label:         z.string().min(1).max(64),
  description:   z.string().max(500).nullable().optional(),
  matchRules:    MatchRulesSchema.optional(),
  matchContexts: MatchContextsSchema.optional(),
  matchPriority: MatchPrioritySchema.optional(),
});

const AssetTypeUpdateSchema = z.object({
  name:          z.string().min(2).max(32).optional(),
  label:         z.string().min(1).max(64).optional(),
  description:   z.string().max(500).nullable().optional(),
  matchRules:    MatchRulesSchema.optional(),
  matchContexts: MatchContextsSchema.optional(),
  matchPriority: MatchPrioritySchema.optional(),
});

const AssetTypePreviewSchema = z.object({
  name:          z.string().min(1).max(32),
  matchRules:    MatchRulesSchema,
  matchContexts: MatchContextsSchema,
  matchPriority: MatchPrioritySchema,
}).optional();

/** Zod failure → a 400 carrying the first issue, the polaris error shape. */
function parseOr400<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((e) => (e.path.length ? `${e.path.join(".")}: ` : "") + e.message).join("; "));
  }
  return parsed.data;
}

/** Who to name in the audit log — the operator, or the API token. */
function actorOf(req: Request): string | undefined {
  return req.session?.username ?? (req.apiToken ? `token:${req.apiToken.name}` : undefined);
}

const READ = requirePermission("serverSettingsSystem", "read");
const WRITE = requirePermission("serverSettingsSystem", "write");

// ═══ /server-settings (default export) ═════════════════════════════════════

const router = Router();

// ─── Tags ──────────────────────────────────────────────────────────────────

router.get("/tags", READ, async (_req, res, next) => {
  try {
    res.json(await listAssetTags());
  } catch (err) { next(err); }
});

router.post("/tags", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(TagBodySchema, req.body ?? {});
    res.status(201).json(await createAssetTag(body, actorOf(req)));
  } catch (err) { next(err); }
});

router.get("/tags/settings", READ, async (_req, res, next) => {
  try {
    res.json(await getTagSettings());
  } catch (err) { next(err); }
});

router.put("/tags/settings", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(TagSettingsSchema, req.body ?? {});
    res.json(await saveTagSettings(body, actorOf(req)));
  } catch (err) { next(err); }
});

// Declared before "/tags/:id" so the literal path can't be captured as an id.
router.get("/tags/filter-schema", READ, async (_req, res, next) => {
  try {
    res.json(await tagFilterSchema());
  } catch (err) { next(err); }
});

// Dry-run a tag's device filter (validates; charon has no assets to match).
router.post("/tags/preview-criteria", READ, async (req, res, next) => {
  try {
    const body = parseOr400(TagPreviewSchema, req.body ?? {});
    res.json(await previewTagFilter({ condition: body.assetCondition, criteria: body.criteria }, body.tagId));
  } catch (err) { next(err); }
});

router.put("/tags/:id", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(TagBodySchema, req.body ?? {});
    res.json(await updateAssetTag(String(req.params.id), body, actorOf(req)));
  } catch (err) { next(err); }
});

router.delete("/tags/:id", WRITE, async (req, res, next) => {
  try {
    await deleteAssetTag(String(req.params.id), actorOf(req));
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── DNS ───────────────────────────────────────────────────────────────────
//
// Polaris's DNS card configures the resolvers POLARIS uses for its own
// lookups (an isolated dns.Resolver / DoT / DoH client) — it never writes the
// host's resolv.conf, so there is no host-level action to degrade here.

router.get("/dns", READ, async (_req, res, next) => {
  try {
    res.json(await getDnsSettings());
  } catch (err) { next(err); }
});

router.put("/dns", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(DnsBodySchema, req.body ?? {});
    const servers = (body.servers || []).map((s) => s.trim()).filter(Boolean);
    const mode = body.mode || "standard";
    const dohUrl = (body.dohUrl || "").trim();
    const verifyTls = body.verifyTls === true;

    // Validate server entries — allow IPs, hostnames, and host:port
    if (mode !== "doh") {
      for (const s of servers) {
        if (!/^[\w.\-:[\]]+$/.test(s)) {
          throw new AppError(400, `Invalid DNS server entry: "${s}". Use an IP address or hostname (e.g. 8.8.8.8, dns.google, or [2001:4860:4860::8888]).`);
        }
      }
    }
    if (mode === "doh") {
      if (!dohUrl) throw new AppError(400, "A DoH URL is required when using DNS over HTTPS mode.");
      if (!/^https:\/\/.+/.test(dohUrl)) throw new AppError(400, "DoH URL must start with https://");
    }

    const saved = await updateDnsSettings({ servers, mode, dohUrl, verifyTls });
    await logEvent({
      level: "info",
      action: "dns.settings.updated",
      resourceType: "setting",
      resourceName: "dnsSettings",
      actor: actorOf(req),
      message: `DNS settings updated (${mode}${mode === "doh" ? ` ${dohUrl}` : `, ${servers.length} server(s)`}, TLS verify ${verifyTls ? "on" : "off"})`,
    });
    res.json(saved);
  } catch (err) { next(err); }
});

// Test probes an operator-supplied server from the server — gate like the write.
router.post("/dns/test", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(DnsBodySchema, req.body ?? {});
    const servers = (body.servers || []).map((s) => s.trim()).filter(Boolean);
    const mode = body.mode || "standard";
    const dohUrl = (body.dohUrl || "").trim();
    const verifyTls = body.verifyTls === true;
    const rawTarget = typeof body.testIp === "string" && body.testIp.trim() ? body.testIp : "8.8.8.8";
    const target = parseDnsTestTarget(rawTarget);
    if (!target) {
      throw new AppError(400, `"${rawTarget}" is not an IP address, hostname or URL`);
    }
    if (mode === "doh" && !dohUrl) {
      return res.json({ ok: false, message: "No DoH URL configured", results: [] });
    }
    if (mode === "doh" && !/^https:\/\/.+/.test(dohUrl)) {
      throw new AppError(400, "DoH URL must start with https://");
    }

    // Carry verifyTls so the test exercises the operator's chosen TLS behavior.
    const targets = mode === "doh"
      ? [{ label: `DoH (${dohUrl})`, settings: { servers: [], mode, dohUrl, verifyTls } as DnsSettings }]
      : mode === "dot"
        ? servers.map((s) => ({ label: `DoT (${s}:853)`, settings: { servers: [s], mode, dohUrl: "", verifyTls } as DnsSettings }))
        : servers.length > 0
          ? servers.map((s) => ({ label: s, settings: { servers: [s], mode: "standard" as const, dohUrl: "", verifyTls: false } }))
          : [{ label: "system DNS", settings: { servers: [], mode: "standard" as const, dohUrl: "", verifyTls: false } }];

    const results = await Promise.all(targets.map(async (t) => {
      const start = Date.now();
      try {
        const resolver = await createResolver(t.settings);
        if (target.kind === "forward") {
          const addrs = await resolver.lookup(target.name);
          const elapsed = Date.now() - start;
          if (addrs.length === 0) {
            return { server: t.label, ok: true, message: `Reachable but no A/AAAA record for ${target.name} (${elapsed}ms)` };
          }
          return { server: t.label, ok: true, message: `${target.name} → ${addrs.map((a) => a.address).join(", ")} in ${elapsed}ms` };
        }
        const records = await resolver.reverse(target.ip);
        const elapsed = Date.now() - start;
        const name = records[0]?.name || "(no PTR)";
        const ttlNote = records[0]?.ttl != null ? ` TTL ${records[0].ttl}s` : "";
        return { server: t.label, ok: true, message: `${target.ip} → ${name}${ttlNote} in ${elapsed}ms` };
      } catch (dnsErr: any) {
        const elapsed = Date.now() - start;
        const subject = target.kind === "forward" ? target.name : target.ip;
        if (dnsErr?.code === "ENOTFOUND" || dnsErr?.code === "ENODATA") {
          const what = target.kind === "forward" ? "A/AAAA" : "PTR";
          return { server: t.label, ok: true, message: `Reachable but no ${what} record for ${subject} (${elapsed}ms)` };
        }
        return { server: t.label, ok: false, message: `${dnsErr?.message || dnsErr?.code || "Unknown error"} (${elapsed}ms)` };
      }
    }));

    const allOk = results.every((r) => r.ok);
    res.json({ ok: allOk, message: results.map((r) => `${r.server}: ${r.message}`).join("; "), results });
  } catch (err) { next(err); }
});

// ─── OUI database ──────────────────────────────────────────────────────────

router.get("/oui", READ, async (_req, res, next) => {
  try {
    res.json(await getOuiStatus());
  } catch (err) { next(err); }
});

router.post("/oui/refresh", WRITE, async (req, res, next) => {
  try {
    const result = await refreshOuiDatabase();
    await logEvent({
      level: "info",
      action: "oui.database.refreshed",
      resourceType: "setting",
      resourceName: "oui_database",
      actor: actorOf(req),
      message: `OUI database refreshed: ${result.entries} vendors (${result.sizeKb} KB)`,
    });
    res.json({ ok: true, ...result, message: `OUI database refreshed: ${result.entries.toLocaleString()} vendors loaded` });
  } catch (err) { next(err); }
});

router.get("/oui/lookup/:prefix", READ, async (req, res, next) => {
  try {
    const result = await lookupOuiDetailed(String(req.params.prefix).slice(0, 64));
    if (!result.normalized) throw new AppError(400, "Invalid MAC or prefix — supply at least 3 bytes (e.g. AA:BB:CC)");
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/oui/overrides", READ, async (_req, res, next) => {
  try {
    res.json(await getOuiOverrides());
  } catch (err) { next(err); }
});

router.post("/oui/overrides", WRITE, async (req, res, next) => {
  try {
    const { prefix, manufacturer, device } = parseOr400(OuiOverrideSchema, req.body ?? {});
    const clean = prefix.replace(/[:\-.\s]/g, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(clean)) throw new AppError(400, "prefix must be 6 hex characters (e.g. AA:BB:CC)");
    const deviceTrim = device ?? "";
    const result = await setOuiOverride(prefix, manufacturer, deviceTrim || undefined);
    const macPrefix = clean.match(/.{2}/g)!.join(":");

    // Polaris rewrites manufacturer/model on every Asset whose MAC starts
    // with the prefix; charon has no asset inventory, so nothing is rewritten.
    await logEvent({
      level: "info",
      action: "oui.override.set",
      resourceType: "ouiOverride",
      resourceId: clean,
      resourceName: macPrefix,
      actor: actorOf(req),
      message: `OUI override set for ${macPrefix} → ${manufacturer}${deviceTrim ? ` / ${deviceTrim}` : ""}`,
    });
    res.json({ ...result, assetsUpdated: 0 });
  } catch (err) { next(err); }
});

router.delete("/oui/overrides/:prefix", WRITE, async (req, res, next) => {
  try {
    const prefix = String(req.params.prefix).slice(0, 64);
    await deleteOuiOverride(prefix);
    await logEvent({
      level: "info",
      action: "oui.override.removed",
      resourceType: "ouiOverride",
      resourceId: prefix,
      resourceName: prefix,
      actor: actorOf(req),
      message: `OUI override removed for ${prefix}`,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Placeholder MAC prefix ────────────────────────────────────────────────

router.get("/reservation-mac", READ, async (_req, res, next) => {
  try {
    res.json(await getReservationMacSettings());
  } catch (err) { next(err); }
});

router.put("/reservation-mac", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(ReservationMacSchema, req.body ?? {});
    res.json(await saveReservationMacSettings(body, actorOf(req)));
  } catch (err) { next(err); }
});

export default router;

// ═══ /device-icons ══════════════════════════════════════════════════════════

/** Mounted at /api/v1/device-icons (polaris path). */
export const deviceIconsRouter = Router();

// Hard cap matches deviceIconService's MAX_ICON_BYTES (the service enforces
// the lower SVG cap after inspecting mimeType). Multer rejects oversized
// uploads before the handler sees the buffer.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024, files: 1 } });

function iconUrl(id: string): string {
  return `/api/v1/device-icons/${id}/image`;
}

deviceIconsRouter.get("/", READ, async (_req, res, next) => {
  try {
    const icons = await listIcons();
    res.json(icons.map((i) => ({ ...i, url: iconUrl(i.id) })));
  } catch (err) { next(err); }
});

// POST /device-icons — multipart: file + scope + manufacturer + typeOrModel.
// Re-uploading the same canonical key replaces the existing image.
deviceIconsRouter.post("/", WRITE, (req, res, next) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      return next(code === "LIMIT_FILE_SIZE"
        ? new AppError(400, "Icon too large (max 262144 bytes)")
        : new AppError(400, (err as Error).message || "Upload failed"));
    }
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "Missing 'file' upload");
    const scope = String(req.body?.scope || "");
    const manufacturer = String(req.body?.manufacturer || "");
    const typeOrModel = String(req.body?.typeOrModel || "");
    if (!scope) throw new AppError(400, "scope is required");
    const summary = await uploadIcon({
      scope: scope as "manufacturer-type" | "manufacturer-model",
      manufacturer,
      typeOrModel,
      filename: String(req.file.originalname || "icon").slice(0, 255),
      mimeType: req.file.mimetype,
      data: req.file.buffer,
      uploadedBy: actorOf(req),
    });
    await logEvent({
      action: "device_icon.uploaded",
      resourceType: "device_icon",
      resourceId: summary.id,
      resourceName: `${summary.scope}:${summary.key}`,
      actor: actorOf(req),
      level: "info",
      message: `Uploaded device icon for ${summary.scope}:${summary.key} (${summary.size} bytes, ${summary.mimeType})`,
    });
    res.json({ ...summary, url: iconUrl(summary.id) });
  } catch (err) { next(err); }
});

// PUT /device-icons/:id — re-key; a key another icon holds is a 409.
deviceIconsRouter.put("/:id", WRITE, async (req, res, next) => {
  try {
    const body = parseOr400(UpdateIconKeySchema, req.body ?? {});
    const { icon, previous } = await updateIconKey(String(req.params.id), body);
    await logEvent({
      action: "device_icon.updated",
      resourceType: "device_icon",
      resourceId: icon.id,
      resourceName: `${icon.scope}:${icon.key}`,
      actor: actorOf(req),
      level: "info",
      message: `Re-keyed device icon from ${previous.scope}:${previous.key} to ${icon.scope}:${icon.key}`,
    });
    res.json({ ...icon, url: iconUrl(icon.id) });
  } catch (err) { next(err); }
});

deviceIconsRouter.delete("/:id", WRITE, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ok = await deleteIcon(id);
    if (!ok) throw new AppError(404, "Icon not found");
    await logEvent({
      action: "device_icon.deleted",
      resourceType: "device_icon",
      resourceId: id,
      actor: actorOf(req),
      level: "info",
      message: `Deleted device icon ${id}`,
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /device-icons/:id/image — raw bytes. Polaris leaves this auth-only (any
// signed-in user) so other pages can render icons; charon's router already
// requires a session, and this route adds no further gate for the same reason.
deviceIconsRouter.get("/:id/image", async (req, res, next) => {
  try {
    const img = await getIconImage(String(req.params.id));
    if (!img) throw new AppError(404, "Icon not found");
    res.setHeader("Content-Type", img.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(img.data.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    // SVG is stored as-is in charon (no rasterizer), so the polaris
    // defense-in-depth headers are load-bearing here: no script, no fetch,
    // sandboxed if opened directly.
    if (img.mimeType === "image/svg+xml") {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      );
    }
    res.send(img.data);
  } catch (err) { next(err); }
});

// ═══ /asset-types ═══════════════════════════════════════════════════════════

/** Mounted at /api/v1/asset-types (polaris path). */
export const assetTypesRouter = Router();

assetTypesRouter.get("/", READ, async (req, res, next) => {
  try {
    const withUsage = req.query.withUsage === "1" || req.query.withUsage === "true";
    res.json({ types: await assetTypeService.listAssetTypes({ withUsage }) });
  } catch (err) { next(err); }
});

// The matching vocabulary + the paths rules cannot reach. Before "/:id".
assetTypesRouter.get("/match-schema", READ, (_req, res) => {
  res.json({
    fields: MATCH_FIELDS,
    ops: MATCH_OPS,
    contexts: MATCH_CONTEXTS,
    condition: matchConditionMeta(),
    authoritativeSources: AUTHORITATIVE_TYPE_SOURCES,
  });
});

// Dry-run (writes nothing). An optional draft previews an unsaved edit.
assetTypesRouter.post("/match-preview", READ, async (req, res, next) => {
  try {
    const draft = parseOr400(AssetTypePreviewSchema, req.body?.draft ?? undefined);
    res.json(await assetTypeService.previewMatchRules(draft ?? undefined));
  } catch (err) { next(err); }
});

// Re-type the assets the saved rules claim — explicit, audited, `other`-only.
assetTypesRouter.post("/match-apply", WRITE, async (req, res, next) => {
  try {
    const result = await assetTypeService.applyMatchRules();
    if (result.updated > 0) {
      await logEvent({
        action: "asset_type.rules_applied",
        resourceType: "asset_type",
        actor: actorOf(req),
        message: `Device-type rules re-typed ${result.updated} asset(s) out of "Other"`,
        details: { byType: result.byType },
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});

assetTypesRouter.get("/:id", READ, async (req, res, next) => {
  try {
    res.json(await assetTypeService.getAssetType(String(req.params.id)));
  } catch (err) { next(err); }
});

assetTypesRouter.post("/", WRITE, async (req, res, next) => {
  try {
    const input = parseOr400(AssetTypeCreateSchema, req.body ?? {});
    const saved = await assetTypeService.createAssetType({ ...input, createdBy: actorOf(req) ?? null });
    await logEvent({
      action: "asset_type.created",
      resourceType: "asset_type",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: actorOf(req),
      message: `Asset type "${saved.label}" (${saved.name}) created`,
    });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

assetTypesRouter.put("/:id", WRITE, async (req, res, next) => {
  try {
    const input = parseOr400(AssetTypeUpdateSchema, req.body ?? {});
    const saved = await assetTypeService.updateAssetType(String(req.params.id), input);
    await logEvent({
      action: "asset_type.updated",
      resourceType: "asset_type",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: actorOf(req),
      message: `Asset type "${saved.label}" (${saved.name}) updated`,
    });
    res.json(saved);
  } catch (err) { next(err); }
});

assetTypesRouter.delete("/:id", WRITE, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const before = await assetTypeService.deleteAssetType(id);
    await logEvent({
      action: "asset_type.deleted",
      resourceType: "asset_type",
      resourceId: id,
      resourceName: before.name,
      actor: actorOf(req),
      message: `Asset type "${before.label}" (${before.name}) deleted`,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});
