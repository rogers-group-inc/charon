/**
 * src/api/routes/users.ts — operator account management (the Users page).
 *
 * Mounted at /users behind requirePermission("users", "read"); every mutation
 * adds users:write. Thin: validate, run the escalation guards (they need the
 * caller's request), call userService, respond. All logic, Events and session
 * revocation live in services/userService.ts.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { requirePermission, assertNoPrivilegeEscalation, assertGrantWithinCaller } from "../middleware/permissions.js";
import { passwordInputSchema } from "../../utils/password.js";
import * as userService from "../../services/userService.js";

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: passwordInputSchema,
  roleId: z.string().uuid("roleId must be a UUID"),
});
const ResetPasswordSchema = z.object({ password: passwordInputSchema });
const UpdateRoleSchema = z.object({ roleId: z.string().uuid("roleId must be a UUID") });

const router = Router();

function actorOf(req: Request): userService.Actor {
  return { userId: req.session?.userId, username: req.session?.username ?? req.apiToken?.name, sessionId: req.sessionID };
}

// Acting on an admin-equivalent account (reset, re-role, delete) is a way to
// BECOME it — refused unless the caller is admin-equivalent too.
async function assertMayActOn(req: Request, id: string): Promise<void> {
  const user = await userService.getUserForAction(id);
  assertNoPrivilegeEscalation(req, user.role.permissions, `the account "${user.username}"`);
}

router.get("/", async (_req, res, next) => {
  try {
    res.json(await userService.listUsers());
  } catch (err) { next(err); }
});

router.post("/", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const input = CreateUserSchema.parse(req.body);
    const role = await userService.getRoleForAssignment(input.roleId);
    assertGrantWithinCaller(req, role.permissions, `the role "${role.name}"`);
    res.status(201).json(await userService.createLocalUser(input, actorOf(req)));
  } catch (err) { next(err); }
});

router.put("/:id/password", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { password } = ResetPasswordSchema.parse(req.body);
    await assertMayActOn(req, id);
    await userService.resetPassword(id, password, actorOf(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.put("/:id/role", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { roleId } = UpdateRoleSchema.parse(req.body);
    const role = await userService.getRoleForAssignment(roleId);
    assertGrantWithinCaller(req, role.permissions, `the role "${role.name}"`);
    await assertMayActOn(req, id);
    res.json({ ok: true, user: await userService.changeRole(id, roleId, actorOf(req)) });
  } catch (err) { next(err); }
});

router.delete("/:id/role-review", requirePermission("users", "write"), async (req, res, next) => {
  try {
    await userService.dismissRoleReview(String(req.params.id), actorOf(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete("/:id/totp", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    await assertMayActOn(req, id);
    await userService.resetTotp(id, actorOf(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/:id/passkeys", async (req, res, next) => {
  try {
    res.json({ passkeys: await userService.listUserPasskeys(String(req.params.id)) });
  } catch (err) { next(err); }
});

router.delete("/:id/passkeys", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    await assertMayActOn(req, id);
    res.json({ ok: true, removed: await userService.revokePasskeys(id, actorOf(req)) });
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    await assertMayActOn(req, id);
    await userService.deleteUser(id, actorOf(req));
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
