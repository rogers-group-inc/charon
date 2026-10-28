/**
 * src/services/integrationHealthService.ts
 *
 * Backs `GET /api/v1/integrations/health-summary`, the sidebar's poll (ported
 * from polaris):
 *
 *   failed       — enabled integrations whose most recent connection test failed.
 *   proxyAdvice  — FortiManager integrations on the proxy transport that manage
 *                  more gates than proxy mode scales to.
 *
 * Charon: polaris counts managed gates from its Asset inventory, which Charon
 * does not keep, so `proxyAdvice` is always empty here. The shape (and the pure
 * `selectProxyAdvice`) is kept so the ported UI renders unchanged and a future
 * gate count can feed it.
 */

import { prisma } from "../db.js";

/** Above this many managed FortiGates, proxy mode is the wrong transport. */
export const FMG_PROXY_GATE_ADVISORY_THRESHOLD = 10;

export interface FailedIntegration {
  id: string;
  name: string;
  type: string;
  lastTestAt: Date | null;
}

export interface ProxyAdviceEntry {
  id: string;
  name: string;
  managedFortigates: number;
}

export interface IntegrationHealthSummary {
  failed: FailedIntegration[];
  proxyAdvice: ProxyAdviceEntry[];
  proxyAdviceThreshold: number;
}

/** Proxy is the DEFAULT, so an absent flag means proxy. */
export function integrationIsFmgProxyMode(config: unknown): boolean {
  return ((config as Record<string, unknown> | null) || {}).useProxy !== false;
}

/** Pair each proxy-mode integration with its gate count and keep those over the line. Pure. */
export function selectProxyAdvice(
  integrations: Array<{ id: string; name: string }>,
  gateCountById: Map<string, number>,
  threshold: number = FMG_PROXY_GATE_ADVISORY_THRESHOLD,
): ProxyAdviceEntry[] {
  return integrations
    .map((i) => ({ id: i.id, name: i.name, managedFortigates: gateCountById.get(i.id) ?? 0 }))
    .filter((i) => i.managedFortigates > threshold);
}

export async function getIntegrationHealthSummary(): Promise<IntegrationHealthSummary> {
  const failed = await prisma.integration.findMany({
    where: { enabled: true, lastTestOk: false },
    select: { id: true, name: true, type: true, lastTestAt: true },
    orderBy: { name: "asc" },
  });
  return { failed, proxyAdvice: [], proxyAdviceThreshold: FMG_PROXY_GATE_ADVISORY_THRESHOLD };
}
