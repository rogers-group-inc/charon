/**
 * src/services/fortigateService.ts — FortiGate REST client.
 *
 * Direct-to-FortiGate path (the alternative to FMG-proxied enforcement). Used
 * for testConnection now and for direct CMDB writes in milestone 6. Bearer
 * API-token auth against /api/v2; per-call TLS-verify toggle (FortiGates often
 * present a self-signed cert).
 *
 * Scale model (mirrors polaris): direct-to-FortiGate calls run up to ~20
 * concurrent with a warm management-IP cache; FMG-proxied calls are serialized.
 */

import { httpJson } from "./httpClient.js";
import type { TestResult } from "./integrationService.js";

export interface FortiGateConfig {
  host: string;
  port?: number;
  apiToken: string;
  verifyTls?: boolean;
  vdom?: string;
}

function url(c: FortiGateConfig, path: string): string {
  const vdom = c.vdom ? `?vdom=${encodeURIComponent(c.vdom)}` : "";
  return `https://${c.host}:${c.port || 443}${path}${vdom}`;
}

/** GET against a FortiGate REST path with the stored token. */
export async function fgGet<T = any>(c: FortiGateConfig, path: string, signal?: AbortSignal): Promise<T> {
  return httpJson<T>(url(c, path), {
    method: "GET",
    headers: { Authorization: `Bearer ${c.apiToken}` },
    verifyTls: c.verifyTls,
    signal,
    label: "FortiGate",
  });
}

/** Write (POST/PUT/DELETE) against a FortiGate CMDB path. Used ONLY by the
 *  enforcement service, ONLY when the integration's enforce toggle is ON. */
export async function fgWrite<T = any>(
  c: FortiGateConfig,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const { httpRequest } = await import("./httpClient.js");
  const res = await httpRequest(url(c, path), {
    method,
    headers: { Authorization: `Bearer ${c.apiToken}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    verifyTls: c.verifyTls,
    signal,
    label: "FortiGate",
  });
  // 200/424 etc. handled by httpRequest; FortiGate returns the object on success.
  return (await res.json().catch(() => ({}))) as T;
}

export async function testConnection(config: FortiGateConfig, signal?: AbortSignal): Promise<TestResult> {
  try {
    const res = await fgGet<{ version?: string; results?: { version?: string } }>(
      config,
      "/api/v2/monitor/system/status",
      signal,
    );
    const version = res.version || res.results?.version;
    return { ok: true, message: "Connected to FortiGate", version: version ? String(version) : undefined };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? "Connection failed" };
  }
}
