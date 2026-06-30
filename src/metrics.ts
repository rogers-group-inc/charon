/**
 * src/metrics.ts — Prometheus metrics registry + helpers.
 *
 * One Registry, a small surface of typed helpers so callers don't import
 * metric objects directly. Default Node.js process / event-loop metrics are
 * registered with no prefix (standard dashboards work unmodified); everything
 * Charon-specific is prefixed `charon_`.
 *
 * Endpoint: GET /metrics on the main HTTP listener (web/all). Non-HTTP roles
 * (endpoint/enforcer/worker) expose it on CHARON_METRICS_PORT via
 * utils/metricsServer.ts. Optional Bearer-token gate via METRICS_TOKEN.
 */

import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// ─── Process role ────────────────────────────────────────────────────────────

const processRole = new Gauge({
  name: "charon_process_role",
  help: "Active CHARON_ROLE for this process (1 for the running role). Labels: role=web|endpoint|enforcer|worker|migrate|all.",
  labelNames: ["role"] as const,
  registers: [registry],
});

export function recordProcessRole(role: string): void {
  processRole.set({ role }, 1);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const httpRequestDuration = new Histogram({
  name: "charon_http_request_duration_seconds",
  help: "HTTP request latency. `route` is the matched Express route template so cardinality stays bounded; unmatched paths roll up to `unmatched`. `status_class` is 2xx/3xx/4xx/5xx. /metrics + /health excluded.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 5],
  registers: [registry],
});

const httpInFlight = new Gauge({
  name: "charon_http_in_flight",
  help: "HTTP requests currently being handled.",
  registers: [registry],
});

// ─── Endpoint agents ────────────────────────────────────────────────────────

const endpointsByStatus = new Gauge({
  name: "charon_endpoints_by_status",
  help: "Enrolled endpoints grouped by status (pending|enrolled|online|offline|revoked).",
  labelNames: ["status"] as const,
  registers: [registry],
});

const agentWsConnections = new Gauge({
  name: "charon_agent_ws_connections",
  help: "Currently-connected agent telemetry WebSockets on this endpoint-role process.",
  registers: [registry],
});

export function setEndpointsByStatus(counts: Record<string, number>): void {
  endpointsByStatus.reset();
  for (const [status, n] of Object.entries(counts)) endpointsByStatus.set({ status }, n);
}

export function incAgentWs(): void {
  agentWsConnections.inc();
}
export function decAgentWs(): void {
  agentWsConnections.dec();
}

// ─── Tag reconciliation + enforcement ─────────────────────────────────────────

const tagReconcileDuration = new Histogram({
  name: "charon_tag_reconcile_duration_seconds",
  help: "Wall-clock duration of one endpoint tag-set recompute in the reconciler.",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15],
  registers: [registry],
});

const enforcementApplyTotal = new Counter({
  name: "charon_enforcement_apply_total",
  help: "Fortinet enforcement deltas processed, by integration_type, object_type (addrgrp|address|policy), and outcome (applied|dry_run|error).",
  labelNames: ["integration_type", "object_type", "outcome"] as const,
  registers: [registry],
});

const enforcementDrift = new Gauge({
  name: "charon_enforcement_drift",
  help: "Count of Charon-owned Fortinet objects in `drift` state, by integration_type. Non-zero means desired ≠ actual — surfaced on the Integrations page.",
  labelNames: ["integration_type"] as const,
  registers: [registry],
});

export function startTagReconcileTimer(): () => number {
  return tagReconcileDuration.startTimer();
}

export type EnforcementOutcome = "applied" | "dry_run" | "error";

export function recordEnforcementApply(
  integrationType: string,
  objectType: string,
  outcome: EnforcementOutcome,
): void {
  enforcementApplyTotal.inc({ integration_type: integrationType, object_type: objectType, outcome });
}

export function setEnforcementDrift(integrationType: string, count: number): void {
  enforcementDrift.set({ integration_type: integrationType }, count);
}

// ─── Integrations / discovery ─────────────────────────────────────────────────

const integrationTestTotal = new Counter({
  name: "charon_integration_test_total",
  help: "Integration testConnection / health-check results by integration_type and outcome (success|failure|skipped).",
  labelNames: ["integration_type", "outcome"] as const,
  registers: [registry],
});

const discoveryDuration = new Histogram({
  name: "charon_discovery_duration_seconds",
  help: "Wall-clock duration of a directory discovery run, by integration_type.",
  labelNames: ["integration_type"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry],
});

export type TestOutcome = "success" | "failure" | "skipped";

export function recordIntegrationTest(integrationType: string, outcome: TestOutcome): void {
  integrationTestTotal.inc({ integration_type: integrationType, outcome });
}

export function recordDiscovery(integrationType: string, durationSeconds: number): void {
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    discoveryDuration.observe({ integration_type: integrationType }, durationSeconds);
  }
}

// ─── HA / leader election ──────────────────────────────────────────────────────

const isLeader = new Gauge({
  name: "charon_is_leader",
  help: "1 when this process currently holds the Postgres advisory-lock leadership (runs schedulers/enforcement); 0 otherwise.",
  registers: [registry],
});

export function setLeader(leader: boolean): void {
  isLeader.set(leader ? 1 : 0);
}

// ─── pg-boss queues ────────────────────────────────────────────────────────────

const pgbossQueueJobs = new Gauge({
  name: "charon_pgboss_queue_jobs",
  help: "pg-boss job counts by queue and state.",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

export function setPgbossQueueJobs(queue: string, state: string, count: number): void {
  pgbossQueueJobs.set({ queue, state }, count);
}

// ─── Scheduled-job execution ─────────────────────────────────────────────────

const jobDuration = new Histogram({
  name: "charon_job_duration_seconds",
  help: "Wall-clock duration of one tick of a scheduled background job. `job` is the job's stable id.",
  labelNames: ["job"] as const,
  buckets: [0.05, 0.5, 1, 5, 30, 60, 300],
  registers: [registry],
});

const jobTotal = new Counter({
  name: "charon_job_total",
  help: "Scheduled-job tick executions by job and outcome (success|failure).",
  labelNames: ["job", "outcome"] as const,
  registers: [registry],
});

export type JobOutcome = "success" | "failure";

export function startJobTimer(job: string): () => number {
  return jobDuration.startTimer({ job });
}

export function recordJobOutcome(job: string, outcome: JobOutcome): void {
  jobTotal.inc({ job, outcome });
}

// ─── HTTP helpers (consumed by app.ts) ────────────────────────────────────────

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

export function statusToClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

export function startHttpRequestTimer(): (
  method: string,
  route: string,
  statusClass: StatusClass,
) => number {
  const end = httpRequestDuration.startTimer();
  return (method, route, statusClass) => end({ method, route, status_class: statusClass });
}

export function incHttpInFlight(): void {
  httpInFlight.inc();
}

export function decHttpInFlight(): void {
  httpInFlight.dec();
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
