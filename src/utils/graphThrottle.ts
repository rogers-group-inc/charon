/**
 * src/utils/graphThrottle.ts — Microsoft cloud throttle backoff.
 *
 * Pure headers → milliseconds policy for a 429 / 503 from Microsoft Graph.
 * Ported verbatim from polaris (where it lives in azureArcService.ts so the two
 * Azure surfaces cannot diverge; Charon carries no Azure Arc integration).
 *
 *   - `Retry-After` (seconds) wins when present, capped at 60 s;
 *   - else `x-ms-user-quota-resets-after` (hh:mm:ss), capped at 60 s;
 *   - else 5 s.
 */

export function throttleDelayMs(headers: {
  get(name: string): string | null;
}): number {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);

  const quota = headers.get("x-ms-user-quota-resets-after");
  if (quota) {
    const parts = quota.split(":").map((p) => Number(p));
    if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
      const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (seconds > 0) return Math.min(seconds * 1000, 60_000);
    }
  }
  return 5_000;
}
