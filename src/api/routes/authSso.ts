/**
 * src/api/routes/authSso.ts — operator SSO (SAML, OIDC, Entra App Proxy) and
 * the per-provider settings, including LDAP's. Mounted at /auth beside
 * routes/auth.ts, before requireAuth.
 *
 * Public flows:
 *   GET  /saml/config | /oidc/config | /entra-proxy/config  — login-page probes (booleans only)
 *   GET  /saml/login  | /oidc/login                          — ssoEntryLimiter; redirect to the IdP
 *   POST /saml/callback (cross-site form POST; CSRF-exempt)  — ssoCallbackLimiter
 *   GET  /oidc/callback (top-level GET)                      — ssoCallbackLimiter
 *   GET  /entra-proxy/login                                  — entraProxyLoginLimiter
 * Every failure redirects to /login.html?error=… (never a protected page), so
 * the skip-login redirect can never loop.
 *
 * Settings: GET → requireAuth + authentication:read; PUT and POST …/test →
 * authentication:write. Secrets come back masked.
 *
 * SSO is never subject to Local Login Access (the path that must keep working
 * from anywhere) and never owes Charon's TOTP (the IdP owns MFA).
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { ssoEntryLimiter, ssoCallbackLimiter, entraProxyLoginLimiter } from "../middleware/rateLimits.js";
import { logEvent } from "../../services/eventService.js";
import * as authService from "../../services/authService.js";
import * as saml from "../../services/samlAuthService.js";
import * as oidc from "../../services/oidcAuthService.js";
import * as ldap from "../../services/ldapAuthService.js";
import * as entraProxy from "../../services/entraProxyAuthService.js";
import { regenerateSession, stampLoginSession, ctxOf } from "./auth.js";
import { generateRelayState, peekLoginTarget, relayStateTarget, takeLoginTarget } from "../../utils/loginRedirect.js";
import { safeNextPath } from "../../utils/safeRedirect.js";

const httpUrl = z.string().max(2048);
const SamlSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  applicationUrl: httpUrl.optional(),
  idpEntityId: z.string().max(1024).optional(),
  idpLoginUrl: httpUrl.optional(),
  idpLogoutUrl: httpUrl.optional(),
  idpCertificate: z.string().max(20_000).optional(),
  wantResponseSigned: z.boolean().optional(),
});
const OidcSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  discoveryUrl: httpUrl.optional(),
  clientId: z.string().max(512).optional(),
  clientSecret: z.string().max(2048).optional(),
  scopes: z.string().max(512).optional(),
  groupsClaim: z.string().max(128).optional(),
  usernameClaim: z.string().max(128).optional(),
  emailClaim: z.string().max(128).optional(),
  displayNameClaim: z.string().max(128).optional(),
});
const LdapSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().max(512).optional(),
  bindDn: z.string().max(1024).optional(),
  bindPassword: z.string().max(1024).optional(),
  searchBase: z.string().max(1024).optional(),
  searchFilter: z.string().max(1024).optional(),
  tlsVerify: z.boolean().optional(),
  displayNameAttr: z.string().max(128).optional(),
  emailAttr: z.string().max(128).optional(),
  userIdAttribute: z.string().max(128).optional(),
  groupAttribute: z.string().max(128).optional(),
  groupBaseDn: z.string().max(1024).optional(),
  groupFilter: z.string().max(1024).optional(),
});
const EntraProxySettingsSchema = z.object({
  enabled: z.boolean(),
  trustedSourceIps: z.array(z.string().max(64)).max(64),
  objectIdHeader: z.string().max(64),
  usernameHeader: z.string().max(64),
  emailHeader: z.string().max(64),
  displayNameHeader: z.string().max(64),
  groupsHeader: z.string().max(64),
}).partial();

const router = Router();

const readGate = [requireAuth, requirePermission("authentication", "read")];
const writeGate = [requireAuth, requirePermission("authentication", "write")];
const actor = (req: Request) => req.session?.username ?? req.apiToken?.name;
const originOf = (req: Request) => `${req.protocol}://${req.get("host") ?? ""}`;

function failRedirect(res: Response, err: unknown, fallback: string): void {
  res.redirect(`/login.html?error=${encodeURIComponent((err as Error)?.message || fallback)}`);
}

/** Sign an SSO-provisioned user in and send them on. */
async function finishSsoLogin(req: Request, res: Response, user: authService.UserWithRole, provider: string, target: string): Promise<void> {
  await regenerateSession(req);
  stampLoginSession(req, user, provider);
  await authService.recordLogin(user, provider, ctxOf(req));
  res.redirect(target);
}

async function auditSettings(req: Request, provider: string, enabled: boolean): Promise<void> {
  await logEvent({
    action: `auth.${provider}.settings_updated`,
    resourceType: "setting",
    resourceName: provider,
    actor: actor(req),
    message: `${provider.toUpperCase()} sign-in settings saved (${enabled ? "enabled" : "disabled"})`,
  });
}

// ─── SAML ───────────────────────────────────────────────────────────────────

router.get("/saml/config", ssoCallbackLimiter, async (_req, res) => {
  const s = await saml.getSamlSettings().catch(() => saml.defaultSamlSettings());
  const login = s.idpLoginUrl.toLowerCase();
  const brand = /microsoftonline\.com|login\.microsoft\.com/.test(login) ? "microsoft"
    : /accounts\.google\.com/.test(login) ? "google"
      : /okta\.com/.test(login) ? "okta" : "generic";
  res.json({ enabled: await saml.isSamlEnabled().catch(() => false), brand });
});

router.get("/saml/login", ssoEntryLimiter, async (req, res) => {
  try {
    if (!(await saml.isSamlEnabled())) return res.redirect("/login.html?error=saml_not_configured");
    // Fold the remembered destination into RelayState — the cookie may not
    // survive the IdP's cross-site POST back. Peek, never consume.
    const relayState = generateRelayState(peekLoginTarget(req));
    req.session.samlRelayState = relayState;
    res.redirect(await saml.getSamlLoginUrl(relayState));
  } catch (err) {
    failRedirect(res, err, "saml_error");
  }
});

router.post("/saml/callback", ssoCallbackLimiter, async (req, res) => {
  try {
    // The session cookie is usually ABSENT on this cross-site POST
    // (SameSite=Lax), so the relay-state check only applies when it is
    // present; the signed assertion is the primary guarantee.
    const returnedState = typeof req.body?.RelayState === "string" ? req.body.RelayState : "";
    if (req.session.samlRelayState && returnedState !== req.session.samlRelayState) {
      return res.redirect("/login.html?error=invalid_state");
    }
    const profile = await saml.validateSamlResponse(req.body);
    const user = await saml.findOrProvisionSamlUser(profile);
    const target = relayStateTarget(returnedState) ?? takeLoginTarget(req, res);
    await regenerateSession(req);
    stampLoginSession(req, user, "saml");
    req.session.samlNameID = profile.nameID;
    req.session.samlSessionIndex = profile.sessionIndex;
    await authService.recordLogin(user, "saml", ctxOf(req));
    res.redirect(target);
  } catch (err) {
    await logEvent({ action: "auth.login.saml_failed", level: "error", message: `SAML sign-in failed: ${(err as Error).message}`, details: { ip: req.ip } });
    failRedirect(res, err, "saml_callback_error");
  }
});

// Single logout: answers the IdP logout URL when this session came from SAML.
router.post("/saml/logout", requireAuth, async (req, res) => {
  const { samlNameID: nameID, samlSessionIndex: sessionIndex, username } = req.session;
  let logoutUrl: string | undefined;
  try {
    if (nameID && sessionIndex && (await saml.isSamlEnabled())) {
      logoutUrl = await saml.getSamlLogoutUrl(nameID, sessionIndex, generateRelayState());
    }
  } catch {
    /* fall through to a local logout */
  }
  req.session.destroy(() => {
    if (username) void logEvent({ action: "auth.logout", actor: username, message: `${username} logged out (SAML)` });
    res.json({ ok: true, ...(logoutUrl ? { logoutUrl } : {}) });
  });
});

router.get("/saml/settings", ...readGate, async (_req, res, next) => {
  try {
    const s = await saml.getSamlSettings();
    res.json({ ...s, effectiveBaseUrl: saml.samlBaseUrl(s) || null, callbackPath: saml.SAML_CALLBACK_PATH });
  } catch (err) { next(err); }
});

router.put("/saml/settings", ...writeGate, async (req, res, next) => {
  try {
    const s = await saml.updateSamlSettings(SamlSettingsSchema.parse(req.body ?? {}));
    await auditSettings(req, "saml", s.enabled);
    res.json({ ...s, effectiveBaseUrl: saml.samlBaseUrl(s) || null, callbackPath: saml.SAML_CALLBACK_PATH });
  } catch (err) { next(err); }
});

router.post("/saml/test", ...writeGate, async (_req, res, next) => {
  try {
    res.json(await saml.testSamlSettings());
  } catch (err) { next(err); }
});

// ─── OIDC ───────────────────────────────────────────────────────────────────

router.get("/oidc/config", ssoCallbackLimiter, async (_req, res) => {
  res.json({ enabled: await oidc.isOidcEnabled().catch(() => false) });
});

router.get("/oidc/login", ssoEntryLimiter, async (req, res) => {
  try {
    if (!(await oidc.isOidcEnabled())) return res.redirect("/login.html?error=oidc_not_configured");
    const { url, state, nonce, codeVerifier } = await oidc.buildAuthorizationUrl(originOf(req));
    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    req.session.oidcCodeVerifier = codeVerifier;
    req.session.save((err) => (err ? failRedirect(res, err, "oidc_session_error") : res.redirect(url)));
  } catch (err) {
    failRedirect(res, err, "oidc_error");
  }
});

router.get("/oidc/callback", ssoCallbackLimiter, async (req, res) => {
  const { oidcState: state, oidcNonce: nonce, oidcCodeVerifier: codeVerifier } = req.session;
  try {
    if (!state || !nonce || !codeVerifier) return res.redirect("/login.html?error=oidc_no_session");
    // The URL the IdP sent the browser to, rebuilt on the redirect URI's base
    // so the two always match (the library compares them).
    const base = oidc.getRedirectUri(originOf(req)).slice(0, -oidc.OIDC_CALLBACK_PATH.length);
    const claims = await oidc.handleCallback(`${base}${req.originalUrl}`, { state, nonce, codeVerifier });
    const user = await oidc.findOrProvisionOidcUser(claims);
    await finishSsoLogin(req, res, user, "oidc", takeLoginTarget(req, res));
  } catch (err) {
    await logEvent({ action: "auth.login.oidc_failed", level: "error", message: `OIDC sign-in failed: ${(err as Error).message}`, details: { ip: req.ip } });
    failRedirect(res, err, "oidc_callback_error");
  }
});

router.get("/oidc/settings", ...readGate, async (req, res, next) => {
  try {
    res.json(await oidc.getOidcSettingsForUi(originOf(req)));
  } catch (err) { next(err); }
});

router.put("/oidc/settings", ...writeGate, async (req, res, next) => {
  try {
    const s = await oidc.updateOidcSettings(OidcSettingsSchema.parse(req.body ?? {}));
    await auditSettings(req, "oidc", s.enabled);
    res.json(await oidc.getOidcSettingsForUi(originOf(req)));
  } catch (err) { next(err); }
});

router.post("/oidc/test", ...writeGate, async (req, res, next) => {
  try {
    res.json(await oidc.testOidcConnection(originOf(req)));
  } catch (err) { next(err); }
});

// ─── LDAP (the sign-in itself is POST /auth/login) ──────────────────────────

router.get("/ldap/settings", ...readGate, async (_req, res, next) => {
  try {
    res.json(await ldap.getLdapSettingsMasked());
  } catch (err) { next(err); }
});

router.put("/ldap/settings", ...writeGate, async (req, res, next) => {
  try {
    const s = await ldap.updateLdapSettings(LdapSettingsSchema.parse(req.body ?? {}));
    await auditSettings(req, "ldap", s.enabled);
    res.json(await ldap.getLdapSettingsMasked());
  } catch (err) { next(err); }
});

router.post("/ldap/test", ...writeGate, async (_req, res, next) => {
  try {
    res.json(await ldap.testLdapConnection());
  } catch (err) { next(err); }
});

// ─── Entra App Proxy (header SSO) ───────────────────────────────────────────
// The identity headers are UNSIGNED: trust is the connector's source IP only
// (entraProxyAuthService). app.ts strips the headers from untrusted sources,
// and /entra-proxy/login re-validates trust itself.

router.get("/entra-proxy/config", ssoCallbackLimiter, async (req, res) => {
  const enabled = await entraProxy.isEntraProxyEnabled().catch(() => false);
  const available = enabled && (await entraProxy.isEntraProxyLoginAvailable(req).catch(() => false));
  res.json({ enabled, available });
});

router.get("/entra-proxy/login", entraProxyLoginLimiter, async (req, res) => {
  // An explicit ?next= (the silent auto-login sets it) wins; the cookie is consumed either way.
  const remembered = takeLoginTarget(req, res);
  const target = req.query.next ? safeNextPath(req.query.next) : remembered;
  try {
    if (!(await entraProxy.isEntraProxyEnabled())) return res.redirect("/login.html?error=entra_proxy_not_configured");
    if (!(await entraProxy.isTrustedEntraProxySource(req.ip))) {
      await logEvent({
        action: "auth.login.entra_proxy_untrusted",
        level: "warning",
        message: `App Proxy sign-in refused: source ${req.ip || "unknown"} is not an allowlisted connector`,
        details: { ip: req.ip },
      });
      return res.redirect("/login.html?error=entra_proxy_untrusted_source");
    }
    const identity = await entraProxy.extractEntraProxyIdentity(req);
    if (!identity) return res.redirect("/login.html?error=entra_proxy_missing_headers");
    const user = await entraProxy.findOrProvisionEntraProxyUser(identity);
    await finishSsoLogin(req, res, user, "entra-proxy", target);
  } catch (err) {
    await logEvent({ action: "auth.login.entra_proxy_failed", level: "error", message: `App Proxy sign-in failed: ${(err as Error).message}`, details: { ip: req.ip } });
    failRedirect(res, err, "entra_proxy_error");
  }
});

router.get("/entra-proxy/settings", ...readGate, async (_req, res, next) => {
  try {
    res.json(await entraProxy.getEntraProxySettings());
  } catch (err) { next(err); }
});

router.put("/entra-proxy/settings", ...writeGate, async (req, res, next) => {
  try {
    const s = await entraProxy.updateEntraProxySettings(EntraProxySettingsSchema.parse(req.body ?? {}));
    await auditSettings(req, "entra-proxy", s.enabled);
    res.json(s);
  } catch (err) { next(err); }
});

// Reports how THIS request looks to the trust gate — header NAMES, never values.
router.post("/entra-proxy/test", ...writeGate, async (req, res, next) => {
  try {
    res.json(await entraProxy.testEntraProxyRequest(req));
  } catch (err) { next(err); }
});

export default router;
