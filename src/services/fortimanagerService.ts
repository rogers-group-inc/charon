/**
 * src/services/fortimanagerService.ts — FortiManager JSON RPC API client
 *
 * Authenticates via bearer token (API key) rather than session-based login.
 *
 * Ported from polaris: the connection layer verbatim — testConnection, the
 * random-FortiGate direct-mode test, management-IP resolution, rpc() with its
 * retry and the per-integration FmgWorker lanes (proxy calls serialized, native
 * calls parallel), the API console's proxyQuery / fmgProxyRest, central-
 * management detection and the device roster. Polaris's per-device DHCP / switch
 * / AP / ARP inventory discovery and the coordinate setters are not carried: a
 * FortiManager is an enforcement target in Charon, not a directory source.
 * Business-rule numbers in the ported comments are POLARIS rules.
 */

import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { tlsFetch } from "../utils/tlsDispatcher.js";
import { logger } from "../utils/logger.js";
import { isValidIpv4 } from "../utils/cidr.js";
import { getFmgWorker } from "./fmgWorker.js";
import {
  testConnection as fgTestConnection,
  proxyQuery as fgProxyQuery,
  type FortiGateConfig,
} from "./fortigateService.js";

// FMG-side device names and FortiOS system-status hostnames can disagree in
// case (e.g. FMG stores "evansville-fw-1" while the device returns
// "EVANSVILLE-FW-1" via /api/v2/cmdb/system/global). Every in-memory Map/Set
// that keys by "FortiGate device name" must lowercase the key so writes from
// either source land in the same bucket; original casing is preserved on the
// raw device object and the asset row for logging and Event messages.
export const fmgNameKey = (n: string | null | undefined): string =>
  String(n ?? "").toLowerCase();

export interface FortiManagerConfig {
  host: string;
  port?: number;
  apiUser: string;          // API user name (required by newer FMG versions)
  apiToken: string;         // Bearer token for authentication
  adom?: string;            // Administrative Domain (default: "root")
  verifySsl?: boolean;      // Verify the CA chain (default true); off ⇒ the leaf cert is TOFU-pinned (TlsCertPin)
  mgmtInterface?: string;
  deviceInclude?: string[];   // FortiGate device names to include (wildcards ok). Matched against name/hostname.
  deviceExclude?: string[];   // FortiGate device names to exclude. Ignored if deviceInclude is non-empty.
  useProxy?: boolean;         // If true (default), per-device calls go through FMG's /sys/proxy/json. If false, they go direct to each FortiGate's management IP using fortigateApiUser + fortigateApiToken.
  fortigateApiUser?: string;  // Only used when useProxy is false — REST API admin username configured on each managed FortiGate.
  fortigateApiToken?: string; // Only used when useProxy is false — Bearer token for the REST API admin on each managed FortiGate.
  fortigateVerifySsl?: boolean; // Only used when useProxy is false — whether to verify TLS certs on direct FortiGate connections (default false).
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  id: number;
  result: Array<{
    status: { code: number; message: string };
    url: string;
    data?: unknown;
  }>;
}

/**
 * Test connectivity to a FortiManager using bearer token auth.
 * Calls /sys/status to verify access and retrieve version info.
 */
export async function testConnection(
  config: FortiManagerConfig,
  integrationId?: string,
): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;

  try {
    const statusPayload: JsonRpcRequest = {
      id: 1,
      method: "get",
      params: [{ url: "/sys/status" }],
    };

    const statusRes = await rpc(baseUrl, statusPayload, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);

    const code = statusRes.result?.[0]?.status?.code;
    if (code !== 0) {
      const msg = statusRes.result?.[0]?.status?.message || "Request failed";
      if (code === -11) {
        return { ok: false, message: "Invalid or expired API token" };
      }
      return { ok: false, message: msg };
    }

    const data = statusRes.result?.[0]?.data as Record<string, unknown> | undefined;
    const version = data?.Version ? String(data.Version) : undefined;

    return {
      ok: true,
      message: version ? `Connected — FortiManager ${version}` : "Connected successfully",
      version,
    };
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED") {
      return { ok: false, message: `Connection refused — ${config.host}:${config.port || 443}` };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: `Host not found — ${config.host}` };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError") {
      return { ok: false, message: `Connection timed out — ${config.host}:${config.port || 443}` };
    }
    if (err.message === "fetch failed" && err.cause) {
      const code = err.cause?.code;
      if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return { ok: false, message: `TLS certificate error (${code}) — try disabling SSL verification` };
      }
      return { ok: false, message: err.cause?.message || err.message };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * No /sys/logout. Polaris authenticates to FortiManager with a predefined
 * REST API Admin api-key (bearer). Per the FortiManager API Best Practices
 * Guide, that key is permanent: "the same user account will always share the
 * same session and you do not need to use the login/logout endpoints." The
 * logout-to-free-slots advice applies only to session-based auth. A prior
 * hourly /sys/logout (commit 3e70476) tore down the shared session out from
 * under the split-role monitor/discovery processes that reuse it, producing
 * RPC -11 "no valid session" churn — removed deliberately. If FMG ever reaps
 * the session at its hard lifetime, the next bearer call re-establishes it.
 */

/**
 * Resolve a FortiGate's real management-interface IP via FMG.
 *
 * FMG's own `device.ip` field is FMG's view of the gate — frequently a
 * FortiLink/mgmt-tunnel address that isn't reachable from outside the
 * FMG↔FortiGate path. For direct transport we need the IP the gate
 * actually listens on for REST API traffic, which lives in the
 * interface config.
 *
 * Strategy: try a filtered `filter: [["name","==",mgmt]]` query first
 * (small response). FMG's filter evaluator sporadically returns an
 * empty array even when the interface exists — so if the filtered
 * response comes back empty, fall back to fetching the full interface
 * list and matching client-side. Returns null only if the interface
 * genuinely has no usable v4 IP configured on either pass.
 */
function _extractV4(raw: unknown): string | null {
  const ip = Array.isArray(raw) ? raw[0] : (raw as string | null | undefined);
  if (!ip || ip === "0.0.0.0" || !isValidIpv4(ip)) return null;
  return ip;
}

/**
 * Resolve the management IP of a managed FortiGate by reading its interface
 * config through FMG. Returns the IP that direct-mode REST calls should
 * target, or null if the configured management interface has no usable IP.
 *
 * Exposed so reservationPushService can build a per-device FortiGateConfig
 * when the integration is in direct (`useProxy=false`) mode.
 */
export async function resolveDeviceMgmtIpViaFmg(
  config: FortiManagerConfig,
  deviceName: string,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<string | null> {
  const mgmtIfaceName = config.mgmtInterface?.trim();
  if (!mgmtIfaceName) return null;
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  return resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, signal, integrationId);
}

async function resolveDeviceMgmtIp(
  baseUrl: string,
  config: FortiManagerConfig,
  deviceName: string,
  mgmtIfaceName: string,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<string | null> {
  const url = `/pm/config/device/${deviceName}/global/system/interface`;

  // Fast path — filtered query.
  try {
    const filteredRes = await rpc(
      baseUrl,
      { id: 2, method: "get", params: [{ url, filter: [["name", "==", mgmtIfaceName]], fields: ["name", "ip"], loadsub: 0 }] },
      config.apiUser, config.apiToken, config.verifySsl, signal, integrationId,
    );
    const list = filteredRes.result?.[0]?.data;
    if (Array.isArray(list) && list.length > 0) {
      const found = (list as any[]).find((i) => i.name === mgmtIfaceName);
      const ip = found ? _extractV4(found.ip) : null;
      if (ip) return ip;
    }
  } catch { /* fall through to unfiltered fetch */ }

  // Fallback — unfiltered fetch, client-side match. FMG's filter evaluator
  // sometimes returns an empty list under load even when the interface
  // exists; pulling every interface avoids that failure mode at the cost
  // of one larger response.
  const fullRes = await rpc(
    baseUrl,
    { id: 2, method: "get", params: [{ url, fields: ["name", "ip"], loadsub: 0 }] },
    config.apiUser, config.apiToken, config.verifySsl, signal, integrationId,
  );
  const all = fullRes.result?.[0]?.data;
  if (!Array.isArray(all)) return null;
  const match = (all as any[]).find((i) => i.name === mgmtIfaceName);
  return match ? _extractV4(match.ip) : null;
}

/**
 * Pick a random managed FortiGate from the FMG device list and run a
 * FortiGate-side connection test against it using the direct-transport
 * credentials. Exposed as a standalone call so the UI can stream its
 * result independently of the FMG connection test.
 *
 * Retries with a different random gate (a "backup pick") if the first pick
 * fails — so a single offline/in-maintenance gate doesn't fail the whole
 * test when the rest of the fleet is healthy. Total attempts capped at
 * MAX_RANDOM_FORTIGATE_ATTEMPTS; FMG-level failures (device list fetch,
 * empty/filtered-out ADOM, missing mgmt interface) are not retried because
 * they aren't gate-specific.
 */
const MAX_RANDOM_FORTIGATE_ATTEMPTS = 2;

export async function testRandomFortiGate(
  config: FortiManagerConfig,
  integrationId?: string,
): Promise<{
  ok: boolean;
  message: string;
  deviceName: string;
  version?: string;
  attempts?: string[];
}> {
  if (!config.fortigateApiToken) {
    return {
      ok: false,
      message: 'FortiGate API Token is required when the FortiManager proxy is disabled',
      deviceName: "(none)",
    };
  }

  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    params: [{ url: `/dvmdb/adom/${adom}/device`, fields: ["name", "hostname", "ip"], loadsub: 0 }],
  };

  let devicesRes: JsonRpcResponse;
  try {
    devicesRes = await rpc(baseUrl, devicesPayload, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);
  } catch (err: any) {
    return { ok: false, message: `Failed to fetch device list from FMG: ${err.message || "Unknown error"}`, deviceName: "(none)" };
  }

  const raw = devicesRes.result?.[0]?.data;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: `No managed devices found in ADOM "${adom}"`, deviceName: "(none)" };
  }

  // Apply the same include/exclude filters the discovery run would use. We
  // don't require FMG's `device.ip` here — that field is FMG's own view of
  // the gate (often a FortiLink/mgmt-tunnel address) and isn't reachable
  // from Polaris. The real management IP comes from the gate's interface
  // config, resolved below.
  const filtered = filterDevices(raw as any[], config.deviceInclude, config.deviceExclude);

  if (filtered.length === 0) {
    return {
      ok: false,
      message: "No managed FortiGate is available to test against — adjust device include/exclude or make sure at least one gate is online in FMG",
      deviceName: "(none)",
    };
  }

  const mgmtIfaceName = config.mgmtInterface?.trim();
  if (!mgmtIfaceName) {
    return {
      ok: false,
      message: 'FortiGate mgmt interface is not configured on the integration — set "Management Interface" before testing direct transport',
      deviceName: "(none)",
    };
  }

  // Fisher-Yates shuffle of the filtered list, then walk the first N entries.
  // Shuffling (instead of repeated `Math.random()` index picks) guarantees we
  // never re-test the same gate when the filtered list has ≥2 entries.
  const shuffled = filtered.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const maxAttempts = Math.min(MAX_RANDOM_FORTIGATE_ATTEMPTS, shuffled.length);

  const attemptLog: string[] = [];
  let lastResult: {
    ok: boolean;
    message: string;
    deviceName: string;
    version?: string;
  } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pick = shuffled[attempt];
    const deviceName = String(pick.name || pick.hostname || pick.ip || "(unknown)");

    let mgmtIp: string | null;
    try {
      mgmtIp = await resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, undefined, integrationId);
    } catch (err: any) {
      lastResult = {
        ok: false,
        message: `Failed to resolve management IP for "${deviceName}" via FMG (${mgmtIfaceName}): ${err.message || "Unknown error"}`,
        deviceName,
      };
      attemptLog.push(deviceName);
      continue;
    }

    if (!mgmtIp) {
      lastResult = {
        ok: false,
        message: `Could not resolve a management IP for "${deviceName}" on interface "${mgmtIfaceName}"`,
        deviceName,
      };
      attemptLog.push(deviceName);
      continue;
    }

    const fgConfig: FortiGateConfig = {
      host: mgmtIp,
      port: 443,
      apiUser: config.fortigateApiUser || "",
      apiToken: config.fortigateApiToken,
      vdom: "root",
      verifySsl: config.fortigateVerifySsl === true,
      mgmtInterface: mgmtIfaceName,
    };

    const fgResult = await fgTestConnection(fgConfig);
    attemptLog.push(deviceName);
    if (fgResult.ok) {
      return {
        ok: true,
        message: fgResult.message,
        version: fgResult.version,
        deviceName,
        attempts: attemptLog,
      };
    }
    lastResult = { ok: false, message: fgResult.message, version: fgResult.version, deviceName };
  }

  // All attempts failed. Surface the last failure, but include the full list
  // of attempted device names in the message so the operator can see which
  // gates were tried and rule out an unlucky single-pick fluke.
  const lr = lastResult ?? {
    ok: false,
    message: "No FortiGate could be tested",
    deviceName: "(none)",
  };
  const message = attemptLog.length > 1
    ? `${lr.message} (also tried: ${attemptLog.filter((n) => n !== lr.deviceName).join(", ")})`
    : lr.message;
  return { ok: false, message, deviceName: lr.deviceName, version: lr.version, attempts: attemptLog };
}

/** True when this JSON-RPC payload targets FMG's `/sys/proxy/json` passthrough
 *  (i.e. forwards a call through to a managed FortiGate). FMG drops parallel
 *  proxy connections past 1-2 so these go through the FmgWorker's strict
 *  proxy lane; everything else (CMDB, dvmdb, auth) goes through the unbounded
 *  native lane. */
function rpcPayloadIsProxy(payload: JsonRpcRequest): boolean {
  const params = payload.params;
  if (!Array.isArray(params)) return false;
  for (const p of params) {
    const url = (p as { url?: string } | undefined)?.url;
    if (typeof url === "string" && url === "/sys/proxy/json") return true;
  }
  return false;
}

/**
 * Low-level JSON RPC call to FortiManager with bearer token auth.
 *
 * When `integrationId` is provided, the call funnels through the
 * per-integration FmgWorker. The worker has two lanes:
 *
 *   • Proxy lane (strict concurrency=1) — every `/sys/proxy/json` call.
 *     FortiManager drops parallel proxy connections past 1-2, so these stay
 *     serialized by design.
 *   • Native lane (unbounded) — every other call (CMDB, dvmdb, auth, etc.).
 *     Native endpoints hit FMG's own database and don't share the proxy
 *     concurrency constraint, so they parallelize freely.
 *
 * When `integrationId` is omitted (e.g. test-connection on an unsaved
 * integration where no id exists yet), the call runs direct — there's no
 * other code talking to that FMG instance, so contention is impossible.
 */
async function rpc(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
  integrationId?: string,
): Promise<JsonRpcResponse> {
  const inner = () => rpcInner(url, payload, apiUser, apiToken, verifySsl, externalSignal);
  if (!integrationId) return inner();
  const label = `fmg.${payload.method}:${describeRpcParams(payload)}`;
  const worker = getFmgWorker(integrationId);
  return rpcPayloadIsProxy(payload)
    ? worker.submitProxy(label, inner, externalSignal)
    : worker.submitNative(label, inner, externalSignal);
}

function describeRpcParams(payload: JsonRpcRequest): string {
  const first = payload.params?.[0] as { url?: string; data?: { resource?: string; target?: string[] } } | undefined;
  if (!first) return "?";
  // /sys/proxy/json wraps the real path in data.resource + data.target[0]
  if (first.url === "/sys/proxy/json" && first.data) {
    const tgt = first.data.target?.[0] ?? "?";
    const res = first.data.resource ?? "?";
    return `${tgt}:${res}`;
  }
  return first.url ?? "?";
}

// Bounded retry for transient FortiManager faults. Per the FortiManager API
// Best Practices Guide ("implement retry logic with exponential backoff for
// transient errors"), only TRANSIENT failures are retried — HTTP 5xx and
// network-layer faults (timeout / connection reset). PERMANENT failures
// (HTTP 401/403/404/405, and the FMG RPC -11 surfaced by callers) are thrown
// immediately. Retries run INSIDE the caller's FmgWorker lane slot, so the
// proxy lane stays serialized (concurrency=1) and a struggling FMG isn't piled
// on. The outward AppError.httpStatus stays 502 for every transport failure
// (unchanged) — the upstream HTTP code is encoded in the message and used only
// to decide retryability, never re-exposed to Polaris's own clients (a raw 401
// would otherwise trip the frontend's session-expired logout).
const RPC_MAX_ATTEMPTS = 3;        // 1 initial + 2 retries
const RPC_RETRY_BASE_MS = 500;     // backoff: 500ms then 1500ms

function markRetryable<E extends object>(err: E): E {
  (err as { retryable?: boolean }).retryable = true;
  return err;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function rpcInner(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<JsonRpcResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    if (externalSignal?.aborted) break;
    try {
      return await rpcAttempt(url, payload, apiUser, apiToken, verifySsl, externalSignal);
    } catch (err) {
      lastErr = err;
      const retryable = (err as { retryable?: boolean })?.retryable === true;
      if (!retryable || externalSignal?.aborted || attempt === RPC_MAX_ATTEMPTS - 1) throw err;
      const backoffMs = RPC_RETRY_BASE_MS * (attempt * 2 + 1); // 500ms, then 1500ms
      logger.debug(
        { url: describeRpcParams(payload), attempt: attempt + 1, backoffMs, message: (err as Error)?.message },
        "fmg rpc: transient failure — backing off then retrying",
      );
      await sleepWithAbort(backoffMs, externalSignal);
    }
  }
  throw lastErr;
}

async function rpcAttempt(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);

  // If an external signal fires (e.g. integration re-saved), abort this request too
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    };
    if (apiUser) headers["access_user"] = apiUser;

    let res: Awaited<ReturnType<typeof tlsFetch>>;
    try {
      // verifySsl=false relaxes TLS for THIS connection only (an undici
      // dispatcher scoped to this request) — never via the process-global env
      // flip, which raced concurrent requests. tlsFetch owns the pairing: a
      // dispatcher is only valid to the undici copy that created it, so the
      // fetch must not be Node's global one. See src/utils/tlsDispatcher.ts.
      res = await tlsFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, verifySsl);
    } catch (err: any) {
      // Intentional external abort (integration re-saved) — propagate as-is, never retry.
      if (externalSignal?.aborted && !timedOut) throw err;
      // Rule 113(e): a refused certificate is permanent until someone re-trusts
      // it — retrying would only repeat the refusal.
      if (err?.cause?.code === "CERT_PIN_REFUSED") throw new AppError(502, `FortiManager connection refused — ${err.cause.message}`);
      // Timeout or transient connection fault — retryable.
      const detail = timedOut ? "timed out after 10s" : (err?.cause?.code || err?.message || "fetch failed");
      throw markRetryable(new AppError(502, `FortiManager connection error — ${detail}`));
    }

    // Permanent (never retry): auth, permission, missing resource, bad method.
    if (res.status === 401) throw new AppError(502, "FortiManager auth failed (HTTP 401) — invalid or expired API token/session");
    if (res.status === 403) throw new AppError(502, "FortiManager permission denied (HTTP 403) — check the API user's admin profile");
    if (res.status === 404) throw new AppError(502, "FortiManager endpoint not found (HTTP 404)");
    if (res.status === 405) throw new AppError(502, "FortiManager method not allowed (HTTP 405)");
    // Transient (retry): server-side 5xx.
    if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      throw markRetryable(new AppError(502, `FortiManager returned HTTP ${res.status}`));
    }
    if (!res.ok) throw new AppError(502, `FortiManager returned HTTP ${res.status}`);

    return (await res.json()) as JsonRpcResponse;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Proxy an arbitrary JSON-RPC call to FortiManager using stored credentials.
 * Used by the manual API query tool in the UI.
 */
export async function proxyQuery(
  config: FortiManagerConfig,
  method: string,
  params: unknown[],
  integrationId?: string,
): Promise<unknown> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  return rpc(baseUrl, { id: 1, method, params }, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);
}

export interface CentralManagementDetection {
  wtp: boolean;
  fsw: boolean;
  /** Row counts from the ADOM tables (null = table absent / per-device). */
  wtpCount: number | null;
  fswCount: number | null;
  detectedAt: string;
}

/**
 * Decode the ADOM's central-management state from its dvmdb `flags` value.
 * Central is the DEFAULT — per-device mode is expressed as explicit
 * `per_device_wtp` / `per_device_fsw` flags (confirmed against a live FMG
 * 7.x: the /dvmdb/adom syntax dump lists per_device_wtp=1024,
 * per_device_fsw=65536, and an ADOM with switches per-device + APs central
 * carried exactly the per_device_fsw bit). The bit values are read from the
 * caller-supplied `opts` map (the syntax dump) rather than hardcoded, so a
 * version that renumbers the enum can't flip the decode. Returns null for a
 * class whose per-device flag isn't in `opts` (build predates per-device
 * support for it — the caller falls back to the table probe).
 *
 * `flags` arrives as a uint32 bitmask on current builds; verbose builds may
 * render it as a string array — both are handled. Exported for unit tests.
 */
export function decodeCentralManagementFlags(
  flags: unknown,
  opts: Record<string, unknown>,
): { wtp: boolean | null; fsw: boolean | null } {
  const decode = (flagName: string): boolean | null => {
    if (Array.isArray(flags)) return !flags.map(String).includes(flagName);
    const bit = opts[flagName];
    if (typeof flags !== "number" || typeof bit !== "number") return null;
    return (flags & bit) === 0; // per-device flag ABSENT = central
  };
  return { wtp: decode("per_device_wtp"), fsw: decode("per_device_fsw") };
}

/**
 * Detect whether this ADOM centrally manages FortiAPs (AP Manager) and/or
 * FortiSwitches (FortiSwitch Manager).
 *
 * Primary signal: the ADOM's dvmdb `flags` (see
 * decodeCentralManagementFlags) — authoritative and immune to the
 * empty-table edge. The per-class row counts still come from probing the
 * ADOM-level object table each central pane owns —
 *   APs:      /pm/config/adom/<adom>/obj/wireless-controller/wtp
 *   Switches: /pm/config/adom/<adom>/obj/fsp/managed-switch
 * — for the integrations-page display, and the probe ("table readable AND
 * holds rows") doubles as the fallback verdict when the flags path is
 * unavailable (older builds, restricted admin). Returns null on transport
 * failure so the caller keeps the previous stamp. Runs at FMG discovery
 * start (runDiscovery) and lands on `Integration.config.centralManagement`
 * (system-owned key — the PUT handler's config merge preserves it across
 * operator edits).
 */
export async function detectCentralManagement(
  config: FortiManagerConfig,
  integrationId?: string,
): Promise<CentralManagementDetection | null> {
  const adom = config.adom || "root";
  // Row count, or null when FMG rejects the URL (class managed per-device).
  const probe = async (url: string): Promise<number | null> => {
    const res = (await proxyQuery(config, "get", [{ url }], integrationId)) as {
      result?: Array<{ status?: { code?: number }; data?: unknown }>;
    };
    const r = res?.result?.[0];
    if (r?.status?.code !== 0) return null;
    return Array.isArray(r.data) ? r.data.length : null;
  };
  // ADOM flags verdict, or nulls when any piece is unavailable. The mkey-get
  // form rejects extra attributes on some builds, so both reads use the
  // table form (filter / option are table-level attributes).
  const flagsVerdict = async (): Promise<{ wtp: boolean | null; fsw: boolean | null }> => {
    try {
      const [syntaxRes, rowRes] = await Promise.all([
        proxyQuery(config, "get", [{ url: "/dvmdb/adom", option: ["syntax"] }], integrationId),
        proxyQuery(config, "get", [{ url: "/dvmdb/adom", filter: ["name", "==", adom], fields: ["name", "flags"] }], integrationId),
      ]);
      const opts = (syntaxRes as any)?.result?.[0]?.data?.adom?.attr?.flags?.opts;
      const rows = (rowRes as any)?.result?.[0]?.data;
      const row = Array.isArray(rows) ? rows.find((r: any) => r?.name === adom) : null;
      if (!opts || typeof opts !== "object" || !row) return { wtp: null, fsw: null };
      return decodeCentralManagementFlags(row.flags, opts as Record<string, unknown>);
    } catch {
      return { wtp: null, fsw: null };
    }
  };
  try {
    const [verdict, wtpCount, fswCount] = await Promise.all([
      flagsVerdict(),
      probe(`/pm/config/adom/${adom}/obj/wireless-controller/wtp`),
      probe(`/pm/config/adom/${adom}/obj/fsp/managed-switch`),
    ]);
    return {
      wtp: verdict.wtp ?? (wtpCount ?? 0) > 0,
      fsw: verdict.fsw ?? (fswCount ?? 0) > 0,
      wtpCount,
      fswCount,
      detectedAt: new Date().toISOString(),
    };
  } catch {
    return null; // FMG unreachable — keep the previous stamp
  }
}

/**
 * Run an arbitrary FortiOS REST call against a managed FortiGate by wrapping
 * it in FortiManager's `/sys/proxy/json` endpoint. Used by the reservation
 * push path when the integration has `useProxy=true` — the call lands on the
 * FortiGate's running config in real time, with FortiManager forwarding using
 * its own stored device credentials.
 *
 * `method` maps to the proxy `action`: "GET" → "get", "POST" → "post", etc.
 * `body` is forwarded as the proxy `payload` for POST/PUT.
 *
 * Returns the FortiOS body's `results` field on success. The wrapper unpacks
 * both the FMG-level status (`result[0].status.code === 0`) and the
 * FortiOS-level HTTP status (`data[0].status.code` 2xx); either non-success
 * throws AppError(502).
 */
export async function fmgProxyRest<T = unknown>(
  config: FortiManagerConfig,
  deviceName: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  resource: string,
  opts: { body?: unknown; signal?: AbortSignal; integrationId?: string } = {},
): Promise<T> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const action = method.toLowerCase();

  const data: Record<string, unknown> = {
    target: [`/adom/${adom}/device/${deviceName}`],
    action,
    resource,
  };
  if (opts.body !== undefined && (method === "POST" || method === "PUT")) {
    data.payload = opts.body;
  }

  const payload: JsonRpcRequest = {
    id: 1,
    method: "exec",
    params: [{ url: "/sys/proxy/json", data }],
  };

  const res = await rpc(baseUrl, payload, config.apiUser, config.apiToken, config.verifySsl, opts.signal, opts.integrationId);

  const fmgCode = res.result?.[0]?.status?.code;
  if (fmgCode !== 0) {
    const msg = res.result?.[0]?.status?.message || "FortiManager rejected the request";
    if (fmgCode === -11) throw new AppError(502, "FortiManager: invalid or expired API token");
    throw new AppError(502, `FortiManager proxy error: ${msg}`);
  }

  // The proxy response wraps each target's reply. Single target → single entry.
  const proxyData = res.result?.[0]?.data as any;
  const entry = Array.isArray(proxyData) ? proxyData[0] : proxyData;
  if (!entry) throw new AppError(502, "FortiManager proxy returned no response payload");

  // FortiOS HTTP status (separate from the FMG envelope status above)
  const httpStatus =
    entry?.status?.code ??
    entry?.http_status ??
    entry?.response?.http_status ??
    200;
  if (httpStatus < 200 || httpStatus >= 300) {
    const msg =
      entry?.status?.message ||
      entry?.response?.error ||
      entry?.response?.message ||
      `FortiGate returned HTTP ${httpStatus}`;
    throw new AppError(502, `FortiGate (via FMG proxy) error: ${msg}`);
  }

  // FortiOS REST envelope wraps real data under `response.results`. Some
  // monitor endpoints set the body directly on `response`; CMDB writes
  // typically echo `mkey` at the top level of the response.
  const inner = entry?.response ?? entry;
  return (inner?.results ?? inner) as T;
}

// ─── Native FMG write helpers (no /sys/proxy/json) ─────────────────────────

/**
 * Write a managed FortiGate's `gui-device-latitude` / `gui-device-longitude`
 * via FMG's CMDB tree. Same path the discovery geo fetcher reads from.
 *
 * Native FMG `update` on `/pm/config/device/<deviceName>/global/system/global`
 * — does NOT trigger an FMG install, so the change stays in FMG's CMDB until
 * an operator clicks Install Device Configuration. UI text on the write-back
 * toggle surfaces this caveat for operators.
 *
 * FortiOS stores these fields as strings; values are formatted via `.toFixed(6)`
 * to match FMG's serialized form.
 */

export async function proxyQueryViaFortigate(
  config: FortiManagerConfig,
  deviceName: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query?: Record<string, string>,
  integrationId?: string,
  body?: unknown,
): Promise<unknown> {
  if (!config.fortigateApiToken) {
    throw new AppError(400, 'Direct mode requires "FortiGate API Token" to be set on this integration');
  }
  const mgmtIfaceName = config.mgmtInterface?.trim();
  if (!mgmtIfaceName) {
    throw new AppError(400, 'Direct mode requires "Management Interface" to be set on this integration');
  }

  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const mgmtIp = await resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, undefined, integrationId);
  if (!mgmtIp) {
    throw new AppError(502, `Could not resolve a management IP for "${deviceName}" on interface "${mgmtIfaceName}"`);
  }

  const fgConfig: FortiGateConfig = {
    host: mgmtIp,
    port: 443,
    apiUser: config.fortigateApiUser || "",
    apiToken: config.fortigateApiToken,
    vdom: "root",
    verifySsl: config.fortigateVerifySsl === true,
    mgmtInterface: mgmtIfaceName,
  };

  return fgProxyQuery(
    fgConfig, method, path, query, body,
    `(management IP of "${deviceName}" as FortiManager reports it on interface "${mgmtIfaceName}")`,
  );
}

// ─── DHCP Discovery ─────────────────────────────────────────────────────────

export type DiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
  device?: string,
) => void;

/**
 * Every identity the FMG device roster knows, from the RAW `/dvmdb/adom/<adom>
 * /device` payload — pre-filter, any conn_status, HA members included.
 *
 * The HA half is the point. A cluster's standby never appears at the top-level
 * `name`/`sn`; its identity lives only inside `ha_slave[]`. Collecting member
 * identities from the PROCESSED devices instead (which is what the sync layer
 * used to do) tied a standby's survival to its cluster being reachable: one
 * gate that failed its direct read, was skipped for an unresolved management
 * IP, or was dropped by the include/exclude filter still contributed its
 * top-level name — so the primary asset matched the roster and lived, while
 * the standby matched nothing and was decommissioned by the Phase 2a stale-
 * firewall sweep. Roster membership is config truth for every member of every
 * cluster, online or not, so it is captured in one place, once.
 *
 * `ha_mode` is deliberately NOT consulted: a member listed in `ha_slave[]` is
 * a configured chassis whatever the mode field says, and this function answers
 * "does the upstream still know this box", not "what shape is the cluster".
 * Duplicates are possible (the primary appears both at top level and in
 * `ha_slave[]`) and harmless — both consumers build Sets.
 */
export function extractRosterIdentities(devicesRaw: any[]): { names: string[]; serials: string[] } {
  const names: string[] = [];
  const serials: string[] = [];
  const pushName = (v: unknown) => { if (typeof v === "string" && v.length > 0) names.push(v); };
  const pushSerial = (v: unknown) => { if (typeof v === "string" && v.length > 0) serials.push(v); };
  for (const d of Array.isArray(devicesRaw) ? devicesRaw : []) {
    pushName(d?.name || d?.hostname);
    pushSerial(d?.sn);
    for (const m of Array.isArray(d?.ha_slave) ? d.ha_slave : []) {
      pushName(m?.name);
      pushSerial(m?.sn);
    }
  }
  return { names, serials };
}

/** One chassis's reachability as FortiManager currently understands it. */
export interface RosterDeviceStatus {
  /** FMG device name (top level), or the `ha_slave[]` member name. */
  name: string;
  /** Serial, upper-cased — the join key. */
  serial: string;
  connected: boolean;
  /** Raw signal, surfaced verbatim in probe errors so an operator can see what FMG said. */
  raw: string;
  /** True when the row came from `ha_slave[]` rather than the top level. */
  haMember: boolean;
}

/**
 * Reachability for every chassis in the RAW `/dvmdb/adom/<adom>/device` payload
 * — the status sibling of `extractRosterIdentities`, walking the same rows and
 * the same `ha_slave[]` members so the two cannot disagree about which serials
 * exist.
 *
 * This is FortiManager's OWN view, refreshed on FMG's check-in cadence rather
 * than by Polaris touching the device. It is therefore lagged, and it is
 * second-hand — but it is free (a native `/dvmdb` read, outside the
 * `/sys/proxy/json` concurrency-1 lane) and it covers the whole fleet in one
 * call, which is exactly what the `fortimanager` polling method trades for.
 *
 * Two encodings, both matching how discovery already reads them:
 *  - top level `conn_status`: 1 = connected. **Absent counts as connected**,
 *    the same "unknown is not down" reading `processDevice` uses to decide
 *    whether a gate is offline — an FMG that stopped reporting the field must
 *    not mass-down a fleet.
 *  - `ha_slave[].status`: 1 = member up, 0 = down. Flagged
 *    verify-on-real-FMG where it is first read (`parseHaCluster`); the same
 *    caveat applies here.
 *
 * Serials are upper-cased because every Fortinet serial join in this codebase
 * folds case on both sides.
 */
export function extractRosterConnectivity(devicesRaw: any[]): RosterDeviceStatus[] {
  const out: RosterDeviceStatus[] = [];
  for (const d of Array.isArray(devicesRaw) ? devicesRaw : []) {
    const sn = typeof d?.sn === "string" ? d.sn.trim() : "";
    if (sn) {
      const cs = d?.conn_status;
      out.push({
        name: String(d?.name || d?.hostname || ""),
        serial: sn.toUpperCase(),
        connected: cs === undefined || cs === null || cs === 1,
        raw: cs === undefined || cs === null ? "unreported" : `conn_status=${String(cs)}`,
        haMember: false,
      });
    }
    for (const m of Array.isArray(d?.ha_slave) ? d.ha_slave : []) {
      const msn = typeof m?.sn === "string" ? m.sn.trim() : "";
      if (!msn) continue;
      const st = m?.status;
      out.push({
        name: String(m?.name || ""),
        serial: msn.toUpperCase(),
        connected: st === undefined || st === null || st === 1,
        raw: st === undefined || st === null ? "unreported" : `ha_slave.status=${String(st)}`,
        haMember: true,
      });
    }
  }
  return out;
}

/**
 * Fetch the ADOM device roster and project it to per-serial reachability.
 *
 * Native `/dvmdb` read: NOT subject to FMG's `/sys/proxy/json` concurrency-1
 * throttle, and one call covers every managed gate — which is what lets the
 * monitor role poll a whole fleet's up/down for the price of a single request.
 * The monitor process cannot reuse discovery's copy of this payload (separate
 * process in the split-role layout), so it issues its own.
 */
export async function fetchRosterConnectivity(
  config: FortiManagerConfig,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<RosterDeviceStatus[]> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const { apiUser, apiToken, verifySsl } = config;
  // No `fields` list, deliberately: naming fields makes FMG authorize each one
  // individually and fail the whole query with -11 when the API user's profile
  // doesn't grant one of them. See the roster fetch in discoverDhcpSubnets.
  const res = await rpc(
    baseUrl,
    { id: 1, method: "get", params: [{ url: `/dvmdb/adom/${adom}/device` }] },
    apiUser,
    apiToken,
    verifySsl,
    signal,
    integrationId,
  );
  return extractRosterConnectivity(res.result?.[0]?.data as any[]);
}

/**
 * Extract HA cluster info from a raw FMG `/dvmdb/adom/<adom>/device` record.
 * FMG exposes `ha_mode` + `ha_slave[]` directly on the device record — no
 * extra calls needed. The "current primary" is the ha_slave entry whose `sn`
 * matches the top-level `sn`; FMG keeps these in sync across failover. When
 * the device is standalone (ha_mode missing/zero or ha_slave empty), returns
 * `{ haMode: "standalone" }` so downstream code has a single branch.
 *
 * FMG encodes `ha_mode` as either a string ("standalone"|"a-p"|"a-a") or an
 * integer (0=standalone, 1=a-p, 2=a-a). Both are normalized here.
 */

export function buildFmgOsVersion(raw: any): string {
  const major = Number(raw?.os_ver);
  if (!Number.isFinite(major) || major <= 0) return "";
  const mr = Number(raw?.mr);
  const patch = Number(raw?.patch);
  const parts: number[] = [major];
  if (Number.isFinite(mr) && mr >= 0) parts.push(mr);
  if (Number.isFinite(patch) && patch >= 0) parts.push(patch);
  return parts.join(".");
}

function filterDevices(
  devices: any[],
  include?: string[],
  exclude?: string[],
): any[] {
  const matchDevice = (d: any, pattern: string): boolean => {
    const name = String(d.name ?? "");
    const hostname = String(d.hostname ?? "");
    return matchesWildcard(pattern, name) || (hostname !== "" && matchesWildcard(pattern, hostname));
  };

  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchDevice(d, p)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchDevice(d, p)));
  }
  return devices;
}
