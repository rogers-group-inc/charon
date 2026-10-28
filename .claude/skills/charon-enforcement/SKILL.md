---
name: charon-enforcement
description: "How Charon works end to end — the identity + posture → ZTNA tag → Fortinet pipeline: directory discovery from Active Directory / Entra ID / Intune into the DirectoryObject mirror, tag sources (directory group, OU, custom group, posture), the user↔device binding, the reconciler and effective tags, the enforcement-sync queue, Fortinet writeback to FortiGate / FortiManager (charon-<tag> address groups, charon-ep-* addresses, dry-run vs enforce, drift), integration testConnection and the 10-minute health check, the pg-boss queue registry, process roles (web / endpoint / enforcer / worker / migrate), boot path, leader election and HA, and the charon_* Prometheus metrics. Load when a task touches tags, reconcile, discovery, an integration type, enforcement, drift, a pg-boss queue or job, a process role, leader election / failover / GSLB, /health or /metrics, or asks why an endpoint has (or lacks) a tag or why a firewall did (or didn't) change."
---

# Charon enforcement pipeline

Charon decides *who* and *what* may reach network resources and enforces by pushing dynamic tags
to Fortinet. The pipeline, in one line: **discover** directory objects → **define** tags and
their sources → **bind** a user to a device at agent login → **reconcile** the endpoint's
effective tags → **enforce** the delta on Fortinet (dry-run unless an integration is set to
enforce). Fortinet writes are destructive: business rules 1 (ownership) and 2 (dry-run default)
govern every step that leaves the process.

## Which file

| You need… | Read |
|---|---|
| the five pipeline stages and what triggers a reconcile | [references/tag-pipeline.md](references/tag-pipeline.md) |
| how deltas become Fortinet objects; dry-run vs enforce; FMG vs direct FortiGate; drift | [references/fortinet-enforcement.md](references/fortinet-enforcement.md) |
| integration types, testConnection / discover, the health check | [references/integrations-discovery.md](references/integrations-discovery.md) |
| the boot path, process roles, pg-boss queues, leader election / HA | [references/jobs-roles-ha.md](references/jobs-roles-ha.md) |
| metrics and where they are exposed | [references/observability.md](references/observability.md) |

## Facts that bite

- **EndpointTag is materialized truth** — never mutate it directly; trigger a reconcile.
- **Reconcile enqueues enforcement only on change.** A login that changes nothing writes nothing.
- **FMG enforce stays dry-run** until the policy-package install flow is completed and reviewed;
  only direct-FortiGate enforce writes today.
- **`directory_group` matches `memberOf` directly**: a user's `attributes.memberOf` holds group
  DNs for AD and transitive group object ids for Entra, so the source's `ref` is a DN (AD) or a
  group id (Entra). A user the directory no longer returns is removed by the guarded discovery
  sweep, and with it the tags its membership granted.
- **Schedulers run only on the leader; consumers run on their role** — the same job can be
  produced on `web` and consumed on `worker` (rules 5, 6).
- **Scale-check at 100 and 2000 endpoints**: a fleet-wide reconcile (tag/source edit, directory
  sync, `POST /tags/reconcile`) touches every endpoint — batch DB writes, keep `select`s tight,
  and remember FMG-proxied calls are serialized (~1 concurrent) while direct FortiGate allows
  ~20.

Related: `charon-change-impact` (per-service entries and the canonical patterns —
reconcile → enqueue, enforcement writeback, leader-gated scheduler), `charon-domain-model`
(Tag / TagSource / EndpointTag / EnforcementState), `charon-business-rules` (rules 1, 2, 5, 6).
