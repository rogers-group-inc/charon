/**
 * src/api/routes/settings/apiTokens.ts — Server Settings: API Tokens tab.
 *
 * Ported from polaris (src/api/routes/apiTokens.ts + serverSettings.ts
 * /api-docs) to back public/js/server-settings-api-tokens.js at the exact paths
 * public/js/settings-api.js calls. Mounted WITHOUT a router-level gate
 * (router.ts) — every route declares its own requirePermission(), because a
 * router.use() gate here would also fire for every other /server-settings path
 * that passes through this router.
 *
 *   default export   /server-settings/api-docs        GET (serverSettingsSystem read)
 *                                                      PUT (serverSettingsSystem write)
 *   apiTokensRouter  /api-tokens                       GET (apiTokens read)
 *                    /api-tokens, /:id/trusted-hosts, /:id/revoke, DELETE /:id
 *                                                      (apiTokens write)
 *
 * Each token is bound to a Role at mint time and acts with that role's matrix
 * (permissions.ts). The raw token value is returned ONCE by POST and never again.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, ensureSessionRoleSnapshot } from "../../middleware/permissions.js";
import { logEvent } from "../../../services/eventService.js";
import {
  createToken,
  deleteToken,
  listTokens,
  listRoleChoices,
  revokeToken,
  updateTrustedHosts,
  getPublicApiBaseUrl,
} from "../../../services/apiTokenService.js";
import {
  getApiDocsSettings,
  saveApiDocsSettings,
  docsSourceAllowed,
  describeIpScope,
} from "../../../services/apiDocsAccessService.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(80).regex(NO_CONTROL_CHARS, "Name may not contain control characters"),
  roleId: z.string().min(1),
  // Polaris's quarantine-integration binding has no charon equivalent; accepted
  // (the shared UI may send it) and ignored.
  integrationIds: z.array(z.string()).max(0, "Integration binding is not supported in Charon").optional(),
  // Bare IPs / CIDRs; omitted or empty = any source. Format validated in the service.
  trustedHosts: z.array(z.string().max(64)).max(256).optional(),
  expiresAt: z.string().datetime().optional(),
});

const UpdateTrustedHostsSchema = z.object({
  trustedHosts: z.array(z.string().max(64)).max(256),
});

const ApiDocsSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  ipScope: z.enum(["loopback", "rfc1918", "custom"]).optional(),
  allowedCidrs: z.array(z.string()).max(200).optional(),
});

function actorOf(req: Request): string {
  return req.session?.username || (req.apiToken ? `api:${req.apiToken.name}` : "unknown");
}

// ─── /server-settings/api-docs ──────────────────────────────────────────────

const router = Router();

router.get("/api-docs", requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    // callerIp: the scope compares req.ip, which is only the real client when
    // `trust proxy` matches the deployment's hop count — surfacing the observed
    // value lets an operator catch a misconfiguration before relying on it.
    res.json({ apiDocs: await getApiDocsSettings(), callerIp: req.ip ?? "" });
  } catch (err) {
    next(err);
  }
});

router.put("/api-docs", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const input = ApiDocsSettingsSchema.parse(req.body ?? {});
    const before = await getApiDocsSettings();
    const updated = await saveApiDocsSettings(input);
    // Warn-only: being outside the DOCS scope is not a lockout.
    const callerIp = req.ip ?? "";
    const callerAllowed = docsSourceAllowed(callerIp, updated);
    await logEvent({
      level: "info",
      action: "api_docs_settings.updated",
      resourceType: "setting",
      resourceName: "apiDocsConfig",
      actor: actorOf(req),
      message: updated.enabled
        ? `API documentation page scoped to ${describeIpScope(updated.ipScope, updated.allowedCidrs)}`
        : "API documentation page disabled",
      details: { before, after: updated, actorIp: callerIp },
    });
    // Charon has no managed nginx `location = /api` block for the docs page,
    // so there is never an nginx sync to attempt (polaris returned its result).
    res.json({ apiDocs: updated, callerAllowed, nginx: { attempted: false } });
  } catch (err) {
    next(err);
  }
});

export default router;

// ─── /api-tokens ────────────────────────────────────────────────────────────

/** Mounted at /api/v1/api-tokens (polaris path). */
export const apiTokensRouter = Router();

apiTokensRouter.get("/", requirePermission("apiTokens", "read"), async (_req, res, next) => {
  try {
    const [tokens, roles] = await Promise.all([listTokens(), listRoleChoices()]);
    // quarantineIntegrations: polaris's FortiGate-quarantine picker — always
    // empty in charon, so the tab renders nothing for it.
    res.json({ tokens, roles, quarantineIntegrations: [], apiBaseUrl: getPublicApiBaseUrl() });
  } catch (err) {
    next(err);
  }
});

apiTokensRouter.post("/", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const input = CreateTokenSchema.parse(req.body);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, "expiresAt must be in the future");
    }
    const caller = await ensureSessionRoleSnapshot(req);
    if (!caller) throw new AppError(403, "Forbidden — role required");
    const result = await createToken({
      name: input.name,
      roleId: input.roleId,
      trustedHosts: input.trustedHosts,
      expiresAt,
      createdBy: actorOf(req),
      callerPermissions: caller.permissions,
    });
    await logEvent({
      action: "api_token.created",
      resourceType: "api_token",
      resourceId: result.token.id,
      resourceName: result.token.name,
      actor: actorOf(req),
      message:
        `API token "${result.token.name}" created with role "${result.token.roleName}"` +
        (result.token.trustedHosts.length
          ? `, accepted only from ${result.token.trustedHosts.join(", ")}`
          : ", accepted from any source address"),
      details: { trustedHosts: result.token.trustedHosts, expiresAt: result.token.expiresAt },
    });
    // The raw token field is the ONLY time the caller sees the value.
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

apiTokensRouter.put("/:id/trusted-hosts", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const input = UpdateTrustedHostsSchema.parse(req.body);
    const { token, before } = await updateTrustedHosts(id, input.trustedHosts);
    const describe = (hosts: string[]) => (hosts.length ? hosts.join(", ") : "any source");
    await logEvent({
      action: "api_token.trusted_hosts_updated",
      resourceType: "api_token",
      resourceId: token.id,
      resourceName: token.name,
      actor: actorOf(req),
      // Opening a restricted token to every source is the widening an auditor needs to see first.
      level: before.length > 0 && token.trustedHosts.length === 0 ? "warning" : "info",
      message: `API token "${token.name}" trusted hosts changed from ${describe(before)} to ${describe(token.trustedHosts)}`,
      details: { before, after: token.trustedHosts },
    });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

apiTokensRouter.post("/:id/revoke", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { name } = await revokeToken(id, actorOf(req));
    await logEvent({
      action: "api_token.revoked",
      resourceType: "api_token",
      resourceId: id,
      resourceName: name,
      actor: actorOf(req),
      level: "warning",
      message: `API token "${name}" revoked`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

apiTokensRouter.delete("/:id", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { name } = await deleteToken(id);
    await logEvent({
      action: "api_token.deleted",
      resourceType: "api_token",
      resourceId: id,
      resourceName: name,
      actor: actorOf(req),
      level: "warning",
      message: `API token "${name}" deleted`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
