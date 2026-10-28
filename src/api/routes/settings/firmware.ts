/**
 * src/api/routes/settings/firmware.ts — Server Settings: Repository tab (firmware images).
 *
 * Ported from polaris (src/api/routes/firmware.ts → firmwareRouter) to back
 * the ported public/js/server-settings-firmware.js module at the exact paths
 * public/js/settings-api.js calls. Mounted WITHOUT a router-level gate
 * (router.ts) — every route declares its own requirePermission(), because a
 * router.use() gate here would also fire for every other /server-settings path
 * that passes through this router.
 *
 * Charon adaptation: polaris gates on its own `firmware` key; Charon has none,
 * so the Repository rides serverSettingsSystem — read to look, fullwrite to
 * upload / delete / promote / purge / bind. Polaris's /assets/:id/firmware-upgrade
 * and /assets/firmware-groups routers are not ported (no Asset inventory, no
 * upgrade executor): /runs is always empty and /assets lists no devices.
 *
 *   GET    /server-settings/firmware/tree                  read
 *   GET    /server-settings/firmware/assets                read   (always empty)
 *   GET    /server-settings/firmware/images                read
 *   POST   /server-settings/firmware/images                fullwrite (multipart, ≤ 300 MiB)
 *   GET    /server-settings/firmware/images/:id            read
 *   POST   /server-settings/firmware/images/:id/make-primary fullwrite
 *   DELETE /server-settings/firmware/images/:id            fullwrite
 *   POST   /server-settings/firmware/models/purge          fullwrite
 *   GET    /server-settings/firmware/bindings              read
 *   PUT    /server-settings/firmware/bindings              fullwrite
 *   DELETE /server-settings/firmware/bindings/:id          fullwrite
 *   GET    /server-settings/firmware/runs                  read   (always empty)
 *   GET    /server-settings/firmware/runs/:id              read   (always 404)
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { AppError } from "../../../utils/errors.js";
import { FIRMWARE_INCOMING_DIR } from "../../../utils/paths.js";
import {
  FIRMWARE_ASSET_TYPES,
  FIRMWARE_MAX_IMAGE_BYTES,
  FIRMWARE_BINDING_SOURCES,
  getFirmwareTree,
  listImages,
  getImage,
  registerUploadedImage,
  discardIncomingUpload,
  setPrimaryImage,
  deleteImage,
  purgeModelImages,
  listBindings,
  upsertBinding,
  deleteBinding,
  listRecentRuns,
  getRun,
  listAssetsForNode,
} from "../../../services/firmwareRepositoryService.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AssetTypeSchema = z.enum(FIRMWARE_ASSET_TYPES);

const NodeAssetsQuerySchema = z.object({
  manufacturer: z.string().trim().min(1),
  assetType: AssetTypeSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  // The tree's "(no model)" node — a flag, because a query string drops an empty model.
  noModel: z.enum(["1", "true"]).optional().transform((v) => v !== undefined),
})
  .refine((q) => (q.model === undefined && !q.noModel) || q.assetType !== undefined, { message: "model needs assetType" })
  .refine((q) => !(q.model && q.noModel), { message: "model and noModel are exclusive" });

const ImageListQuerySchema = z.object({
  manufacturer: z.string().trim().min(1).optional(),
  assetType: AssetTypeSchema.optional(),
  model: z.string().optional(),
});

// Parsed from req.body AFTER multer has read the multipart text fields.
const ImageUploadFieldsSchema = z.object({
  manufacturer: z.string().trim().min(1, "manufacturer is required").max(200),
  assetType: AssetTypeSchema,
  model: z.string().trim().min(1, "model is required").max(200),
  notes: z.string().trim().max(2000).optional(),
});

const ModelScopeSchema = z.object({
  manufacturer: z.string().trim().min(1).max(200),
  assetType: AssetTypeSchema,
  model: z.string().min(1).max(200),
});

const BindingUpsertSchema = z.object({
  manufacturer: z.string().trim().min(1).max(200),
  assetType: AssetTypeSchema.optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  credentialId: z.string().uuid().nullable(),
  // "integration-token" binds the discovering integration's FortiOS API token
  // (a firewall scope only; credentialId is then null).
  source: z.enum(FIRMWARE_BINDING_SOURCES).optional(),
});

const RunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "unverified"]).optional(),
});

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid request";
}

function actorOf(req: Request): string | null {
  return req.session?.username ?? null;
}

// ─── Upload storage ───────────────────────────────────────────────────────────

// Disk, never memory: an image is up to 300 MiB (a FortiGate). Into
// FIRMWARE_DIR/.incoming (not os.tmpdir()) so the service's final rename is on
// one filesystem and atomic. multer answers LIMIT_FILE_SIZE before the handler
// sees anything; the permission check runs BEFORE multer touches the body.
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { mkdirSync(FIRMWARE_INCOMING_DIR, { recursive: true }); cb(null, FIRMWARE_INCOMING_DIR); }
      catch (err) { cb(err as Error, FIRMWARE_INCOMING_DIR); }
    },
    filename: (_req, _file, cb) => cb(null, `firmware-upload-${Date.now()}-${randomBytes(6).toString("hex")}`),
  }),
  limits: { fileSize: FIRMWARE_MAX_IMAGE_BYTES, files: 1 },
});

function uploadSingle(field: string) {
  const mw = imageUpload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") return next(new AppError(413, `Firmware images are limited to ${Math.round(FIRMWARE_MAX_IMAGE_BYTES / 1_048_576)} MiB`));
      if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") return next(new AppError(400, `Send exactly one file in the "${field}" field`));
      next(err);
    });
  };
}

// ─── /server-settings/firmware ────────────────────────────────────────────────

const READ = requirePermission("serverSettingsSystem", "read");
const WRITE = requirePermission("serverSettingsSystem", "fullwrite");

const router = Router();

router.get("/firmware/tree", READ, async (_req, res) => {
  res.json(await getFirmwareTree());
});

// The asset-count slide-in on a tree node. Polaris also required assets:read;
// Charon has no inventory, so this answers an empty list.
router.get("/firmware/assets", READ, async (req, res) => {
  const q = NodeAssetsQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json(await listAssetsForNode(q.data));
});

router.get("/firmware/images", READ, async (req, res) => {
  const q = ImageListQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ images: await listImages(q.data) });
});

router.post("/firmware/images", WRITE, uploadSingle("file"), async (req, res) => {
  if (!req.file) throw new AppError(400, "Missing 'file' upload");
  const fields = ImageUploadFieldsSchema.safeParse(req.body ?? {});
  if (!fields.success) {
    await discardIncomingUpload(req.file.path);
    throw new AppError(400, firstIssue(fields.error));
  }
  const result = await registerUploadedImage({
    tmpPath: req.file.path,
    originalName: req.file.originalname,
    sizeBytes: req.file.size,
    manufacturer: fields.data.manufacturer,
    assetType: fields.data.assetType,
    model: fields.data.model,
    notes: fields.data.notes ?? null,
    actor: actorOf(req),
  });
  res.status(201).json(result);
});

router.get("/firmware/images/:id", READ, async (req, res) => {
  res.json({ image: await getImage(String(req.params.id)) });
});

router.post("/firmware/images/:id/make-primary", WRITE, async (req, res) => {
  res.json({ image: await setPrimaryImage(String(req.params.id), actorOf(req)) });
});

router.delete("/firmware/images/:id", WRITE, async (req, res) => {
  await deleteImage(String(req.params.id), actorOf(req));
  res.status(204).end();
});

// Body, not path params: a model string carries spaces and slashes.
router.post("/firmware/models/purge", WRITE, async (req, res) => {
  const body = ModelScopeSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  res.json(await purgeModelImages(body.data, actorOf(req)));
});

router.get("/firmware/bindings", READ, async (_req, res) => {
  res.json({ bindings: await listBindings() });
});

router.put("/firmware/bindings", WRITE, async (req, res) => {
  const body = BindingUpsertSchema.safeParse(req.body ?? {});
  if (!body.success) throw new AppError(400, firstIssue(body.error));
  // Polaris also writes a credential-use audit row here (its rule 112); Charon
  // has no such ledger — the firmware.binding_set Event is the record.
  const binding = await upsertBinding({ ...body.data, actor: actorOf(req) });
  res.json({ binding });
});

router.delete("/firmware/bindings/:id", WRITE, async (req, res) => {
  await deleteBinding(String(req.params.id), actorOf(req));
  res.status(204).end();
});

router.get("/firmware/runs", READ, async (req, res) => {
  const q = RunsQuerySchema.safeParse(req.query);
  if (!q.success) throw new AppError(400, firstIssue(q.error));
  res.json({ runs: await listRecentRuns(q.data) });
});

router.get("/firmware/runs/:id", READ, async (req, res) => {
  res.json({ run: await getRun(String(req.params.id)) });
});

export default router;
