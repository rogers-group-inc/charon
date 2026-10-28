/**
 * src/services/fortigateService.ts — Single FortiGate REST API client
 *
 * Talks directly to a standalone FortiGate (not managed by FortiManager), and
 * to each FortiGate a FortiManager integration reaches in direct mode
 * (`useProxy: false`). Uses the FortiOS REST API with Bearer token
 * authentication against a specific VDOM.
 *
 * Ported from polaris: the transport layer verbatim (paced fgRequest, the 401
 * pause, error mapping, the API console's proxyQuery). Polaris's DHCP / switch /
 * AP / ARP inventory discovery is not carried — a FortiGate is an enforcement
 * target in Charon, not a directory source. `fgGet` / `fgWrite` (bottom) are the
 * enforcement service's CMDB calls; they go through the same per-gate pacing.
 * Business-rule numbers in the ported comments (96, 113) are POLARIS rules.
 */

import { AppError } from "../utils/errors.js";
import { tlsFetch } from "../utils/tlsDispatcher.js";
import { logger } from "../utils/logger.js";
import {
  fortiosGateKey,
  authPauseRemainingMs,
  recordFortiosAuthResult,
  consecutive401sFor,
  withFortiosGateSlot,
  FortiosGateBusyError,
} from "../utils/fortiosRequestGate.js";
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from "undici";
import { urlHost } from "../utils/cidr.js";
import { readSystemStatus } from "../utils/fortiosEnvelope.js";

export interface FortiGateConfig {
  host: string;
  port?: number;
  apiUser?: string;         // API admin username (optional; forwarded as access_user for audit parity with FMG)
  apiToken: string;         // Bearer token for authentication
  vdom?: string;            // Virtual Domain (default: "root")
  verifySsl?: boolean;      // Verify the CA chain (default true); off ⇒ the leaf cert is TOFU-pinned (TlsCertPin)
  mgmtInterface?: string;
}

/**
 * Test connectivity to a FortiGate using bearer token auth.
 * Calls /api/v2/monitor/system/status to verify access and retrieve version info.
 */
export async function testConnection(config: FortiGateConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  try {
    // `envelope: true`: the version is an envelope field, so reading it off the
    // unwrapped payload meant this button could never name it — every healthy
    // standalone FortiGate answered with the bare "Connected successfully"
    // while the device was reporting its model, serial and FortiOS version in
    // the very same response.
    const body = await fgRequest<unknown>(config, "GET", "/api/v2/monitor/system/status", {
      envelope: true,
    });
    const status = readSystemStatus(body);
    const { hostname, version, model } = status;
    const box = hostname && model ? `${hostname} (${model})` : hostname || model;
    const label = box && version
      ? `Connected — ${box}, FortiOS ${version}`
      : box
        ? `Connected — ${box}`
        : version
          ? `Connected — FortiOS ${version}`
          : "Connected successfully";
    return { ok: true, message: label, version };
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
    if (err instanceof AppError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * Low-level FortiOS REST request with bearer token auth.
 * Returns the decoded JSON body on success, or throws AppError on auth/HTTP failures.
 * Exported so fortimanagerService can reuse this when `useProxy` is disabled on
 * an FMG integration — FMG enumerates the devices, per-device REST calls go direct.
 *
 * Method support: GET / POST / PUT / DELETE. POST and PUT may carry a JSON
 * body via `opts.body`; the body is JSON-stringified before send. GET and
 * DELETE ignore the body field. Used by reservation push to write
 * /api/v2/cmdb/system.dhcp/server/<id>/reserved-address.
 */
/**
 * Best-effort detail from a failed FortiOS response body, formatted as a
 * trailing ` — …` fragment (empty string when there is nothing to add).
 *
 * FortiOS shapes seen in the wild on a CMDB refusal:
 *   { "http_status": 500, "status": "error", "error": -651, "cli_error": "..." }
 * `error` is the CLI return code and `cli_error` the message the CLI printed;
 * either alone is far more actionable than the HTTP status. Never throws — a
 * diagnostic must not replace the error it is describing.
 */
async function fgErrorDetail(res: UndiciResponse): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (an HTML error page from a proxy, say). One trimmed line is
      // enough to recognize it; the whole page is not.
      const line = text.replace(/\s+/g, " ").trim();
      return line ? ` — ${line.slice(0, 200)}` : "";
    }
    const parts: string[] = [];
    const cliError = body?.cli_error ?? body?.cli_errors;
    if (typeof cliError === "string" && cliError.trim()) parts.push(cliError.replace(/\s+/g, " ").trim());
    if (typeof body?.message === "string" && body.message.trim()) parts.push(body.message.trim());
    // The numeric CLI code is the part Fortinet documentation is indexed by, so
    // it goes last but is never dropped.
    if (body?.error !== undefined && body?.error !== null) parts.push(`FortiOS error ${body.error}`);
    if (parts.length === 0) return "";
    return ` — ${parts.join("; ").slice(0, 300)}`;
  } catch {
    return "";
  }
}

/**
 * A request fgRequest refused WITHOUT sending, because the gate is inside a
 * 401 pause (see fgRequest). The message keeps the "Authentication failed
 * (HTTP 401)" prefix push-error classifiers already read. A monitor probe
 * that catches this must report `skipped`, not a miss: Charon chose not to
 * ask, so it learned nothing about whether the device is up.
 */
export class FortiosAuthPausedError extends AppError {
  readonly remainingMs: number;
  constructor(host: string, port: number, remainingMs: number) {
    super(
      502,
      `Authentication failed (HTTP 401) for ${host}:${port} — Charon has paused requests to this FortiGate ` +
      `for ${Math.ceil(remainingMs / 1000)} s after it rejected the API token, so FortiOS's API-key lockout for this ` +
      `server can expire. Check the API token (and any per-asset REST credential) for this gate`,
    );
    this.name = "FortiosAuthPausedError";
    this.remainingMs = remainingMs;
  }
}

export interface FgRequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Return the whole FortiOS envelope instead of unwrapping to `results`.
   * Only for callers that need an envelope-level field (`serial`, `version`,
   * `build`) — read them through `utils/fortiosEnvelope.ts` rather than by
   * hand, so one module owns which half each field is in.
   */
  envelope?: boolean;
}

/**
 * Every direct FortiOS REST call goes through here, paced per gate by
 * utils/fortiosRequestGate.ts so Charon cannot drive FortiOS 7.6's
 * per-source-IP API-key lockout (business rule 96):
 *
 *  - at most CHARON_FORTIOS_PER_GATE_CONCURRENCY requests in flight per
 *    host:port (default 2, below FortiOS's default lockout threshold of 3);
 *  - after a 401 nothing is sent to that gate for a pause that doubles on each
 *    consecutive 401 (60 s → 30 min). A paused request fails fast with the
 *    same "Authentication failed (HTTP 401)" prefix callers already classify,
 *    and never reaches the gate.
 *
 * The pause is re-checked after the slot is granted, so requests queued behind
 * the one that drew the 401 are not sent either.
 */
export async function fgRequest<T>(
  config: FortiGateConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: FgRequestOptions = {},
): Promise<T> {
  const port = config.port || 443;
  const gateKey = fortiosGateKey(config.host, port);
  const refuseIfPaused = () => {
    const remaining = authPauseRemainingMs(gateKey);
    if (remaining > 0) throw new FortiosAuthPausedError(config.host, port, remaining);
  };
  refuseIfPaused();
  try {
    return await withFortiosGateSlot(
      gateKey,
      async () => {
        refuseIfPaused();
        return fgRequestUnpaced<T>(config, method, path, opts);
      },
      // Waiting for a slot may use up to one request timeout; the request's own
      // timeout starts only once it is sent.
      { signal: opts.signal, maxWaitMs: opts.timeoutMs ?? 15_000 },
    );
  } catch (err) {
    if (err instanceof FortiosGateBusyError) throw new AppError(504, err.message);
    throw err;
  }
}

async function fgRequestUnpaced<T>(
  config: FortiGateConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: FgRequestOptions,
): Promise<T> {
  const port = config.port || 443;
  const qs = new URLSearchParams(opts.query || {});
  const url = `https://${urlHost(config.host)}:${port}${path}${qs.toString() ? (path.includes("?") ? "&" : "?") + qs.toString() : ""}`;

  const controller = new AbortController();
  // Default 15s for discovery / push paths. Response-time probes pass their
  // resolved per-asset probeTimeoutMs (default 5000, range 100..60000) so a
  // wedged FortiOS box trips faster than the discovery default.
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiToken}`,
    };
    // Parity with FMG: forward the API user if provided. FortiOS ignores it,
    // but some admin/audit configurations log this header.
    if (config.apiUser) headers["access_user"] = config.apiUser;

    // verifySsl=false relaxes TLS for THIS connection only (an undici
    // dispatcher scoped to this request) — never via the process-global
    // NODE_TLS_REJECT_UNAUTHORIZED flip, which raced the parallel per-device
    // query chains. tlsFetch owns the pairing: a dispatcher is only valid to
    // the undici copy that created it, so the fetch must not be Node's global
    // one. See src/utils/tlsDispatcher.ts.
    const init: UndiciRequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (opts.body !== undefined && (method === "POST" || method === "PUT")) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await tlsFetch(url, init, config.verifySsl);

    // Every HTTP answer feeds the gate's 401 pause (utils/fortiosRequestGate.ts):
    // a 401 starts or lengthens it, anything else ends the run.
    const gateKey = fortiosGateKey(config.host, port);
    const pauseMs = recordFortiosAuthResult(gateKey, res.status);
    if (pauseMs > 0) {
      logger.warn(
        { host: config.host, port, path, consecutive401s: consecutive401sFor(gateKey), pauseSec: Math.round(pauseMs / 1000) },
        "FortiGate answered 401 — pausing all REST requests to it so FortiOS's per-source-IP API-key lockout can expire",
      );
    }

    // 401 and 403 are DIFFERENT operator problems and must not share a message.
    // 401 = the token is wrong. 403 = the token authenticated fine, but FortiOS
    // refused this endpoint — the api-user's accessprofile doesn't grant the
    // group the path belongs to (e.g. /monitor/system/status needs System read),
    // or the caller's source IP is outside the api-user's trusthost. Conflating
    // them sends operators to re-issue a token that was never the problem, and
    // it reads as "the API key stopped working" when only ONE endpoint is
    // refused — the Query API tool keeps working against paths the profile does
    // allow. fortimanagerService's rpc() has always split these; this is the
    // FortiGate-side parity fix.
    // Both messages name the TARGET. Under FMG bypass mode the host is not
    // something the operator typed — it is resolved per-device out of FMG's
    // copy of the gate's `system/interface` table (resolveDeviceMgmtIp, keyed
    // on one fleet-wide mgmtInterface name). So "auth failed" against an
    // unnamed host is unanswerable: a token that is valid fleet-wide still
    // fails if the resolved address belongs to a different box than the one
    // the operator tested by hand — which overlapping RFC1918 branch subnets
    // make entirely possible. Print the address so that is checkable.
    if (res.status === 401) {
      throw new AppError(
        502,
        `Authentication failed (HTTP 401) for ${config.host}:${port} — check your API token`,
      );
    }
    if (res.status === 403) {
      throw new AppError(
        502,
        `FortiGate permission denied (HTTP 403) for ${config.host}:${port} on ${path} — the API ` +
        `token authenticated, but the api-user's access profile does not permit this endpoint, ` +
        `or the caller is outside its trusthost`,
      );
    }
    if (res.status === 404) {
      throw new AppError(404, `Endpoint not found: ${path}`);
    }
    if (!res.ok) {
      // Surface FortiOS's OWN complaint. A failing CMDB write answers with a
      // body — `error` (the negative CLI code) and often `cli_error` (the exact
      // text the CLI printed) — and this branch used to discard it, so every
      // refusal an operator hit read "FortiGate returned HTTP 500" with no way
      // to tell a rejected field from an unsupported table from a dependency
      // failure. The FMG-proxy path has always relayed the device's message
      // (`fortimanagerService`'s rpcInner), so the direct transport was the
      // blind one: a quarantine push that 500'd was undiagnosable from the UI,
      // the Event details and the log alike. The body is read as TEXT and
      // parsed defensively — an HTML error page from something in front of the
      // gate must not turn a device error into a parse error — and the prefix
      // is unchanged because classifyPushError and the 502 fragment list read
      // these messages.
      throw new AppError(
        502,
        `FortiGate returned HTTP ${res.status} for ${path}${await fgErrorDetail(res)}`,
      );
    }

    const body = (await res.json()) as any;

    // FortiOS REST envelope: { status, http_status, results, ... }
    // Errors may arrive as { status: "error", http_status: 4xx, error: <code> }
    if (body && body.status === "error") {
      throw new AppError(502, `FortiGate error (${body.error ?? "unknown"}): ${body.message ?? path}`);
    }

    // Unwrapping to `results` is what almost every caller wants, and stays the
    // default. But the box's own identity — `serial`, `version`, `build` — is
    // on the ENVELOPE, not in `results`, so a caller that needs it must ask for
    // the whole body. Reading those fields off the unwrapped payload is exactly
    // the bug this option exists to close: it silently yielded an empty serial
    // and an empty osVersion for every standalone-discovered FortiGate, which
    // in turn made HA undetectable. See utils/fortiosEnvelope.ts.
    if (opts.envelope) return body as T;
    return (body?.results ?? body) as T;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

const FG_TLS_CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Describe a transport-level failure out of fgRequest — the request never got
 * an HTTP answer (refused, timed out, no route, TLS rejected) or the answer was
 * not JSON. fgRequest turns every HTTP-status failure into an AppError but lets
 * these escape raw, which the route error handler can only report as a bare
 * 500 "Internal server error". Returns null for anything that is not one.
 */
export function describeFgTransportError(err: unknown): string | null {
  if (err instanceof AppError) return null;
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  // fgRequest's own timeout fires controller.abort(), which surfaces as AbortError.
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "request timed out";
  if (err instanceof SyntaxError) return "the response was not JSON (something other than FortiOS answered on this address)";
  const code = e?.cause?.code;
  // Rule 113(e): the gate's certificate no longer matches its pin — nothing was sent.
  if (code === "CERT_PIN_REFUSED") return e?.cause?.message || "the TLS certificate changed since it was pinned";
  switch (code) {
    case "ECONNREFUSED": return "connection refused (ECONNREFUSED) — nothing is listening on this port, or HTTPS admin access is not allowed on this interface";
    case "ENOTFOUND": return "host not found (ENOTFOUND)";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT": return `connection timed out (${code}) — the address is unreachable from Charon or a firewall is dropping the traffic`;
    case "EHOSTUNREACH":
    case "ENETUNREACH": return `no route to host (${code})`;
    case "ECONNRESET":
    case "UND_ERR_SOCKET": return `connection reset (${code})`;
  }
  if (code && FG_TLS_CERT_CODES.has(code)) {
    return `TLS certificate error (${code}) — SSL verification is on for this FortiGate; turn it off or install a trusted certificate`;
  }
  if (code) return `${code}${e.cause?.message ? `: ${e.cause.message}` : ""}`;
  if (e?.message === "fetch failed" && e.cause?.message) return e.cause.message;
  return null;
}

/**
 * Proxy an arbitrary REST call to the FortiGate using stored credentials.
 * Used by the manual API query tool in the UI. Transport failures become a
 * 502 naming the address and port so the operator can see WHERE the call went;
 * `targetNote` adds how that address was chosen (the FMG bypass path resolves
 * it rather than the operator typing it).
 */
export async function proxyQuery(
  config: FortiGateConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
  targetNote?: string,
): Promise<unknown> {
  try {
    return await fgRequest(config, method, path, { query, body });
  } catch (err) {
    const detail = describeFgTransportError(err);
    if (!detail) throw err;
    const target = `${config.host}:${config.port || 443}`;
    throw new AppError(502, `Could not reach FortiGate at ${target}${targetNote ? ` ${targetNote}` : ""} — ${detail}`);
  }
}

// ─── Enforcement CMDB calls (Charon) ────────────────────────────────────────

/**
 * GET a FortiOS CMDB / monitor path, unwrapped to `results`. Paced through the
 * per-gate request gate like every other direct call.
 */
export async function fgGet<T = unknown>(config: FortiGateConfig, path: string, signal?: AbortSignal): Promise<T> {
  return fgRequest<T>(config, "GET", path, { query: vdomQuery(config), signal });
}

/**
 * Write (POST / PUT / DELETE) a FortiOS CMDB path. Called ONLY by
 * fortinetEnforcementService, ONLY for `charon-*` objects, ONLY when the
 * integration's enforcement mode is `enforce` (business rules 1, 2).
 */
export async function fgWrite<T = unknown>(
  config: FortiGateConfig,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return fgRequest<T>(config, method, path, { query: vdomQuery(config), body, signal });
}

function vdomQuery(config: FortiGateConfig): Record<string, string> | undefined {
  return config.vdom ? { vdom: config.vdom } : undefined;
}
