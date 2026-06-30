/**
 * src/services/customGroupService.ts — Net-new custom groups (tag sources).
 *
 * A custom group's membership is the UNION of its explicit members (directory
 * user keys) and the users matched by its rule set over DirectoryObject
 * attributes. This is a Charon-native tag source alongside directory groups/OUs.
 *
 * Rule shape (stored in CustomGroup.rules):
 *   { "all": [Condition, ...], "any": [Condition, ...] }
 *   Condition = { attr: string, op: "eq"|"neq"|"contains"|"in", value: string|string[] }
 *   A user matches when ALL `all` conditions hold AND (no `any`, or ANY `any`
 *   condition holds). attr is read from the user's DirectoryObject.attributes
 *   (e.g. department, mail) or the top-level identifier/name.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventService.js";

export type RuleOp = "eq" | "neq" | "contains" | "in";
export interface Condition { attr: string; op: RuleOp; value: string | string[]; }
export interface RuleSet { all?: Condition[]; any?: Condition[]; }

function attrValue(userObj: any, attr: string): unknown {
  if (attr === "identifier") return userObj.identifier;
  if (attr === "name") return userObj.name;
  const a = (userObj.attributes ?? {}) as Record<string, unknown>;
  return a[attr];
}

function condMatches(userObj: any, c: Condition): boolean {
  const raw = attrValue(userObj, c.attr);
  const hay = Array.isArray(raw) ? raw.map((x) => String(x).toLowerCase()) : [String(raw ?? "").toLowerCase()];
  const needleArr = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => String(v).toLowerCase());
  switch (c.op) {
    case "eq": return hay.includes(needleArr[0]);
    case "neq": return !hay.includes(needleArr[0]);
    case "contains": return hay.some((h) => h.includes(needleArr[0]));
    case "in": return hay.some((h) => needleArr.includes(h));
    default: return false;
  }
}

export function userMatchesRules(userObj: any, rules: RuleSet): boolean {
  const all = rules.all ?? [];
  const any = rules.any ?? [];
  if (all.length && !all.every((c) => condMatches(userObj, c))) return false;
  if (any.length && !any.some((c) => condMatches(userObj, c))) return false;
  // A group with no rules at all matches nobody by rule (explicit members only).
  return all.length > 0 || any.length > 0;
}

/** Resolve the set of directory user keys (identifier) in a custom group. */
export async function resolveGroupMembers(groupId: string): Promise<Set<string>> {
  const group = await prisma.customGroup.findUnique({ where: { id: groupId } });
  if (!group) return new Set();
  const members = new Set<string>(group.members);
  const rules = (group.rules ?? {}) as RuleSet;
  if ((rules.all?.length ?? 0) > 0 || (rules.any?.length ?? 0) > 0) {
    const users = await prisma.directoryObject.findMany({ where: { kind: "user" } });
    for (const u of users) {
      if (u.identifier && userMatchesRules(u, rules)) members.add(u.identifier);
    }
  }
  return members;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
export async function listGroups() {
  return prisma.customGroup.findMany({ orderBy: { name: "asc" } });
}

export async function createGroup(input: { name: string; description?: string; members?: string[]; rules?: RuleSet }, actor?: string) {
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Group name is required");
  if (await prisma.customGroup.findUnique({ where: { name } })) {
    throw new AppError(409, `A group named "${name}" already exists`);
  }
  const row = await prisma.customGroup.create({
    data: { name, description: input.description ?? null, members: input.members ?? [], rules: (input.rules ?? {}) as any, createdBy: actor ?? "system" },
  });
  await logEvent({ action: "group.created", resourceType: "group", resourceId: row.id, resourceName: name, actor, message: `Created custom group "${name}"` });
  return row;
}

export async function updateGroup(id: string, input: { name?: string; description?: string; members?: string[]; rules?: RuleSet }, actor?: string) {
  const existing = await prisma.customGroup.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Group not found");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description;
  if (input.members !== undefined) data.members = input.members;
  if (input.rules !== undefined) data.rules = input.rules as any;
  const row = await prisma.customGroup.update({ where: { id }, data });
  await logEvent({ action: "group.updated", resourceType: "group", resourceId: id, resourceName: row.name, actor, message: `Updated custom group "${row.name}"` });
  return row;
}

export async function deleteGroup(id: string, actor?: string) {
  const existing = await prisma.customGroup.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Group not found");
  await prisma.customGroup.delete({ where: { id } });
  await logEvent({ action: "group.deleted", resourceType: "group", resourceId: id, resourceName: existing.name, actor, message: `Deleted custom group "${existing.name}"` });
}
