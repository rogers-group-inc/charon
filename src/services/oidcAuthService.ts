/**
 * src/services/oidcAuthService.ts — operator SSO via OpenID Connect
 * (Authorization Code + PKCE, openid-client v6), ported from polaris.
 *
 * Discovery, JWKS, PKCE-S256 and ID-token signature / iss / aud / exp / nonce
 * validation are the library's; this module owns the settings, the redirect
 * URI and the hand-off to provisioning.
 *
 * Settings live in the `oidc` Setting row. `clientSecret` is a crypto.ts
 * envelope at rest (rule 3), masked on read, and never follows a changed
 * discovery URL or client id (utils/settingSecret.ts).
 *
 * Redirect URI: `<base>/api/v1/auth/oidc/callback`, where base is
 * CHARON_PUBLIC_URL when set, else the origin the browser used (trust-proxy
 * resolved). Deriving from the request is safe: the IdP only redirects to
 * URIs registered for the client, so a forged Host yields an IdP error, not a
 * redirect elsewhere. Both legs of one sign-in derive from the same request
 * origin, so they always agree.
 *
 * state (CSRF), nonce (ID-token replay) and the PKCE verifier live in the
 * Postgres-backed session between /oidc/login and /oidc/callback — a top-level
 * GET, so the SameSite=Lax session cookie IS sent.
 */

import * as client from "openid-client";
import { AppError } from "../utils/errors.js";
import { createSettingStore } from "./settingsStore.js";
import { provisionExternalUser } from "./ssoProvisioning.js";
import { maskSettingSecret, nextSettingSecret, openSettingSecret } from "../utils/settingSecret.js";

export const OIDC_CALLBACK_PATH = "/api/v1/auth/oidc/callback";

export interface OidcSettings {
  enabled: boolean;
  discoveryUrl: string; // issuer or full .well-known URL
  clientId: string;
  clientSecret: string; // SEALED at rest
  scopes: string; // space-separated; must include "openid"
  groupsClaim: string;
  usernameClaim: string;
  emailClaim: string;
  displayNameClaim: string;
}

export function defaultOidcSettings(): OidcSettings {
  return {
    enabled: false,
    discoveryUrl: "",
    clientId: "",
    clientSecret: "",
    scopes: "openid profile email",
    groupsClaim: "groups",
    usernameClaim: "preferred_username",
    emailClaim: "email",
    displayNameClaim: "name",
  };
}

function parseOidcSettings(raw: unknown): OidcSettings {
  const d = defaultOidcSettings();
  if (raw == null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const str = (k: keyof OidcSettings) => (typeof r[k] === "string" ? (r[k] as string) : (d[k] as string));
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    discoveryUrl: str("discoveryUrl"),
    clientId: str("clientId"),
    clientSecret: str("clientSecret"),
    scopes: str("scopes") || d.scopes,
    groupsClaim: str("groupsClaim"),
    usernameClaim: str("usernameClaim"),
    emailClaim: str("emailClaim"),
    displayNameClaim: str("displayNameClaim"),
  };
}

const store = createSettingStore<OidcSettings>({ key: "oidc", ttlMs: 30_000, parse: parseOidcSettings });
let discovered: client.Configuration | null = null;

export async function getOidcSettings(): Promise<OidcSettings> {
  return store.get();
}

/** The redirect URI for a sign-in started from `requestOrigin` (e.g. "https://charon.example"). */
export function getRedirectUri(requestOrigin: string): string {
  let base = (process.env.CHARON_PUBLIC_URL || requestOrigin || "").trim();
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (!base) throw new AppError(400, "Cannot derive the OIDC redirect URI — set CHARON_PUBLIC_URL");
  return `${base}${OIDC_CALLBACK_PATH}`;
}

/** Settings for the admin UI — secret masked, redirect URI for this origin. */
export async function getOidcSettingsForUi(requestOrigin: string): Promise<OidcSettings & { redirectUri: string }> {
  const s = await getOidcSettings();
  return { ...s, clientSecret: maskSettingSecret(s.clientSecret), redirectUri: getRedirectUri(requestOrigin) };
}

export async function updateOidcSettings(input: Partial<OidcSettings>): Promise<OidcSettings> {
  const cur = await getOidcSettings();
  const d = defaultOidcSettings();
  const pick = (k: keyof OidcSettings) => (typeof input[k] === "string" ? (input[k] as string).trim() : (cur[k] as string));
  const next: OidcSettings = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : cur.enabled,
    discoveryUrl: pick("discoveryUrl"),
    clientId: pick("clientId"),
    clientSecret: nextSettingSecret(
      cur.clientSecret,
      input.clientSecret,
      [
        { label: "discovery URL", current: cur.discoveryUrl, incoming: input.discoveryUrl },
        { label: "client ID", current: cur.clientId, incoming: input.clientId },
      ],
      "client secret",
    ),
    scopes: pick("scopes") || d.scopes,
    groupsClaim: pick("groupsClaim"),
    usernameClaim: pick("usernameClaim") || d.usernameClaim,
    emailClaim: pick("emailClaim"),
    displayNameClaim: pick("displayNameClaim"),
  };
  if (next.discoveryUrl && !/^https?:\/\//i.test(next.discoveryUrl)) throw new AppError(400, "Discovery URL must start with http:// or https://");
  if (!next.scopes.split(/\s+/).includes("openid")) throw new AppError(400, 'Scopes must include "openid"');
  await store.save(next);
  discovered = null; // rediscover on next use
  return next;
}

export async function isOidcEnabled(): Promise<boolean> {
  const s = await getOidcSettings();
  return !!(s.enabled && s.discoveryUrl && s.clientId && s.clientSecret);
}

// Accept either the issuer URL or the full .well-known URL.
function issuerUrl(discoveryUrl: string): URL {
  return new URL(discoveryUrl.trim().replace(/\/\.well-known\/openid-configuration\/?$/i, ""));
}

async function getConfig(): Promise<client.Configuration> {
  if (discovered) return discovered;
  const s = await getOidcSettings();
  if (!s.discoveryUrl || !s.clientId || !s.clientSecret) throw new AppError(400, "OIDC is not configured");
  discovered = await client.discovery(issuerUrl(s.discoveryUrl), s.clientId, openSettingSecret(s.clientSecret));
  return discovered;
}

export interface OidcAuthStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function buildAuthorizationUrl(requestOrigin: string): Promise<OidcAuthStart> {
  const s = await getOidcSettings();
  const config = await getConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri(requestOrigin),
    scope: s.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url: url.href, state, nonce, codeVerifier };
}

export interface OidcClaims {
  sub: string;
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}

function toStringArray(val: unknown): string[] {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return [String(val).trim()].filter(Boolean);
}

/**
 * Exchange the code and validate the ID token. `callbackUrl` is the full URL
 * the IdP sent the browser to (its origin must equal the redirect URI's).
 */
export async function handleCallback(
  callbackUrl: string,
  checks: { state: string; nonce: string; codeVerifier: string },
): Promise<OidcClaims> {
  const s = await getOidcSettings();
  const config = await getConfig();
  const tokens = await client.authorizationCodeGrant(config, new URL(callbackUrl), {
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    pkceCodeVerifier: checks.codeVerifier,
    idTokenExpected: true,
  });
  const idClaims = (tokens.claims() ?? {}) as Record<string, unknown>;
  const sub = String(idClaims.sub || "");
  if (!sub) throw new AppError(502, "OIDC ID token missing `sub` claim");

  // Groups / profile claims may live in userinfo rather than the ID token.
  let merged: Record<string, unknown> = { ...idClaims };
  if (tokens.access_token) {
    try {
      merged = { ...merged, ...((await client.fetchUserInfo(config, tokens.access_token, sub)) as Record<string, unknown>) };
    } catch {
      /* userinfo is optional — the ID token claims are already validated */
    }
  }
  return {
    sub,
    username: String(merged[s.usernameClaim] || merged.email || sub),
    displayName: String(merged[s.displayNameClaim] || ""),
    email: String(merged[s.emailClaim] || ""),
    groups: toStringArray(merged[s.groupsClaim]),
  };
}

export async function findOrProvisionOidcUser(claims: OidcClaims) {
  return provisionExternalUser({
    provider: "oidc",
    externalIdField: "oidcSubject",
    externalId: claims.sub,
    usernameHint: claims.username,
    displayName: claims.displayName || null,
    email: claims.email || null,
    groups: claims.groups,
  });
}

/** Admin "Test": run discovery and report the issuer and endpoints. */
export async function testOidcConnection(requestOrigin: string): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
  const s = await getOidcSettings();
  if (!s.discoveryUrl) return { ok: false, message: "Discovery URL is required" };
  if (!s.clientId) return { ok: false, message: "Client ID is required" };
  if (!s.clientSecret) return { ok: false, message: "Client secret is required" };
  try {
    discovered = null;
    const meta = (await getConfig()).serverMetadata();
    return {
      ok: true,
      message: `Discovery succeeded — issuer ${meta.issuer}`,
      details: {
        issuer: meta.issuer,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        userinfo_endpoint: meta.userinfo_endpoint,
        redirectUri: getRedirectUri(requestOrigin),
      },
    };
  } catch (err) {
    return { ok: false, message: `Discovery failed: ${(err as Error)?.message || err}` };
  }
}

/** Test hook. */
export function resetOidcForTests(): void {
  store.invalidate();
  discovered = null;
}
