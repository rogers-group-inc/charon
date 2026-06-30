/**
 * src/services/httpClient.ts — Shared outbound HTTP conventions for integrations.
 *
 * Captures polaris's integration HTTP-client stereotype in one place so every
 * Fortinet / Graph call behaves identically:
 *   - a hard per-request timeout (default 12s) via AbortController
 *   - an external AbortSignal race (so a re-saved/disabled integration aborts
 *     in-flight calls) that is distinguished from a timeout
 *   - bounded retry with backoff on TRANSIENT faults only (network reset,
 *     timeout, HTTP 5xx); permanent faults (401/403/404/405) throw immediately
 *   - a per-call TLS-verify toggle (Fortinet appliances commonly present a
 *     self-signed cert; verification defaults ON and can be disabled per
 *     integration). Verification is the secure default — never silently off.
 *
 * SECURITY NOTE on the TLS toggle: we set rejectUnauthorized at the request
 * level via an undici dispatcher rather than mutating the process-global
 * NODE_TLS_REJECT_UNAUTHORIZED, so disabling verification for one self-signed
 * appliance never weakens TLS for every other outbound call in the process.
 */

import { Agent } from "undici";
import { AppError } from "../utils/errors.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries
const RETRY_BASE_MS = 500; // 500ms then 1500ms

// One insecure dispatcher, reused — building an Agent per request leaks sockets.
let insecureDispatcher: Agent | null = null;
function getInsecureDispatcher(): Agent {
  if (!insecureDispatcher) {
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureDispatcher;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Verify the server TLS certificate. Defaults to true (secure). */
  verifyTls?: boolean;
  timeoutMs?: number;
  /** External abort (integration re-saved / discovery cancelled). */
  signal?: AbortSignal;
  /** Service label used in error messages, e.g. "FortiManager". */
  label?: string;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function markRetryable<E extends object>(err: E): E {
  (err as { retryable?: boolean }).retryable = true;
  return err;
}

async function attempt(url: string, opts: HttpOptions): Promise<Response> {
  const label = opts.label ?? "Upstream";
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
        // @ts-expect-error — undici dispatcher is accepted by Node's fetch at runtime
        dispatcher: opts.verifyTls === false ? getInsecureDispatcher() : undefined,
      });
    } catch (err: any) {
      if (opts.signal?.aborted && !timedOut) throw err; // intentional external abort — never retry
      const detail = timedOut
        ? `timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : err?.cause?.code || err?.message || "fetch failed";
      throw markRetryable(new AppError(502, `${label} connection error — ${detail}`));
    }

    if (res.status === 401) throw new AppError(502, `${label} auth failed (HTTP 401) — invalid or expired credential`);
    if (res.status === 403) throw new AppError(502, `${label} permission denied (HTTP 403) — check the admin profile/scope`);
    if (res.status === 404) throw new AppError(502, `${label} endpoint not found (HTTP 404)`);
    if (res.status === 405) throw new AppError(502, `${label} method not allowed (HTTP 405)`);
    if (res.status >= 500) throw markRetryable(new AppError(502, `${label} returned HTTP ${res.status}`));
    if (!res.ok) throw new AppError(502, `${label} returned HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Fetch with timeout + transient-retry + per-call TLS-verify toggle. */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (opts.signal?.aborted) break;
    try {
      return await attempt(url, opts);
    } catch (err) {
      lastErr = err;
      const retryable = (err as { retryable?: boolean })?.retryable === true;
      if (!retryable || opts.signal?.aborted || i === MAX_ATTEMPTS - 1) throw err;
      await sleepWithAbort(RETRY_BASE_MS * (i * 2 + 1), opts.signal);
    }
  }
  throw lastErr;
}

/** JSON convenience wrapper. */
export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpRequest(url, opts);
  return (await res.json()) as T;
}
