# Observability / metrics

Moved verbatim from ARCHITECTURE.md § 12.

`metrics.ts` exposes a prom-client registry on `/metrics` (web/endpoint) or a
metrics-only server (enforcer/worker). Series: `charon_http_request_duration`,
`charon_http_in_flight`, `charon_endpoints_by_status`,
`charon_agent_ws_connections`, `charon_tag_reconcile_duration`,
`charon_enforcement_apply_total`, `charon_enforcement_drift`,
`charon_integration_test_total`, `charon_discovery_duration`, `charon_is_leader`,
`charon_pgboss_queue_jobs`, `charon_job_duration`/`_total`, `charon_process_role`.

## Conventions

- Define a metric once in `src/metrics.ts` and export a typed helper (`startXTimer()` /
  `recordX(...)`); callers never touch metric objects (`charon-change-impact` →
  patterns/backend-patterns.md → Prometheus instrumentation).
- `/health` and `/metrics` are open unless `HEALTH_TOKEN` / `METRICS_TOKEN` are set, in which
  case they need that bearer.
- The metrics-only listener (`src/utils/metricsServer.ts → startMetricsOnlyServer()`) binds
  `CHARON_METRICS_BIND` (default `127.0.0.1`) on `CHARON_METRICS_PORT`.
- A new or renamed `charon_*` series is a deployment-surface change: any dashboard or alert rule
  that names it moves with it.
