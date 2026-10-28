/**
 * src/api/routes/settings/credentials.ts — Server Settings: Credentials tab
 * (stored credentials, MIB database, manufacturer aliases + profiles).
 *
 * Ported from polaris src/api/routes/credentials.ts, mibs.ts,
 * manufacturerAliases.ts and manufacturerProfiles.ts to back the ported
 * public/js/server-settings-credentials.js at the paths public/js/settings-api.js
 * calls. Mounted WITHOUT a router-level gate (router.ts) — every route declares
 * its own requirePermission(), because a router.use() gate here would also
 * fire for every other /server-settings path that passes through this router.
 *
 * Permission mapping (polaris key → Charon key):
 *   credentials           → credentials (same; write/fullwrite ownership rule)
 *   mibDatabase           → serverSettingsSystem (read: browse/walk, write: upload/delete)
 *   manufacturerProfiles  → serverSettingsSystem (read / write)
 *   assets (widget devices, walk/test targets) → n/a: Charon has no Asset
 *     inventory, so asset targets are refused and the device lists are empty.
 *
 * Mounts:
 *   default export     → /api/v1/server-settings  (mibs, manufacturer-aliases,
 *                                                   manufacturer-profiles)
 *   credentialsRouter  → /api/v1/credentials
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { makeRateLimiter } from "../../middleware/rateLimits.js";
import { AppError } from "../../../utils/errors.js";
import { logEvent } from "../../../services/eventService.js";
import * as credentialService from "../../../services/credentials/credentialService.js";
import * as aliasService from "../../../services/credentials/manufacturerAliasService.js";
import { probeCredentialAgainstHost, snmpWalkRaw } from "../../../services/credentials/credentialProbeService.js";
import { type HttpProbeDiagnostics } from "../../../services/credentials/httpCheck.js";
import { normalizeProbeTarget } from "../../../services/credentials/probeTarget.js";
import { resolveAllowedHost, guardedLookup } from "../../../services/credentials/netGuard.js";
import {
  listMibs,
  getMib,
  createMib,
  deleteMib,
  getMibFacets,
  parseMibStructured,
  MIB_MAX_BYTES,
  type MibSymbol,
  type MibTable,
  type ParsedMibStructured,
} from "../../../services/credentials/mibService.js";
import { resolveSymbolsForMib, findUnresolvedRootSymbols, missingRootsForMib, type MissingRoot } from "../../../services/credentials/oidRegistry.js";
import { listStdMibs, getStdMibDef, getStdMibStructure } from "../../../services/credentials/stdMibLibrary.js";
import {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  updateMetricRow, createOverride, updateOverride, deleteOverride,
  createWidget, updateWidget, deleteWidget, listManufacturerSuggestions,
  symbolWarningsForProfile, setWidgetLayout, sensorColumnSymbols,
} from "../../../services/credentials/manufacturerProfileService.js";
import {
  TRANSFORM_KINDS,
  TRANSFORM_LABELS,
  COMBINER_KINDS,
  COMBINER_LABELS,
  METRIC_ROW_TRANSFORMS,
} from "../../../services/credentials/symbolTransforms.js";
import { exportProfile, previewProfileImport, applyProfileImport, saveProfileCode } from "../../../services/credentials/manufacturerProfilePortabilityService.js";
import { syncAssetTypeRegistry } from "../../../services/credentials/assetTypes.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const CredentialTypeEnum = z.enum(["snmp", "winrm", "ssh", "restapi", "http"]);

const CreateCredentialSchema = z.object({
  name:   z.string().min(1),
  type:   CredentialTypeEnum,
  config: z.record(z.string(), z.unknown()),
});

const UpdateCredentialSchema = z.object({
  name:   z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

// POST /credentials/test. polaris accepts an assetId OR a typed host; Charon has
// no Asset inventory, so an assetId is refused below and the host is the target.
const TestSchema = z.object({
  assetId: z.string().uuid("assetId must be a UUID").optional(),
  host:    z.string().min(1).max(300).optional(),
  type:    CredentialTypeEnum,
  config:  z.record(z.string(), z.unknown()),
  id:      z.string().uuid().optional(),
  check:   z.record(z.string(), z.unknown()).optional(),
}).refine((v) => !!v.assetId || !!v.host || v.type === "restapi", {
  message: "Provide either an assetId or a host to test against",
});

const IdParam = z.string().uuid("Invalid id");

const AliasCreateSchema = z.object({
  alias:     z.string().min(1),
  canonical: z.string().min(1),
});

const AliasUpdateSchema = z.object({
  alias:     z.string().min(1).optional(),
  canonical: z.string().min(1).optional(),
});

// MIB-aware walk. polaris walks an asset ({ assetId }); Charon walks a typed
// host ({ host }) with the same credential / object / row-cap fields.
const WalkSchema = z.object({
  assetId:      z.string().uuid("assetId must be a UUID").optional(),
  host:         z.string().min(1).max(300).optional(),
  credentialId: z.string().uuid("credentialId must be a UUID"),
  objectName:   z.string().min(1, "objectName is required").max(128),
  maxRows:      z.number().int().min(1).max(5000).optional().default(500),
});

const ProfileCreateSchema = z.object({ manufacturer: z.string().min(1, "manufacturer is required").max(200) });
const ProfileUpdateSchema = z.object({ matchPattern: z.string().max(500).nullable().optional() });

const WidgetAssetsSchema = z.object({
  enable:  z.array(z.string().min(1)).max(5000).optional(),
  disable: z.array(z.string().min(1)).max(5000).optional(),
});

const ImportPreviewSchema = z.object({ file: z.unknown() });
const ImportApplySchema = z.object({
  file:  z.unknown(),
  items: z.array(z.string().min(1).max(200)).max(2000),
});

const WidgetLayoutSchema = z.object({
  layout: z.object({
    version: z.literal(1),
    columns: z.array(z.object({
      id:      z.string().min(1).max(64),
      width:   z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(12)]),
      widgets: z.array(z.object({
        id:     z.string().min(1).max(64),
        height: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      })).max(500),
    })).max(48),
  }).nullable(),
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

const NO_ASSETS = "Charon has no asset inventory — enter the device's IP address or hostname instead";

function actorOf(req: Request): string | undefined {
  return req.session?.username ?? (req.apiToken ? `token:${req.apiToken.name}` : undefined);
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (err) { next(err); }
  };
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((e) => e.message).join("; ");
}

function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, zodMessage(parsed.error));
  return parsed.data;
}

/**
 * polaris assertOwnership for the `credentials` key: fullwrite reaches any
 * row; write only rows whose createdBy is the caller. A null owner (rows that
 * predate the column, or a token-created row) is fullwrite-only.
 */
function assertCredentialOwnership(req: Request, createdBy: string | null, verb: string): void {
  if (req.permissionLevel === "fullwrite") return;
  const me = req.session?.username;
  if (me && createdBy && createdBy === me) return;
  throw new AppError(
    403,
    createdBy
      ? `Forbidden — only ${createdBy} or a role with Full Read-Write on Credentials can ${verb} this one`
      : `Forbidden — this credential has no recorded owner; ${verb} needs Full Read-Write on Credentials`,
  );
}

/**
 * Validate an operator-typed target (rule 110): no scheme/port/path, must
 * resolve, and not loopback / link-local / metadata. Returns the dial address
 * (the checked IP for ssh/snmp, the name otherwise) plus a guarded lookup, or a
 * refusal string the caller renders as a test RESULT.
 */
async function checkTypedHost(
  raw: string | undefined,
  type: string,
): Promise<{ host: string | null; lookup?: import("node:net").LookupFunction; refusal?: string }> {
  const target = normalizeProbeTarget(raw);
  if (target.error) return { host: null, refusal: target.error };
  let host = target.host;
  if (!host) return { host: null };
  try {
    const checked = await resolveAllowedHost(host);
    if (!checked) return { host: null, refusal: `${host} does not resolve. Check the name, or test against its address.` };
    if (type === "ssh" || type === "snmp") host = checked;
    return { host, lookup: guardedLookup() };
  } catch (err: any) {
    if (err?.code !== "BLOCKED_HOST") throw err;
    return {
      host: null,
      refusal: `${host} is a loopback / link-local / metadata address. Test against the device's routable address.`,
    };
  }
}

// Lazily runs polaris's boot-time alias seed + cache load (see
// manufacturerAliasService.ensureAliasesBooted). Per-route, not router.use.
async function aliasesBooted(_req: Request, _res: Response, next: NextFunction) {
  await aliasService.ensureAliasesBooted();
  next();
}

// Device-type validation on override rows reads the asset-type registry,
// which in Charon is the Identification tab's DB-backed service.
async function assetTypesSynced(_req: Request, _res: Response, next: NextFunction) {
  await syncAssetTypeRegistry();
  next();
}

// polaris credentialTestLimiter (rateLimits.ts) — local so the shared file is untouched.
const credentialTestLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Too many credential tests — wait a few minutes and retry.",
});

const SYS_READ = requirePermission("serverSettingsSystem", "read");
const SYS_WRITE = requirePermission("serverSettingsSystem", "write");

// ═════════════════════════════════════════════════════════════════════════════
// /api/v1/credentials
// ═════════════════════════════════════════════════════════════════════════════

/** Mounted at /api/v1/credentials (polaris path). */
export const credentialsRouter = Router();

// GET /credentials — secrets masked.
credentialsRouter.get("/", requirePermission("credentials", "read"), handle(async (_req, res) => {
  res.json(await credentialService.listCredentials());
}));

// GET /credentials/usage — per-credential asset counts (always {} in Charon).
// Registered before /:id so "usage" isn't read as an id.
credentialsRouter.get("/usage", requirePermission("credentials", "read"), handle(async (_req, res) => {
  res.json(await credentialService.getCredentialUsageCounts());
}));

// POST /credentials/test — exercise a credential against a typed host without
// persisting anything. Declared before /:id routes.
credentialsRouter.post("/test", credentialTestLimiter, requirePermission("credentials", "write"), handle(async (req, res) => {
  const input = parseOr400(TestSchema, req.body);

  // Testing a STORED credential merges its real secrets into the probe, so it
  // is ownership-scoped (borrowing someone else's password otherwise).
  if (input.id) {
    const owner = await credentialService.getCredential(input.id);
    assertCredentialOwnership(req, owner.createdBy, "test");
  }
  if (input.assetId) throw new AppError(400, NO_ASSETS);

  const typed = await checkTypedHost(input.host, input.type);
  if (typed.refusal && input.type !== "restapi") {
    res.json({ success: false, responseTimeMs: 0, error: typed.refusal, host: null });
    return;
  }
  const host = typed.host;

  let config = input.config || {};
  if (input.id) {
    const existing = await credentialService.getCredential(input.id, { revealSecrets: true });
    if (existing.type !== input.type) {
      throw new AppError(400, `Credential "${existing.name}" is type "${existing.type}", but the form sent "${input.type}"`);
    }
    config = credentialService.mergeConfigPreservingSecrets(input.type, existing.config || {}, config);
  }

  const check: Record<string, unknown> = { ...(input.check || {}) };
  const skipCredentialValidation = input.type === "http" && Object.keys(config).length === 0;
  try {
    if (!skipCredentialValidation) credentialService.validateConfig(input.type, config);
    if (input.type === "http") credentialService.validateHttpCheckDefinition(check);
  } catch (err: any) {
    res.json({ success: false, responseTimeMs: 0, error: err?.message || "Credential config is invalid", host });
    return;
  }

  // A restapi credential dials its own baseUrl — same rule 110 guard on it.
  if (input.type === "restapi" && typeof config.baseUrl === "string") {
    let baseHost: string;
    try { baseHost = new URL(String(config.baseUrl)).hostname; } catch { baseHost = ""; }
    if (baseHost) {
      try {
        await resolveAllowedHost(baseHost);
      } catch (err: any) {
        if (err?.code !== "BLOCKED_HOST") throw err;
        res.json({
          success: false,
          responseTimeMs: 0,
          error: `The base URL points at ${baseHost}, a loopback / link-local / metadata address. Use the API's routable address.`,
          host,
        });
        return;
      }
    }
  }

  const probeOut: { diag?: HttpProbeDiagnostics } = {};
  const result = await probeCredentialAgainstHost(host || "", input.type, config, probeOut, check, typed.lookup);
  const label = host || "(no target)";
  void logEvent({
    action: "credential.tested",
    resourceType: "credential",
    resourceId: input.id,
    actor: actorOf(req),
    level: result.success ? "info" : "warning",
    message: result.success
      ? `Credential test succeeded against ${label} (${result.responseTimeMs} ms)`
      : `Credential test failed against ${label}: ${result.error || "unknown error"}`,
    // The response BODY is deliberately not audited (unbounded sensitivity).
    details: {
      assetId: null, host, hostSource: "manual", type: input.type,
      ...(probeOut.diag
        ? { httpStatus: probeOut.diag.statusCode, httpUrl: probeOut.diag.url, httpMatched: probeOut.diag.matched }
        : {}),
    },
  });
  res.json({ ...result, host, ...(probeOut.diag ? { httpDiagnostics: probeOut.diag } : {}) });
}));

// GET /credentials/:id
credentialsRouter.get("/:id", requirePermission("credentials", "read"), handle(async (req, res) => {
  res.json(await credentialService.getCredential(parseOr400(IdParam, String(req.params.id))));
}));

// GET /credentials/:id/usage — usage breakdown for the slide-in (empty in Charon).
credentialsRouter.get("/:id/usage", requirePermission("credentials", "read"), handle(async (req, res) => {
  res.json(await credentialService.getCredentialUsage(parseOr400(IdParam, String(req.params.id))));
}));

// POST /credentials — write-level callers may create; stamped with their username.
credentialsRouter.post("/", requirePermission("credentials", "write"), handle(async (req, res) => {
  const input = parseOr400(CreateCredentialSchema, req.body);
  const saved = await credentialService.createCredential({
    name: input.name,
    type: input.type,
    config: input.config,
    createdBy: req.session?.username ?? null,
  });
  const reboot = credentialService.credentialAllowsReboot(saved.type, saved.config);
  void logEvent({
    action: "credential.created",
    resourceType: "credential",
    resourceId: saved.id,
    resourceName: saved.name,
    actor: actorOf(req),
    message: `Credential "${saved.name}" (${saved.type}) created${reboot ? " — reboots allowed" : ""}`,
    ...(reboot ? { details: { allowReboot: true } } : {}),
  });
  res.status(201).json(saved);
}));

// PUT /credentials/:id — own rows at write, any row at fullwrite.
credentialsRouter.put("/:id", requirePermission("credentials", "write"), handle(async (req, res) => {
  const id = parseOr400(IdParam, String(req.params.id));
  const existing = await credentialService.getCredential(id);
  assertCredentialOwnership(req, existing.createdBy, "edit");
  const input = parseOr400(UpdateCredentialSchema, req.body);
  const saved = await credentialService.updateCredential(id, { name: input.name, config: input.config });
  const rebootBefore = credentialService.credentialAllowsReboot(existing.type, existing.config);
  const rebootAfter = credentialService.credentialAllowsReboot(saved.type, saved.config);
  const rebootNote = rebootBefore === rebootAfter ? "" : rebootAfter ? " — reboots now allowed" : " — reboots no longer allowed";
  void logEvent({
    action: "credential.updated",
    resourceType: "credential",
    resourceId: saved.id,
    resourceName: saved.name,
    actor: actorOf(req),
    level: rebootBefore !== rebootAfter ? "warning" : "info",
    message: `Credential "${saved.name}" updated${rebootNote}`,
    ...(rebootBefore !== rebootAfter ? { details: { allowReboot: rebootAfter } } : {}),
  });
  res.json(saved);
}));

// DELETE /credentials/:id — own rows at write, any row at fullwrite.
credentialsRouter.delete("/:id", requirePermission("credentials", "write"), handle(async (req, res) => {
  const id = parseOr400(IdParam, String(req.params.id));
  const existing = await credentialService.getCredential(id);
  assertCredentialOwnership(req, existing.createdBy, "delete");
  await credentialService.deleteCredential(id);
  void logEvent({
    action: "credential.deleted",
    resourceType: "credential",
    resourceId: id,
    resourceName: existing.name,
    actor: actorOf(req),
    message: `Credential "${existing.name}" deleted`,
  });
  res.status(204).send();
}));

// ═════════════════════════════════════════════════════════════════════════════
// /api/v1/server-settings — MIBs, manufacturer aliases, manufacturer profiles
// ═════════════════════════════════════════════════════════════════════════════

const router = Router();
export default router;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MIB_MAX_BYTES, files: 1 } });

// ─── MIB Database ────────────────────────────────────────────────────────────

router.get("/mibs/facets", SYS_READ, aliasesBooted, handle(async (_req, res) => {
  res.json(await getMibFacets());
}));

router.get("/mibs/std", SYS_READ, (_req, res) => {
  res.json(listStdMibs().map((m) => ({ key: m.key, label: m.label, moduleName: m.moduleName, rootOid: m.rootOid })));
});

router.get("/mibs/std/:key/structure", SYS_READ, handle(async (req, res) => {
  const key = String(req.params.key);
  const def = getStdMibDef(`std:${key}`);
  if (!def) throw new AppError(404, `Unknown standard MIB "${key}"`);
  const structured = getStdMibStructure(def.key);
  res.json({ ...structured, mibId: def.key, moduleName: def.moduleName, manufacturer: null, model: null, isStandard: true });
}));

router.post("/mibs/std/:key/walk", SYS_READ, requirePermission("credentials", "write"), handle(async (req, res) => {
  const body = parseOr400(WalkSchema, req.body);
  const key = String(req.params.key);
  const def = getStdMibDef(`std:${key}`);
  if (!def) throw new AppError(404, `Unknown standard MIB "${key}"`);
  res.json(await runMibWalk(req, {
    structured: getStdMibStructure(def.key),
    moduleName: def.moduleName,
    mibId: def.key,
    unresolvedOidSuffix: " at the standard scope",
    body,
  }));
}));

router.get("/mibs", SYS_READ, aliasesBooted, handle(async (req, res) => {
  const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : "all";
  const scope: "all" | "device" | "generic" = scopeRaw === "device" || scopeRaw === "generic" ? scopeRaw : "all";
  const manufacturer = typeof req.query.manufacturer === "string" && req.query.manufacturer.trim() ? req.query.manufacturer.trim() : undefined;
  const model = typeof req.query.model === "string" && req.query.model.trim() ? req.query.model.trim() : undefined;
  res.json(await listMibs({ manufacturer, model, scope }));
}));

router.get("/mibs/:id/download", SYS_READ, handle(async (req, res) => {
  const row = await getMib(parseOr400(IdParam, String(req.params.id)));
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${row.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.send(row.contents);
}));

router.get("/mibs/:id/structure", SYS_READ, handle(async (req, res) => {
  const id = parseOr400(IdParam, String(req.params.id));
  const row = await getMib(id);
  const structured = parseMibStructured(row.contents);
  const oidMap = await resolveSymbolsForMib(id);
  if (oidMap) {
    for (const sym of structured.symbols) sym.fullOid = oidMap.get(sym.name) ?? null;
  }
  const unresolvedCount = structured.symbols.filter((s) => s.fullOid === null).length;
  const unresolvedRoots = unresolvedCount > 0 && oidMap ? findUnresolvedRootSymbols(row.contents, oidMap) : [];
  const unresolvedRootDetails: MissingRoot[] = unresolvedCount > 0 ? missingRootsForMib(row.id) : [];
  res.json({
    ...structured,
    mibId: row.id,
    manufacturer: row.manufacturer,
    model: row.model,
    unresolvedCount,
    unresolvedRoots,
    unresolvedRootDetails,
  });
}));

router.get("/mibs/:id", SYS_READ, handle(async (req, res) => {
  res.json(await getMib(parseOr400(IdParam, String(req.params.id))));
}));

// multer answers an oversized file before the handler runs; name the limit.
function uploadMibFile(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if ((err as { code?: string } | undefined)?.code === "LIMIT_FILE_SIZE") {
      return next(new AppError(413, `MIB files are limited to ${MIB_MAX_BYTES / 1_048_576} MiB`));
    }
    if (err) return next(new AppError(400, (err as Error).message || "MIB upload failed"));
    next();
  });
}

router.post("/mibs", SYS_WRITE, aliasesBooted, uploadMibFile, handle(async (req, res) => {
  if (!req.file) throw new AppError(400, "No MIB file uploaded");
  const created = await createMib({
    filename: req.file.originalname,
    contents: req.file.buffer.toString("utf-8"),
    manufacturer: typeof req.body?.manufacturer === "string" ? req.body.manufacturer : null,
    model: typeof req.body?.model === "string" ? req.body.model : null,
    notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    uploadedBy: req.session?.username ?? null,
  });
  void logEvent({
    action: "mib.uploaded",
    actor: actorOf(req),
    resourceType: "mib",
    resourceId: created.id,
    resourceName: created.moduleName,
    message:
      `Uploaded MIB ${created.moduleName}` +
      (created.manufacturer ? ` for ${created.manufacturer}${created.model ? ` ${created.model}` : ""}` : " (generic)"),
  });
  res.status(201).json(created);
}));

router.delete("/mibs/:id", SYS_WRITE, handle(async (req, res) => {
  const id = parseOr400(IdParam, String(req.params.id));
  const row = await getMib(id);
  await deleteMib(id);
  void logEvent({
    action: "mib.deleted",
    actor: actorOf(req),
    resourceType: "mib",
    resourceId: row.id,
    resourceName: row.moduleName,
    message: `Deleted MIB ${row.moduleName}`,
  });
  res.status(204).send();
}));

// POST /mibs/:id/walk — MIB-aware walk against a typed host. Sends the stored
// credential's secrets to that host, so it carries the same gate as a stored-
// credential test: credentials write + ownership of the credential.
router.post("/mibs/:id/walk", SYS_READ, requirePermission("credentials", "write"), handle(async (req, res) => {
  const body = parseOr400(WalkSchema, req.body);
  const id = parseOr400(IdParam, String(req.params.id));
  const mibRow = await getMib(id);
  const structured = parseMibStructured(mibRow.contents);
  const oidMap = await resolveSymbolsForMib(id);
  if (oidMap) {
    for (const sym of structured.symbols) sym.fullOid = oidMap.get(sym.name) ?? null;
  }
  res.json(await runMibWalk(req, {
    structured,
    moduleName: mibRow.moduleName,
    mibId: mibRow.id,
    unresolvedOidSuffix: " — likely a missing IMPORTS dependency",
    body,
  }));
}));

interface WalkScalarEntry {
  oid: string;
  symbol: string | null;
  suffix: string | null;
  syntax: string | null;
  baseType: string | null;
  raw: string;
  decoded: string;
}

interface WalkTablePayload {
  name: string;
  rowSymbol: string;
  columns: string[];
  indexNames: string[];
  rows: { index: string; cells: Record<string, { raw: string; decoded: string } | null> }[];
}

/** Longest symbol OID that prefixes `oid` (a table cell → its column symbol). Exported for tests. */
export function findSymbolForOid(oid: string, symbols: MibSymbol[]): { symbol: MibSymbol; suffix: string } | null {
  let best: { symbol: MibSymbol; suffix: string; len: number } | null = null;
  for (const sym of symbols) {
    if (!sym.fullOid) continue;
    if (oid === sym.fullOid) {
      if (!best || sym.fullOid.length > best.len) best = { symbol: sym, suffix: "", len: sym.fullOid.length };
      continue;
    }
    const prefix = sym.fullOid + ".";
    if (oid.startsWith(prefix)) {
      if (!best || sym.fullOid.length > best.len) best = { symbol: sym, suffix: oid.slice(prefix.length), len: sym.fullOid.length };
    }
  }
  return best ? { symbol: best.symbol, suffix: best.suffix } : null;
}

/** INTEGER enums → "up(1)", TimeTicks → human duration. Exported for tests. */
export function decodeValue(rawStr: string, symbol: MibSymbol | null, type: string): string {
  if (symbol?.enumValues && /^-?\d+$/.test(rawStr)) {
    const v = parseInt(rawStr, 10);
    const hit = symbol.enumValues.find((e) => e.value === v);
    if (hit) return `${hit.label}(${v})`;
  }
  if ((symbol?.baseType === "TimeTicks" || type === "TimeTicks") && /^\d+$/.test(rawStr)) {
    return formatTimeTicks(parseInt(rawStr, 10));
  }
  return rawStr;
}

export function formatTimeTicks(ticks: number): string {
  const totalSeconds = Math.floor(ticks / 100);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (mins || hours || days) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/** Numeric-aware comparator for OID-suffix strings ("1" < "2" < "10"). Exported for tests. */
export function compareIndexSuffix(a: string, b: string): number {
  const ap = a.split(".");
  const bp = b.split(".");
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const an = parseInt(ap[i], 10);
    const bn = parseInt(bp[i], 10);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ap[i].localeCompare(bp[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return ap.length - bp.length;
}

function renderTablePayload(
  table: MibTable,
  entries: { oid: string; symbol: string | null; suffix: string | null; raw: string; decoded: string }[],
): WalkTablePayload {
  const rowMap = new Map<string, Record<string, { raw: string; decoded: string }>>();
  for (const e of entries) {
    if (!e.symbol || e.suffix === null) continue;
    if (!table.columns.includes(e.symbol)) continue;
    let cells = rowMap.get(e.suffix);
    if (!cells) {
      cells = {};
      rowMap.set(e.suffix, cells);
    }
    cells[e.symbol] = { raw: e.raw, decoded: e.decoded };
  }
  const rows = Array.from(rowMap.entries())
    .sort((a, b) => compareIndexSuffix(a[0], b[0]))
    .map(([index, cells]) => {
      const fullCells: Record<string, { raw: string; decoded: string } | null> = {};
      for (const col of table.columns) fullCells[col] = cells[col] ?? null;
      return { index, cells: fullCells };
    });
  return { name: table.name, rowSymbol: table.rowSymbol, columns: table.columns, indexNames: table.indexNames, rows };
}

/** Shared walk pipeline behind both walk routes (polaris runMibWalk, host-targeted). */
async function runMibWalk(req: Request, opts: {
  structured: ParsedMibStructured;
  moduleName: string;
  mibId: string;
  unresolvedOidSuffix: string;
  body: z.infer<typeof WalkSchema>;
}) {
  const { structured, moduleName, mibId, unresolvedOidSuffix } = opts;
  const { credentialId, objectName, maxRows } = opts.body;
  const actor = actorOf(req);

  const targetSymbol = structured.symbols.find((s) => s.name === objectName);
  if (!targetSymbol) throw new AppError(400, `MIB ${moduleName} does not define an object named "${objectName}"`);
  if (!targetSymbol.fullOid) throw new AppError(400, `Object "${objectName}" cannot be resolved to a numeric OID${unresolvedOidSuffix}`);

  if (opts.body.assetId || !opts.body.host) throw new AppError(400, NO_ASSETS);
  const typed = await checkTypedHost(opts.body.host, "snmp");
  if (typed.refusal || !typed.host) throw new AppError(400, typed.refusal || "Enter the device's IP address or hostname");
  const walkHost = typed.host;

  const stored = await credentialService.getCredential(credentialId);
  assertCredentialOwnership(req, stored.createdBy, "walk with");
  const cred = await credentialService.getCredential(credentialId, { revealSecrets: true });
  if (cred.type !== "snmp") throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}", expected "snmp"`);

  const baseOid = targetSymbol.fullOid;
  const label = opts.body.host;

  let walk;
  try {
    walk = await snmpWalkRaw(walkHost, cred.config, baseOid, maxRows);
  } catch (err: any) {
    const message = err?.message || "SNMP walk failed";
    void logEvent({
      action: "snmp.walk",
      resourceType: "mib",
      resourceId: mibId,
      resourceName: moduleName,
      actor,
      level: "warning",
      message: `MIB walk failed: ${label} — ${moduleName}::${objectName} — ${message}`,
      details: { mibId, mibModuleName: moduleName, objectName, oid: baseOid, host: walkHost, credentialName: cred.name, error: message },
    });
    throw new AppError(502, message);
  }

  type Entry = WalkScalarEntry & { symbolRef: MibSymbol | null };
  const entries: Entry[] = walk.rows.map((row) => {
    const hit = findSymbolForOid(row.oid, structured.symbols);
    const symbolRef = hit?.symbol ?? null;
    return {
      oid: row.oid,
      symbol: symbolRef?.name ?? null,
      suffix: hit?.suffix ?? null,
      syntax: symbolRef?.syntax ?? null,
      baseType: symbolRef?.baseType ?? null,
      raw: row.value,
      decoded: decodeValue(row.value, symbolRef, row.type),
      symbolRef,
    };
  });

  let kind: "table" | "scalars" = "scalars";
  let tablePayload: WalkTablePayload | null = null;
  const rowParents = new Set<string>();
  for (const e of entries) {
    if (!e.symbolRef?.parentName) {
      rowParents.clear();
      break;
    }
    rowParents.add(e.symbolRef.parentName);
  }
  if (entries.length > 0 && rowParents.size === 1) {
    const onlyParent = rowParents.values().next().value as string;
    const tableMatch = structured.tables.find((t) => t.rowSymbol === onlyParent);
    if (tableMatch) {
      kind = "table";
      tablePayload = renderTablePayload(tableMatch, entries);
    }
  }

  const decodedCount = entries.filter((e) => e.symbol !== null).length;
  void logEvent({
    action: "snmp.walk",
    resourceType: "mib",
    resourceId: mibId,
    resourceName: moduleName,
    actor,
    message: `MIB walk: ${label} — ${moduleName}::${objectName} → ${entries.length} row(s)${walk.truncated ? " (truncated)" : ""}`,
    details: {
      mibId, mibModuleName: moduleName, objectName, oid: baseOid, host: walkHost, credentialName: cred.name,
      kind, rowCount: entries.length, decodedCount, truncated: walk.truncated, durationMs: walk.durationMs,
    },
  });

  const common = {
    truncated: walk.truncated,
    durationMs: walk.durationMs,
    rowCount: entries.length,
    decodedCount,
    host: walkHost,
    oid: baseOid,
    objectName,
  };
  if (kind === "table" && tablePayload) return { kind, table: tablePayload, ...common };
  return { kind: "scalars" as const, entries: entries.map(({ symbolRef: _ignored, ...rest }) => rest), ...common };
}

// ─── Manufacturer aliases ────────────────────────────────────────────────────
// polaris mounts these at /api/v1/manufacturer-aliases; Charon serves them
// under /server-settings (settings-api.js paths adjusted to match).

router.get("/manufacturer-aliases", SYS_READ, aliasesBooted, handle(async (_req, res) => {
  res.json(await aliasService.listAliases());
}));

router.post("/manufacturer-aliases", SYS_WRITE, aliasesBooted, handle(async (req, res) => {
  const saved = await aliasService.createAlias(parseOr400(AliasCreateSchema, req.body));
  void logEvent({
    action: "manufacturer_alias.created",
    resourceType: "manufacturer_alias",
    resourceId: saved.id,
    resourceName: saved.canonical,
    actor: actorOf(req),
    message: `Manufacturer alias "${saved.alias}" → "${saved.canonical}" created`,
  });
  res.status(201).json(saved);
}));

router.put("/manufacturer-aliases/:id", SYS_WRITE, aliasesBooted, handle(async (req, res) => {
  const id = parseOr400(IdParam, String(req.params.id));
  const saved = await aliasService.updateAlias(id, parseOr400(AliasUpdateSchema, req.body));
  void logEvent({
    action: "manufacturer_alias.updated",
    resourceType: "manufacturer_alias",
    resourceId: saved.id,
    resourceName: saved.canonical,
    actor: actorOf(req),
    message: `Manufacturer alias "${saved.alias}" → "${saved.canonical}" updated`,
  });
  res.json(saved);
}));

router.delete("/manufacturer-aliases/:id", SYS_WRITE, aliasesBooted, handle(async (req, res) => {
  const id = parseOr400(IdParam, String(req.params.id));
  const existing = (await aliasService.listAliases()).find((a) => a.id === id);
  await aliasService.deleteAlias(id);
  void logEvent({
    action: "manufacturer_alias.deleted",
    resourceType: "manufacturer_alias",
    resourceId: id,
    resourceName: existing?.canonical,
    actor: actorOf(req),
    message: existing
      ? `Manufacturer alias "${existing.alias}" → "${existing.canonical}" deleted`
      : "Manufacturer alias deleted",
  });
  res.status(204).send();
}));

// ─── Manufacturer profiles ───────────────────────────────────────────────────

const MP = "/manufacturer-profiles";

function scopeLabel(o: { assetType: string | null; modelPattern: string | null }): string {
  if (o.assetType && o.modelPattern) return `${o.assetType} / ${o.modelPattern}`;
  if (o.assetType) return `${o.assetType} default`;
  return String(o.modelPattern);
}

router.get(MP, SYS_READ, aliasesBooted, handle(async (_req, res) => {
  res.json({
    profiles: await listProfiles(),
    transforms: TRANSFORM_KINDS.map((k) => ({ kind: k, label: TRANSFORM_LABELS[k] })),
    combiners: COMBINER_KINDS.map((k) => ({ kind: k, label: COMBINER_LABELS[k] })),
    metricTransforms: METRIC_ROW_TRANSFORMS,
  });
}));

router.get(`${MP}/suggestions`, SYS_READ, aliasesBooted, handle(async (_req, res) => {
  res.json({ suggestions: await listManufacturerSuggestions() });
}));

router.post(`${MP}/import/preview`, SYS_WRITE, aliasesBooted, assetTypesSynced, handle(async (req, res) => {
  res.json(await previewProfileImport(parseOr400(ImportPreviewSchema, req.body).file));
}));

router.post(`${MP}/import`, SYS_WRITE, aliasesBooted, assetTypesSynced, handle(async (req, res) => {
  const body = parseOr400(ImportApplySchema, req.body);
  res.json(await applyProfileImport(body.file, body.items, actorOf(req)));
}));

router.get(`${MP}/:id`, SYS_READ, handle(async (req, res) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) { res.status(404).json({ error: "Profile not found" }); return; }
  res.json({ profile });
}));

router.post(MP, SYS_WRITE, aliasesBooted, handle(async (req, res) => {
  const { manufacturer } = parseOr400(ProfileCreateSchema, req.body);
  const profile = await createProfile({ manufacturer, createdBy: req.session?.username ?? null });
  void logEvent({
    action: "manufacturer_profile.created",
    resourceType: "manufacturer_profile",
    resourceId: profile.id,
    resourceName: profile.manufacturer,
    actor: actorOf(req),
    message: `Manufacturer profile "${profile.manufacturer}" created`,
  });
  res.status(201).json({ profile });
}));

router.put(`${MP}/:id`, SYS_WRITE, handle(async (req, res) => {
  const body = parseOr400(ProfileUpdateSchema, req.body);
  const profile = await updateProfile(String(req.params.id), { matchPattern: body.matchPattern });
  void logEvent({
    action: "manufacturer_profile.updated",
    resourceType: "manufacturer_profile",
    resourceId: profile.id,
    resourceName: profile.manufacturer,
    actor: actorOf(req),
    message: `Manufacturer profile "${profile.manufacturer}" match pattern ${profile.matchPattern ? `set to /${profile.matchPattern}/i` : "cleared"}`,
  });
  res.json({ profile });
}));

// Body shapes for metric / override / widget writes are validated field by
// field in manufacturerProfileService (as in polaris), so only "an object" here.
const BodyObject = z.record(z.string(), z.unknown());

router.put(`${MP}/:id/metrics/:metricKey`, SYS_WRITE, handle(async (req, res) => {
  const id = String(req.params.id);
  const metricKey = String(req.params.metricKey);
  const updated = await updateMetricRow(id, metricKey, parseOr400(BodyObject, req.body ?? {}));
  void logEvent({
    action: "manufacturer_profile.metric_updated",
    resourceType: "manufacturer_profile",
    resourceId: id,
    actor: actorOf(req),
    message: `Manufacturer profile metric "${metricKey}" updated`,
  });
  const warnings = symbolWarningsForProfile(id, [
    { symbol: updated.defaultSymbol,  mibId: updated.defaultMibId },
    { symbol: updated.defaultSymbolB, mibId: updated.defaultMibId },
    ...sensorColumnSymbols(updated.defaultSensorColumns).map((symbol) => ({ symbol, mibId: updated.defaultMibId })),
  ]);
  res.json({ metric: updated, warnings });
}));

router.post(`${MP}/:id/metrics/:metricKey/overrides`, SYS_WRITE, assetTypesSynced, handle(async (req, res) => {
  const id = String(req.params.id);
  const metricKey = String(req.params.metricKey);
  const created = await createOverride(id, metricKey, parseOr400(BodyObject, req.body ?? {}));
  void logEvent({
    action: "manufacturer_profile.override_created",
    resourceType: "manufacturer_profile",
    resourceId: id,
    actor: actorOf(req),
    message: `Manufacturer profile override "${scopeLabel(created)}" added for metric "${metricKey}"`,
  });
  const warnings = symbolWarningsForProfile(id, [
    { symbol: created.symbol,  mibId: created.mibId },
    { symbol: created.symbolB, mibId: created.mibId },
    ...sensorColumnSymbols(created.sensorColumns).map((symbol) => ({ symbol, mibId: created.mibId })),
  ]);
  res.status(201).json({ override: created, warnings });
}));

router.put(`${MP}/:id/metrics/:metricKey/overrides/:overrideId`, SYS_WRITE, assetTypesSynced, handle(async (req, res) => {
  const id = String(req.params.id);
  const metricKey = String(req.params.metricKey);
  const updated = await updateOverride(String(req.params.overrideId), parseOr400(BodyObject, req.body ?? {}));
  void logEvent({
    action: "manufacturer_profile.override_updated",
    resourceType: "manufacturer_profile",
    resourceId: id,
    actor: actorOf(req),
    message: `Manufacturer profile override "${scopeLabel(updated)}" updated for metric "${metricKey}"`,
  });
  const warnings = symbolWarningsForProfile(id, [
    { symbol: updated.symbol,  mibId: updated.mibId },
    { symbol: updated.symbolB, mibId: updated.mibId },
    ...sensorColumnSymbols(updated.sensorColumns).map((symbol) => ({ symbol, mibId: updated.mibId })),
  ]);
  res.json({ override: updated, warnings });
}));

router.delete(`${MP}/:id/metrics/:metricKey/overrides/:overrideId`, SYS_WRITE, handle(async (req, res) => {
  await deleteOverride(String(req.params.overrideId));
  void logEvent({
    action: "manufacturer_profile.override_deleted",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: actorOf(req),
    message: `Manufacturer profile override deleted for metric "${String(req.params.metricKey)}"`,
  });
  res.status(204).end();
}));

router.post(`${MP}/:id/widgets`, SYS_WRITE, handle(async (req, res) => {
  const id = String(req.params.id);
  // Field-level validation is the service's (as in polaris, which passes req.body through).
  const input = { ...parseOr400(BodyObject, req.body ?? {}), createdBy: req.session?.username ?? null } as Parameters<typeof createWidget>[1];
  const widget = await createWidget(id, input);
  void logEvent({
    action: "manufacturer_profile.widget_created",
    resourceType: "manufacturer_profile",
    resourceId: id,
    resourceName: widget.name,
    actor: actorOf(req),
    message: `Manufacturer profile custom widget "${widget.name}" created`,
  });
  const warnings = symbolWarningsForProfile(id, [{ symbol: widget.symbol, mibId: widget.mibId }]);
  res.status(201).json({ widget, warnings });
}));

router.put(`${MP}/:id/widgets/:widgetId`, SYS_WRITE, handle(async (req, res) => {
  const id = String(req.params.id);
  const widget = await updateWidget(String(req.params.widgetId), parseOr400(BodyObject, req.body ?? {}));
  void logEvent({
    action: "manufacturer_profile.widget_updated",
    resourceType: "manufacturer_profile",
    resourceId: id,
    resourceName: widget.name,
    actor: actorOf(req),
    message: `Manufacturer profile custom widget "${widget.name}" updated`,
  });
  const warnings = symbolWarningsForProfile(id, [{ symbol: widget.symbol, mibId: widget.mibId }]);
  res.json({ widget, warnings });
}));

router.delete(`${MP}/:id/widgets/:widgetId`, SYS_WRITE, handle(async (req, res) => {
  await deleteWidget(String(req.params.widgetId));
  void logEvent({
    action: "manufacturer_profile.widget_deleted",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: actorOf(req),
    message: "Manufacturer profile custom widget deleted",
  });
  res.status(204).end();
}));

// GET /:id/widgets/:widgetId/assets — the devices a widget applies to (polaris
// rule 130). Charon has no Asset inventory: the widget is checked to exist
// under the profile, and the list is empty (the picker's empty state).
router.get(`${MP}/:id/widgets/:widgetId/assets`, SYS_READ, handle(async (req, res) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile || !profile.widgets.some((w) => w.id === String(req.params.widgetId))) {
    throw new AppError(404, "Widget not found");
  }
  res.json({ assets: [] });
}));

// PUT /:id/widgets/:widgetId/assets — per-device switches; nothing to switch in Charon.
router.put(`${MP}/:id/widgets/:widgetId/assets`, SYS_WRITE, handle(async (req, res) => {
  const body = parseOr400(WidgetAssetsSchema, req.body);
  if ((body.enable?.length ?? 0) + (body.disable?.length ?? 0) > 0) {
    throw new AppError(400, "Charon has no asset inventory — custom widgets cannot be switched on per device");
  }
  res.json({ enabled: 0, disabled: 0 });
}));

router.get(`${MP}/:id/export`, SYS_READ, handle(async (req, res) => {
  const file = await exportProfile(String(req.params.id));
  const safe = file.manufacturer.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.manufacturer-profile.json"`);
  res.json(file);
}));

router.get(`${MP}/:id/code`, SYS_READ, handle(async (req, res) => {
  res.json(await exportProfile(String(req.params.id), { withIds: true }));
}));

router.put(`${MP}/:id/code`, SYS_WRITE, assetTypesSynced, handle(async (req, res) => {
  const body = parseOr400(ImportPreviewSchema, req.body);
  res.json(await saveProfileCode(String(req.params.id), body.file, actorOf(req)));
}));

router.put(`${MP}/:id/widget-layout`, SYS_WRITE, handle(async (req, res) => {
  const body = parseOr400(WidgetLayoutSchema, req.body);
  const layout = await setWidgetLayout(String(req.params.id), body.layout);
  void logEvent({
    action: "manufacturer_profile.widget_layout_updated",
    resourceType: "manufacturer_profile",
    resourceId: String(req.params.id),
    actor: actorOf(req),
    message: layout
      ? `Custom MIB widget layout saved (${layout.columns.length} column(s))`
      : "Custom MIB widget layout reset to the default grid",
  });
  res.json({ layout });
}));

router.delete(`${MP}/:id`, SYS_WRITE, handle(async (req, res) => {
  const id = String(req.params.id);
  const existing = await getProfile(id);
  await deleteProfile(id);
  void logEvent({
    action: "manufacturer_profile.deleted",
    resourceType: "manufacturer_profile",
    resourceId: id,
    resourceName: existing?.manufacturer,
    actor: actorOf(req),
    message: existing ? `Manufacturer profile "${existing.manufacturer}" deleted` : "Manufacturer profile deleted",
  });
  res.status(204).end();
}));
