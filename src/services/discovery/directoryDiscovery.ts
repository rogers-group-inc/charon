/**
 * src/services/discovery/directoryDiscovery.ts — directory discovery runs.
 *
 * Charon's replacement for polaris's discoveryEngine (whose sync writes Assets,
 * Subnets and Reservations). Same run lifecycle — trigger → DiscoveryRun row
 * `queued` → pg-boss `charon.directory-sync` job → worker `runDiscovery` →
 * terminal status — with the same cancel flag, worker heartbeat and stale-run
 * reaper (services/discoveryRunState.ts, ported verbatim). What a run WRITES is
 * Charon's: the read-only DirectoryObject mirror that feeds the tag pipeline.
 *
 *   Active Directory → users (memberOf DNs), groups, OUs, computers (`device`)
 *   Entra ID         → users (transitive group ids), groups, devices
 *                      (+ Intune compliance / serial / MAC when enableIntune)
 *
 * Persistence is chunked upserts in transactions (scale: 2000 endpoints, tens
 * of thousands of users). Objects the read no longer returns are REMOVED — a
 * deleted user must lose the tags their memberOf granted — but only behind
 * polaris's sweep guards (planSweep): never on a partial / cancelled / empty
 * read, and never more than max(50, 20%) of a kind in one run. When a guard
 * refuses, stale rows are kept and a warning Event says why.
 *
 * Fortinet types are enforcement targets, not directory sources: they have no
 * discovery run. Their connection test is the only call this module makes.
 */

import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { logEvent } from "../eventService.js";
import { recordDiscovery } from "../../metrics.js";
import { QUEUES, publish } from "../../jobs.js";
import { decryptConfig } from "../integrationConfig.js";
import type { DiscoveredDirectoryObject } from "../directoryTypes.js";
import {
  upsertQueuedRun, markRunStarted, finishRun, isRunActive, isCancelRequested,
  touchWorkerHeartbeat, flushRunProgress, newRunAccumulator,
} from "../discoveryRunState.js";
import * as fmg from "../fortimanagerService.js";
import * as fgt from "../fortigateService.js";
import * as ad from "../activeDirectoryService.js";
import * as entra from "../entraIdService.js";

export type DirectoryKind = DiscoveredDirectoryObject["kind"];

/** Integration types that run discovery (mirror a directory). */
export const DISCOVERABLE_TYPES: ReadonlySet<string> = new Set(["activedirectory", "entraid"]);

export function isDirectorySource(type: string): boolean {
  return DISCOVERABLE_TYPES.has(type);
}

/** Rows per upsert transaction. */
const UPSERT_CHUNK = 500;
/** How often the worker polls the cancel flag. */
const CANCEL_POLL_MS = 3_000;
/** Worker heartbeat while a run is in a quiet phase (the reaper's input). */
const HEARTBEAT_MS = 60_000;

// ─── Connection test ────────────────────────────────────────────────────────

/** Dispatch a connection test on a DECRYPTED config. */
export async function runPreflightTest(integration: { id?: string; type: string; config: Record<string, unknown> }): Promise<{ ok: boolean; message: string; version?: string }> {
  const config = integration.config;
  switch (integration.type) {
    case "fortimanager": return fmg.testConnection(config as any, integration.id);
    case "fortigate": return fgt.testConnection(config as any);
    case "activedirectory": return ad.testConnection(config as any);
    case "entraid": return entra.testConnection(config as any);
    default: return { ok: false, message: `Unknown integration type: ${integration.type}` };
  }
}

// ─── Trigger ────────────────────────────────────────────────────────────────

/**
 * Enqueue a discovery run: validate the config (fast 400 for the manual
 * route), upsert a `queued` DiscoveryRun row, publish the pg-boss job — or,
 * when pg-boss is unavailable, run it in-process detached. Coalesces: while a
 * run is queued/running a re-trigger is a no-op and returns false.
 */
export async function triggerDiscovery(integrationId: string, actor: string): Promise<boolean> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration) throw new AppError(404, "Integration not found");
  if (!isDirectorySource(integration.type)) {
    throw new AppError(400, `${integration.name} is an enforcement target, not a directory source — there is nothing to discover`);
  }
  const config = integration.config as Record<string, unknown>;
  if (integration.type === "entraid") {
    if (!config.tenantId) throw new AppError(400, "Integration has no tenant ID configured");
    if (!config.clientId) throw new AppError(400, "Integration has no client ID configured");
    if (!config.clientSecret) throw new AppError(400, "Integration has no client secret configured");
  } else {
    if (!config.host) throw new AppError(400, "Integration has no host configured");
    if (!config.bindDn) throw new AppError(400, "Integration has no bind DN configured");
    if (!config.bindPassword) throw new AppError(400, "Integration has no bind password configured");
    if (!config.baseDn) throw new AppError(400, "Integration has no base DN configured");
  }

  if (await isRunActive(integrationId)) return false;
  await upsertQueuedRun({ integrationId, integrationName: integration.name, type: integration.type, actor });
  const jobId = await publish(QUEUES.directorySync, { integrationId, actor });
  if (!jobId) void runDiscovery(integrationId, actor);
  return true;
}

/** True when a queued/running run exists for this integration. */
export async function isDiscoveryRunning(integrationId: string): Promise<boolean> {
  return isRunActive(integrationId);
}

// ─── Run ────────────────────────────────────────────────────────────────────

/**
 * Execute a discovery run (the pg-boss worker, or triggerDiscovery's in-process
 * fallback). Owns the preflight, the DiscoveryRun transitions, cancellation and
 * the mirror write. Never throws: every failure lands on the run row + an Event.
 */
export async function runDiscovery(integrationId: string, actor: string): Promise<void> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration || !isDirectorySource(integration.type)) {
    await finishRun(integrationId, "error").catch(() => {});
    return;
  }
  const type = integration.type;
  const name = integration.name;
  const started = Date.now();
  const acc = newRunAccumulator(integrationId, name, type, started);
  await markRunStarted(integrationId, new Date(started)).catch(() => {});

  const controller = new AbortController();
  const cancelTimer = setInterval(() => {
    void isCancelRequested(integrationId).then((c) => { if (c) controller.abort(); }).catch(() => {});
  }, CANCEL_POLL_MS);
  const heartbeat = setInterval(() => void touchWorkerHeartbeat(integrationId), HEARTBEAT_MS);
  const log = (step: string, level: "info" | "error", message: string): void => {
    if (level === "error") logger.warn({ integrationId, step }, message);
    else logger.info({ integrationId, step }, message);
  };

  try {
    const config = decryptConfig(type, integration.config as Record<string, unknown>);
    const pre = await runPreflightTest({ id: integrationId, type, config });
    await prisma.integration.update({ where: { id: integrationId }, data: { lastTestAt: new Date(), lastTestOk: pre.ok } });
    if (!pre.ok) {
      await logEvent({ level: "error", action: "integration.discovery.failed", resourceType: "integration", resourceId: integrationId, resourceName: name, actor, message: `Discovery of "${name}" did not start — connection test failed: ${pre.message}` });
      await finishRun(integrationId, "error");
      return;
    }

    const read = await readDirectory(integrationId, type, config, controller.signal, log);
    if (controller.signal.aborted) {
      await logEvent({ level: "warning", action: "integration.discovery.aborted", resourceType: "integration", resourceId: integrationId, resourceName: name, actor, message: `Discovery of "${name}" was cancelled — the directory mirror was not changed` });
      await finishRun(integrationId, "aborted");
      return;
    }

    acc.totalDevices = read.objects.length;
    const counts = await persistObjects(integrationId, read.objects, () => {
      acc.completedCount = Math.min(acc.completedCount + UPSERT_CHUNK, read.objects.length);
      void flushRunProgress(acc);
    });
    const swept = await sweepAbsent(integrationId, name, read, actor);

    await prisma.integration.update({ where: { id: integrationId }, data: { lastDiscoveryAt: new Date() } });
    recordDiscovery(type, (Date.now() - started) / 1000);
    await logEvent({
      action: "integration.discovered",
      resourceType: "integration",
      resourceId: integrationId,
      resourceName: name,
      actor,
      message:
        `Discovered ${counts.user} users, ${counts.group} groups, ${counts.ou} OUs, ${counts.device} devices from "${name}"` +
        (swept.removed > 0 ? `; removed ${swept.removed} object(s) no longer in the directory` : ""),
      details: { counts, removed: swept.removed, sweepSkipped: swept.skipped },
    });
    await finishRun(integrationId, "completed");
    // Directory changed → recompute effective tags fleet-wide (dynamic import
    // breaks the service import cycle; enforcement stays dry-run until enforce is ON).
    void import("../tagReconciler.js").then((m) => m.reconcileAll()).catch(() => {});
  } catch (err: any) {
    const aborted = controller.signal.aborted || err?.name === "AbortError";
    await logEvent({
      level: aborted ? "warning" : "error",
      action: aborted ? "integration.discovery.aborted" : "integration.discovery.failed",
      resourceType: "integration",
      resourceId: integrationId,
      resourceName: name,
      actor,
      message: aborted ? `Discovery of "${name}" was cancelled` : `Discovery of "${name}" failed: ${err?.message ?? String(err)}`,
    });
    await finishRun(integrationId, aborted ? "aborted" : "error");
  } finally {
    clearInterval(cancelTimer);
    clearInterval(heartbeat);
  }
}

export interface DirectoryRead {
  objects: DiscoveredDirectoryObject[];
  /** Per kind: was the read of that kind whole (safe input to the sweep)? */
  completeKinds: Partial<Record<DirectoryKind, boolean>>;
}

/** Read everything a directory source mirrors, normalized to DiscoveredDirectoryObject. */
async function readDirectory(
  integrationId: string,
  type: string,
  config: Record<string, unknown>,
  signal: AbortSignal,
  log: (step: string, level: "info" | "error", message: string) => void,
): Promise<DirectoryRead> {
  if (type === "activedirectory") {
    const cfg = config as unknown as ad.ActiveDirectoryConfig;
    const dir = await ad.discoverDirectory(cfg, signal, log);
    const dev = await ad.discoverDevices(cfg, signal, log);
    const devicesOk = ad.adSweepBlockedReason(dev) === null;
    return {
      objects: [...dir.objects, ...dev.devices.map(adDeviceObject)],
      completeKinds: { user: dir.complete, group: dir.complete, ou: dir.complete, device: devicesOk },
    };
  }
  const cfg = config as unknown as entra.EntraIdConfig;
  const dir = await entra.discoverDirectory(cfg, signal, log);
  const known = await knownEthernetMacs(integrationId);
  const dev = await entra.discoverDevices(cfg, signal, log, undefined, known);
  const devicesOk = entra.entraSweepBlockedReason(dev) === null;
  return {
    objects: [...dir.objects, ...dev.devices.map(entraDeviceObject)],
    completeKinds: { user: dir.complete, group: dir.complete, device: devicesOk },
  };
}

function adDeviceObject(d: ad.DiscoveredAdDevice): DiscoveredDirectoryObject {
  return {
    kind: "device",
    externalId: d.objectGuid,
    name: d.cn,
    identifier: d.dnsHostName || d.cn,
    parentOu: d.distinguishedName.replace(/^.*?(?<!\\),/, "") || undefined,
    attributes: {
      dn: d.distinguishedName,
      sid: d.objectSid || undefined,
      operatingSystem: d.operatingSystem || undefined,
      operatingSystemVersion: d.operatingSystemVersion || undefined,
      description: d.description || undefined,
      lastLogonTimestamp: d.lastLogonTimestamp,
      disabled: d.disabled,
      ouPath: d.ouPath || undefined,
    },
  };
}

function entraDeviceObject(d: entra.DiscoveredEntraDevice): DiscoveredDirectoryObject {
  return {
    kind: "device",
    externalId: d.deviceId,
    name: d.displayName,
    identifier: d.displayName,
    attributes: {
      sources: d.sources,
      operatingSystem: d.operatingSystem || undefined,
      operatingSystemVersion: d.operatingSystemVersion || undefined,
      trustType: d.trustType || undefined,
      disabled: !d.accountEnabled,
      sid: d.onPremisesSecurityIdentifier,
      isCompliant: d.isCompliant,
      isManaged: d.isManaged,
      complianceState: d.complianceState,
      userPrincipalName: d.userPrincipalName,
      serialNumber: d.serialNumber,
      ethernetMacAddress: d.ethernetMacAddress,
      ethernetMacSyncedAt: d.ethernetMacSyncedAt,
      wifiMacAddress: d.wifiMacAddress,
      lastSyncDateTime: d.lastSyncDateTime,
      approximateLastSignInDateTime: d.approximateLastSignInDateTime,
    },
  };
}

/**
 * The Ethernet MAC each mirrored Intune device already holds, so the per-device
 * Graph read can skip devices that have not synced since (polaris's
 * resolveEthernetMacs contract). One bounded query: device rows of this
 * integration, attributes only.
 */
async function knownEthernetMacs(integrationId: string): Promise<Map<string, entra.KnownEthernetMac>> {
  const rows = await prisma.directoryObject.findMany({
    where: { integrationId, kind: "device" },
    select: { externalId: true, attributes: true },
  });
  const out = new Map<string, entra.KnownEthernetMac>();
  for (const r of rows) {
    const a = (r.attributes ?? {}) as Record<string, unknown>;
    if (typeof a.ethernetMacSyncedAt !== "string") continue;
    out.set(r.externalId.toLowerCase(), {
      ethernetMacAddress: typeof a.ethernetMacAddress === "string" ? a.ethernetMacAddress : null,
      ethernetMacSyncedAt: a.ethernetMacSyncedAt,
    });
  }
  return out;
}

// ─── Persist ────────────────────────────────────────────────────────────────

/** Upsert the read into the mirror in transaction chunks. Returns per-kind counts. */
export async function persistObjects(
  integrationId: string,
  objects: DiscoveredDirectoryObject[],
  onChunk?: () => void,
): Promise<Record<DirectoryKind, number>> {
  const counts: Record<DirectoryKind, number> = { user: 0, group: 0, ou: 0, device: 0 };
  const now = new Date();
  for (let i = 0; i < objects.length; i += UPSERT_CHUNK) {
    const chunk = objects.slice(i, i + UPSERT_CHUNK);
    await prisma.$transaction(
      chunk.map((o) => {
        counts[o.kind]++;
        const fields = {
          name: o.name,
          identifier: o.identifier ?? null,
          parentOu: o.parentOu ?? null,
          attributes: (o.attributes ?? {}) as any,
          syncedAt: now,
        };
        return prisma.directoryObject.upsert({
          where: { integrationId_kind_externalId: { integrationId, kind: o.kind, externalId: o.externalId } },
          create: { integrationId, kind: o.kind, externalId: o.externalId, ...fields },
          update: fields,
        });
      }),
    );
    onChunk?.();
  }
  return counts;
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

/** Never remove more than this share of a kind in one run (polaris rule 70's cap). */
export const SWEEP_MAX_FRACTION = 0.2;
/** …except a small directory may always lose this many. */
export const SWEEP_MIN_CAP = 50;

export interface SweepPlan {
  /** Ids to remove for this kind (empty when refused). */
  remove: string[];
  /** Why the sweep refused, or null. */
  refused: string | null;
}

/**
 * Decide which stored ids of one kind to remove. Pure.
 *   - a partial read (cancelled / capped / a failed member read) refuses;
 *   - an EMPTY read refuses — zero users is a bind / permission / base-DN
 *     answer far more often than an emptied directory (polaris rule 35);
 *   - removing more than max(SWEEP_MIN_CAP, 20% of stored) refuses.
 */
export function planSweep(storedIds: readonly string[], presentIds: ReadonlySet<string>, complete: boolean): SweepPlan {
  if (!complete) return { remove: [], refused: "the directory read was partial" };
  if (presentIds.size === 0 && storedIds.length > 0) return { remove: [], refused: "the directory read came back empty" };
  const remove = storedIds.filter((id) => !presentIds.has(id));
  const cap = Math.max(SWEEP_MIN_CAP, Math.floor(storedIds.length * SWEEP_MAX_FRACTION));
  if (remove.length > cap) {
    return { remove: [], refused: `${remove.length} of ${storedIds.length} would be removed, above the ${cap}-object safety cap` };
  }
  return { remove, refused: null };
}

async function sweepAbsent(
  integrationId: string,
  name: string,
  read: DirectoryRead,
  actor: string,
): Promise<{ removed: number; skipped: Record<string, string> }> {
  const present = new Map<DirectoryKind, Set<string>>();
  for (const o of read.objects) {
    const set = present.get(o.kind) ?? new Set<string>();
    set.add(o.externalId);
    present.set(o.kind, set);
  }
  let removed = 0;
  const skipped: Record<string, string> = {};
  for (const [kind, complete] of Object.entries(read.completeKinds) as Array<[DirectoryKind, boolean]>) {
    const stored = await prisma.directoryObject.findMany({ where: { integrationId, kind }, select: { externalId: true } });
    const plan = planSweep(stored.map((s) => s.externalId), present.get(kind) ?? new Set(), complete);
    if (plan.refused) {
      if (stored.length > (present.get(kind)?.size ?? 0)) skipped[kind] = plan.refused;
      continue;
    }
    if (plan.remove.length === 0) continue;
    const res = await prisma.directoryObject.deleteMany({ where: { integrationId, kind, externalId: { in: plan.remove } } });
    removed += res.count;
  }
  if (Object.keys(skipped).length > 0) {
    await logEvent({
      level: "warning",
      action: "integration.discovery.sweep_skipped",
      resourceType: "integration",
      resourceId: integrationId,
      resourceName: name,
      actor,
      message: `Discovery of "${name}" kept objects the directory no longer returned, because ${Object.entries(skipped).map(([k, r]) => `${k}s: ${r}`).join("; ")}. Their tags stay until a whole read confirms the removal.`,
      details: { skipped },
    });
  }
  return { removed, skipped };
}
