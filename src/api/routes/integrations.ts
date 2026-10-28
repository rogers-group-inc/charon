/**
 * src/api/routes/integrations.ts — Integration CRUD, test, discovery, API console.
 *
 * Ported from polaris's integrations router, cut to Charon's four types
 * (FortiManager, FortiGate, Active Directory, Entra ID + Intune). Mounted
 * behind requirePermission("integrations", "read"); writes require "write".
 * Secrets are masked on read and preserved-on-unchanged (only while their
 * destination is unchanged) by integrationConfig. Discovery is read-only
 * (populates the DirectoryObject mirror). Enforcement enable/disable lives on
 * a separate route gated by the "enforcement" function key — flipping a
 * firewall to live writes is higher blast radius than editing an integration.
 *
 * Config validation: every config — create AND update — is parsed with its
 * type's schema below (fields optional; defaults only on create). polaris
 * validated create only and merged updates unvalidated; z.object strips
 * unknown keys, so a field a schema forgot was silently dropped on one path
 * and kept on the other. Here a field missing from a schema is dropped on
 * BOTH, which a test catches.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import {
  listIntegrations, getIntegration, createIntegration, updateIntegration,
  deleteIntegration, testIntegration, preflightTest, getDecryptedIntegration,
  INTEGRATION_TYPES,
} from "../../services/integrationService.js";
import { triggerDiscovery } from "../../services/discovery/directoryDiscovery.js";
import { listActiveRuns, requestCancel } from "../../services/discoveryRunState.js";
import { getIntegrationHealthSummary } from "../../services/integrationHealthService.js";
import { getFmgActivityForIntegration } from "../../services/fmgActivityService.js";
import * as fortimanager from "../../services/fortimanagerService.js";
import * as fortigate from "../../services/fortigateService.js";
import * as entraId from "../../services/entraIdService.js";
import * as activeDirectory from "../../services/activeDirectoryService.js";
import { logEvent } from "../../services/eventService.js";
import { isBlockedOutboundHost } from "../../utils/netGuard.js";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";

// ─── Config schemas (per type) ──────────────────────────────────────────────

// SSRF guard shared by every config schema that carries a `host`: blocks
// loopback / link-local / cloud-metadata / multicast literals while leaving
// RFC1918 LAN device addresses (the normal target) allowed.
function refineConfigHost(cfg: { host?: string }, ctx: z.RefinementCtx): void {
  if (cfg.host && isBlockedOutboundHost(cfg.host)) {
    ctx.addIssue({
      code: "custom",
      path: ["host"],
      message:
        `Host "${cfg.host.trim()}" is in a blocked range (loopback / link-local / ` +
        `metadata / multicast) and cannot be used as an integration target. ` +
        `Use the device's routable LAN address.`,
    });
  }
}

const patterns = z.array(z.string().max(512)).max(500);

// Field sets, all optional; CREATE_DEFAULTS supplies a new integration's values.
const FortiManagerFields = z.object({
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65535),
  apiUser: z.string().max(255),
  apiToken: z.string().max(4096),
  adom: z.string().max(255),
  // Verify the CA chain. Off ⇒ the leaf certificate is TOFU-pinned (TlsCertPin).
  verifySsl: z.boolean(),
  mgmtInterface: z.string().max(255),
  deviceInclude: patterns,
  deviceExclude: patterns,
  // true (default): per-device calls ride FMG's /sys/proxy/json (serialized).
  // false: direct to each FortiGate's management IP with the fleet token below.
  useProxy: z.boolean(),
  fortigateApiUser: z.string().max(255),
  fortigateApiToken: z.string().max(4096),
  fortigateVerifySsl: z.boolean(),
}).partial();

const FortiGateFields = z.object({
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65535),
  apiUser: z.string().max(255),
  apiToken: z.string().max(4096),
  vdom: z.string().max(255),
  verifySsl: z.boolean(),
  mgmtInterface: z.string().max(255),
}).partial();

const EntraIdFields = z.object({
  tenantId: z.string().trim().max(255),
  clientId: z.string().trim().max(255),
  clientSecret: z.string().max(4096),
  // Intune is a flag on this integration (polaris), not a type of its own.
  enableIntune: z.boolean(),
  includeDisabled: z.boolean(),
  deviceInclude: patterns,
  deviceExclude: patterns,
  // Opt-in WRITE capability: publish the agent onboarding script to Intune as
  // an UNASSIGNED Remediation. Needs DeviceManagementScripts.ReadWrite.All.
  publishToIntune: z.boolean(),
}).partial();

const ActiveDirectoryFields = z.object({
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65535),
  useLdaps: z.boolean(),
  verifyTls: z.boolean(),
  bindDn: z.string().max(1024),
  bindPassword: z.string().max(4096),
  baseDn: z.string().max(1024),
  searchScope: z.enum(["sub", "one"]),
  ouInclude: patterns,
  ouExclude: patterns,
  includeDisabled: z.boolean(),
}).partial();

const CONFIG_SCHEMAS = {
  fortimanager: FortiManagerFields.superRefine(refineConfigHost),
  fortigate: FortiGateFields.superRefine(refineConfigHost),
  entraid: EntraIdFields,
  activedirectory: ActiveDirectoryFields.superRefine(refineConfigHost),
} as const;

/** A new integration's defaults — secure by default (TLS verification ON). */
const CREATE_DEFAULTS: Record<keyof typeof CONFIG_SCHEMAS, Record<string, unknown>> = {
  fortimanager: { host: "", port: 443, apiUser: "", apiToken: "", adom: "root", verifySsl: true, mgmtInterface: "", deviceInclude: [], deviceExclude: [], useProxy: true, fortigateApiUser: "", fortigateApiToken: "", fortigateVerifySsl: true },
  fortigate: { host: "", port: 443, apiUser: "", apiToken: "", vdom: "root", verifySsl: true, mgmtInterface: "" },
  entraid: { tenantId: "", clientId: "", clientSecret: "", enableIntune: false, includeDisabled: true, deviceInclude: [], deviceExclude: [], publishToIntune: false },
  activedirectory: { host: "", port: 636, useLdaps: true, verifyTls: true, bindDn: "", bindPassword: "", baseDn: "", searchScope: "sub", ouInclude: [], ouExclude: [], includeDisabled: true },
};

/** Parse a submitted config with its type's schema (unknown keys stripped). Exported for tests. */
export function parseConfig(type: string, config: unknown): Record<string, unknown> {
  const schema = CONFIG_SCHEMAS[type as keyof typeof CONFIG_SCHEMAS];
  if (!schema) throw new AppError(400, `Unknown integration type "${type}"`);
  return schema.parse(config ?? {}) as Record<string, unknown>;
}

const typeEnum = z.enum(INTEGRATION_TYPES as unknown as [string, ...string[]]);

const createSchema = z.object({
  type: typeEnum,
  name: z.string().trim().min(1).max(255),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().optional(),
  autoDiscover: z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(168).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  autoDiscover: z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(168).optional(),
});

const preflightSchema = z.object({
  type: typeEnum,
  config: z.record(z.string(), z.unknown()),
  existingId: z.string().optional(),
});

// API console bodies — READ-ONLY by construction (Charon): the console reaches
// devices with the stored credentials, so it only ever reads.
const FmgQuerySchema = z.object({
  mode: z.literal("fmg").optional(),
  // JSON-RPC "get" only — never set/add/update/delete/exec.
  method: z.literal("get"),
  params: z.array(z.unknown()).max(20),
});
const FmgViaGateQuerySchema = z.object({
  mode: z.literal("fortigate"),
  deviceName: z.string().min(1).max(255),
  method: z.literal("GET").optional().default("GET"),
  path: z.string().min(1).max(1024),
  query: z.record(z.string(), z.string()).optional(),
});
const FgtQuerySchema = z.object({
  method: z.literal("GET").optional().default("GET"),
  path: z.string().min(1).max(1024),
  query: z.record(z.string(), z.string()).optional(),
});
const GraphQuerySchema = z.object({
  path: z.string().min(1).max(2048),
  query: z.record(z.string(), z.string()).optional(),
});
const LdapQuerySchema = z.object({
  filter: z.string().max(4096).optional(),
  baseDn: z.string().max(1024).optional(),
  scope: z.enum(["sub", "one", "base"]).optional(),
  attributes: z.array(z.string().max(255)).max(100).optional(),
  sizeLimit: z.number().int().min(1).max(500).optional(),
});

const router = Router();

function sendProxyJson(res: Response, result: unknown): void {
  res.json({ result });
}

// ─── Read-gated ──────────────────────────────────────────────────────────────

router.get("/types", (_req, res) => res.json({ types: INTEGRATION_TYPES }));

router.get("/", async (_req, res, next) => {
  try {
    res.json({ integrations: await listIntegrations() });
  } catch (err) { next(err); }
});

// Failed-integration notice for the sidebar (polaris's health-summary poll).
router.get("/health-summary", async (_req, res, next) => {
  try {
    res.json(await getIntegrationHealthSummary());
  } catch (err) { next(err); }
});

// Live discovery runs (queued / running) for the Integrations page.
router.get("/discoveries", async (_req, res, next) => {
  try {
    const now = Date.now();
    const rows = await listActiveRuns();
    res.json({
      discoveries: rows.map((row) => {
        const base = (row.startedAt ?? row.createdAt).getTime();
        return {
          id: row.integrationId,
          name: row.integrationName,
          type: row.type,
          status: row.status,
          startedAt: base,
          elapsedMs: now - base,
          totalObjects: row.totalDevices,
          completedCount: row.completedCount,
        };
      }),
    });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await getIntegration(String(req.params.id)));
  } catch (err) { next(err); }
});

// Live FortiManager worker-lane state (heartbeat snapshot from the process that runs FMG traffic).
router.get("/:id/fmg-activity", async (req, res, next) => {
  try {
    const integ = await getIntegration(String(req.params.id));
    if (integ.type !== "fortimanager") throw new AppError(400, "fmg-activity only applies to fortimanager integrations");
    res.json(await getFmgActivityForIntegration(integ.id));
  } catch (err) { next(err); }
});

// ─── Write-gated ─────────────────────────────────────────────────────────────

router.post("/", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const config = { ...CREATE_DEFAULTS[input.type as keyof typeof CREATE_DEFAULTS], ...parseConfig(input.type, input.config) };
    res.status(201).json(await createIntegration({ ...input, config }, req.session.username));
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const input = updateSchema.parse(req.body);
    const id = String(req.params.id);
    if (input.config) {
      const existing = await getIntegration(id);
      input.config = parseConfig(existing.type, input.config);
    }
    res.json(await updateIntegration(id, input, req.session.username));
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    await deleteIntegration(String(req.params.id), req.session.username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Test a SAVED integration's stored credentials.
router.post("/:id/test", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    res.json(await testIntegration(String(req.params.id)));
  } catch (err) { next(err); }
});

// FortiManager direct mode: test one random managed FortiGate with the fleet token.
router.post("/:id/test/fortigate-sample", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const integ = await getDecryptedIntegration(String(req.params.id));
    if (integ.type !== "fortimanager") throw new AppError(400, "fortigate-sample only applies to fortimanager integrations");
    res.json(await fortimanager.testRandomFortiGate(integ.config as any, integ.id));
  } catch (err) { next(err); }
});

// Preflight test of an UNSAVED config (the configure modal's Test button).
router.post("/test", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const { type, config, existingId } = preflightSchema.parse(req.body);
    res.json(await preflightTest(type, parseConfig(type, config), existingId));
  } catch (err) { next(err); }
});

// Start a discovery run (directory sources). 202: the run is queued; poll /discoveries.
router.post("/:id/discover", requirePermission("integrations", "write"), async (req, res, next) => {
  try {
    const started = await triggerDiscovery(String(req.params.id), req.session.username ?? "unknown");
    res.status(202).json({ queued: started, alreadyRunning: !started });
  } catch (err) { next(err); }
});

// Cancel an in-flight discovery — disruptive, so fullwrite (polaris parity).
router.delete("/:id/discover", requirePermission("integrations", "fullwrite"), async (req, res, next) => {
  try {
    const cancelled = await requestCancel(String(req.params.id));
    if (!cancelled) throw new AppError(404, "No active discovery for this integration");
    res.status(204).send();
  } catch (err) { next(err); }
});

// Read-only API console. Reaches devices with the STORED credentials, so it is
// fullwrite-gated and every call is audited.
router.post("/:id/query", requirePermission("integrations", "fullwrite"), async (req, res, next) => {
  try {
    const integ = await getDecryptedIntegration(String(req.params.id));
    const audit = (detail: string, details: Record<string, unknown>) =>
      void logEvent({ action: "integration.query", resourceType: "integration", resourceId: integ.id, resourceName: integ.name, actor: req.session.username, message: `API console: ${detail}`, details });

    if (integ.type === "fortimanager") {
      if (req.body && (req.body as { mode?: unknown }).mode === "fortigate") {
        const q = FmgViaGateQuerySchema.parse(req.body);
        audit(`GET ${q.path} on FortiGate "${q.deviceName}" (direct)`, { deviceName: q.deviceName, path: q.path });
        sendProxyJson(res, await fortimanager.proxyQueryViaFortigate(integ.config as any, q.deviceName, "GET", q.path, q.query, integ.id));
        return;
      }
      const q = FmgQuerySchema.parse(req.body);
      audit("FortiManager JSON-RPC get", { params: q.params });
      sendProxyJson(res, await fortimanager.proxyQuery(integ.config as any, "get", q.params, integ.id));
      return;
    }
    if (integ.type === "fortigate") {
      const q = FgtQuerySchema.parse(req.body);
      audit(`GET ${q.path}`, { path: q.path });
      sendProxyJson(res, await fortigate.proxyQuery(integ.config as any, "GET", q.path, q.query));
      return;
    }
    if (integ.type === "entraid") {
      const q = GraphQuerySchema.parse(req.body);
      audit(`Graph GET ${q.path}`, { path: q.path });
      sendProxyJson(res, await entraId.proxyQuery(integ.config as any, q.path, q.query));
      return;
    }
    if (integ.type === "activedirectory") {
      const q = LdapQuerySchema.parse(req.body);
      audit(`LDAP search ${q.filter ?? "(default)"}`, { filter: q.filter, baseDn: q.baseDn, scope: q.scope });
      sendProxyJson(res, await activeDirectory.proxyQuery(integ.config as any, q));
      return;
    }
    throw new AppError(400, "API query is not supported for this integration type");
  } catch (err) { next(err); }
});

// ─── Enforcement (high blast radius — separate "enforcement" key) ────────────
// Flipping to LIVE Fortinet writes requires fullwrite on the enforcement key
// AND human review. Default is dry_run.
router.patch("/:id/enforcement", requirePermission("enforcement", "fullwrite"), async (req, res, next) => {
  try {
    const { setEnforcementMode } = await import("../../services/fortinetEnforcementService.js");
    const { mode } = z.object({ mode: z.enum(["dry_run", "enforce"]) }).parse(req.body);
    await setEnforcementMode(String(req.params.id), mode, req.session.username);
    res.json({ ok: true, mode });
  } catch (err) { next(err); }
});

// Per-object sync state (drift surface) for an integration.
router.get("/:id/enforcement-state", requirePermission("enforcement", "read"), async (req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const states = await prisma.enforcementState.findMany({ where: { integrationId: String(req.params.id) }, orderBy: { objectName: "asc" } });
    res.json({ states });
  } catch (err) { next(err); }
});

export default router;
