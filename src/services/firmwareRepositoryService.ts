/**
 * src/services/firmwareRepositoryService.ts — the firmware repository
 * (Server Settings → Repository).
 *
 * Ported from polaris (src/services/firmwareRepositoryService.ts). Owns three
 * things and their invariants:
 *
 *   THE TREE. manufacturer › device type (switch / access_point / firewall) ›
 *   model. Charon adaptation: polaris folds its Asset inventory into the tree
 *   (asset counts, orphaned nodes, serial-prefix warnings); Charon has no
 *   inventory, so the tree is built from the model nodes that hold images and
 *   the scopes that carry a binding. Every assetCount is 0 and no node is
 *   flagged orphaned — "no assets" would be true of all of them and so says
 *   nothing.
 *
 *   IMAGES. One `.out` per row, bytes under FIRMWARE_DIR. Each PLATFORM under
 *   a model node keeps TWO: a new upload becomes `primary`, the displaced
 *   primary becomes `backup`, and the displaced backup is removed by the
 *   rotation. The operator can swap the two. Identity — platform, version —
 *   is parsed from the image header; the model node is only where it is filed.
 *
 *   BINDINGS. Which device-admin login (an `http` Credential, authMode
 *   "form") — or, on a FortiGate, which FortiOS API token: a `restapi`
 *   Credential, or the discovering integration's own token (`source:
 *   "integration-token"`) — applies at manufacturer, device-type or model
 *   scope; the most specific scope with a LIVE credential wins, and a binding
 *   whose credential was deleted falls through instead of shadowing a wider one.
 *
 * Charon adaptation: there is no upgrade executor (polaris's
 * firmwareUpgradeService / engines / schedules / groups need its Asset model),
 * so nothing here talks to a device and no image is ever "being flashed".
 * The binding references Credential by id only (no Prisma relation / FK), so a
 * deleted credential leaves a dangling id that reads as stale.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { FIRMWARE_DIR, FIRMWARE_INCOMING_DIR } from "../utils/paths.js";
import {
  identifyFirmwareImage,
  formatFirmwareVersion,
  IMAGE_HEADER_BYTES,
  type FirmwareVersion,
} from "../utils/firmwareVersion.js";
import { logEvent } from "./eventService.js";
import { logger } from "../utils/logger.js";

export const FIRMWARE_ASSET_TYPES = ["switch", "access_point", "firewall"] as const;
export type FirmwareAssetType = (typeof FIRMWARE_ASSET_TYPES)[number];
/**
 * Per device type: 100 MiB is the FortiSwitch upload endpoint's own ceiling
 * (and ample for a FortiAP); a FortiGate image runs to ~250 MB.
 */
export const FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE: Record<FirmwareAssetType, number> = {
  switch: 104_857_600,
  access_point: 104_857_600,
  firewall: 314_572_800,
};
/** The largest of the per-type ceilings — what the upload route accepts at all. */
export const FIRMWARE_MAX_IMAGE_BYTES = Math.max(...Object.values(FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE));
export const FIRMWARE_IMAGE_ROLES = ["primary", "backup"] as const;
export type FirmwareImageRole = (typeof FIRMWARE_IMAGE_ROLES)[number];

export function isFirmwareAssetType(v: unknown): v is FirmwareAssetType {
  return v === "switch" || v === "access_point" || v === "firewall";
}

/**
 * What a binding signs in with. `credential` is a stored Credential — a
 * device-admin `form` login on any type, or a `restapi` token on a FortiGate;
 * `integration-token` is the FortiOS API token of the integration that
 * discovered the gate (FortiGate bindings only — a CHECK in the migration).
 */
export const FIRMWARE_BINDING_SOURCES = ["credential", "integration-token"] as const;
export type FirmwareBindingSource = (typeof FIRMWARE_BINDING_SOURCES)[number];
const INTEGRATION_TOKEN_LABEL = "Integration API token";

const TYPE_LABELS: Record<FirmwareAssetType, string> = { switch: "Switch", access_point: "Access Point", firewall: "Firewall" };

function mibLabel(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MiB`;
}

/**
 * Charon adaptation: polaris canonicalises manufacturer spellings through its
 * alias table; Charon has none, so the canonical form is the trimmed input.
 */
export function normalizeManufacturer(input: string): string | null {
  const t = input.trim();
  return t || null;
}

// ─── Shapes ───────────────────────────────────────────────────────────────────

export interface FirmwareImageRow {
  id: string;
  manufacturer: string;
  assetType: string;
  model: string;
  platform: string | null;
  version: FirmwareVersion | null;
  versionLabel: string;
  build: number | null;
  parsedFrom: string;
  role: FirmwareImageRole;
  filename: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
  /** The bytes are gone from disk (a restore without data/firmware, a bad volume). */
  fileMissing: boolean;
  warnings: string[];
}

export interface FirmwareBindingRef {
  id: string;
  source: FirmwareBindingSource;
  credentialId: string | null;
  /** The credential's name, or "Integration API token". */
  credentialName: string | null;
  /** The credential was deleted; resolution skips this row. */
  stale: boolean;
}

export interface EffectiveBinding {
  source: FirmwareBindingSource;
  /** Null for an integration-token binding. */
  credentialId: string | null;
  credentialName: string;
  scope: "manufacturer" | "assetType" | "model";
}

export interface FirmwareModelNode {
  model: string;
  assetCount: number;
  orphaned: boolean;
  images: FirmwareImageRow[];
  binding: FirmwareBindingRef | null;
  effectiveBinding: EffectiveBinding | null;
}

export interface FirmwareTypeNode {
  assetType: string;
  label: string;
  engine: string | null;
  assetCount: number;
  binding: FirmwareBindingRef | null;
  effectiveBinding: EffectiveBinding | null;
  models: FirmwareModelNode[];
}

export interface FirmwareManufacturerNode {
  name: string;
  assetCount: number;
  binding: FirmwareBindingRef | null;
  effectiveBinding: EffectiveBinding | null;
  assetTypes: FirmwareTypeNode[];
}

export interface FirmwareTree {
  manufacturers: FirmwareManufacturerNode[];
}

type ImageRecord = {
  id: string; manufacturer: string; assetType: string; model: string; platform: string | null;
  versionMajor: number | null; versionMinor: number | null; versionPatch: number | null; build: number | null;
  versionLabel: string; parsedFrom: string; role: string; filename: string; sizeBytes: number; sha256: string;
  storagePath: string; notes: string | null; uploadedBy: string | null; uploadedAt: Date;
};

type BindingRecord = {
  id: string; manufacturer: string; assetType: string | null; model: string | null; credentialId: string | null;
  source?: string | null;
  credential?: { id: string; name: string; type?: string } | null;
};

function sourceOf(b: BindingRecord): FirmwareBindingSource {
  return b.source === "integration-token" ? "integration-token" : "credential";
}

/** A binding that names something live — an integration token always does; a credential binding only while its credential exists. */
export function bindingIsLive(b: BindingRecord): boolean {
  return sourceOf(b) === "integration-token" || (!!b.credentialId && !!b.credential);
}

function effectiveOf(b: BindingRecord, scope: EffectiveBinding["scope"]): EffectiveBinding {
  return sourceOf(b) === "integration-token"
    ? { source: "integration-token", credentialId: null, credentialName: INTEGRATION_TOKEN_LABEL, scope }
    : { source: "credential", credentialId: b.credentialId, credentialName: b.credential?.name ?? "", scope };
}

function versionOf(r: { versionMajor: number | null; versionMinor: number | null; versionPatch: number | null; build: number | null }): FirmwareVersion | null {
  if (r.versionMajor === null) return null;
  const v: FirmwareVersion = { major: r.versionMajor };
  if (r.versionMinor !== null) v.minor = r.versionMinor;
  if (r.versionPatch !== null) v.patch = r.versionPatch;
  if (r.build !== null) v.build = r.build;
  return v;
}

/** Warnings an image carries wherever it is shown. */
function imageWarnings(r: ImageRecord): string[] {
  const out: string[] = [];
  if (!r.platform) out.push("Only the file name was readable, so no platform is known — this image will not be offered to any device.");
  return out;
}

function toRow(r: ImageRecord, fileMissing = false): FirmwareImageRow {
  return {
    id: r.id,
    manufacturer: r.manufacturer,
    assetType: r.assetType,
    model: r.model,
    platform: r.platform,
    version: versionOf(r),
    versionLabel: r.versionLabel,
    build: r.build,
    parsedFrom: r.parsedFrom,
    role: r.role === "backup" ? "backup" : "primary",
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    notes: r.notes,
    uploadedBy: r.uploadedBy,
    uploadedAt: r.uploadedAt,
    fileMissing,
    warnings: imageWarnings(r),
  };
}

function bindingRef(b: BindingRecord | undefined): FirmwareBindingRef | null {
  if (!b) return null;
  const source = sourceOf(b);
  return {
    id: b.id,
    source,
    credentialId: b.credentialId,
    credentialName: source === "integration-token" ? INTEGRATION_TOKEN_LABEL : (b.credential?.name ?? null),
    // Charon adaptation: no FK SetNull, so a deleted credential is a dangling id.
    stale: source === "credential" && (b.credentialId === null || !b.credential),
  };
}

function nodeKey(manufacturer: string, assetType: string | null, model: string | null): string {
  return [manufacturer, assetType ?? "", model ?? ""].join("\u0000");
}

/**
 * Bindings with their credential (name + type) joined in memory — the
 * Charon stand-in for polaris's `include: { credential }` relation.
 */
async function loadBindings(where?: Record<string, unknown>): Promise<BindingRecord[]> {
  const rows = await prisma.firmwareCredentialBinding.findMany({
    ...(where ? { where } : {}),
    orderBy: [{ manufacturer: "asc" }, { assetType: "asc" }, { model: "asc" }],
  });
  const ids = Array.from(new Set(rows.map((r) => r.credentialId).filter((x): x is string => !!x)));
  const creds = ids.length
    ? await prisma.credential.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, type: true } })
    : [];
  const byId = new Map(creds.map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r, credential: r.credentialId ? (byId.get(r.credentialId) ?? null) : null }));
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

export async function ensureFirmwareDirs(): Promise<void> {
  await mkdir(FIRMWARE_INCOMING_DIR, { recursive: true });
}

/** Absolute path of an image's bytes, refused when the stored path escapes FIRMWARE_DIR. */
export function resolveImagePath(storagePath: string): string {
  const abs = resolve(FIRMWARE_DIR, storagePath);
  if (abs !== FIRMWARE_DIR && !abs.startsWith(FIRMWARE_DIR + sep)) {
    throw new AppError(500, "Firmware image path escapes the repository directory");
  }
  return abs;
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function sha256OfFile(p: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

async function readHead(p: string): Promise<Buffer> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, IMAGE_HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ─── The tree ─────────────────────────────────────────────────────────────────

/**
 * Whether a binding can sign in to a device of `assetType`. A form login fits
 * every type; a token — the integration's, or a `restapi` credential — only a
 * FortiGate (null type = a manufacturer-wide node, which a token never is).
 */
function bindingFitsType(b: BindingRecord, assetType: string | null): boolean {
  const isToken = sourceOf(b) === "integration-token" || b.credential?.type === "restapi";
  return !isToken || assetType === "firewall";
}

/**
 * The whole Repository tab in one read: the images and the bindings, folded
 * in memory. Charon adaptation: no asset groupBy — a node exists because it
 * holds images or carries a binding (a type / model binding creates its node
 * so the operator can see and change it).
 */
export async function getFirmwareTree(): Promise<FirmwareTree> {
  const [images, bindings] = await Promise.all([
    prisma.firmwareImage.findMany({ orderBy: [{ role: "asc" }, { uploadedAt: "desc" }] }),
    loadBindings(),
  ]);

  const bindingByKey = new Map<string, BindingRecord>();
  for (const b of bindings) bindingByKey.set(nodeKey(b.manufacturer, b.assetType, b.model), b);

  type MfrAcc = { name: string; types: Map<string, { models: Map<string, { images: ImageRecord[] }> }> };
  const mfrs = new Map<string, MfrAcc>();
  const mfr = (name: string): MfrAcc => {
    let m = mfrs.get(name);
    if (!m) { m = { name, types: new Map() }; mfrs.set(name, m); }
    return m;
  };
  const type = (m: MfrAcc, t: string) => {
    let x = m.types.get(t);
    if (!x) { x = { models: new Map() }; m.types.set(t, x); }
    return x;
  };
  const model = (m: MfrAcc, t: string, name: string) => {
    const tt = type(m, t);
    let md = tt.models.get(name);
    if (!md) { md = { images: [] }; tt.models.set(name, md); }
    return md;
  };

  for (const img of images) model(mfr(img.manufacturer), img.assetType, img.model).images.push(img as ImageRecord);
  for (const b of bindings) {
    const m = mfr(b.manufacturer);
    if (b.assetType && b.model !== null) model(m, b.assetType, b.model);
    else if (b.assetType) type(m, b.assetType);
  }

  const effectiveFor = (manufacturer: string, assetType: string | null, modelName: string | null): EffectiveBinding | null => {
    const tiers: Array<[BindingRecord | undefined, EffectiveBinding["scope"]]> = [
      [modelName !== null && assetType !== null ? bindingByKey.get(nodeKey(manufacturer, assetType, modelName)) : undefined, "model"],
      [assetType !== null ? bindingByKey.get(nodeKey(manufacturer, assetType, null)) : undefined, "assetType"],
      [bindingByKey.get(nodeKey(manufacturer, null, null)), "manufacturer"],
    ];
    for (const [b, scope] of tiers) {
      // A token kind only signs in to a FortiGate: on a switch / AP node it is skipped.
      if (b && bindingIsLive(b) && bindingFitsType(b, assetType)) return effectiveOf(b, scope);
    }
    return null;
  };

  const manufacturers: FirmwareManufacturerNode[] = [];
  for (const m of Array.from(mfrs.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    const assetTypes: FirmwareTypeNode[] = [];
    for (const t of FIRMWARE_ASSET_TYPES) {
      const tt = m.types.get(t);
      if (!tt) continue;
      const models: FirmwareModelNode[] = [];
      for (const [name, md] of Array.from(tt.models.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        models.push({
          model: name,
          assetCount: 0,
          orphaned: false,
          images: md.images
            .sort((a, b) => (a.role === b.role ? b.uploadedAt.getTime() - a.uploadedAt.getTime() : a.role === "primary" ? -1 : 1))
            .map((img) => toRow(img, false)),
          binding: bindingRef(bindingByKey.get(nodeKey(m.name, t, name))),
          effectiveBinding: effectiveFor(m.name, t, name),
        });
      }
      assetTypes.push({
        assetType: t,
        label: TYPE_LABELS[t],
        // Charon adaptation: no upgrade engines — images are stored, never flashed.
        engine: null,
        assetCount: 0,
        binding: bindingRef(bindingByKey.get(nodeKey(m.name, t, null))),
        effectiveBinding: effectiveFor(m.name, t, null),
        models,
      });
    }
    manufacturers.push({
      name: m.name,
      assetCount: 0,
      binding: bindingRef(bindingByKey.get(nodeKey(m.name, null, null))),
      effectiveBinding: effectiveFor(m.name, null, null),
      assetTypes,
    });
  }
  return { manufacturers };
}

// ─── Images ───────────────────────────────────────────────────────────────────

export async function listImages(filter: { manufacturer?: string; assetType?: string; model?: string } = {}): Promise<FirmwareImageRow[]> {
  const where: Record<string, unknown> = {};
  if (filter.manufacturer) where.manufacturer = normalizeManufacturer(filter.manufacturer);
  if (filter.assetType) where.assetType = filter.assetType;
  if (filter.model !== undefined) where.model = filter.model;
  const rows = await prisma.firmwareImage.findMany({ where, orderBy: [{ manufacturer: "asc" }, { assetType: "asc" }, { model: "asc" }, { role: "asc" }] });
  const out: FirmwareImageRow[] = [];
  for (const r of rows) out.push(toRow(r as ImageRecord, !(await fileExists(resolveImagePath(r.storagePath)))));
  return out;
}

export async function getImage(id: string): Promise<FirmwareImageRow> {
  const r = await prisma.firmwareImage.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "Firmware image not found");
  return toRow(r as ImageRecord, !(await fileExists(resolveImagePath(r.storagePath))));
}

export interface RegisterImageInput {
  tmpPath: string;
  originalName: string;
  sizeBytes: number;
  manufacturer: string;
  assetType: string;
  model: string;
  notes?: string | null;
  actor?: string | null;
}

export interface RegisterImageResult {
  image: FirmwareImageRow;
  /** The backup the rotation removed, if the platform already held two. */
  rotatedOut: { id: string; versionLabel: string; filename: string } | null;
  /** The previous primary, now the backup. */
  demoted: { id: string; versionLabel: string } | null;
  warnings: string[];
}

/**
 * Resolve a multer temp path and prove it sits inside FIRMWARE_INCOMING_DIR,
 * or null. Every file operation on an upload goes through this first — a path
 * that fails it is never read, renamed OR deleted.
 */
function incomingPath(tmpPath: string): string | null {
  const tmp = resolve(tmpPath);
  return tmp.startsWith(FIRMWARE_INCOMING_DIR + sep) ? tmp : null;
}

/** Remove an upload the route refused before registering it. A path outside the incoming directory is left alone. */
export async function discardIncomingUpload(tmpPath: string): Promise<void> {
  const tmp = incomingPath(tmpPath);
  if (tmp) await rm(tmp, { force: true }).catch(() => undefined);
}

function typeSentenceLabel(t: FirmwareAssetType): string {
  return t === "firewall" ? "Firewall" : t === "access_point" ? "Access point" : "Switch";
}

/**
 * Register an upload that multer already wrote under FIRMWARE_INCOMING_DIR.
 * Identity from the header (filename fallback), sha256 by stream, then ONE
 * transaction rotates the platform's pair: the current backup is deleted, the
 * current primary becomes backup, the new row is primary. The rename to its
 * final name happens after the row exists; on any failure the temp file is
 * removed.
 */
export async function registerUploadedImage(input: RegisterImageInput): Promise<RegisterImageResult> {
  const tmp = incomingPath(input.tmpPath);
  // Refused, NOT removed: a path that failed containment is not ours to delete.
  if (!tmp) throw new AppError(400, "Upload landed outside the firmware incoming directory");
  try {
    const manufacturer = normalizeManufacturer(input.manufacturer);
    if (!manufacturer) throw new AppError(400, "manufacturer is required");
    if (!isFirmwareAssetType(input.assetType)) throw new AppError(400, "assetType must be switch, access_point or firewall");
    const model = input.model.trim();
    if (!model) throw new AppError(400, "model is required");
    if (input.sizeBytes <= 0) throw new AppError(400, "The uploaded file is empty");
    const cap = FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE[input.assetType];
    if (input.sizeBytes > cap) throw new AppError(413, `${typeSentenceLabel(input.assetType)} firmware images are limited to ${cap} bytes (${mibLabel(cap)})`);

    const head = await readHead(tmp);
    const identity = identifyFirmwareImage(head, input.originalName);
    if (!identity) {
      throw new AppError(400, "This file is not a recognisable firmware image — no Fortinet header and no version in the file name");
    }
    const warnings: string[] = [];
    if (identity.parsedFrom === "filename") {
      warnings.push("Only the file name was readable, so no platform is known — this image will not be offered to any device.");
    }
    const filedAs = input.assetType === "access_point" ? "an access-point" : input.assetType === "firewall" ? "a firewall" : "a switch";
    if (identity.family === "switch" && input.assetType !== "switch") warnings.push(`The image header says this is a FortiSwitch image, but it is being filed under ${filedAs} model.`);
    if (identity.family === "ap" && input.assetType !== "access_point") warnings.push(`The image header says this is a FortiAP image, but it is being filed under ${filedAs} model.`);
    if (identity.family === "firewall" && input.assetType !== "firewall") warnings.push(`The image header says this is a FortiGate image, but it is being filed under ${filedAs} model.`);

    const sha256 = await sha256OfFile(tmp);
    const dup = await prisma.firmwareImage.findUnique({ where: { sha256 } });
    if (dup) {
      throw new AppError(409, `This exact image is already in the repository under ${dup.manufacturer} › ${dup.assetType} › ${dup.model} (${dup.versionLabel})`);
    }

    // The pair this image joins: its PLATFORM's under the node. A node can hold
    // several platforms, and a per-node pair would let one platform's upload
    // demote, then delete, another's primary.
    const existing = await prisma.firmwareImage.findMany({ where: { manufacturer, assetType: input.assetType, model, platform: identity.platform } });
    const primary = existing.find((r) => r.role === "primary") ?? null;
    const backup = existing.find((r) => r.role === "backup") ?? null;

    const versionLabel = formatFirmwareVersion(identity.version);
    const created = await prisma.$transaction(async (tx) => {
      if (backup) await tx.firmwareImage.delete({ where: { id: backup.id } });
      if (primary) await tx.firmwareImage.update({ where: { id: primary.id }, data: { role: "backup" } });
      return tx.firmwareImage.create({
        data: {
          manufacturer,
          assetType: input.assetType,
          model,
          platform: identity.platform,
          versionMajor: identity.version.major,
          versionMinor: identity.version.minor ?? null,
          versionPatch: identity.version.patch ?? null,
          build: identity.version.build ?? null,
          versionLabel,
          parsedFrom: identity.parsedFrom,
          role: "primary",
          filename: input.originalName.replace(/\\/g, "/").split("/").pop() ?? input.originalName,
          sizeBytes: input.sizeBytes,
          sha256,
          storagePath: "pending",
          notes: input.notes?.trim() || null,
          uploadedBy: input.actor ?? null,
        },
      });
    });
    const storagePath = `${created.id}.out`;
    await mkdir(FIRMWARE_DIR, { recursive: true });
    try {
      await rename(tmp, resolveImagePath(storagePath));
      await prisma.firmwareImage.update({ where: { id: created.id }, data: { storagePath } });
    } catch (err) {
      // Undo the row; the rotation already happened but the bytes never landed.
      await prisma.firmwareImage.delete({ where: { id: created.id } }).catch(() => undefined);
      throw err;
    }
    if (backup) await rm(resolveImagePath(backup.storagePath), { force: true }).catch(() => undefined);

    await logEvent({
      action: "firmware.image_uploaded",
      resourceType: "firmware_image",
      resourceId: created.id,
      resourceName: `${manufacturer} › ${input.assetType} › ${model} — ${versionLabel}`,
      actor: input.actor ?? undefined,
      level: "info",
      message: `Firmware ${versionLabel} (${identity.platform ?? "no platform"}) uploaded for ${manufacturer} ${model} as primary`
        + (primary ? `; ${primary.versionLabel} is now the backup` : "")
        + (backup ? `; ${backup.versionLabel} removed` : ""),
      details: { manufacturer, assetType: input.assetType, model, platform: identity.platform, versionLabel, sha256, sizeBytes: input.sizeBytes, parsedFrom: identity.parsedFrom, demoted: primary?.id ?? null, rotatedOut: backup?.id ?? null },
    });
    if (backup) {
      await logEvent({
        action: "firmware.image_deleted",
        resourceType: "firmware_image",
        resourceId: backup.id,
        resourceName: `${manufacturer} › ${input.assetType} › ${model} — ${backup.versionLabel}`,
        actor: input.actor ?? undefined,
        level: "warning",
        message: `Firmware ${backup.versionLabel} removed from ${manufacturer} ${model} by the upload of ${versionLabel} (each platform keeps two images)`,
        details: { manufacturer, assetType: input.assetType, model, sha256: backup.sha256, rotation: true },
      });
    }
    const row = toRow({ ...(created as ImageRecord), storagePath }, false);
    row.warnings = warnings;
    return {
      image: row,
      rotatedOut: backup ? { id: backup.id, versionLabel: backup.versionLabel, filename: backup.filename } : null,
      demoted: primary ? { id: primary.id, versionLabel: primary.versionLabel } : null,
      warnings,
    };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Swap a platform's primary and backup. */
export async function setPrimaryImage(id: string, actor?: string | null): Promise<FirmwareImageRow> {
  const r = await prisma.firmwareImage.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "Firmware image not found");
  if (r.role === "primary") throw new AppError(400, "That image is already the primary");
  const current = await prisma.firmwareImage.findFirst({ where: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, platform: r.platform, role: "primary" } });
  await prisma.$transaction(async (tx) => {
    // Through a neutral role so the partial unique on "primary" never sees two.
    await tx.firmwareImage.update({ where: { id: r.id }, data: { role: "swapping" } });
    if (current) await tx.firmwareImage.update({ where: { id: current.id }, data: { role: "backup" } });
    await tx.firmwareImage.update({ where: { id: r.id }, data: { role: "primary" } });
  });
  await logEvent({
    action: "firmware.image_promoted",
    resourceType: "firmware_image",
    resourceId: r.id,
    resourceName: `${r.manufacturer} › ${r.assetType} › ${r.model} — ${r.versionLabel}`,
    actor: actor ?? undefined,
    level: "info",
    message: `Firmware ${r.versionLabel} is now the primary image for ${r.manufacturer} ${r.model}` + (current ? ` (${current.versionLabel} is the backup)` : ""),
    details: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, demoted: current?.id ?? null },
  });
  return getImage(r.id);
}

/** Delete one image. Deleting a primary promotes its platform's backup, so no platform has a backup alone. */
export async function deleteImage(id: string, actor?: string | null): Promise<void> {
  const r = await prisma.firmwareImage.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "Firmware image not found");
  const backup = r.role === "primary"
    ? await prisma.firmwareImage.findFirst({ where: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, platform: r.platform, role: "backup" } })
    : null;
  await prisma.$transaction(async (tx) => {
    await tx.firmwareImage.delete({ where: { id: r.id } });
    if (backup) await tx.firmwareImage.update({ where: { id: backup.id }, data: { role: "primary" } });
  });
  await rm(resolveImagePath(r.storagePath), { force: true }).catch((err) => logger.warn({ err, id }, "firmware image row deleted but its file could not be removed"));
  await logEvent({
    action: "firmware.image_deleted",
    resourceType: "firmware_image",
    resourceId: r.id,
    resourceName: `${r.manufacturer} › ${r.assetType} › ${r.model} — ${r.versionLabel}`,
    actor: actor ?? undefined,
    level: "warning",
    message: `Firmware ${r.versionLabel} deleted from ${r.manufacturer} ${r.model}` + (backup ? ` (${backup.versionLabel} promoted to primary)` : ""),
    details: { manufacturer: r.manufacturer, assetType: r.assetType, model: r.model, sha256: r.sha256, promoted: backup?.id ?? null },
  });
}

/** Delete every image under a model node. */
export async function purgeModelImages(input: { manufacturer: string; assetType: string; model: string }, actor?: string | null): Promise<{ deleted: number }> {
  const manufacturer = normalizeManufacturer(input.manufacturer);
  if (!manufacturer) throw new AppError(400, "manufacturer is required");
  if (!isFirmwareAssetType(input.assetType)) throw new AppError(400, "assetType must be switch, access_point or firewall");
  const rows = await prisma.firmwareImage.findMany({ where: { manufacturer, assetType: input.assetType, model: input.model } });
  if (rows.length === 0) return { deleted: 0 };
  await prisma.firmwareImage.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  for (const r of rows) await rm(resolveImagePath(r.storagePath), { force: true }).catch(() => undefined);
  await logEvent({
    action: "firmware.model_purged",
    resourceType: "firmware_image",
    resourceId: `${manufacturer}/${input.assetType}/${input.model}`,
    resourceName: `${manufacturer} › ${input.assetType} › ${input.model}`,
    actor: actor ?? undefined,
    level: "warning",
    message: `All firmware (${rows.map((r) => r.versionLabel).join(", ")}) deleted for ${manufacturer} ${input.model}`,
    details: { manufacturer, assetType: input.assetType, model: input.model, imageIds: rows.map((r) => r.id) },
  });
  return { deleted: rows.length };
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

export interface BindingScope { manufacturer: string; assetType: string | null; model: string | null }

function assertBindingScope(input: { manufacturer: string; assetType?: string | null; model?: string | null }): BindingScope {
  const manufacturer = normalizeManufacturer(input.manufacturer ?? "");
  if (!manufacturer) throw new AppError(400, "manufacturer is required");
  const assetType = input.assetType ? String(input.assetType) : null;
  const model = input.model !== undefined && input.model !== null ? String(input.model) : null;
  if (assetType !== null && !isFirmwareAssetType(assetType)) throw new AppError(400, "assetType must be switch, access_point or firewall");
  if (model !== null && assetType === null) throw new AppError(400, "A model binding needs its device type");
  return { manufacturer, assetType, model };
}

export async function listBindings(): Promise<Array<BindingScope & FirmwareBindingRef>> {
  const rows = await loadBindings();
  return rows.map((b) => ({ manufacturer: b.manufacturer, assetType: b.assetType, model: b.model, ...bindingRef(b)! }));
}

/** An `http` credential in "Device admin login (form)" mode. */
export function isDeviceLoginCredential(config: unknown): boolean {
  return !!config && typeof config === "object" && (config as { authMode?: unknown }).authMode === "form";
}

/**
 * Bind a login at one scope (upsert by scope). `source: "integration-token"`
 * binds the discovering integration's API token (a FortiGate scope only);
 * otherwise `credentialId` names a device-admin `form` login, or — on a
 * FortiGate scope — a `restapi` token credential. `credentialId: null` with
 * the default source removes the binding.
 */
export async function upsertBinding(input: { manufacturer: string; assetType?: string | null; model?: string | null; credentialId: string | null; source?: FirmwareBindingSource; actor?: string | null }): Promise<FirmwareBindingRef | null> {
  const scope = assertBindingScope(input);
  const source: FirmwareBindingSource = input.source ?? "credential";
  const existing = await prisma.firmwareCredentialBinding.findFirst({ where: { manufacturer: scope.manufacturer, assetType: scope.assetType, model: scope.model } });
  const scopeLabel = [scope.manufacturer, scope.assetType, scope.model].filter(Boolean).join(" › ");
  if (source === "credential" && input.credentialId === null) {
    if (existing) {
      await prisma.firmwareCredentialBinding.delete({ where: { id: existing.id } });
      await logEvent({ action: "firmware.binding_deleted", resourceType: "firmware_binding", resourceId: existing.id, resourceName: scopeLabel, actor: input.actor ?? undefined, level: "info", message: `Device login binding removed at ${scopeLabel}`, details: { ...scope } });
    }
    return null;
  }
  let data: { source: FirmwareBindingSource; credentialId: string | null };
  let what: string;
  let credential: { id: string; name: string; type: string } | null = null;
  if (source === "integration-token") {
    if (scope.assetType !== "firewall") throw new AppError(400, "The integration's API token can only sign in to FortiGates — bind it on a Firewall node");
    data = { source, credentialId: null };
    what = "the discovering integration's API token";
  } else {
    const cred = await prisma.credential.findUnique({ where: { id: input.credentialId! }, select: { id: true, name: true, type: true, config: true } });
    if (!cred) throw new AppError(400, "The selected credential no longer exists");
    const isLogin = cred.type === "http" && isDeviceLoginCredential(cred.config);
    const isToken = cred.type === "restapi";
    if (isToken && scope.assetType !== "firewall") throw new AppError(400, "A REST API token credential can only sign in to FortiGates — bind it on a Firewall node");
    if (!isLogin && !isToken) {
      throw new AppError(400, scope.assetType === "firewall"
        ? "A firewall binding needs an HTTP credential in \"Device admin login (form)\" mode or a REST API credential"
        : "A firmware binding needs an HTTP credential in \"Device admin login (form)\" mode");
    }
    data = { source, credentialId: cred.id };
    credential = { id: cred.id, name: cred.name, type: cred.type };
    what = `${isToken ? "REST API token" : "device login"} "${cred.name}"`;
  }
  const row = existing
    ? await prisma.firmwareCredentialBinding.update({ where: { id: existing.id }, data })
    : await prisma.firmwareCredentialBinding.create({ data: { ...scope, ...data, createdBy: input.actor ?? null } });
  await logEvent({
    action: "firmware.binding_set",
    resourceType: "firmware_binding",
    resourceId: row.id,
    resourceName: scopeLabel,
    actor: input.actor ?? undefined,
    level: "info",
    message: `${what.charAt(0).toUpperCase()}${what.slice(1)} bound at ${scopeLabel}`,
    details: { ...scope, source, credentialId: data.credentialId, credentialName: credential?.name ?? null },
  });
  return bindingRef({ ...row, credential });
}

export async function deleteBinding(id: string, actor?: string | null): Promise<void> {
  const b = await prisma.firmwareCredentialBinding.findUnique({ where: { id } });
  if (!b) throw new AppError(404, "Firmware binding not found");
  await prisma.firmwareCredentialBinding.delete({ where: { id } });
  const scopeLabel = [b.manufacturer, b.assetType, b.model].filter(Boolean).join(" › ");
  await logEvent({ action: "firmware.binding_deleted", resourceType: "firmware_binding", resourceId: id, resourceName: scopeLabel, actor: actor ?? undefined, level: "info", message: `Device login binding removed at ${scopeLabel}`, details: { manufacturer: b.manufacturer, assetType: b.assetType, model: b.model } });
}

/**
 * The stored credential the Repository's login binding hands each device, for
 * the Stored Credentials usage count: one bindings read, folded in memory with
 * the same tier order and liveness / type-fit tests as the tree. A winning
 * integration-token binding names no stored credential, so that device maps
 * to nothing. Charon has no inventory, so callers usually pass no devices.
 */
export async function firmwareBindingCredentialIds(
  assets: Array<{ id: string; manufacturer: string | null; assetType: string; model: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const eligible = assets.filter((a) => a.manufacturer && isFirmwareAssetType(a.assetType));
  if (eligible.length === 0) return out;
  const rows = await loadBindings();
  if (rows.length === 0) return out;
  for (const a of eligible) {
    const manufacturer = normalizeManufacturer(a.manufacturer!);
    const live = rows.filter((b) => b.manufacturer === manufacturer && bindingIsLive(b) && bindingFitsType(b, a.assetType));
    const b =
      live.find((r) => r.assetType === a.assetType && r.model !== null && r.model === (a.model ?? "")) ??
      live.find((r) => r.assetType === a.assetType && r.model === null) ??
      live.find((r) => r.assetType === null);
    if (b && sourceOf(b) === "credential" && b.credentialId) out.set(a.id, b.credentialId);
  }
  return out;
}

// ─── Node assets / runs (no inventory, no executor in Charon) ─────────────────

/** The device-list slide-in's cap (kept for response-shape parity with polaris). */
export const FIRMWARE_NODE_ASSET_LIMIT = 2000;

/**
 * The devices behind one tree node. Charon adaptation: there is no Asset
 * inventory, so the list is always empty — same response shape as polaris.
 */
export async function listAssetsForNode(_input: { manufacturer: string; assetType?: string | null; model?: string | null; noModel?: boolean }): Promise<{ total: number; limit: number; assets: never[] }> {
  return { total: 0, limit: FIRMWARE_NODE_ASSET_LIMIT, assets: [] };
}

/**
 * Recent upgrade runs. Charon adaptation: Charon never flashes a device (no
 * executor, no Asset model), so no run exists and none is stored.
 */
export async function listRecentRuns(_opts: { limit?: number; status?: string } = {}): Promise<never[]> {
  return [];
}

export async function getRun(_id: string): Promise<never> {
  throw new AppError(404, "Firmware upgrade run not found");
}
