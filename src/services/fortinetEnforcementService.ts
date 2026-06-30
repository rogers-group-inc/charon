/**
 * src/services/fortinetEnforcementService.ts — Tag → Fortinet writeback.
 *
 * THE destructive surface. Two hard safety rails:
 *   1. Per-integration enforce toggle (Integration.enforcementMode). Default
 *      `dry_run`: every intended change is computed, recorded as an
 *      EnforcementState row, and logged as an Event — but NOTHING is written to
 *      the firewall. Flipping to `enforce` requires the "enforcement" fullwrite
 *      permission AND human review (the UI says so loudly).
 *   2. Ownership scoping: Charon only ever creates/edits objects it names
 *      `charon-*`. It never reads-then-rewrites an operator-authored object.
 *
 * Model: one dynamic address group `charon-<tag>` per tag; one address object
 * `charon-ep-<shortId>` per enrolled endpoint (its current IP). An endpoint
 * holding a tag ⇒ its address is a member of that tag's group. Policies
 * (Policy model) reference `charon-<tag>` groups.
 *
 * Direct-FortiGate enforce is implemented. The FMG path stays dry-run-only for
 * now (a half-applied policy-package install is worse than none) — the intended
 * change is logged so an operator can apply it via FMG until the
 * /securityconsole/install flow is completed and reviewed.
 */

import { prisma } from "../db.js";
import { decryptConfig } from "./integrationConfig.js";
import { fgWrite, type FortiGateConfig } from "./fortigateService.js";
import { logEvent } from "./eventService.js";
import { recordEnforcementApply, setEnforcementDrift } from "../metrics.js";
import { logger } from "../utils/logger.js";

const PREFIX = "charon-";

export function addrGroupName(tag: string): string {
  return `${PREFIX}${tag}`;
}
export function endpointAddressName(endpointId: string): string {
  return `${PREFIX}ep-${endpointId.slice(0, 12)}`;
}

interface IntendedChange {
  objectType: "address" | "addrgrp" | "policy";
  objectName: string;
  op: "ensure" | "add-member" | "remove-member";
  detail: Record<string, unknown>;
}

/**
 * Apply a per-endpoint tag delta to every enforcement-capable integration.
 * added/removed are tag NAMES. Records EnforcementState + Events for both
 * dry-run and enforce; only the enforce path touches the firewall.
 */
export async function applyEndpointDelta(endpointId: string, added: string[], removed: string[]): Promise<void> {
  const endpoint = await prisma.endpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) return;
  if (!endpoint.currentIp && added.length) {
    logger.warn({ endpointId }, "enforcement: endpoint has no current IP — cannot add address membership yet");
  }

  const integrations = await prisma.integration.findMany({
    where: { enabled: true, type: { in: ["fortigate", "fortimanager"] } },
  });

  for (const integ of integrations) {
    const changes = buildIntendedChanges(endpoint, added, removed);
    if (!changes.length) continue;

    if (integ.enforcementMode === "dry_run") {
      await recordDryRun(integ.id, integ.type, endpointId, changes);
      continue;
    }

    if (integ.type === "fortimanager") {
      // SAFETY: FMG enforce path not yet completed — never half-apply a policy
      // package. Record as dry-run and log so an operator can apply manually.
      await recordDryRun(integ.id, integ.type, endpointId, changes, "FMG enforce path pending — logged, not applied");
      continue;
    }

    await applyDirectFortiGate(integ.id, integ.config, endpoint, added, removed, changes);
  }
}

function buildIntendedChanges(endpoint: { id: string; currentIp: string | null }, added: string[], removed: string[]): IntendedChange[] {
  const changes: IntendedChange[] = [];
  const addrName = endpointAddressName(endpoint.id);
  if (endpoint.currentIp && added.length) {
    changes.push({ objectType: "address", objectName: addrName, op: "ensure", detail: { ip: endpoint.currentIp } });
  }
  for (const tag of added) changes.push({ objectType: "addrgrp", objectName: addrGroupName(tag), op: "add-member", detail: { member: addrName } });
  for (const tag of removed) changes.push({ objectType: "addrgrp", objectName: addrGroupName(tag), op: "remove-member", detail: { member: addrName } });
  return changes;
}

async function recordDryRun(integrationId: string, type: string, endpointId: string, changes: IntendedChange[], note?: string): Promise<void> {
  for (const c of changes) {
    await prisma.enforcementState.upsert({
      where: { integrationId_objectType_objectName: { integrationId, objectType: c.objectType, objectName: c.objectName } },
      create: { integrationId, objectType: c.objectType, objectName: c.objectName, endpointId, desired: c as any, status: "dry_run" },
      update: { desired: c as any, status: "dry_run", endpointId },
    });
    recordEnforcementApply(type, c.objectType, "dry_run");
  }
  await logEvent({
    level: "info",
    action: "enforcement.dryrun",
    resourceType: "integration",
    resourceId: integrationId,
    message: `[DRY-RUN] ${changes.length} intended Fortinet change(s)${note ? ` — ${note}` : ""}`,
    details: { changes },
  });
}

async function applyDirectFortiGate(
  integrationId: string,
  rawConfig: unknown,
  endpoint: { id: string; currentIp: string | null },
  added: string[],
  removed: string[],
  changes: IntendedChange[],
): Promise<void> {
  const cfg = decryptConfig("fortigate", rawConfig as any) as unknown as FortiGateConfig;
  const addrName = endpointAddressName(endpoint.id);
  try {
    // 1. Ensure the endpoint address object (charon-ep-…) exists for its IP.
    if (endpoint.currentIp && added.length) {
      await fgWrite(cfg, "POST", "/api/v2/cmdb/firewall/address", {
        name: addrName,
        subnet: `${endpoint.currentIp} 255.255.255.255`,
        comment: "charon-managed",
      }).catch(() => fgWrite(cfg, "PUT", `/api/v2/cmdb/firewall/address/${encodeURIComponent(addrName)}`, {
        subnet: `${endpoint.currentIp} 255.255.255.255`,
      }));
    }
    // 2. Add/remove the address from each tag's charon-<tag> group.
    for (const tag of added) await ensureGroupMember(cfg, addrGroupName(tag), addrName, true);
    for (const tag of removed) await ensureGroupMember(cfg, addrGroupName(tag), addrName, false);

    for (const c of changes) {
      await prisma.enforcementState.upsert({
        where: { integrationId_objectType_objectName: { integrationId, objectType: c.objectType, objectName: c.objectName } },
        create: { integrationId, objectType: c.objectType, objectName: c.objectName, endpointId: endpoint.id, desired: c as any, actual: c as any, status: "in_sync", lastAppliedAt: new Date() },
        update: { desired: c as any, actual: c as any, status: "in_sync", lastError: null, lastAppliedAt: new Date(), endpointId: endpoint.id },
      });
      recordEnforcementApply("fortigate", c.objectType, "applied");
    }
    await prisma.integration.update({ where: { id: integrationId }, data: { lastSyncAt: new Date() } });
    await logEvent({ action: "enforcement.applied", resourceType: "integration", resourceId: integrationId, message: `Applied ${changes.length} Fortinet change(s) to FortiGate`, details: { added, removed } });
  } catch (err: any) {
    for (const c of changes) {
      await prisma.enforcementState.upsert({
        where: { integrationId_objectType_objectName: { integrationId, objectType: c.objectType, objectName: c.objectName } },
        create: { integrationId, objectType: c.objectType, objectName: c.objectName, endpointId: endpoint.id, desired: c as any, status: "error", lastError: err?.message },
        update: { status: "error", lastError: err?.message },
      });
      recordEnforcementApply("fortigate", c.objectType, "error");
    }
    await logEvent({ level: "error", action: "enforcement.error", resourceType: "integration", resourceId: integrationId, message: `Enforcement apply failed: ${err?.message}` });
  }
}

/** Idempotently add/remove an address from a charon-<tag> group, creating the
 *  group if missing. Reads the current members (the group is charon-owned, so
 *  this is not rewriting an operator object), then writes the new member set. */
async function ensureGroupMember(cfg: FortiGateConfig, group: string, member: string, present: boolean): Promise<void> {
  const { fgGet } = await import("./fortigateService.js");
  let members: string[] = [];
  let exists = true;
  try {
    const res = await fgGet<{ results?: Array<{ member?: Array<{ name: string }> }> }>(cfg, `/api/v2/cmdb/firewall/addrgrp/${encodeURIComponent(group)}`);
    members = (res.results?.[0]?.member ?? []).map((m) => m.name);
  } catch {
    exists = false;
  }
  const set = new Set(members);
  if (present) set.add(member); else set.delete(member);
  // A charon-<tag> group must always have ≥1 member; FortiGate rejects empty
  // groups, so when the last member leaves we keep a sentinel "none" address.
  const memberList = [...set];
  const body = { name: group, member: (memberList.length ? memberList : ["none"]).map((n) => ({ name: n })) };
  if (exists) await fgWrite(cfg, "PUT", `/api/v2/cmdb/firewall/addrgrp/${encodeURIComponent(group)}`, body);
  else await fgWrite(cfg, "POST", "/api/v2/cmdb/firewall/addrgrp", { ...body, comment: "charon-managed" });
}

/** Recompute drift counts per integration for the Integrations page + metrics. */
export async function refreshDriftCounts(): Promise<void> {
  const integrations = await prisma.integration.findMany({ where: { type: { in: ["fortigate", "fortimanager"] } } });
  for (const integ of integrations) {
    const drift = await prisma.enforcementState.count({ where: { integrationId: integ.id, status: "drift" } });
    setEnforcementDrift(integ.type, drift);
  }
}

/** Flip a per-integration enforce toggle (guarded by the route's permission). */
export async function setEnforcementMode(integrationId: string, mode: "dry_run" | "enforce", actor?: string): Promise<void> {
  const integ = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integ) return;
  await prisma.integration.update({ where: { id: integrationId }, data: { enforcementMode: mode } });
  await logEvent({
    level: mode === "enforce" ? "warning" : "info",
    action: "enforcement.mode.changed",
    resourceType: "integration",
    resourceId: integrationId,
    resourceName: integ.name,
    actor,
    message: `Enforcement mode for "${integ.name}" set to ${mode.toUpperCase()}${mode === "enforce" ? " — LIVE Fortinet writes enabled" : ""}`,
  });
}
