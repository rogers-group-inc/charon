/**
 * src/services/tagService.ts — ZTNA tag model + effective-tag computation.
 *
 * A Tag's membership is the union of its TagSources combined with device
 * posture. computeEffectiveTags() resolves, for one endpoint, which tags it
 * currently holds and WHY (audit breadcrumb) — the heart of the reconciler.
 *
 * Matching by source kind:
 *   directory_group → the bound user is a member of the group (memberOf DN /
 *                     group externalId). [Entra group membership requires the
 *                     richer discovery added later; AD memberOf works today.]
 *   directory_ou    → the bound user's DN sits under the OU's DN.
 *   custom_group    → the bound user is in the resolved custom-group member set.
 *   posture         → the endpoint's PostureState equals the source ref.
 *
 * The `charon-` Fortinet prefix is applied at the enforcement boundary, never
 * stored on the Tag name.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";
import { resolveGroupMembers } from "./customGroupService.js";

export interface EffectiveTag {
  tagId: string;
  tagName: string;
  reasons: string[];
}

interface EndpointFacts {
  userKey: string | null; // bound user identifier (UPN/sam)
  userDn: string | null; // user's distinguishedName (for OU matching)
  memberOf: string[]; // group DNs the user belongs to (AD)
  postureState: string;
}

async function gatherFacts(endpoint: { boundUserKey: string | null; postureState: string }): Promise<EndpointFacts> {
  const facts: EndpointFacts = { userKey: endpoint.boundUserKey, userDn: null, memberOf: [], postureState: endpoint.postureState };
  if (endpoint.boundUserKey) {
    const user = await prisma.directoryObject.findFirst({ where: { kind: "user", identifier: endpoint.boundUserKey } });
    if (user) {
      facts.userDn = (user.identifier && user.identifier.includes("=")) ? user.identifier : null;
      const attrs = (user.attributes ?? {}) as Record<string, unknown>;
      const mo = attrs.memberOf;
      if (Array.isArray(mo)) facts.memberOf = mo.map(String);
      // The user's DN may live in identifier or be reconstructible; parentOu
      // holds the containing OU DN for OU matching.
      if (user.parentOu) facts.userDn = facts.userDn ?? `cn=${user.name},${user.parentOu}`;
    }
  }
  return facts;
}

/** Compute the set of tags an endpoint currently holds, with reasons. */
export async function computeEffectiveTags(endpointId: string): Promise<EffectiveTag[]> {
  const endpoint = await prisma.endpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) throw new AppError(404, "Endpoint not found");
  const facts = await gatherFacts(endpoint);

  const tags = await prisma.tag.findMany({ where: { enabled: true }, include: { sources: true } });

  // Pre-resolve custom-group membership only for the groups actually referenced.
  const customGroupIds = new Set<string>();
  for (const t of tags) for (const s of t.sources) if (s.kind === "custom_group" && s.customGroupId) customGroupIds.add(s.customGroupId);
  const customGroupMembers = new Map<string, Set<string>>();
  for (const gid of customGroupIds) customGroupMembers.set(gid, await resolveGroupMembers(gid));

  const result: EffectiveTag[] = [];
  for (const tag of tags) {
    const reasons: string[] = [];
    for (const s of tag.sources) {
      if (s.kind === "directory_group") {
        // ref is the group's externalId; match if the user's memberOf DNs
        // include the group's DN. Look up the group's identifier (DN).
        const matched = facts.memberOf.some((dn) => dn === s.ref) ||
          facts.memberOf.some((dn) => dn.toLowerCase() === s.ref.toLowerCase());
        if (matched) reasons.push(`group ${s.ref}`);
      } else if (s.kind === "directory_ou") {
        if (facts.userDn && facts.userDn.toLowerCase().endsWith(s.ref.toLowerCase())) reasons.push(`OU ${s.ref}`);
      } else if (s.kind === "custom_group") {
        const members = s.customGroupId ? customGroupMembers.get(s.customGroupId) : undefined;
        if (facts.userKey && members?.has(facts.userKey)) reasons.push(`custom group`);
      } else if (s.kind === "posture") {
        if (facts.postureState === s.ref) reasons.push(`posture=${s.ref}`);
      }
    }
    if (reasons.length) result.push({ tagId: tag.id, tagName: tag.name, reasons });
  }
  return result;
}

// ─── Tag CRUD ────────────────────────────────────────────────────────────────
export async function listTags() {
  return prisma.tag.findMany({ orderBy: { name: "asc" }, include: { sources: true, _count: { select: { endpointTags: true, policies: true } } } });
}

export async function createTag(input: { name: string; description?: string; color?: string }, actor?: string) {
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Tag name is required");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new AppError(400, "Tag name may contain only letters, digits, hyphen, underscore");
  if (await prisma.tag.findUnique({ where: { name } })) throw new AppError(409, `A tag named "${name}" already exists`);
  const row = await prisma.tag.create({ data: { name, description: input.description ?? null, color: input.color ?? null } });
  await logEvent({ action: "tag.created", resourceType: "tag", resourceId: row.id, resourceName: name, actor, message: `Created tag "${name}"` });
  return row;
}

export async function updateTag(id: string, input: { name?: string; description?: string; color?: string; enabled?: boolean }, actor?: string) {
  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Tag not found");
  const row = await prisma.tag.update({ where: { id }, data: { ...input, name: input.name?.trim() ?? existing.name } });
  await logEvent({ action: "tag.updated", resourceType: "tag", resourceId: id, resourceName: row.name, actor, message: `Updated tag "${row.name}"` });
  return row;
}

export async function deleteTag(id: string, actor?: string) {
  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Tag not found");
  await prisma.tag.delete({ where: { id } });
  await logEvent({ action: "tag.deleted", resourceType: "tag", resourceId: id, resourceName: existing.name, actor, message: `Deleted tag "${existing.name}"` });
}

// ─── TagSource CRUD ──────────────────────────────────────────────────────────
export async function addSource(tagId: string, input: { kind: string; ref?: string; customGroupId?: string }, actor?: string) {
  const tag = await prisma.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw new AppError(404, "Tag not found");
  const kind = input.kind;
  let ref = input.ref ?? "";
  if (kind === "custom_group") {
    if (!input.customGroupId) throw new AppError(400, "customGroupId is required for a custom_group source");
    ref = input.customGroupId;
  } else if (!ref) {
    throw new AppError(400, "ref is required for this source kind");
  }
  const row = await prisma.tagSource.create({
    data: { tagId, kind: kind as any, ref, customGroupId: kind === "custom_group" ? input.customGroupId : null },
  });
  await logEvent({ action: "tag.source.added", resourceType: "tag", resourceId: tagId, resourceName: tag.name, actor, message: `Added ${kind} source to tag "${tag.name}"` });
  return row;
}

export async function removeSource(sourceId: string, actor?: string) {
  const existing = await prisma.tagSource.findUnique({ where: { id: sourceId }, include: { tag: true } });
  if (!existing) throw new AppError(404, "Tag source not found");
  await prisma.tagSource.delete({ where: { id: sourceId } });
  await logEvent({ action: "tag.source.removed", resourceType: "tag", resourceId: existing.tagId, resourceName: existing.tag.name, actor, message: `Removed ${existing.kind} source from tag "${existing.tag.name}"` });
}
