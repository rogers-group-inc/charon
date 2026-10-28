/**
 * src/services/ssoProbe.ts — "is this IdP URL alive?" for the Authentication
 * modal's Test buttons.
 *
 * The URL is operator-supplied, so it is SSRF-guarded like integration hosts:
 * http(s) only, and never a blocked range (loopback, link-local / cloud
 * metadata, multicast — credentials/netGuard.ts). Any HTTP status counts as
 * reachable (an IdP login endpoint answers a bare HEAD with 200, 302 or 405);
 * only a transport failure is a failure. Redirects are not followed.
 */

import { isBlockedOutboundHost } from "./credentials/netGuard.js";

export interface ProbeResult {
  ok: boolean;
  message: string;
  status?: number;
}

export async function probeIdpUrl(raw: string, timeoutMs = 8000): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `Not a URL: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `Unsupported URL scheme "${url.protocol}" — must be http(s)` };
  }
  if (isBlockedOutboundHost(url.hostname)) {
    return { ok: false, message: `Host "${url.hostname}" is in a blocked range (loopback / link-local / multicast)` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
    return { ok: true, status: res.status, message: `Reachable (HTTP ${res.status})` };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    const message = e.name === "AbortError"
      ? `Connection timed out (${timeoutMs / 1000}s)`
      : e.cause?.code === "ENOTFOUND"
        ? `Host not found — ${url.hostname}`
        : e.message || "Connection failed";
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}
