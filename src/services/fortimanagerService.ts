/**
 * src/services/fortimanagerService.ts — FortiManager JSON-RPC client.
 *
 * FortiManager is an ENFORCEMENT target (not a directory source): Charon pushes
 * dynamic address-group members + charon-* policies through it (milestone 6).
 * This module provides the connection stereotype now: testConnection() logs in
 * with the API token and reads /sys/status for a version string.
 *
 * Conventions match polaris: token bearer auth, per-call TLS-verify toggle,
 * transient-retry via httpClient. At scale (300+ FortiGates) FMG-proxied calls
 * are serialized (~1 concurrent); the enforcement worker enforces that lane —
 * see milestone 6 / docs/fmg-discovery.
 */

import { httpJson } from "./httpClient.js";
import type { TestResult } from "./integrationService.js";

export interface FortiManagerConfig {
  host: string;
  port?: number;
  apiToken: string;
  apiUser?: string;
  verifyTls?: boolean;
  adom?: string;
}

interface JsonRpcResponse {
  result?: Array<{ status?: { code?: number; message?: string }; data?: any; url?: string }>;
}

function baseUrl(c: FortiManagerConfig): string {
  return `https://${c.host}:${c.port || 443}/jsonrpc`;
}

async function rpc(c: FortiManagerConfig, method: string, params: unknown[], signal?: AbortSignal): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${c.apiToken}`,
  };
  if (c.apiUser) headers["access_user"] = c.apiUser;
  return httpJson<JsonRpcResponse>(baseUrl(c), {
    method: "POST",
    headers,
    body: JSON.stringify({ id: 1, method, params }),
    verifyTls: c.verifyTls,
    signal,
    label: "FortiManager",
  });
}

export async function testConnection(config: FortiManagerConfig, signal?: AbortSignal): Promise<TestResult> {
  try {
    const res = await rpc(config, "get", [{ url: "/sys/status" }], signal);
    const entry = res.result?.[0];
    if (entry?.status?.code !== 0) {
      return { ok: false, message: entry?.status?.message || "FortiManager returned a non-zero RPC status" };
    }
    const version = entry.data?.Version || entry.data?.version;
    return { ok: true, message: "Connected to FortiManager", version: version ? String(version) : undefined };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? "Connection failed" };
  }
}
