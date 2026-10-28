/**
 * src/services/samlAuthService.ts — operator SSO via SAML 2.0 (@node-saml),
 * ported from polaris azureAuthService. Works with any SAML IdP; the claim
 * extraction understands Entra ID's claim URIs and the common short names.
 *
 * Settings live in the `saml` Setting row (Users → Authentication → SAML). No
 * secret: the IdP certificate is public material.
 *
 * Endpoints the IdP is given (shown read-only in the UI):
 *   ACS (reply URL)  <applicationUrl>/api/v1/auth/saml/callback
 *   Entity ID        <applicationUrl>
 * where applicationUrl is the operator-set "Application URL", or
 * CHARON_PUBLIC_URL when that is blank. SAML needs an absolute base the IdP
 * can POST back to; with neither set, login and Test refuse with a message
 * that says so rather than inventing one from a request header.
 *
 * SECURITY: assertions must be signed (wantAssertionsSigned); a response is
 * bound to the request that asked for it whenever it carries InResponseTo, and
 * every assertion id is accepted once (utils/samlReplayCache.ts — process
 * local; the GSLB sends a sign-in to one node). The callback is a cross-site
 * POST, so it is CSRF-exempt (/api/v1/auth/saml/) and the session cookie may be
 * absent; the signed assertion is the guarantee.
 */

import { SAML, type SamlConfig, type Profile, ValidateInResponseTo } from "@node-saml/node-saml";
import { createHash, X509Certificate } from "node:crypto";
import { claimSamlAssertion } from "../utils/samlReplayCache.js";
import { createSettingStore } from "./settingsStore.js";
import { provisionExternalUser } from "./ssoProvisioning.js";
import { AppError } from "../utils/errors.js";
import { probeIdpUrl } from "./ssoProbe.js";

export const SAML_CALLBACK_PATH = "/api/v1/auth/saml/callback";

export interface SamlSettings {
  enabled: boolean;
  applicationUrl: string; // SP entity id + base of the ACS URL; "" → CHARON_PUBLIC_URL
  idpEntityId: string;
  idpLoginUrl: string;
  idpLogoutUrl: string;
  idpCertificate: string;
  wantResponseSigned: boolean;
}

export function defaultSamlSettings(): SamlSettings {
  return {
    enabled: false,
    applicationUrl: "",
    idpEntityId: "",
    idpLoginUrl: "",
    idpLogoutUrl: "",
    idpCertificate: "",
    wantResponseSigned: false,
  };
}

export function parseSamlSettings(raw: unknown): SamlSettings {
  const d = defaultSamlSettings();
  if (raw == null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fb: string) => (typeof v === "string" ? v : fb);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    applicationUrl: str(r.applicationUrl, d.applicationUrl),
    idpEntityId: str(r.idpEntityId, d.idpEntityId),
    idpLoginUrl: str(r.idpLoginUrl, d.idpLoginUrl),
    idpLogoutUrl: str(r.idpLogoutUrl, d.idpLogoutUrl),
    idpCertificate: str(r.idpCertificate, d.idpCertificate),
    wantResponseSigned: typeof r.wantResponseSigned === "boolean" ? r.wantResponseSigned : d.wantResponseSigned,
  };
}

const store = createSettingStore<SamlSettings>({ key: "saml", ttlMs: 30_000, parse: parseSamlSettings });
let samlClient: SAML | null = null;

export async function getSamlSettings(): Promise<SamlSettings> {
  return store.get();
}

/** Trim trailing slashes without a `/\/+$/` regex (polynomial backtracking). */
function trimSlashes(s: string): string {
  let out = s.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** The SP base URL in force: the operator's Application URL, else CHARON_PUBLIC_URL, else "". */
export function samlBaseUrl(s: SamlSettings): string {
  return trimSlashes(s.applicationUrl || process.env.CHARON_PUBLIC_URL || "");
}

export async function updateSamlSettings(input: Partial<SamlSettings>): Promise<SamlSettings> {
  const cur = await getSamlSettings();
  const pick = (k: keyof SamlSettings) => (typeof input[k] === "string" ? (input[k] as string).trim() : (cur[k] as string));
  const next: SamlSettings = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : cur.enabled,
    applicationUrl: pick("applicationUrl"),
    idpEntityId: pick("idpEntityId"),
    idpLoginUrl: pick("idpLoginUrl"),
    idpLogoutUrl: pick("idpLogoutUrl"),
    idpCertificate: pick("idpCertificate"),
    wantResponseSigned: typeof input.wantResponseSigned === "boolean" ? input.wantResponseSigned : cur.wantResponseSigned,
  };
  for (const [label, url] of [["Application URL", next.applicationUrl], ["IdP login URL", next.idpLoginUrl], ["IdP logout URL", next.idpLogoutUrl]] as const) {
    if (url && !/^https?:\/\//i.test(url)) throw new AppError(400, `${label} must start with http:// or https://`);
  }
  await store.save(next);
  samlClient = null; // rebuild with the new config
  return next;
}

/** Enabled and complete enough to start a sign-in. */
export async function isSamlEnabled(): Promise<boolean> {
  const s = await getSamlSettings();
  return !!(s.enabled && s.idpEntityId && s.idpLoginUrl && s.idpCertificate && samlBaseUrl(s));
}

async function getSamlClient(): Promise<SAML> {
  if (samlClient) return samlClient;
  const s = await getSamlSettings();
  if (!s.idpEntityId || !s.idpLoginUrl || !s.idpCertificate) throw new AppError(400, "SAML SSO is not configured");
  const base = samlBaseUrl(s);
  if (!base) throw new AppError(400, "SAML SSO needs an Application URL (or CHARON_PUBLIC_URL) — set it in Users → Authentication → SAML");
  const config: SamlConfig = {
    idpCert: s.idpCertificate,
    issuer: base,
    callbackUrl: `${base}${SAML_CALLBACK_PATH}`,
    entryPoint: s.idpLoginUrl,
    logoutUrl: s.idpLogoutUrl || s.idpLoginUrl,
    idpIssuer: s.idpEntityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: s.wantResponseSigned,
    disableRequestedAuthnContext: true,
    // Bind a response to the request that asked for it WHEN it says it answers
    // one. Unsolicited (IdP-initiated) responses carry no InResponseTo and stay
    // allowed; claimSamlAssertion stops one being presented twice.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
  };
  samlClient = new SAML(config);
  return samlClient;
}

export async function getSamlLoginUrl(relayState: string): Promise<string> {
  return (await getSamlClient()).getAuthorizeUrlAsync(relayState, undefined, {});
}

export async function validateSamlResponse(body: Record<string, string>): Promise<Profile> {
  const { profile } = await (await getSamlClient()).validatePostResponseAsync(body);
  if (!profile) throw new AppError(401, "SAML assertion validation failed — no profile returned");
  // One assertion signs one person in, once. Fall back to a hash of the XML if
  // the library did not surface the ID, so a missing field can't switch the
  // replay check off (or lock everyone out).
  const assertionId =
    profile.ID ??
    (typeof profile.getAssertionXml === "function" ? createHash("sha256").update(profile.getAssertionXml()).digest("hex") : undefined);
  if (!claimSamlAssertion(assertionId)) {
    throw new AppError(401, "This SAML response has already been used. Start the sign-in again.");
  }
  return profile;
}

export async function getSamlLogoutUrl(nameID: string, sessionIndex: string, relayState: string): Promise<string> {
  const user: Profile = {
    issuer: "",
    nameID,
    nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    sessionIndex,
  };
  return (await getSamlClient()).getLogoutUrlAsync(user, relayState, {});
}

function claim(profile: Profile, ...names: string[]): string {
  for (const n of names) {
    const v = profile[n];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0]) return v[0];
  }
  return "";
}

function claimList(profile: Profile, ...names: string[]): string[] {
  for (const n of names) {
    const v = profile[n];
    if (Array.isArray(v)) return v.filter((g): g is string => typeof g === "string" && !!g);
    if (typeof v === "string" && v) return [v];
  }
  return [];
}

/**
 * SAML claims → the shared find-or-provision path. Group claims are matched
 * against "saml" group mappings as sent: Entra ID emits group object ids
 * unless the app is configured to emit names.
 */
export async function findOrProvisionSamlUser(profile: Profile) {
  const nameID = profile.nameID || "";
  const email = claim(profile, "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "email", "mail") || nameID;
  const displayName = claim(
    profile,
    "http://schemas.microsoft.com/identity/claims/displayname",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "displayName",
  );
  const externalId = claim(profile, "http://schemas.microsoft.com/identity/claims/objectidentifier") || nameID;
  if (!externalId) throw new AppError(502, "SAML assertion missing user identifier");
  const groups = claimList(profile, "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups", "groups", "memberOf");
  return provisionExternalUser({
    provider: "saml",
    externalIdField: "azureOid",
    externalId,
    usernameHint: email,
    displayName: displayName || null,
    email: email || null,
    groups,
  });
}

/** Admin "Test": the certificate parses and is in date; the IdP login URL answers. */
export async function testSamlSettings(): Promise<{ ok: boolean; results: Record<string, { ok: boolean; message: string; [k: string]: unknown }> }> {
  const s = await getSamlSettings();
  const results: Record<string, { ok: boolean; message: string; [k: string]: unknown }> = {
    applicationUrl: samlBaseUrl(s)
      ? { ok: true, message: `ACS URL ${samlBaseUrl(s)}${SAML_CALLBACK_PATH}` }
      : { ok: false, message: "No Application URL and CHARON_PUBLIC_URL is unset" },
    certificate: { ok: false, message: "No certificate provided" },
    idpLoginUrl: { ok: false, message: "No IdP login URL provided" },
  };
  if (s.idpCertificate) {
    try {
      let pem = s.idpCertificate.trim();
      if (!pem.startsWith("-----BEGIN")) pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
      const cert = new X509Certificate(pem);
      const now = Date.now();
      const validTo = new Date(cert.validTo).getTime();
      const validFrom = new Date(cert.validFrom).getTime();
      const daysLeft = Math.floor((validTo - now) / 86_400_000);
      results.certificate = {
        ok: now <= validTo && now >= validFrom,
        subject: cert.subject,
        validTo: cert.validTo,
        daysLeft,
        message: now > validTo
          ? `Certificate expired on ${cert.validTo}`
          : now < validFrom
            ? `Certificate not valid until ${cert.validFrom}`
            : `Valid — expires in ${daysLeft} days (${cert.validTo})`,
      };
    } catch (err) {
      results.certificate = { ok: false, message: `Invalid certificate: ${(err as Error).message}` };
    }
  }
  if (s.idpLoginUrl) results.idpLoginUrl = { ...(await probeIdpUrl(s.idpLoginUrl)) };
  return { ok: Object.values(results).every((r) => r.ok), results };
}

/** Test hook. */
export function resetSamlForTests(): void {
  store.invalidate();
  samlClient = null;
}
