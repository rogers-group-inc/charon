/**
 * src/services/entraIdService.ts — Microsoft Entra ID (+ Intune) discovery
 *
 * Authenticates via OAuth2 client credentials and queries Microsoft Graph:
 *   • /v1.0/users, /v1.0/groups + each group's transitive members — the ZTNA
 *     tag sources (`discoverDirectory`, Charon): a user's group ids land in
 *     `attributes.memberOf`, which `directory_group` tag sources match;
 *   • /v1.0/devices — every Entra-registered device (hostname, OS, trust type)
 *   • /v1.0/deviceManagement/managedDevices — Intune enrolled devices (serial,
 *     MAC, model, manufacturer, primary user, compliance) — only when
 *     config.enableIntune is true. Intune is a flag on this integration, as in
 *     polaris, not a type of its own.
 *
 * Device results from both endpoints are merged on deviceId ↔ azureADDeviceId;
 * Intune data wins on any field present in both sources.
 *
 * Ported from polaris: the token cache, the host-pinned Graph transport (401 /
 * 403 re-mint, 429 backoff), paging, the device + Intune read with the Ethernet
 * MAC $batch, and the sweep guard. Polaris's address-book (GAL) search and the
 * Intune detected-apps read are not carried. Strictly read-only toward Entra;
 * `graphApiRequest` also serves Intune script publishing. Business-rule numbers
 * in the ported comments (35, 70) are POLARIS rules.
 */

import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import { buildClientCredentialsTokenRequest } from "../utils/entraClientCredentials.js";
import { sleep } from "../utils/sleep.js";
import { throttleDelayMs } from "../utils/graphThrottle.js";
import type { DiscoveredDirectoryObject } from "./directoryTypes.js";

export interface EntraIdConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  enableIntune?: boolean;
  includeDisabled?: boolean;  // Default true — disabled (accountEnabled=false) users / devices are still mirrored
  // No `decommissionMissing` (polaris's opt-in sweep): the mirror's sweep always
  // runs, guarded — see discovery/directoryDiscovery → planSweep.
  deviceInclude?: string[];  // Match against displayName; wildcards supported
  deviceExclude?: string[];
}

export interface DiscoveredEntraDevice {
  // Which Graph endpoints contributed to this merged record. Entra-registered
  // devices that haven't been Intune-enrolled show ["entra"]; Intune-managed
  // devices that lack an Entra registration (rare) show ["intune"]; the
  // common hybrid case shows ["entra", "intune"]. Drives the AssetSource
  // write split in syncEntraDevices — each contributing source gets its own
  // row so the asset details modal can render side-by-side.
  sources: ("entra" | "intune")[];
  // Original entra-side displayName, kept distinct from `displayName` (which
  // is intune-overridden when intune contributed). Used by the entra source
  // observed blob so it reflects what Entra actually said. Undefined when
  // entra didn't contribute (intune-only devices).
  entraDisplayName?: string;
  // Original intune-side deviceName. Undefined when intune didn't contribute.
  intuneDeviceName?: string;
  // Intune's own managedDevice id — NOT the Entra deviceId. The per-device
  // Graph reads (detected apps) are addressed by it. Undefined when intune
  // didn't contribute.
  intuneManagedDeviceId?: string;
  deviceId: string;            // Azure AD deviceId — stable identifier across both endpoints
  displayName: string;         // Hostname in Entra; deviceName in Intune
  operatingSystem: string;
  operatingSystemVersion: string;
  trustType: string;           // "AzureAd" | "Workplace" | "ServerAd" | ""
  accountEnabled: boolean;     // false → disabled in Entra; maps to `decommissioned` status
  onPremisesSecurityIdentifier?: string; // On-prem AD SID for hybrid-joined devices (cross-link to AD integration)
  registrationDateTime?: string;
  approximateLastSignInDateTime?: string;
  isCompliant?: boolean;
  isManaged?: boolean;
  // Intune-only fields (present only when enableIntune and a matching managed device was found)
  serialNumber?: string;
  // Primary MAC for back-compat callers — populated as ethernetMacAddress preferred,
  // falling back to wifiMacAddress. Prefer reading the typed fields below when
  // wiring new behaviour (e.g. cross-asset merging should use Ethernet only,
  // since WiFi MAC randomizes on modern Windows/iOS/Android).
  macAddress?: string;
  wifiMacAddress?: string;       // Intune `wiFiMacAddress`
  ethernetMacAddress?: string;   // Intune `ethernetMacAddress` (per-device read — see resolveEthernetMacs)
  // The Intune `lastSyncDateTime` the Ethernet MAC above was read at. Stored
  // on the intune source row so the next run can skip the per-device read for
  // a device that has not checked in since. Undefined when no read has
  // succeeded yet (the field is then re-fetched every run until one does).
  ethernetMacSyncedAt?: string;
  manufacturer?: string;
  model?: string;
  userPrincipalName?: string;
  chassisType?: string;        // "desktop" | "laptop" | "tablet" | "phone" | ...
  complianceState?: string;    // "compliant" | "noncompliant" | "unknown" | ...
  lastSyncDateTime?: string;
  ipAddress?: string;
}

export interface EntraDiscoveryResult {
  devices: DiscoveredEntraDevice[];
  /**
   * Every meaningful deviceId `/v1.0/devices` returned, taken BEFORE
   * `deviceInclude` / `deviceExclude` and BEFORE the `includeDisabled=false`
   * skip — the raw answer to "what does the tenant still hold?", which is the
   * only honest input to the disappearance sweep. `devices` is the filtered
   * view and would read a filter edit as a deletion.
   */
  presentDeviceIds: string[];
  /** Of those, the ones with `accountEnabled=false`. */
  disabledDeviceIds: string[];
  /**
   * The `azureADDeviceId`s the Intune managedDevices read returned. Only
   * meaningful when `intuneRead === "ok"` — when Intune is switched off, or
   * its call failed (which is caught so an Intune outage can't fail the whole
   * run), every intune source row must be left alone rather than swept.
   */
  presentIntuneDeviceIds: string[];
  intuneRead: "ok" | "disabled" | "failed";
  /**
   * False when the Entra read may be partial — cancelled mid-page, or the
   * 10,000-device hard cap was reached.
   */
  inventoryComplete: boolean;
  /** True when the run was narrowed to one device ("Discover Now"). */
  scoped: boolean;
}

export type EntraDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// ─── Access token cache ─────────────────────────────────────────────────────
// Keyed by tenantId:clientId — value includes token and expiry timestamp.
// Tokens are refreshed 60s before expiry to avoid mid-request expiration.

interface CachedToken {
  token: string;
  expiresAt: number; // Unix ms
}
const tokenCache = new Map<string, CachedToken>();

function cacheKey(config: EntraIdConfig): string {
  return `${config.tenantId}:${config.clientId}`;
}

/**
 * Returns the app-only access token, minting one when the cache is cold.
 *
 * `fromCache` is part of the return because a client-credentials token carries
 * its `roles` claim FROZEN at issuance: an admin who grants a new Graph
 * application permission changes nothing about a token already minted. Callers
 * that hit an authorization failure need to know whether re-asking could
 * plausibly help (cached token, possibly pre-dating the grant) or whether the
 * app genuinely lacks the permission (token minted seconds ago).
 */
async function getAccessToken(
  config: EntraIdConfig,
  signal?: AbortSignal,
): Promise<{ token: string; fromCache: boolean }> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, fromCache: true };
  }

  const { url, body } = buildClientCredentialsTokenRequest({
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error_description) msg = String(parsed.error_description).split(/\r?\n/)[0];
        else if (parsed.error) msg = String(parsed.error);
      } catch { /* ignore */ }
      throw new AppError(502, `Entra ID token request failed: ${msg}`);
    }

    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new AppError(502, "Entra ID token response missing access_token");
    }
    const expiresInMs = (parsed.expires_in ?? 3600) * 1000;
    tokenCache.set(key, { token: parsed.access_token, expiresAt: Date.now() + expiresInMs });
    return { token: parsed.access_token, fromCache: false };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Invalidate the cached token for this config (e.g. after a 401 or 403). */
function invalidateToken(config: EntraIdConfig): void {
  tokenCache.delete(cacheKey(config));
}

// ─── Graph request (GET + write verbs) with paging ──────────────────────────

/** Graph's fixed host. Every URL this module builds is asserted against it. */
export const GRAPH_HOST = "graph.microsoft.com";

const MAX_GRAPH_THROTTLE_RETRIES = 3;

export interface GraphRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serialized when present; also sets Content-Type. */
  body?: unknown;
  signal?: AbortSignal;
  retryOn401?: boolean;
  /** Internal: false once a 403 has already been retried on a fresh token. */
  retryOn403?: boolean;
  throttleAttempt?: number;
  /** Return null instead of throwing on 404 (upsert lookups). */
  allow404?: boolean;
}

/**
 * One Graph call. Generalized from the former GET-only `graphGet` so write
 * verbs (Intune script publishing) share the token cache, the 401/403
 * invalidate-and-retry, and the host pinning rather than hand-rolling a second
 * transport — the repo already carries one hand-rolled Graph POST
 * (emailChannel.sendM365Email) and a second would be two too many.
 *
 * 429 handling is NEW here: reads tolerate a throttle badly enough that the
 * GET path never grew one, but Graph throttles writes hard, and a failed
 * publish that silently did nothing is worse than a slow one. The backoff
 * policy is `throttleDelayMs`, imported from azureArcService rather than
 * copied — it is a pure headers→ms function and forking it would give the two
 * Azure surfaces divergent throttle behaviour.
 * (Direction is admittedly odd for a service→service import; it belongs in a
 * util. Left as an import to keep this change off azureArcService.ts while a
 * concurrent branch owns that file.)
 */
async function graphRequest(
  config: EntraIdConfig,
  url: string,
  opts: GraphRequestOptions = {},
): Promise<any> {
  const {
    method = "GET", body, signal,
    retryOn401 = true, retryOn403 = true, throttleAttempt = 0, allow404 = false,
  } = opts;

  // Host pinning. `new URL()` alone is not enough — a crafted path can move
  // the authority — so assert equality after construction. This mirrors
  // azureArcService's ARM_HOST check; the read-only `proxyQuery` below
  // predates it and only prefix-checks the path.
  const parsed = new URL(url);
  if (parsed.host !== GRAPH_HOST) {
    throw new AppError(400, `Graph host must be ${GRAPH_HOST}`);
  }

  const { token, fromCache } = await getAccessToken(config, signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "ConsistencyLevel": "eventual",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (res.status === 401 && retryOn401) {
      invalidateToken(config);
      return graphRequest(config, url, { ...opts, retryOn401: false });
    }
    if (res.status === 429 && throttleAttempt < MAX_GRAPH_THROTTLE_RETRIES) {
      const delay = throttleDelayMs(res.headers);
      await sleep(delay);
      if (signal?.aborted) throw new AppError(502, "Graph request aborted while throttled");
      return graphRequest(config, url, { ...opts, throttleAttempt: throttleAttempt + 1 });
    }
    if (res.status === 429) {
      throw new AppError(502, "Microsoft Graph throttled the request (429) — retry in a moment.");
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 403 && retryOn403 && fromCache) {
      // An app-only token's `roles` claim is fixed at issuance, so a permission
      // an admin granted five minutes ago is invisible to a token minted before
      // it — and this cache holds one for up to an hour. Without this retry the
      // operator fixes the grant in Entra, presses the button again, and gets a
      // byte-identical 403; the only cures were restarting Polaris or pressing
      // Test Connection (which invalidates for its own reasons). Discard and
      // re-mint ONCE. Bounded: only when the token was cached, so a genuinely
      // unauthorized app costs one extra token fetch per operator click, not a
      // loop.
      invalidateToken(config);
      return graphRequest(config, url, { ...opts, retryOn403: false });
    }
    if (res.status === 403) {
      const text = await res.text();
      throw new AppError(502, `Graph API permission denied (403): ${extractGraphError(text)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(502, `Graph API HTTP ${res.status}: ${extractGraphError(text)}`);
    }
    // 204 (and any empty body) would blow up res.json().
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Read-only wrapper — the shape every pre-existing caller uses. */
async function graphGet(
  config: EntraIdConfig,
  url: string,
  signal?: AbortSignal,
  retryOn401 = true,
): Promise<any> {
  return graphRequest(config, url, { method: "GET", signal, retryOn401 });
}

/**
 * Graph transport for other services (intunePublishService). Deliberately
 * exported as a bound-to-a-config call rather than exposing `graphRequest`
 * itself, so callers cannot reach a different host or skip the pinning.
 */
export async function graphApiRequest(
  config: EntraIdConfig,
  url: string,
  opts: GraphRequestOptions = {},
): Promise<any> {
  return graphRequest(config, url, opts);
}

function extractGraphError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// Page through a Graph collection, concatenating `value` arrays until
// nextLink is absent or hardCap items have been collected.
// `meta.complete` reports whether the caller is holding the WHOLE collection:
// a page fetch throws, but cancellation and the hard cap both break the loop
// and return a short list that is indistinguishable from a small tenant. Only
// the disappearance sweep cares, and only it passes a meta object.
async function graphPage(
  config: EntraIdConfig,
  initialUrl: string,
  hardCap: number,
  signal?: AbortSignal,
  meta?: { complete: boolean },
): Promise<any[]> {
  const results: any[] = [];
  let url: string | undefined = initialUrl;
  if (meta) meta.complete = true;
  while (url) {
    if (signal?.aborted) { if (meta) meta.complete = false; break; }
    const page = await graphGet(config, url, signal);
    if (Array.isArray(page.value)) results.push(...page.value);
    if (results.length >= hardCap) { if (meta) meta.complete = false; break; }
    url = page["@odata.nextLink"];
  }
  return results.slice(0, hardCap);
}

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: EntraIdConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.tenantId) return { ok: false, message: "Tenant ID is required" };
  if (!config.clientId) return { ok: false, message: "Client ID is required" };
  if (!config.clientSecret) return { ok: false, message: "Client secret is required" };

  try {
    // Invalidate any cached token so the test always exercises the fresh secret
    invalidateToken(config);

    // Primary probe — Device.Read.All is the minimum required permission
    await graphGet(config, "https://graph.microsoft.com/v1.0/devices?$top=1&$select=id");

    // Charon: users + groups are the tag sources, so their grants are probed
    // too (User.Read.All, GroupMember.Read.All — or Directory.Read.All).
    try {
      await graphGet(config, "https://graph.microsoft.com/v1.0/users?$top=1&$select=id");
      await graphGet(config, "https://graph.microsoft.com/v1.0/groups?$top=1&$select=id");
    } catch (err: any) {
      return {
        ok: false,
        message: `Entra device scope OK, but the user / group read failed — ${err.message || "check User.Read.All and GroupMember.Read.All permissions"}`,
      };
    }

    if (config.enableIntune) {
      try {
        await graphGet(config, "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=1&$select=id");
      } catch (err: any) {
        return {
          ok: false,
          message: `Entra device scope OK, but Intune query failed — ${err.message || "check DeviceManagementManagedDevices.Read.All permission"}`,
        };
      }
    }

    // Optional — fetch the tenant display name for a friendlier success message.
    // Requires Organization.Read.All, which most integrations won't have; swallow
    // any failure and fall back to a generic message.
    let tenantName: string | undefined;
    try {
      const org = await graphGet(config, "https://graph.microsoft.com/v1.0/organization?$select=displayName");
      tenantName = org?.value?.[0]?.displayName;
    } catch { /* no Organization.Read.All — that's fine */ }

    return { ok: true, message: tenantName ? `Connected — tenant "${tenantName}"` : "Connected successfully" };
  } catch (err: any) {
    if (err instanceof AppError) {
      return { ok: false, message: err.message };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: "Host not found — check network connectivity" };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, message: "Connection timed out contacting Microsoft Graph" };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

// ─── Directory (tag-source) discovery — Charon ──────────────────────────────

/** Graph's page ceiling for /users and /groups. */
const DIRECTORY_PAGE_SIZE = 999;
/** Per-collection cap (users, groups) and per-group member cap. */
export const DIRECTORY_HARD_CAP = 50_000;
/** Groups whose members are read concurrently. Graph throttles per app per tenant. */
const MEMBERSHIP_CONCURRENCY = 4;

export interface EntraDirectoryResult {
  objects: DiscoveredDirectoryObject[];
  /**
   * False when any read may be partial: cancelled, a collection hit
   * DIRECTORY_HARD_CAP, or a group's member read failed (its members' memberOf
   * would be missing that group). The mirror's removal sweep refuses on it.
   */
  complete: boolean;
  /** Groups whose member read failed (the run continues without them). */
  failedGroups: number;
}

/**
 * Users and groups, with each user's TRANSITIVE group membership as
 * `attributes.memberOf` (group object ids — what a `directory_group` tag
 * source's `ref` holds for Entra). Membership is read group-wise
 * (`/groups/{id}/transitiveMembers/microsoft.graph.user`), which costs one
 * paged read per group instead of one per user — far fewer calls in a typical
 * tenant (2000 users, a few hundred groups). Read-only; needs User.Read.All +
 * GroupMember.Read.All (or Directory.Read.All).
 */
export async function discoverDirectory(
  config: EntraIdConfig,
  signal?: AbortSignal,
  onProgress?: EntraDiscoveryProgressCallback,
): Promise<EntraDirectoryResult> {
  const log = onProgress || (() => {});
  const userMeta = { complete: true };
  const groupMeta = { complete: true };

  const users = await graphPage(
    config,
    `https://graph.microsoft.com/v1.0/users?$top=${DIRECTORY_PAGE_SIZE}&$select=id,userPrincipalName,displayName,mail,department,accountEnabled,onPremisesSecurityIdentifier`,
    DIRECTORY_HARD_CAP, signal, userMeta,
  );
  const groups = await graphPage(
    config,
    `https://graph.microsoft.com/v1.0/groups?$top=${DIRECTORY_PAGE_SIZE}&$select=id,displayName,description,securityEnabled,mailEnabled`,
    DIRECTORY_HARD_CAP, signal, groupMeta,
  );
  log("discover.entra.directory", "info", `Entra ID: ${users.length} user(s), ${groups.length} group(s)`);

  // userId → group ids, filled group by group.
  const memberOf = new Map<string, string[]>();
  let failedGroups = 0;
  let membersComplete = true;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < groups.length) {
      if (signal?.aborted) { membersComplete = false; return; }
      const g = groups[next++];
      const gid = String(g.id);
      const meta = { complete: true };
      try {
        const members = await graphPage(
          config,
          `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(gid)}/transitiveMembers/microsoft.graph.user?$top=${DIRECTORY_PAGE_SIZE}&$select=id`,
          DIRECTORY_HARD_CAP, signal, meta,
        );
        if (!meta.complete) membersComplete = false;
        for (const m of members) {
          const uid = String(m.id);
          const list = memberOf.get(uid);
          if (list) list.push(gid); else memberOf.set(uid, [gid]);
        }
      } catch (err: any) {
        failedGroups++;
        membersComplete = false;
        log("discover.entra.members", "error", `Entra ID: member read failed for group "${g.displayName ?? gid}" — ${err?.message || "unknown error"}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEMBERSHIP_CONCURRENCY, groups.length) }, worker));

  const objects: DiscoveredDirectoryObject[] = [];
  for (const u of users) {
    if (u.accountEnabled === false && config.includeDisabled === false) continue;
    const id = String(u.id);
    objects.push({
      kind: "user",
      externalId: id,
      name: u.displayName || u.userPrincipalName || "",
      identifier: u.userPrincipalName || undefined,
      attributes: {
        mail: u.mail || undefined,
        department: u.department || undefined,
        disabled: u.accountEnabled === false,
        onPremisesSecurityIdentifier: u.onPremisesSecurityIdentifier || undefined,
        memberOf: memberOf.get(id) ?? [],
      },
    });
  }
  for (const g of groups) {
    objects.push({
      kind: "group",
      externalId: String(g.id),
      name: g.displayName || "",
      identifier: String(g.id),
      attributes: { description: g.description || undefined, securityEnabled: g.securityEnabled === true, mailEnabled: g.mailEnabled === true },
    });
  }

  const complete = userMeta.complete && groupMeta.complete && membersComplete && !signal?.aborted;
  if (!complete) log("discover.entra.directory", "error", "Entra ID: the directory read was partial (cancelled, capped, or a group member read failed) — removals will be skipped");
  return { objects, complete, failedGroups };
}

// ─── Manual query (UI tool) ─────────────────────────────────────────────────

/**
 * Proxy an arbitrary GET against Microsoft Graph using stored credentials.
 * Used by the manual API query tool in the UI. Path must begin with `/v1.0/`
 * or `/beta/` — the host is fixed to graph.microsoft.com so credentials cannot
 * be exfiltrated to an arbitrary endpoint.
 */
export async function proxyQuery(
  config: EntraIdConfig,
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  if (!path.startsWith("/v1.0/") && !path.startsWith("/beta/")) {
    throw new AppError(400, "Path must begin with /v1.0/ or /beta/");
  }
  const url = new URL("https://graph.microsoft.com" + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (k) url.searchParams.set(k, v);
    }
  }
  return graphGet(config, url.toString());
}

// ─── Device discovery ───────────────────────────────────────────────────────

const DEVICES_HARD_CAP = 10_000;

// ─── Intune Ethernet MAC (per-device read) ──────────────────────────────────
//
// Graph's managedDevices LIST never returns `ethernetMacAddress`: it is a
// "Non-Default property", null on every row of a list call even when $select
// names it, and only an individual GET with $select fills it in (Microsoft's
// managedDevice reference, v1.0). Before this read existed every Intune
// device reached Polaris with its Wi-Fi MAC only, so FortiGate discovery's
// sighting of the wired NIC matched nothing and created a second asset for
// the same machine — and the Ethernet-MAC cross-link that should have joined
// them never had a MAC to match on.
//
// The read goes through Graph JSON batching (20 GETs per $batch call) and is
// skipped for any device whose `lastSyncDateTime` equals the one the stored
// MAC was read at: a device that has not checked in cannot have reported a
// new MAC. A fleet of 2000 costs ~100 batch calls on the first run and, after
// that, only the devices that synced since the previous run.

/** What a previous run stored for one device (from its intune source row). */
export interface KnownEthernetMac {
  ethernetMacAddress: string | null;
  ethernetMacSyncedAt: string | null;
}

/** One device's resolved Ethernet MAC ("" = the device reports none). */
interface ResolvedEthernetMac {
  mac: string;
  syncedAt: string | undefined;
}

/** Graph's JSON batching limit. */
const GRAPH_BATCH_SIZE = 20;
/** Batch calls in flight at once — keeps a cold 2000-device run near 80 req/round. */
const ETHERNET_MAC_BATCH_CONCURRENCY = 4;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Decide, per Intune device, whether its Ethernet MAC can come from the list
 * row or the stored value, or needs a per-device read. Pure — the I/O is in
 * fetchEthernetMacs.
 *
 * `forceRefresh` (a scoped "Discover Now") reads every device regardless of
 * the stored value: one call, and the operator asked for fresh data.
 */
export function planEthernetMacFetch(
  intuneDevices: Iterable<[string, any]>,
  known: ReadonlyMap<string, KnownEthernetMac> | undefined,
  forceRefresh: boolean,
): { resolved: Map<string, ResolvedEthernetMac>; toFetch: Array<{ deviceId: string; managedDeviceId: string; lastSync: string | undefined }> } {
  const resolved = new Map<string, ResolvedEthernetMac>();
  const toFetch: Array<{ deviceId: string; managedDeviceId: string; lastSync: string | undefined }> = [];
  for (const [deviceId, d] of intuneDevices) {
    const lastSync = d?.lastSyncDateTime ? String(d.lastSyncDateTime) : undefined;
    // Should Graph ever start filling the field on a list row, take it.
    const fromList = formatMac(d?.ethernetMacAddress);
    if (fromList) {
      resolved.set(deviceId, { mac: fromList, syncedAt: lastSync });
      continue;
    }
    const prev = known?.get(deviceId);
    if (!forceRefresh && prev && lastSync && prev.ethernetMacSyncedAt === lastSync) {
      resolved.set(deviceId, { mac: formatMac(prev.ethernetMacAddress), syncedAt: lastSync });
      continue;
    }
    const managedDeviceId = d?.id ? String(d.id) : "";
    if (GUID_RE.test(managedDeviceId)) {
      toFetch.push({ deviceId, managedDeviceId, lastSync });
    } else if (prev) {
      // Nothing safe to put in a URL — keep what we had.
      resolved.set(deviceId, carryForward(prev));
    }
  }
  return { resolved, toFetch };
}

/** A failed or impossible read keeps the stored MAC AND its stored stamp, so
 *  the device is retried next run instead of being cached as "no MAC". */
function carryForward(prev: KnownEthernetMac): ResolvedEthernetMac {
  return { mac: formatMac(prev.ethernetMacAddress), syncedAt: prev.ethernetMacSyncedAt ?? undefined };
}

/**
 * Read `ethernetMacAddress` for each managed device id through Graph $batch.
 * Returns the raw value per managed device id for every read that SUCCEEDED
 * (null when the device reports none); a device missing from the result
 * failed and must keep its stored value. A 429 inside a batch is retried up
 * to MAX_GRAPH_THROTTLE_RETRIES times after the longest Retry-After the
 * throttled responses asked for; the outer $batch call's own 401/403/429
 * handling is graphRequest's.
 */
async function fetchEthernetMacs(
  config: EntraIdConfig,
  managedDeviceIds: string[],
  signal: AbortSignal | undefined,
  log: EntraDiscoveryProgressCallback,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const { bodies, failedBatches, batchCount, lastError } = await graphBatchGet(
    config, "v1.0", managedDeviceIds,
    (id) => `/deviceManagement/managedDevices/${id}?$select=id,ethernetMacAddress`, signal,
  );
  for (const [id, body] of bodies) out.set(id, body?.ethernetMacAddress ? String(body.ethernetMacAddress) : null);
  if (failedBatches > 0) {
    log("discover.intune.ethernet_mac", "error", `Intune: ${failedBatches} of ${batchCount} Ethernet MAC batch read(s) failed — those devices keep their stored MAC and are retried next run (last error: ${lastError})`);
  }
  return out;
}

/**
 * One GET per managed device id through Graph JSON batching (20 per $batch
 * call, ETHERNET_MAC_BATCH_CONCURRENCY calls in flight). Returns the response
 * body for every read that SUCCEEDED; a device missing from `bodies` failed
 * (404 for a device retired mid-run, 403, 5xx, a batch call that threw) and
 * the caller keeps whatever it had. A 429 inside a batch is retried up to
 * MAX_GRAPH_THROTTLE_RETRIES times after the longest Retry-After the throttled
 * responses asked for; the outer $batch call's own 401/403/429 handling is
 * graphRequest's. `pathFor` must only interpolate a GUID_RE-checked id.
 */
async function graphBatchGet(
  config: EntraIdConfig,
  version: "v1.0" | "beta",
  managedDeviceIds: string[],
  pathFor: (id: string) => string,
  signal: AbortSignal | undefined,
): Promise<{ bodies: Map<string, any>; failedBatches: number; batchCount: number; lastError: string }> {
  const out = new Map<string, any>();
  const batches: string[][] = [];
  for (let i = 0; i < managedDeviceIds.length; i += GRAPH_BATCH_SIZE) {
    batches.push(managedDeviceIds.slice(i, i + GRAPH_BATCH_SIZE));
  }
  let failedBatches = 0;
  let lastError = "";

  const runBatch = async (ids: string[]): Promise<void> => {
    let pending = ids;
    for (let attempt = 0; pending.length > 0 && attempt <= MAX_GRAPH_THROTTLE_RETRIES; attempt++) {
      if (signal?.aborted) return;
      const res = await graphRequest(config, `https://graph.microsoft.com/${version}/$batch`, {
        method: "POST",
        signal,
        body: {
          requests: pending.map((id) => ({ id, method: "GET", url: pathFor(id) })),
        },
      });
      const throttled: string[] = [];
      let delay = 0;
      for (const r of Array.isArray(res?.responses) ? res.responses : []) {
        const id = String(r?.id ?? "");
        if (!pending.includes(id)) continue;
        if (r.status === 200) {
          out.set(id, r.body ?? null);
        } else if (r.status === 429) {
          throttled.push(id);
          // A batch sub-response's headers are a plain object with Graph's
          // casing ("Retry-After"); throttleDelayMs asks in lower case.
          const h: Record<string, unknown> = r.headers ?? {};
          const get = (n: string): string | null => {
            const k = Object.keys(h).find((key) => key.toLowerCase() === n.toLowerCase());
            return k !== undefined && h[k] != null ? String(h[k]) : null;
          };
          delay = Math.max(delay, throttleDelayMs({ get }));
        }
        // Any other status (404 for a device retired mid-run, 403, 5xx) is a
        // failed read: left out of `out`, so the caller keeps the stored MAC.
      }
      pending = throttled;
      if (pending.length > 0 && attempt < MAX_GRAPH_THROTTLE_RETRIES) await sleep(delay);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length && !signal?.aborted) {
      const ids = batches[next++];
      try {
        await runBatch(ids);
      } catch (err: any) {
        failedBatches++;
        lastError = err?.message || "Unknown error";
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ETHERNET_MAC_BATCH_CONCURRENCY, batches.length) }, worker));
  return { bodies: out, failedBatches, batchCount: batches.length, lastError };
}

/**
 * The Ethernet MAC for every Intune device, keyed by azureADDeviceId: from the
 * list row when Graph filled it, the stored value when the device has not
 * synced since it was read, otherwise a per-device read.
 */
async function resolveEthernetMacs(
  config: EntraIdConfig,
  intuneByDeviceId: Map<string, any>,
  known: ReadonlyMap<string, KnownEthernetMac> | undefined,
  forceRefresh: boolean,
  signal: AbortSignal | undefined,
  log: EntraDiscoveryProgressCallback,
): Promise<Map<string, ResolvedEthernetMac>> {
  const { resolved, toFetch } = planEthernetMacFetch(intuneByDeviceId, known, forceRefresh);
  if (toFetch.length === 0 || signal?.aborted) {
    for (const f of toFetch) {
      const prev = known?.get(f.deviceId);
      if (prev) resolved.set(f.deviceId, carryForward(prev));
    }
    return resolved;
  }
  const fetched = await fetchEthernetMacs(config, toFetch.map((f) => f.managedDeviceId), signal, log);
  for (const f of toFetch) {
    if (fetched.has(f.managedDeviceId)) {
      resolved.set(f.deviceId, { mac: formatMac(fetched.get(f.managedDeviceId)), syncedAt: f.lastSync });
    } else {
      const prev = known?.get(f.deviceId);
      if (prev) resolved.set(f.deviceId, carryForward(prev));
    }
  }
  log("discover.intune.ethernet_mac", "info", `Intune: read the Ethernet MAC of ${fetched.size} device(s) (${toFetch.length} needed a read; ${intuneByDeviceId.size - toFetch.length} unchanged since their last sync)`);
  return resolved;
}

export async function discoverDevices(
  config: EntraIdConfig,
  signal?: AbortSignal,
  onProgress?: EntraDiscoveryProgressCallback,
  /**
   * Narrow the run to ONE device, by its stable Entra `deviceId` GUID (the
   * value stored on the AssetSource row). Backs the asset slide-in's
   * "Discover Now".
   *
   * Everything downstream of the fetch is unchanged — the Intune merge, the
   * include/exclude filter and the includeDisabled rule all still apply — so a
   * scoped run on a device the operator's filter excludes correctly returns
   * zero devices rather than smuggling one past the filter.
   */
  scope?: { deviceId: string },
  /**
   * The Ethernet MAC each device's intune source row already holds, keyed by
   * azureADDeviceId (lower case). Lets the per-device read skip devices that
   * have not synced since — see resolveEthernetMacs. Omitted, every device is
   * read.
   */
  knownEthernetMacs?: ReadonlyMap<string, KnownEthernetMac>,
): Promise<EntraDiscoveryResult> {
  const log = onProgress || (() => {});
  // Guard the interpolation: a deviceId is a GUID, and anything else must not
  // reach an OData $filter string.
  const scopedDeviceId = scope && /^[0-9a-fA-F-]{36}$/.test(scope.deviceId) ? scope.deviceId.toLowerCase() : null;
  if (scope && !scopedDeviceId) {
    throw new AppError(400, `Malformed Entra deviceId for scoped discovery: ${scope.deviceId}`);
  }

  // 1. Entra ID core devices
  const entraUrl = (scopedDeviceId
    ? `https://graph.microsoft.com/v1.0/devices?$filter=deviceId eq '${scopedDeviceId}'&$select=`
    : "https://graph.microsoft.com/v1.0/devices?$top=999&$select=") + [
    "id",
    "deviceId",
    "displayName",
    "operatingSystem",
    "operatingSystemVersion",
    "trustType",
    "accountEnabled",
    "onPremisesSecurityIdentifier",
    "registrationDateTime",
    "approximateLastSignInDateTime",
    "isCompliant",
    "isManaged",
  ].join(",");

  let entraDevices: any[];
  const entraMeta = { complete: false };
  try {
    entraDevices = await graphPage(config, entraUrl, DEVICES_HARD_CAP, signal, entraMeta);
    log("discover.entra.devices", "info", `Entra ID: retrieved ${entraDevices.length} device(s)`);
    if (!entraMeta.complete) {
      log("discover.entra.devices", "error", `Entra ID: the device read is partial (cancelled, or the ${DEVICES_HARD_CAP}-device cap was reached) — the disappearance sweep will be skipped`);
    }
  } catch (err: any) {
    log("discover.entra.devices", "error", `Entra ID: failed to list devices — ${err.message || "Unknown error"}`);
    throw err;
  }

  // 2. Intune managed devices (optional overlay)
  const intuneByDeviceId = new Map<string, any>();
  let intuneRead: EntraDiscoveryResult["intuneRead"] = "disabled";
  if (config.enableIntune && !signal?.aborted) {
    const intuneUrl = (scopedDeviceId
      ? `https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$filter=azureADDeviceId eq '${scopedDeviceId}'&$select=`
      : "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=999&$select=") + [
      "id",
      "azureADDeviceId",
      "deviceName",
      "operatingSystem",
      "osVersion",
      "serialNumber",
      "wiFiMacAddress",
      "ethernetMacAddress",
      "manufacturer",
      "model",
      "userPrincipalName",
      "complianceState",
      "lastSyncDateTime",
    ].join(",");

    const intuneMeta = { complete: false };
    try {
      const intuneDevices = await graphPage(config, intuneUrl, DEVICES_HARD_CAP, signal, intuneMeta);
      for (const d of intuneDevices) {
        const key = String(d.azureADDeviceId || "").toLowerCase();
        if (key) intuneByDeviceId.set(key, d);
      }
      log("discover.intune.devices", "info", `Intune: retrieved ${intuneDevices.length} managed device(s)`);
      // A partial Intune page is treated exactly like a failed one: the only
      // consumer that cares is the sweep, and half a roster would read as
      // "these devices left Intune".
      intuneRead = intuneMeta.complete ? "ok" : "failed";
    } catch (err: any) {
      log("discover.intune.devices", "error", `Intune: failed to list managed devices — ${err.message || "Unknown error"}`);
      // Continue with Entra-only results rather than failing the whole run
      intuneRead = "failed";
    }
  }

  // 2b. Intune Ethernet MACs — absent from the list call, read per device.
  //     Never fails the run: a failed read keeps the stored value.
  let ethernetByDeviceId = new Map<string, ResolvedEthernetMac>();
  if (intuneByDeviceId.size > 0 && !signal?.aborted) {
    try {
      ethernetByDeviceId = await resolveEthernetMacs(config, intuneByDeviceId, knownEthernetMacs, !!scopedDeviceId, signal, log);
    } catch (err: any) {
      log("discover.intune.ethernet_mac", "error", `Intune: Ethernet MAC read failed — ${err.message || "Unknown error"}`);
      for (const [id, prev] of knownEthernetMacs ?? []) {
        if (intuneByDeviceId.has(id)) ethernetByDeviceId.set(id, carryForward(prev));
      }
    }
  }

  // 3. Merge — Intune wins on fields present in both
  const merged: DiscoveredEntraDevice[] = [];
  const seenDeviceIds = new Set<string>();
  let nullIdSkipped = 0;

  for (const e of entraDevices) {
    const deviceId = String(e.deviceId || "").toLowerCase();
    if (!isMeaningfulDeviceId(deviceId)) {
      nullIdSkipped++;
      continue;
    }
    seenDeviceIds.add(deviceId);

    const intune = intuneByDeviceId.get(deviceId);
    const wifi = formatMac(intune?.wiFiMacAddress);
    const ethRes = intune ? ethernetByDeviceId.get(deviceId) : undefined;
    const eth = ethRes?.mac ?? "";
    const sources: ("entra" | "intune")[] = ["entra"];
    if (intune) sources.push("intune");
    merged.push({
      sources,
      entraDisplayName: e.displayName ? String(e.displayName) : undefined,
      intuneDeviceName: intune?.deviceName ? String(intune.deviceName) : undefined,
      intuneManagedDeviceId: intune?.id ? String(intune.id) : undefined,
      deviceId,
      displayName: (intune?.deviceName || e.displayName || "") as string,
      operatingSystem: (intune?.operatingSystem || e.operatingSystem || "") as string,
      operatingSystemVersion: (intune?.osVersion || e.operatingSystemVersion || "") as string,
      trustType: String(e.trustType || ""),
      accountEnabled: e.accountEnabled !== false,
      onPremisesSecurityIdentifier: e.onPremisesSecurityIdentifier ? String(e.onPremisesSecurityIdentifier) : undefined,
      registrationDateTime: e.registrationDateTime || undefined,
      approximateLastSignInDateTime: e.approximateLastSignInDateTime || undefined,
      isCompliant: typeof e.isCompliant === "boolean" ? e.isCompliant : undefined,
      isManaged: typeof e.isManaged === "boolean" ? e.isManaged : undefined,
      serialNumber: intune?.serialNumber || undefined,
      macAddress: (eth || wifi) || undefined,
      wifiMacAddress: wifi || undefined,
      ethernetMacAddress: eth || undefined,
      ethernetMacSyncedAt: ethRes?.syncedAt,
      manufacturer: intune?.manufacturer || undefined,
      model: intune?.model || undefined,
      userPrincipalName: intune?.userPrincipalName || undefined,
      chassisType: intune?.chassisType || undefined,
      complianceState: intune?.complianceState || undefined,
      lastSyncDateTime: intune?.lastSyncDateTime || undefined,
    });
  }

  // Intune-only devices (not yet registered in Entra — rare but possible)
  for (const [deviceId, intune] of intuneByDeviceId) {
    if (seenDeviceIds.has(deviceId)) continue;
    if (!isMeaningfulDeviceId(deviceId)) {
      nullIdSkipped++;
      continue;
    }
    const wifi = formatMac(intune.wiFiMacAddress);
    const ethRes = ethernetByDeviceId.get(deviceId);
    const eth = ethRes?.mac ?? "";
    merged.push({
      sources: ["intune"],
      intuneDeviceName: intune.deviceName ? String(intune.deviceName) : undefined,
      intuneManagedDeviceId: intune.id ? String(intune.id) : undefined,
      deviceId,
      displayName: String(intune.deviceName || ""),
      operatingSystem: String(intune.operatingSystem || ""),
      operatingSystemVersion: String(intune.osVersion || ""),
      trustType: "",
      accountEnabled: true, // Intune-only devices have no Entra accountEnabled — assume active
      serialNumber: intune.serialNumber || undefined,
      macAddress: (eth || wifi) || undefined,
      wifiMacAddress: wifi || undefined,
      ethernetMacAddress: eth || undefined,
      ethernetMacSyncedAt: ethRes?.syncedAt,
      manufacturer: intune.manufacturer || undefined,
      model: intune.model || undefined,
      userPrincipalName: intune.userPrincipalName || undefined,
      chassisType: intune.chassisType || undefined,
      complianceState: intune.complianceState || undefined,
      lastSyncDateTime: intune.lastSyncDateTime || undefined,
    });
  }

  if (nullIdSkipped > 0) {
    log("discover.filter.null_id", "info", `Skipping ${nullIdSkipped} device(s) with empty or null deviceId (e.g. 00000000-0000-0000-0000-000000000000)`);
  }

  // Snapshot the RAW reads for the disappearance sweep before either exclusion
  // below narrows them — see the EntraDiscoveryResult docblock. Taken from the
  // per-endpoint responses rather than from `merged`, because the two source
  // kinds are swept against their OWN endpoint: an Intune-only device is
  // absent from /devices without having left the tenant.
  const absence = {
    presentDeviceIds: [...seenDeviceIds],
    disabledDeviceIds: merged.filter((d) => !d.accountEnabled).map((d) => d.deviceId),
    presentIntuneDeviceIds: [...intuneByDeviceId.keys()],
    intuneRead,
    inventoryComplete: entraMeta.complete,
    scoped: !!scopedDeviceId,
  };

  // 4. Apply device include/exclude filter (match displayName)
  const filtered = filterDevices(merged, config.deviceInclude, config.deviceExclude);
  const dropped = merged.length - filtered.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Device filter: ${filtered.length} included, ${dropped} excluded`);
  } else {
    log("discover.filter", "info", `Merged total: ${filtered.length} device(s)`);
  }

  // 5. If includeDisabled is explicitly false, skip disabled devices entirely
  if (config.includeDisabled === false) {
    const active = filtered.filter((d) => d.accountEnabled);
    const disabledCount = filtered.length - active.length;
    if (disabledCount > 0) {
      log("discover.filter.disabled", "info", `Skipping ${disabledCount} disabled Entra device(s) (includeDisabled=false)`);
    }
    return { devices: active, ...absence };
  }

  return { devices: filtered, ...absence };
}

/**
 * Should the disappearance sweep run against this result?
 *
 * Absence is only evidence of deletion when the read was whole. Returns the
 * reason to skip, or null when the read can be trusted. Mirrors
 * `vcenterService.vcenterSweepBlockedReason`, scoped-run check first so an
 * operator is told the real reason rather than a plausible wrong one.
 *
 * The Intune half needs no gate here: `intuneRead` travels with the result and
 * the sweep leaves every intune row alone unless it says `"ok"`, so an Intune
 * outage costs the Intune rows only and never blocks the Entra ones.
 */
export function entraSweepBlockedReason(
  result: Pick<EntraDiscoveryResult, "presentDeviceIds" | "inventoryComplete" | "scoped">,
): string | null {
  if (result.scoped) return "the run was scoped to a single device";
  if (!result.inventoryComplete) return `the tenant read was incomplete (cancelled, or the ${DEVICES_HARD_CAP}-device cap was reached)`;
  // Zero devices against a tenant that previously had them is a
  // consent/permission answer far more often than an emptied tenant —
  // business rule 35's shrunken-read reasoning, same as vCenter's.
  if (result.presentDeviceIds.length === 0) return "the tenant read came back empty";
  return null;
}

// Reject Entra device IDs that are empty or the canonical null GUID. Some
// devices land in the Graph response with deviceId="00000000-0000-0000-0000-000000000000"
// (typically broken/half-registered records) — accepting them produces an asset
// with assetTag="entra:00000000-..." that all collide on the same key.
function isMeaningfulDeviceId(id: string): boolean {
  if (!id) return false;
  return id.replace(/[-0]/g, "").length > 0;
}

// Normalize a single MAC value from Intune (returned without separators, e.g.
// "A0B1C2D3E4F5") into Polaris's storage convention: colon-separated uppercase.
// Unrecognizable or all-zero input yields "" (falsy → field omitted) — the
// previous fallback stored the raw value uppercased, which poisoned the
// MAC-match cascade with un-normalized junk.
function formatMac(mac: unknown): string {
  if (!mac) return "";
  return normalizeMacOrNull(String(mac)) ?? "";
}

// matchesWildcard is imported from ../utils/integrationFilter.js — the
// canonical glob-lite matcher shared by every device/VM/interface filter.

function filterDevices(
  devices: DiscoveredEntraDevice[],
  include?: string[],
  exclude?: string[],
): DiscoveredEntraDevice[] {
  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchesWildcard(p, d.displayName)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchesWildcard(p, d.displayName)));
  }
  return devices;
}
