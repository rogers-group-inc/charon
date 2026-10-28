/**
 * src/api/routes/settings/webServer.ts — Server Settings: Web Server tab.
 *
 * Ported from polaris (src/api/routes/serverSettings.ts /certificates, /https,
 * /ipv6, /login-access, /agents/cert-pins/*, and proxySettings.ts) to
 * back the ported public/js/server-settings-webserver.js module at the exact
 * paths public/js/settings-api.js calls. Mounted WITHOUT a router-level gate
 * (router.ts) — every route declares its own requirePermission(), because a
 * router.use() gate here would also fire for every other /server-settings path
 * that passes through this router.
 *
 * Supersedes charon's original Certificates routes (GET/POST /certificates,
 * /certificates/stage, /certificates/promote in routes/serverSettings.ts): the
 * leaf cert now changes only through the dual-pin Rotate flow below.
 *
 * Gates: polaris's top rung ("write") maps to charon fullwrite for anything
 * that changes TLS, the agents' pins, nginx, or who may reach the login page.
 *
 *   GET    /certificates                         system:read      trusted CA list
 *   POST   /certificates            (multipart)  system:fullwrite upload a trusted CA
 *   DELETE /certificates/:id                     system:fullwrite remove a trusted CA
 *   GET    /https                                system:read      served leaf-cert facts
 *   GET    /proxy                                system:read      nginx controls + drift + fingerprint
 *   PUT    /proxy                                system:fullwrite save controls (no apply)
 *   POST   /proxy/adopt-managed-mode             system:fullwrite
 *   POST   /proxy/apply                          system:fullwrite render + nginx -t + reload
 *   POST   /proxy/cert/preflight    (multipart)  system:fullwrite validate a new pair
 *   POST   /proxy/cert/rotate                    system:fullwrite swap the pair + reload
 *   GET    /agents/cert-pins/summary             system:read      pin uptake across agents
 *   POST   /agents/cert-pins/bulk-add            system:fullwrite stage a pin
 *   POST   /agents/cert-pins/bulk-remove         system:fullwrite retire a pin
 *   GET/PUT /ipv6                                system:read / write     (persist-only)
 *   GET/PUT /login-access                        system:read / fullwrite (gates /auth/login)
 */

import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { AppError } from "../../../utils/errors.js";
import { logEvent } from "../../../services/eventService.js";
import { addTrustedCa, bufferToPem, deleteTrustedCa, listTrustedCas } from "../../../services/trustedCaService.js";
import {
  applyProxyConfig,
  getDriftStatus,
  getHttpsInfo,
  getServedCertFingerprint,
  preflightCertRotation,
  rotateCertAndKey,
} from "../../../services/webServerService.js";
import { getProxyConfig, saveProxyConfig } from "../../../services/proxyConfigService.js";
import {
  getPinStore,
  listActiveDeliveredPins,
  normalizePin,
  retirePin,
  rowHasPin,
  stageNewPin,
  tallyPins,
} from "../../../services/certPinService.js";
import {
  getIpv6Status,
  getLoginAccessSettings,
  loginSourceAllowed,
  previewLoginAccessSettings,
  saveLoginAccessSettings,
  setIpv6Enabled,
} from "../../../services/webAccessSettingsService.js";
import { describeIpScope } from "../../../utils/ipScope.js";
import { adminActionLimiter } from "../../middleware/rateLimits.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ScopeSchema = z.object({
  enabled: z.boolean().optional(),
  ipScope: z.enum(["rfc1918", "all", "custom"]).optional(),
  // CIDR validation + normalization happens in the service.
  allowedCidrs: z.array(z.string().max(64)).max(200).optional(),
});

const Ipv6ToggleSchema = z.object({ enabled: z.boolean() });

// Field types only — the service's validateProxyConfig owns the value rules
// (TLS 1.3 only, port range, IP syntax).
const ProxyPatchSchema = z.object({
  httpsPort: z.number().int().optional(),
  http3Enabled: z.boolean().optional(),
  tlsProtocols: z.array(z.string()).max(2).optional(),
  hsts: z.object({
    enabled: z.boolean().optional(),
    maxAgeSeconds: z.number().int().min(0).optional(),
    includeSubDomains: z.boolean().optional(),
    preload: z.boolean().optional(),
  }).optional(),
  prometheusAllowIps: z.array(z.string().max(64)).max(200).optional(),
});

const PinSchema = z.object({ pin: z.string().min(1).max(200) });

const RotateSchema = z.object({
  certPem: z.string().min(1).max(64 * 1024),
  keyPem: z.string().min(1).max(64 * 1024),
});

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
}

function parsePin(raw: string): string {
  const pin = normalizePin(raw);
  if (!pin) throw new AppError(400, "pin must be a SHA-256 fingerprint (64 hex chars, optionally sha256:-prefixed)");
  return pin;
}

function parseProxyPatch(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.managedMode !== undefined) throw new AppError(400, "Use POST /adopt-managed-mode to flip managedMode");
  return parse(ProxyPatchSchema, body) as Parameters<typeof saveProxyConfig>[0];
}

function actor(req: Request): string {
  return req.session?.username ?? "unknown";
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 2 } });

const router = Router();

// ─── Trusted CAs ──────────────────────────────────────────────────────────────

router.get("/certificates", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const cas = await listTrustedCas();
    // Strip PEM content from the list response (polaris parity). serverCerts is
    // always empty — the leaf is managed by Rotate certificate, not this list.
    res.json({ trustedCAs: cas.map((c) => ({ ...c, pem: undefined })), serverCerts: [] });
  } catch (err) { next(err); }
});

router.post("/certificates", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No file uploaded");
    if (req.body?.category === "server") {
      throw new AppError(409, "The server certificate is managed by Rotate certificate (dual-pin stage → swap → retire), not uploaded here");
    }
    const record = await addTrustedCa(req.file.originalname, bufferToPem(req.file.buffer));
    await logEvent({
      level: "warning",
      action: "certificate.ca_added",
      resourceType: "certificate",
      resourceId: record.id,
      resourceName: record.name,
      actor: actor(req),
      message: `Trusted CA added: ${record.subject ?? record.name} (outbound TLS now trusts it)`,
      details: { fingerprint: record.fingerprint, expiresAt: record.expiresAt },
    });
    res.status(201).json({ ...record, pem: undefined });
  } catch (err) { next(err); }
});

router.delete("/certificates/:id", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const removed = await deleteTrustedCa(String(req.params.id));
    if (removed) {
      await logEvent({
        level: "warning",
        action: "certificate.ca_removed",
        resourceType: "certificate",
        resourceId: removed.id,
        resourceName: removed.name,
        actor: actor(req),
        message: `Trusted CA removed: ${removed.subject ?? removed.name}`,
      });
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── HTTPS (served leaf cert) ────────────────────────────────────────────────

router.get("/https", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    res.json(await getHttpsInfo());
  } catch (err) { next(err); }
});

// ─── nginx proxy ─────────────────────────────────────────────────────────────

router.get("/proxy", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const [config, drift, currentFingerprint] = await Promise.all([getProxyConfig(), getDriftStatus(), getServedCertFingerprint()]);
    res.json({ config, drift, currentFingerprint });
  } catch (err) { next(err); }
});

router.put("/proxy", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const saved = await saveProxyConfig(parseProxyPatch(req.body));
    await logEvent({
      action: "proxy.config_saved",
      resourceType: "setting",
      resourceName: "proxyConfig",
      actor: actor(req),
      message: "nginx proxy settings saved (not applied)",
    });
    res.json({ config: saved });
  } catch (err) { next(err); }
});

router.post("/proxy/adopt-managed-mode", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const saved = await saveProxyConfig({ managedMode: true });
    await logEvent({
      action: "proxy.managed_mode_adopted",
      resourceType: "setting",
      resourceName: "proxyConfig",
      actor: actor(req),
      message: "Operator adopted Charon-managed nginx config mode",
    });
    res.json({ config: saved });
  } catch (err) { next(err); }
});

router.post("/proxy/apply", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const patch = req.body && Object.keys(req.body).length ? parseProxyPatch(req.body) : undefined;
    const result = await applyProxyConfig(patch);
    await logEvent({
      level: result.ok ? "info" : "warning",
      action: result.ok ? "proxy.config_applied" : "proxy.config_apply_failed",
      resourceType: "setting",
      resourceName: "proxyConfig",
      actor: actor(req),
      message: result.ok
        ? `Applied nginx config (sha256=${result.hash.slice(0, 12)}…)`
        : `nginx config apply failed: ${result.wrapperOutput.slice(0, 500)}`,
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) { next(err); }
});

// Multipart { cert, key }. Echoes the PEMs back so /cert/rotate needs no
// re-upload — the modal holds them in JS memory across its steps (polaris).
router.post(
  "/proxy/cert/preflight",
  requirePermission("serverSettingsSystem", "fullwrite"),
  upload.fields([{ name: "cert", maxCount: 1 }, { name: "key", maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const certFile = files?.cert?.[0];
      const keyFile = files?.key?.[0];
      if (!certFile || !keyFile) throw new AppError(400, "Both `cert` and `key` files are required");
      const certPem = certFile.buffer.toString("utf8");
      const keyPem = keyFile.buffer.toString("utf8");
      const preflight = await preflightCertRotation(certPem, keyPem);
      res.json({ ...preflight, certPem, keyPem });
    } catch (err) { next(err); }
  },
);

// The swap step. The new pin must already be staged (step 2) — enforced in
// the service so the fleet can never be stranded.
router.post("/proxy/cert/rotate", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { certPem, keyPem } = parse(RotateSchema, req.body);
    const result = await rotateCertAndKey(certPem, keyPem);
    await logEvent({
      level: "warning",
      action: result.ok ? "proxy.cert_rotated" : "proxy.cert_rotate_failed",
      resourceType: "certificate",
      resourceName: "server-leaf",
      actor: actor(req),
      message: result.ok
        ? `Server cert rotated (new agent pin ${result.fingerprint}); the previous pin stays accepted until retired` +
          (result.note ? `. ${result.note}` : "")
        : `Cert rotation failed (previous pair restored): ${result.wrapperOutput.slice(0, 500)}`,
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) { next(err); }
});

// ─── Agent cert pins (dual-pin rotation) ─────────────────────────────────────

router.get("/agents/cert-pins/summary", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const [rows, store] = await Promise.all([listActiveDeliveredPins(), getPinStore()]);
    // `accepted` (charon addition) is the server-side set agents are being handed.
    res.json({ totalActiveAgents: rows.length, pins: tallyPins(rows), accepted: store });
  } catch (err) { next(err); }
});

router.post("/agents/cert-pins/bulk-add", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const pin = parsePin(parse(PinSchema, req.body).pin);
    await stageNewPin(pin);
    const rows = await listActiveDeliveredPins();
    const alreadyPresent = rows.filter((r) => rowHasPin(r, pin)).length;
    const added = rows.length - alreadyPresent;
    await logEvent({
      level: "warning",
      action: "agent.cert_pin_staged",
      resourceType: "setting",
      resourceName: "agent.cert_pins",
      actor: actor(req),
      message: `Staged agent cert pin ${pin} — ${added} agent(s) receive it on their next config poll (${alreadyPresent} already had it)`,
      details: { pin, added, alreadyPresent, totalActive: rows.length },
    });
    res.json({ pin, added, alreadyPresent, totalActive: rows.length });
  } catch (err) { next(err); }
});

router.post("/agents/cert-pins/bulk-remove", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const pin = parsePin(parse(PinSchema, req.body).pin);
    if (pin === (await getServedCertFingerprint())) {
      throw new AppError(409, "That pin belongs to the certificate nginx is serving — retiring it would cut every agent off");
    }
    const rows = await listActiveDeliveredPins();
    const holders = rows.filter((r) => rowHasPin(r, pin)).length;
    const outcome = await retirePin(pin);
    const result = {
      pin,
      removed: outcome === "retired" ? holders : 0,
      notPresent: outcome === "not_present" ? rows.length : rows.length - holders,
      lastPinSkipped: outcome === "last_pin" ? holders : 0,
      totalActive: rows.length,
    };
    await logEvent({
      level: "warning",
      action: "agent.cert_pin_retired",
      resourceType: "setting",
      resourceName: "agent.cert_pins",
      actor: actor(req),
      message:
        outcome === "retired" ? `Retired agent cert pin ${pin} (${holders} agent(s) drop it on their next config poll)`
        : outcome === "last_pin" ? `Refused to retire agent cert pin ${pin} — it is the only pin agents trust`
        : `Agent cert pin ${pin} was not in the accepted set — nothing retired`,
      details: { ...result, outcome },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── IPv6 (persist-only in charon) ───────────────────────────────────────────

router.get("/ipv6", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    res.json({ ipv6: await getIpv6Status() });
  } catch (err) { next(err); }
});

router.put("/ipv6", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const { enabled } = parse(Ipv6ToggleSchema, req.body);
    const { before, after } = await setIpv6Enabled(enabled);
    await logEvent({
      action: "settings.ipv6.updated",
      resourceType: "setting",
      resourceName: "ipv6Config",
      actor: actor(req),
      message: `IPv6 switched ${enabled ? "ON" : "OFF"}` + (before.enabled !== enabled ? ` (was ${before.enabled ? "on" : "off"})` : ""),
      details: { enabled, previous: before.enabled, hostAddresses: after.hostAddresses },
    });
    res.json({ ipv6: after });
  } catch (err) { next(err); }
});

// ─── Local login access (source-IP scope on the operator password login) ─────

router.get("/login-access", requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    // callerIp reveals a trust-proxy misconfiguration before the scope is relied on.
    res.json({ loginAccess: await getLoginAccessSettings(), callerIp: req.ip ?? "" });
  } catch (err) { next(err); }
});

router.put("/login-access", adminActionLimiter, requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const input = parse(ScopeSchema, req.body);
    const before = await getLoginAccessSettings();
    // Anti-lockout: refuse a scope that excludes the admin saving it.
    const prospective = await previewLoginAccessSettings(input);
    const callerIp = req.ip ?? "";
    if (prospective.enabled && !loginSourceAllowed(callerIp, prospective)) {
      throw new AppError(
        400,
        `Your own source IP (${callerIp || "unknown"}) is outside that scope — saving it would lock you out of the local login page. ` +
          "Add a network covering it, or apply the restriction from an allowed network.",
      );
    }
    const updated = await saveLoginAccessSettings(input);
    await logEvent({
      level: updated.enabled ? "warning" : "info",
      action: "login_access.updated",
      resourceType: "setting",
      resourceName: "loginAccessConfig",
      actor: actor(req),
      message: updated.enabled
        ? `Local login restricted to ${describeIpScope(updated.ipScope, updated.allowedCidrs)}`
        : "Local login source-IP restriction removed",
      details: { before, after: updated },
    });
    res.json({ loginAccess: updated, callerIp });
  } catch (err) { next(err); }
});

export default router;
