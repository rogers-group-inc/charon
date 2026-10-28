/**
 * src/services/integrationService.ts — Integration framework.
 *
 * Four types, ported from polaris: FortiManager and FortiGate (enforcement
 * targets) and Active Directory and Entra ID (+ Intune via config.enableIntune)
 * (directory sources). One stereotype for every type:
 *   testConnection(config) → { ok, message, version? }
 * Config secrets are AES-256-GCM at rest, masked on read, preserved-on-unchanged
 * on write while their destination is unchanged (see integrationConfig).
 * Directory sources also run discovery (services/discovery/directoryDiscovery)
 * into the read-only DirectoryObject mirror that feeds the tag pipeline.
 *
 * Adding a type = INTEGRATION_TYPES + SECRET_FIELDS (integrationConfig) + the
 * runPreflightTest dispatch (+ readDirectory for a directory source) + the
 * route's Zod schema + the integrations.js form. The route layer never
 * special-cases a type beyond its config schema.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventService.js";
import { recordIntegrationTest } from "../metrics.js";
import { writeConfig, readConfigMasked, decryptConfig, type IntegrationType } from "./integrationConfig.js";
import { runPreflightTest, isDiscoveryRunning, isDirectorySource } from "./discovery/directoryDiscovery.js";

export { isDirectorySource };

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
];

function assertType(type: string): IntegrationType {
  if (!(INTEGRATION_TYPES as readonly string[]).includes(type)) {
    throw new AppError(400, `Unknown integration type "${type}"`);
  }
  return type as IntegrationType;
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

export async function createIntegration(
  input: { type: string; name: string; config: Record<string, unknown>; enabled?: boolean; autoDiscover?: boolean; pollInterval?: number },
  actor?: string,
) {
  const type = assertType(input.type);
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Integration name is required");
  const stored = writeConfig(type, null, input.config ?? {});
  const row = await prisma.integration.create({
    data: {
      type,
      name,
      config: stored as any,
      enabled: input.enabled ?? true,
      ...(input.autoDiscover !== undefined ? { autoDiscover: input.autoDiscover } : {}),
      ...(input.pollInterval !== undefined ? { pollInterval: input.pollInterval } : {}),
    },
  });
  await logEvent({ action: "integration.created", resourceType: "integration", resourceId: row.id, resourceName: name, actor, message: `Created ${type} integration "${name}"` });
  return { ...row, config: readConfigMasked(type, row.config as any) };
}

export async function updateIntegration(
  id: string,
  input: { name?: string; config?: Record<string, unknown>; enabled?: boolean; autoDiscover?: boolean; pollInterval?: number },
  actor?: string,
) {
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
  await prisma.$transaction([
    prisma.discoveryRun.deleteMany({ where: { integrationId: id } }),
    prisma.integration.delete({ where: { id } }),
  ]);
  await logEvent({ action: "integration.deleted", resourceType: "integration", resourceId: id, resourceName: existing.name, actor, message: `Deleted integration "${existing.name}"` });
}

/** The DECRYPTED config of a stored integration — for server-side calls only, never returned. */
export async function getDecryptedIntegration(id: string): Promise<{ id: string; type: IntegrationType; name: string; config: Record<string, unknown> }> {
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Integration not found");
  const type = assertType(row.type);
  return { id: row.id, type, name: row.name, config: decryptConfig(type, row.config as any) };
}

// ─── testConnection (persisted) ────────────────────────────────────────────
export async function testIntegration(id: string): Promise<TestResult> {
  const integ = await getDecryptedIntegration(id);
  const result = await runPreflightTest(integ);
  await prisma.integration.update({ where: { id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } });
  recordIntegrationTest(integ.type, result.ok ? "success" : "failure");
  return result;
}

/**
 * Preflight test of an unsaved config (the configure modal's Test button). When
 * editing an existing integration, masked / blank secrets are filled from the
 * stored row — only while the destination is unchanged (writeConfig).
 */
export async function preflightTest(type: string, config: Record<string, unknown>, existingId?: string): Promise<TestResult> {
  const t = assertType(type);
  let stored: Record<string, unknown>;
  if (existingId) {
    const existing = await prisma.integration.findUnique({ where: { id: existingId } });
    if (!existing) throw new AppError(404, "Integration not found");
    if (existing.type !== t) throw new AppError(400, "Integration type cannot change");
    stored = writeConfig(t, existing.config as any, config);
  } else {
    stored = writeConfig(t, null, config);
  }
  return runPreflightTest({ id: existingId, type: t, config: decryptConfig(t, stored) });
}

// ─── Health-check sweep (job) ───────────────────────────────────────────────
/**
 * Test every enabled integration (polaris integrationConnectionTester):
 * sequential — a FortiManager drops parallel sessions past 1-2 — and skipping
 * any integration in an active discovery run (a fresh session mid-run collides
 * with the worker's and stamps a false failure). An ok-state CHANGE writes an
 * `integration.test.recovered` / `integration.test.failed` Event.
 */
export async function runHealthChecks(signal?: AbortSignal): Promise<void> {
  const integrations = await prisma.integration.findMany({
    where: { enabled: true },
    select: { id: true, name: true, type: true, config: true, lastTestOk: true },
  });
  for (const intg of integrations) {
    if (signal?.aborted) return;
    if (await isDiscoveryRunning(intg.id).catch(() => false)) {
      recordIntegrationTest(intg.type, "skipped");
      continue;
    }
    let result: { ok: boolean; message: string };
    try {
      result = await runPreflightTest({ id: intg.id, type: intg.type, config: decryptConfig(intg.type, intg.config as any) });
    } catch (err: any) {
      result = { ok: false, message: err?.message ?? "Test threw unexpectedly" };
    }
    await prisma.integration.update({ where: { id: intg.id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } })
      .catch((err) => logger.error({ err, integrationId: intg.id }, "integration health check: failed to persist result"));
    recordIntegrationTest(intg.type, result.ok ? "success" : "failure");

    const previouslyOk = intg.lastTestOk === true;
    if (result.ok && !previouslyOk) {
      await logEvent({
        action: "integration.test.recovered",
        resourceType: "integration",
        resourceId: intg.id,
        resourceName: intg.name,
        actor: "system:integration-tester",
        message: `Connection test for "${intg.name}" recovered`,
      });
    } else if (!result.ok && previouslyOk) {
      await logEvent({
        action: "integration.test.failed",
        level: "warning",
        resourceType: "integration",
        resourceId: intg.id,
        resourceName: intg.name,
        actor: "system:integration-tester",
        message: `Connection test for "${intg.name}" failed: ${result.message}`,
      });
    }
  }
}
