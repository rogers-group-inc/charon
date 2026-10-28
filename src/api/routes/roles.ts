/**
 * src/api/routes/roles.ts — dynamic role CRUD + the function-key catalogue.
 *
 * Mounted at /roles with no mount gate; each route declares its own:
 *   GET /functions, GET /, GET /:id — roles:read
 *   POST /, PUT /:id, DELETE /:id   — roles:write
 * plus the escalation guards: a role may only grant what the caller holds, and
 * taking admin-equivalence away needs an admin-equivalent caller.
 */

import { Router } from "express";
import { z } from "zod";
import * as roleService from "../../services/roleService.js";
import {
  FUNCTION_KEYS,
  ACCESS_LEVELS,
  requirePermission,
  assertGrantWithinCaller,
  callerIsAdminEquivalent,
  isAdminEquivalentPermissions,
  normalizePermissions,
  type AccessLevel,
} from "../middleware/permissions.js";

const AccessLevelSchema = z.enum(ACCESS_LEVELS as unknown as [AccessLevel, ...AccessLevel[]]);
// Partial map — missing keys default to "none", unknown keys are dropped (normalizePermissions).
const PermissionsSchema = z.record(z.string(), AccessLevelSchema);
const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #rrggbb hex string");

const CreateRoleSchema = z.object({
  name: z.string().min(2).max(32),
  description: z.string().max(200).optional().nullable(),
  permissions: PermissionsSchema,
  color: ColorSchema.optional().nullable(),
});

const UpdateRoleSchema = z.object({
  name: z.string().min(2).max(32).optional(),
  description: z.string().max(200).optional().nullable(),
  permissions: PermissionsSchema.optional(),
  color: ColorSchema.optional().nullable(),
});

const router = Router();

// Static catalogue — the frontend renders the matrix rows from it.
router.get("/functions", requirePermission("roles", "read"), (_req, res) => {
  res.json({ accessLevels: ACCESS_LEVELS, functions: FUNCTION_KEYS });
});

router.get("/", requirePermission("roles", "read"), async (_req, res, next) => {
  try {
    res.json(await roleService.listRoles());
  } catch (err) { next(err); }
});

router.get("/:id", requirePermission("roles", "read"), async (req, res, next) => {
  try {
    res.json(await roleService.getRole(String(req.params.id)));
  } catch (err) { next(err); }
});

router.post("/", requirePermission("roles", "write"), async (req, res, next) => {
  try {
    const input = CreateRoleSchema.parse(req.body);
    assertGrantWithinCaller(req, input.permissions, `the role "${input.name}"`);
    res.status(201).json(await roleService.createRole(
      { name: input.name, description: input.description ?? null, permissions: input.permissions, color: input.color },
      req.session?.username ?? req.apiToken?.name,
    ));
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("roles", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const input = UpdateRoleSchema.parse(req.body);
    if (input.permissions !== undefined) {
      const current = await roleService.getRole(id);
      // Only keys this edit RAISES count — authority the role already had is not being granted now.
      assertGrantWithinCaller(req, input.permissions, "this permission set", current.permissions);
      await roleService.assertRoleDemotionAllowed(
        id,
        current.permissions,
        isAdminEquivalentPermissions(normalizePermissions(input.permissions)),
        callerIsAdminEquivalent(req),
      );
    }
    res.json(await roleService.updateRole(id, input, req.session?.username ?? req.apiToken?.name));
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("roles", "write"), async (req, res, next) => {
  try {
    await roleService.deleteRole(String(req.params.id), req.session?.username ?? req.apiToken?.name);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
