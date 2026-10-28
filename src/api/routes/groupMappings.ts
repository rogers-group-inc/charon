/**
 * src/api/routes/groupMappings.ts — IdP group → role mapping CRUD.
 *
 * Mounted at /group-mappings behind requirePermission("users", "fullwrite")
 * (the tier that assigns roles; no dedicated function key). Thin wrappers over
 * groupMappingService, plus the grant guards: a mapping hands its role to every
 * member of an IdP group at their next login, so it may not exceed the
 * caller's own access; withdrawing an admin-equivalent mapping (remove,
 * disable, retarget) needs an admin-equivalent caller too.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import * as groupMappingService from "../../services/groupMappingService.js";
import { GROUP_MAPPING_PROVIDERS } from "../../services/groupMappingService.js";
import { assertGrantWithinCaller, assertNoPrivilegeEscalation } from "../middleware/permissions.js";

const ProviderSchema = z.enum(GROUP_MAPPING_PROVIDERS);

const CreateSchema = z.object({
  provider: ProviderSchema,
  groupKey: z.string().min(1).max(512),
  roleId: z.string().uuid(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional().nullable(),
});

const UpdateSchema = z.object({
  groupKey: z.string().min(1).max(512).optional(),
  roleId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional().nullable(),
});

const ListQuerySchema = z.object({ provider: ProviderSchema.optional() });

const router = Router();

async function assertMappingWithinCaller(req: Request, roleId: string): Promise<void> {
  const role = await groupMappingService.roleGrantFor(roleId);
  if (role) assertGrantWithinCaller(req, role.permissions, `the role "${role.name}" this group mapping grants`);
}

async function assertMayWithdrawMapping(req: Request, roleId: string): Promise<void> {
  const role = await groupMappingService.roleGrantFor(roleId);
  if (role) assertNoPrivilegeEscalation(req, role.permissions, `the group mapping's role "${role.name}"`);
}

const actor = (req: Request) => req.session?.username ?? req.apiToken?.name;

router.get("/", async (req, res, next) => {
  try {
    const { provider } = ListQuerySchema.parse(req.query);
    res.json(await groupMappingService.listGroupMappings(provider));
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await groupMappingService.getGroupMapping(String(req.params.id)));
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    // Checked even when created disabled: it is one toggle away from granting.
    await assertMappingWithinCaller(req, input.roleId);
    res.status(201).json(await groupMappingService.createGroupMapping(input, actor(req)));
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const input = UpdateSchema.parse(req.body);
    const before = await groupMappingService.mappingGrantState(id);
    if (before) {
      const nextRoleId = input.roleId ?? before.roleId;
      const roleChanged = nextRoleId !== before.roleId;
      const groupChanged = input.groupKey !== undefined && input.groupKey.trim() !== (before.groupLabel || before.groupKey);
      const switchedOn = input.enabled === true && !before.enabled;
      if (roleChanged || groupChanged || switchedOn) await assertMappingWithinCaller(req, nextRoleId);
      if (roleChanged || groupChanged || input.enabled === false) await assertMayWithdrawMapping(req, before.roleId);
    }
    res.json(await groupMappingService.updateGroupMapping(id, input, actor(req)));
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const doomed = await groupMappingService.mappingGrantState(id);
    if (doomed) await assertMayWithdrawMapping(req, doomed.roleId);
    await groupMappingService.deleteGroupMapping(id, actor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
