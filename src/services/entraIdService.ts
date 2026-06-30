/**
 * src/services/entraIdService.ts — Entra ID + Intune (Microsoft Graph) source.
 *
 * OAuth2 client-credentials flow with a per-(tenant,client) token cache, then
 * Graph reads. Entra ID discovers users + groups (tag sources); Intune reuses
 * the same token to read managed-device posture (milestone 5). All reads are
 * read-only.
 */

import { httpJson } from "./httpClient.js";
import type { TestResult } from "./integrationService.js";
import type { DiscoveredDirectoryObject } from "./directoryTypes.js";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Override the Graph base (sovereign clouds). Defaults to public Graph. */
  graphBase?: string;
}

const TOKEN_TTL_SKEW_MS = 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(c: EntraConfig, signal?: AbortSignal): Promise<string> {
  const key = `${c.tenantId}:${c.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_TTL_SKEW_MS > Date.now()) return cached.token;

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  }).toString();
  const res = await httpJson<{ access_token: string; expires_in: number }>(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
    label: "Entra ID (token)",
  });
  tokenCache.set(key, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
  return res.access_token;
}

function graphBase(c: EntraConfig): string {
  return (c.graphBase || "https://graph.microsoft.com").replace(/\/+$/, "");
}

async function graphGet<T = any>(c: EntraConfig, path: string, signal?: AbortSignal): Promise<T> {
  const token = await getToken(c, signal);
  return httpJson<T>(`${graphBase(c)}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal,
    label: "Entra ID (Graph)",
  });
}

export async function testConnectionEntra(config: EntraConfig, signal?: AbortSignal): Promise<TestResult> {
  try {
    const org = await graphGet<{ value?: Array<{ displayName?: string }> }>(config, "/v1.0/organization?$select=displayName", signal);
    const name = org.value?.[0]?.displayName;
    return { ok: true, message: name ? `Connected to Entra tenant "${name}"` : "Connected to Microsoft Graph" };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? "Connection failed" };
  }
}

export async function testConnectionIntune(config: EntraConfig, signal?: AbortSignal): Promise<TestResult> {
  try {
    await graphGet(config, "/v1.0/deviceManagement/managedDevices?$top=1", signal);
    return { ok: true, message: "Connected to Intune (deviceManagement)" };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? "Connection failed" };
  }
}

/** Paged Graph collection reader (follows @odata.nextLink). */
async function graphCollect<T = any>(c: EntraConfig, firstPath: string, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = `${graphBase(c)}${firstPath}`;
  const token = await getToken(c, signal);
  let guard = 0;
  while (next && guard++ < 200) {
    const page: { value?: T[]; "@odata.nextLink"?: string } = await httpJson(next, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
      label: "Entra ID (Graph)",
    });
    if (page.value) out.push(...page.value);
    next = page["@odata.nextLink"] ?? null;
  }
  return out;
}

export async function discoverEntra(config: EntraConfig, signal?: AbortSignal): Promise<DiscoveredDirectoryObject[]> {
  const out: DiscoveredDirectoryObject[] = [];

  const users = await graphCollect<any>(config, "/v1.0/users?$select=id,userPrincipalName,displayName,mail,department", signal);
  for (const u of users) {
    out.push({
      kind: "user",
      externalId: String(u.id),
      name: u.displayName || u.userPrincipalName || "",
      identifier: u.userPrincipalName,
      attributes: { department: u.department, mail: u.mail },
    });
  }

  const groups = await graphCollect<any>(config, "/v1.0/groups?$select=id,displayName,description", signal);
  for (const g of groups) {
    out.push({
      kind: "group",
      externalId: String(g.id),
      name: g.displayName || "",
      identifier: String(g.id),
      attributes: { description: g.description },
    });
  }

  return out;
}
