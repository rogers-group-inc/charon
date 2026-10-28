/**
 * tests/unit/firmwareRepository.test.ts
 *
 * Ported from polaris (tests/unit/firmwareImageRotation.test.ts). Each
 * platform under a model node keeps two images: a new upload becomes the
 * PRIMARY, the displaced primary becomes the BACKUP, and the displaced backup
 * is removed — row, file and an Event saying so. The operator may swap the
 * two; deleting the primary promotes the backup; purging a node removes both.
 *
 * Charon differences: no "being flashed" refusals (no executor), no
 * serial-prefix warning (no inventory), and bindings join Credential in memory.
 *
 * Prisma is mocked with an in-memory table; the files are real, in a temp
 * directory standing in for FIRMWARE_DIR.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dirs = vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "charon-fw-"));
  fs.mkdirSync(path.join(root, ".incoming"), { recursive: true });
  return { root, incoming: path.join(root, ".incoming") };
});

const h = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const state = { images: [] as Row[], bindings: [] as Row[], credentials: [] as Row[], seq: 0 };
  const match = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
  const table = (get: () => Row[], set: (rows: Row[]) => void, prefix: string) => ({
    findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => get().filter((r) => !args?.where || match(r, args.where))),
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => get().find((r) => match(r, args.where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => get().find((r) => match(r, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `${prefix}-${++state.seq}`, uploadedAt: new Date(Date.now() + state.seq), ...data } as Row; get().push(row); return row; }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const row = get().find((r) => r.id === where.id)!; Object.assign(row, data); return row; }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => { set(get().filter((r) => r.id !== where.id)); return {}; }),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => { set(get().filter((r) => !where.id.in.includes(r.id))); return {}; }),
  });
  const firmwareImage = table(() => state.images, (r) => { state.images = r; }, "img");
  const firmwareCredentialBinding = table(() => state.bindings, (r) => { state.bindings = r; }, "bind");
  const credential = table(() => state.credentials, (r) => { state.credentials = r; }, "cred");
  return {
    state,
    logEvent: vi.fn(async () => {}),
    prisma: {
      firmwareImage,
      firmwareCredentialBinding,
      credential,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ firmwareImage })),
    },
  };
});

vi.mock("../../src/utils/paths.js", () => ({ FIRMWARE_DIR: dirs.root, FIRMWARE_INCOMING_DIR: dirs.incoming, STATE_DIR: dirs.root }));
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventService.js", () => ({ logEvent: h.logEvent }));

import {
  registerUploadedImage, discardIncomingUpload, setPrimaryImage, deleteImage, purgeModelImages,
  getFirmwareTree, upsertBinding, listBindings,
} from "../../src/services/firmwareRepositoryService.js";

let n = 0;
function stageUpload(header: string, filler = "x"): { tmpPath: string; sizeBytes: number } {
  const p = join(dirs.incoming, `firmware-upload-${Date.now()}-${++n}`);
  const buf = Buffer.alloc(1024, filler);
  buf.write(header, 8, "latin1");
  writeFileSync(p, buf);
  return { tmpPath: p, sizeBytes: buf.length };
}
const NODE = { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF" };
function upload(header: string, filler: string, name = "FSW_108F-v7-build0000-FORTINET.out") {
  return registerUploadedImage({ ...stageUpload(header, filler), originalName: name, ...NODE, actor: "tester" });
}
const events = () => h.logEvent.mock.calls.map((c) => (c as unknown[])[0] as { action: string; message: string });
const filesOnDisk = () => readdirSync(dirs.root).filter((f) => f.endsWith(".out"));
const role = (id: string) => h.state.images.find((i) => i.id === id)?.role;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.images = [];
  h.state.bindings = [];
  h.state.credentials = [];
  for (const f of filesOnDisk()) rmSync(join(dirs.root, f), { force: true });
});
afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

describe("the pair belongs to a PLATFORM under the node, not to the node", () => {
  it("a second platform's upload leaves the first platform's primary alone", async () => {
    const a = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const b = await upload("S124FP-7.06-FW-build1164-260709-patch08", "b");
    expect(b.demoted).toBeNull();
    expect(b.rotatedOut).toBeNull();
    expect(role(a.image.id)).toBe("primary");
    expect(role(b.image.id)).toBe("primary");
  });

  it("rotation stays inside the uploaded image's platform", async () => {
    const a1 = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const b1 = await upload("S124FP-7.06-FW-build1164-260709-patch08", "b");
    const a2 = await upload("S108FF-7.06-FW-build1200-260901-patch09", "c");
    expect(a2.demoted).toEqual({ id: a1.image.id, versionLabel: "7.6.8 build1164" });
    const a3 = await upload("S108FF-7.06-FW-build1250-261001-patch10", "d");
    expect(a3.rotatedOut?.id).toBe(a1.image.id);
    expect(role(a2.image.id)).toBe("backup");
    expect(role(a3.image.id)).toBe("primary");
    expect(role(b1.image.id)).toBe("primary");
    expect(h.state.images).toHaveLength(3);
  });

  it("deleting a primary promotes its own platform's backup, never another platform's", async () => {
    const a1 = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const a2 = await upload("S108FF-7.06-FW-build1200-260901-patch09", "c");
    const b1 = await upload("S124FP-7.06-FW-build1164-260709-patch08", "b");
    const b2 = await upload("S124FP-7.06-FW-build1200-260901-patch09", "e");
    await deleteImage(b2.image.id, "tester");
    expect(role(b1.image.id)).toBe("primary");
    expect(role(a1.image.id)).toBe("backup");
    expect(role(a2.image.id)).toBe("primary");
  });
});

describe("uploading into a model node", () => {
  it("the first image is the primary, its bytes land as <id>.out and the temp file is gone", async () => {
    const r = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    expect(r.image.role).toBe("primary");
    expect(r.image.platform).toBe("S108FF");
    expect(r.image.versionLabel).toBe("7.6.8 build1164");
    expect(filesOnDisk()).toEqual([`${r.image.id}.out`]);
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
    expect(events().some((e) => e.action === "firmware.image_uploaded")).toBe(true);
  });

  it("the third removes the old backup — row, file, Event — and names it in the response", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    const third = await upload("S108FF-7.06-FW-build1250-261001-patch10", "c");
    expect(third.rotatedOut).toEqual({ id: first.image.id, versionLabel: "7.6.8 build1164", filename: "FSW_108F-v7-build0000-FORTINET.out" });
    expect(existsSync(join(dirs.root, `${first.image.id}.out`))).toBe(false);
    expect(h.state.images).toHaveLength(2);
    const deleted = events().filter((e) => e.action === "firmware.image_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.message).toMatch(/each platform keeps two images/);
  });

  it("refuses the same bytes twice, naming where they already live", async () => {
    await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await expect(upload("S108FF-7.06-FW-build1164-260709-patch08", "a")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/already in the repository under Fortinet › switch › FortiSwitch S108FF/) });
    expect(h.state.images).toHaveLength(1);
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
  });

  it("stores a filename-only image with no platform and says it will never be offered", async () => {
    const r = await upload("no header here", "z", "FSW_108F_FPOE-v7-build1164-FORTINET.out");
    expect(r.image.platform).toBeNull();
    expect(r.image.parsedFrom).toBe("filename");
    expect(r.warnings.join(" ")).toMatch(/will not be offered/);
  });

  it("warns when the header's family disagrees with the node it is filed under", async () => {
    const r = await registerUploadedImage({ ...stageUpload("FP231K-7.06-AP-build1105-260519-patch05", "q"), originalName: "x.out", ...NODE });
    expect(r.warnings.join(" ")).toMatch(/FortiAP image, but it is being filed under a switch model/);
  });

  it("refuses bytes that are neither a Fortinet image nor a versioned file name", async () => {
    await expect(upload("garbage", "g", "notes.bin")).rejects.toThrow(/not a recognisable firmware image/);
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
  });

  it("refuses a switch image over 100 MiB by its reported size", async () => {
    const staged = stageUpload("S108FF-7.06-FW-build1164-260709-patch08", "s");
    await expect(registerUploadedImage({ ...staged, sizeBytes: 104_857_601, originalName: "x.out", ...NODE })).rejects.toMatchObject({ httpStatus: 413 });
    expect(readdirSync(dirs.incoming)).toHaveLength(0);
  });
});

describe("make-primary, delete and purge", () => {
  it("swaps the roles", async () => {
    const first = await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    const second = await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    const promoted = await setPrimaryImage(first.image.id, "tester");
    expect(promoted.role).toBe("primary");
    expect(role(second.image.id)).toBe("backup");
    expect(events().some((e) => e.action === "firmware.image_promoted")).toBe(true);
    await expect(setPrimaryImage(first.image.id)).rejects.toThrow(/already the primary/);
  });

  it("purge removes every image under the node and the tree stops showing it", async () => {
    await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await upload("S108FF-7.06-FW-build1200-260901-patch09", "b");
    let tree = await getFirmwareTree();
    const node = tree.manufacturers[0]!.assetTypes[0]!.models[0]!;
    expect(node.orphaned).toBe(false); // Charon: no inventory, never orphaned
    expect(node.assetCount).toBe(0);
    expect(node.images).toHaveLength(2);
    expect(node.images[0]!.role).toBe("primary");
    expect(await purgeModelImages(NODE, "tester")).toEqual({ deleted: 2 });
    expect(filesOnDisk()).toHaveLength(0);
    tree = await getFirmwareTree();
    expect(tree.manufacturers).toHaveLength(0);
    expect(events().some((e) => e.action === "firmware.model_purged")).toBe(true);
  });
});

describe("bindings", () => {
  it("a manufacturer-wide form login is inherited by a model; a deleted credential reads stale and falls through", async () => {
    h.state.credentials.push({ id: "11111111-1111-4111-8111-111111111111", name: "fw-admin", type: "http", config: { authMode: "form" } });
    await upload("S108FF-7.06-FW-build1164-260709-patch08", "a");
    await upsertBinding({ manufacturer: "Fortinet", credentialId: "11111111-1111-4111-8111-111111111111", actor: "tester" });
    let tree = await getFirmwareTree();
    expect(tree.manufacturers[0]!.binding?.credentialName).toBe("fw-admin");
    expect(tree.manufacturers[0]!.assetTypes[0]!.models[0]!.effectiveBinding).toMatchObject({ scope: "manufacturer", credentialName: "fw-admin" });
    h.state.credentials = [];
    tree = await getFirmwareTree();
    expect(tree.manufacturers[0]!.binding?.stale).toBe(true);
    expect(tree.manufacturers[0]!.assetTypes[0]!.models[0]!.effectiveBinding).toBeNull();
    expect((await listBindings())[0]!.stale).toBe(true);
  });

  it("refuses a non-login credential and a token outside a firewall scope", async () => {
    h.state.credentials.push({ id: "22222222-2222-4222-8222-222222222222", name: "plain", type: "http", config: { authMode: "basic" } });
    h.state.credentials.push({ id: "33333333-3333-4333-8333-333333333333", name: "tok", type: "restapi", config: {} });
    await expect(upsertBinding({ manufacturer: "Fortinet", credentialId: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: "33333333-3333-4333-8333-333333333333" })).rejects.toThrow(/only sign in to FortiGates/);
    await expect(upsertBinding({ manufacturer: "Fortinet", assetType: "switch", credentialId: null, source: "integration-token" })).rejects.toThrow(/Firewall node/);
    const ok = await upsertBinding({ manufacturer: "Fortinet", assetType: "firewall", credentialId: null, source: "integration-token" });
    expect(ok?.credentialName).toBe("Integration API token");
  });

  it("a type binding creates its node in the tree; credentialId null removes it", async () => {
    h.state.credentials.push({ id: "44444444-4444-4444-8444-444444444444", name: "ap-admin", type: "http", config: { authMode: "form" } });
    await upsertBinding({ manufacturer: "Fortinet", assetType: "access_point", credentialId: "44444444-4444-4444-8444-444444444444" });
    let tree = await getFirmwareTree();
    expect(tree.manufacturers[0]!.assetTypes.map((t) => t.assetType)).toEqual(["access_point"]);
    expect(await upsertBinding({ manufacturer: "Fortinet", assetType: "access_point", credentialId: null })).toBeNull();
    tree = await getFirmwareTree();
    expect(tree.manufacturers).toHaveLength(0);
  });
});

describe("upload containment", () => {
  it("refuses a temp path outside the incoming directory and leaves that file alone", async () => {
    const outside = join(dirs.root, "not-an-upload.bin");
    writeFileSync(outside, "keep me");
    await expect(registerUploadedImage({ tmpPath: outside, sizeBytes: 7, originalName: "x.out", ...NODE })).rejects.toMatchObject({ httpStatus: 400 });
    await discardIncomingUpload(outside);
    expect(existsSync(outside)).toBe(true);
    await discardIncomingUpload(join(dirs.incoming, "..", "not-an-upload.bin"));
    expect(existsSync(outside)).toBe(true);
    rmSync(outside);
  });

  it("discards a refused upload that is inside the incoming directory", async () => {
    const { tmpPath } = stageUpload("S108FF-7.06-FW-build1164-260709-patch08");
    await discardIncomingUpload(tmpPath);
    expect(existsSync(tmpPath)).toBe(false);
  });
});
