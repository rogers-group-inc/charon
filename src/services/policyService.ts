/**
 * src/services/policyService.ts — Charon-managed dynamic firewall policies.
 *
 * A Policy references a Tag; the enforcer renders it to a FortiGate policy that
 * sources/destinations the tag's charon-<tag> address group. Policies are
 * namespaced charon-* at the Fortinet boundary so Charon never edits an
 * operator-authored policy. CRUD here is intent only; the enforcer applies it
 * (dry-run unless the integration's enforce toggle is ON).
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";

export interface PolicySpec {
  srcintf?: string;
  dstintf?: string;
  service?: string[]; // e.g. ["HTTPS", "SSH"]
  action?: "accept" | "deny";
  // Whether the tag group is the source or destination of the policy.
  tagRole?: "src" | "dst";
}

export async function listPolicies() {
  return prisma.policy.findMany({ orderBy: { name: "asc" }, include: { tag: true } });
}

export async function createPolicy(input: { name: string; tagId: string; description?: string; spec?: PolicySpec }, actor?: string) {
  const name = input.name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new AppError(400, "Policy name may contain only letters, digits, hyphen, underscore");
  const tag = await prisma.tag.findUnique({ where: { id: input.tagId } });
  if (!tag) throw new AppError(400, "Referenced tag not found");
  if (await prisma.policy.findUnique({ where: { name } })) throw new AppError(409, `A policy named "${name}" already exists`);
  const row = await prisma.policy.create({
    data: { name, tagId: input.tagId, description: input.description ?? null, spec: (input.spec ?? {}) as any, createdBy: actor ?? "system" },
  });
  await logEvent({ action: "policy.created", resourceType: "policy", resourceId: row.id, resourceName: name, actor, message: `Created policy "${name}" → tag "${tag.name}"` });
  return row;
}

export async function updatePolicy(id: string, input: { description?: string; spec?: PolicySpec; enabled?: boolean }, actor?: string) {
  const existing = await prisma.policy.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Policy not found");
  const row = await prisma.policy.update({
    where: { id },
    data: { description: input.description ?? existing.description, spec: (input.spec ?? (existing.spec as any)) as any, enabled: input.enabled ?? existing.enabled },
  });
  await logEvent({ action: "policy.updated", resourceType: "policy", resourceId: id, resourceName: row.name, actor, message: `Updated policy "${row.name}"` });
  return row;
}

export async function deletePolicy(id: string, actor?: string) {
  const existing = await prisma.policy.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Policy not found");
  await prisma.policy.delete({ where: { id } });
  await logEvent({ action: "policy.deleted", resourceType: "policy", resourceId: id, resourceName: existing.name, actor, message: `Deleted policy "${existing.name}"` });
}
