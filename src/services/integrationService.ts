/**
 * src/services/integrationService.ts — Integration framework + dispatcher.
 *
 * One stereotype for every integration type:
 *   testConnection(config) → { ok, message, version? }
 * Config secrets are AES-256-GCM at rest, masked on read, preserved-on-unchanged
 * on write (see integrationConfig). Directory sources (AD/Entra) also implement
 * discover() → DiscoveredDirectoryObject[], persisted as the read-only
 * DirectoryObject mirror that feeds the tag pipeline (milestone 4).
 *
 * Adding a type = add it to INTEGRATION_TYPES + the testConnection/discover
 * switches here. The route layer never special-cases a type.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";
import { recordIntegrationTest, recordDiscovery } from "../metrics.js";
import { writeConfig, readConfigMasked, decryptConfig, type IntegrationType } from "./integrationConfig.js";
import type { DiscoveredDirectoryObject } from "./directoryTypes.js";

import * as fmg from "./fortimanagerService.js";
import * as fgt from "./fortigateService.js";
import * as ad from "./activeDirectoryService.js";
import * as entra from "./entraIdService.js";

export interface TestResult {
  ok: boolean;
  message: string;
  version?: string;
}

export const INTEGRATION_TYPES: readonly IntegrationType[] = [
  "fortimanager",
  "fortigate",
  "activedirectory",
  "entraid",
  "intune",
];

/** True for types that mirror a directory into DirectoryObject (tag sources). */
export function isDirectorySource(type: string): boolean {
  return type === "activedirectory" || type === "entraid";
}

function assertType(type: string): IntegrationType {
  if (!(INTEGRATION_TYPES as readonly string[]).includes(type)) {
    throw new AppError(400, `Unknown integration type "${type}"`);
  }
  return type as IntegrationType;
}

// ─── Dispatch: testConnection ───────────────────────────────────────────────
async function dispatchTest(type: IntegrationType, cfg: any, signal?: AbortSignal): Promise<TestResult> {
  switch (type) {
    case "fortimanager": return fmg.testConnection(cfg, signal);
    case "fortigate": return fgt.testConnection(cfg, signal);
    case "activedirectory": return ad.testConnection(cfg, signal);
    case "entraid": return entra.testConnectionEntra(cfg, signal);
    case "intune": return entra.testConnectionIntune(cfg, signal);
  }
}

// ─── Dispatch: discover (directory sources only) ────────────────────────────
async function dispatchDiscover(type: IntegrationType, cfg: any, signal?: AbortSignal): Promise<DiscoveredDirectoryObject[]> {
  switch (type) {
    case "activedirectory": return ad.discover(cfg, signal);
    case "entraid": return entra.discoverEntra(cfg, signal);
    default: throw new AppError(400, `Integration type "${type}" is not a directory source`);
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
export async function listIntegrations() {
  const rows = await prisma.integration.findMany({ orderBy: { name: "asc" } });
  return rows.map((r) => ({ ...r, config: readConfigMasked(r.type, r.config as any) }));
}

export async function getIntegration(id: string) {
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Integration not found");
  return { ...row, config: readConfigMasked(row.type, row.config as any) };
}

export async function createIntegration(input: { type: string; name: string; config: Record<string, unknown>; enabled?: boolean }, actor?: string) {
  const type = assertType(input.type);
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Integration name is required");
  const stored = writeConfig(type, null, input.config ?? {});
  const row = await prisma.integration.create({
    data: { type, name, config: stored as any, enabled: input.enabled ?? true },
  });
  await logEvent({ action: "integration.created", resourceType: "integration", resourceId: row.id, resourceName: name, actor, message: `Created ${type} integration "${name}"` });
  return { ...row, config: readConfigMasked(type, row.config as any) };
}

export async function updateIntegration(id: string, input: { name?: string; config?: Record<string, unknown>; enabled?: boolean; autoDiscover?: boolean; pollInterval?: number }, actor?: string) {
  const existing = await prisma.integration.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Integration not found");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.autoDiscover !== undefined) data.autoDiscover = input.autoDiscover;
  if (input.pollInterval !== undefined) data.pollInterval = input.pollInterval;
  if (input.config) data.config = writeConfig(existing.type, existing.config as any, input.config) as any;
  const row = await prisma.integration.update({ where: { id }, data });
  await logEvent({ action: "integration.updated", resourceType: "integration", resourceId: id, resourceName: row.name, actor, message: `Updated integration "${row.name}"` });
  return { ...row, config: readConfigMasked(row.type, row.config as any) };
}

export async function deleteIntegration(id: string, actor?: string) {
  const existing = await prisma.integration.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Integration not found");
  await prisma.integration.delete({ where: { id } });
  await logEvent({ action: "integration.deleted", resourceType: "integration", resourceId: id, resourceName: existing.name, actor, message: `Deleted integration "${existing.name}"` });
}

// ─── testConnection (persisted) ────────────────────────────────────────────
export async function testIntegration(id: string, signal?: AbortSignal): Promise<TestResult> {
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Integration not found");
  const type = assertType(row.type);
  const cfg = decryptConfig(type, row.config as any);
  const result = await dispatchTest(type, cfg, signal);
  await prisma.integration.update({ where: { id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } });
  recordIntegrationTest(type, result.ok ? "success" : "failure");
  return result;
}

/** Preflight test of an unsaved config (the configure modal's Test button). */
export async function preflightTest(type: string, config: Record<string, unknown>, existingId?: string, signal?: AbortSignal): Promise<TestResult> {
  const t = assertType(type);
  // If the modal resubmitted masked secrets, merge against the stored config.
  let cfg = config;
  if (existingId) {
    const existing = await prisma.integration.findUnique({ where: { id: existingId } });
    if (existing) cfg = writeConfig(t, existing.config as any, config);
  } else {
    cfg = writeConfig(t, null, config);
  }
  return dispatchTest(t, decryptConfig(t, cfg), signal);
}

// ─── Directory discovery (read-only) ─────────────────────────────────────────
export async function discoverDirectory(id: string, signal?: AbortSignal): Promise<{ counts: Record<string, number> }> {
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Integration not found");
  const type = assertType(row.type);
  if (!isDirectorySource(type)) throw new AppError(400, `"${type}" is not a directory source`);

  const started = Date.now();
  await prisma.integration.update({ where: { id }, data: { lastDiscoveryAt: new Date() } });
  const objects = await dispatchDiscover(type, decryptConfig(type, row.config as any), signal);

  const counts: Record<string, number> = { user: 0, group: 0, ou: 0 };
  for (const o of objects) {
    counts[o.kind] = (counts[o.kind] ?? 0) + 1;
    await prisma.directoryObject.upsert({
      where: { integrationId_kind_externalId: { integrationId: id, kind: o.kind, externalId: o.externalId } },
      create: {
        integrationId: id,
        kind: o.kind,
        externalId: o.externalId,
        name: o.name,
        identifier: o.identifier ?? null,
        parentOu: o.parentOu ?? null,
        attributes: (o.attributes ?? {}) as any,
      },
      update: { name: o.name, identifier: o.identifier ?? null, parentOu: o.parentOu ?? null, attributes: (o.attributes ?? {}) as any, syncedAt: new Date() },
    });
  }
  recordDiscovery(type, (Date.now() - started) / 1000);
  await logEvent({ action: "integration.discovered", resourceType: "integration", resourceId: id, resourceName: row.name, message: `Discovered ${counts.user} users, ${counts.group} groups, ${counts.ou} OUs from "${row.name}"` });
  // Directory changed → recompute effective tags fleet-wide (dynamic import
  // breaks the service import cycle; non-blocking, dry-run until enforce is ON).
  void import("./tagReconciler.js").then((m) => m.reconcileAll()).catch(() => {});
  return { counts };
}

// ─── Health-check sweep (job) ───────────────────────────────────────────────
export async function runHealthChecks(signal?: AbortSignal): Promise<void> {
  const integrations = await prisma.integration.findMany({ where: { enabled: true } });
  for (const row of integrations) {
    if (signal?.aborted) return;
    try {
      await testIntegration(row.id, signal);
    } catch {
      recordIntegrationTest(row.type, "failure");
    }
  }
}
