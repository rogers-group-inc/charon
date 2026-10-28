---
name: charon-change-impact
description: "'If I change X, what else touches it?' — the Charon touches index: per-service writers/readers/invariants/change checklists for every service in src/services, the cross-cutting concerns (charon-* ownership at the Fortinet boundary, leader-only singletons, roleConfig() flags, crypto at rest and in transport), the canonical backend patterns to copy (permission-gated route, integration testConnection stereotype, masked secrets, metrics helper, HTTP retry, tag source, reconcile → enqueue, enforcement writeback, leader-gated scheduler, crypto-agile secret, nginx render → apply), and the file-by-file source map. Load BEFORE editing anything in src/services, src/jobs, src/utils or a route; before adding a service, job, integration type, metric or scheduler; when asked where something lives, what depends on X, or who writes/reads a model; and when a change to one service might break another."
---

# Charon change impact (the touches index)

## How to use

1. **Before changing a service or a shared invariant**, find its section here (tables below).
2. Walk the **Used by** / **Writers** / **Readers** lists to see what depends on the thing you're touching.
3. Run through the **When changing this** checklist before you commit.
4. **Keep this index current.** If your change moved writers/readers, broke an invariant, or
   invalidated a checklist item, fix the entry in the same commit (`/charon-docs-sync`).
   `npm run check:docs` fails on a service with no `## services/<name>.ts` entry.

## Format

**Per-service** sections: **What it owns** / **Public API** / **Cross-service deps** /
**Used by** (`file → symbol — purpose`) / **Invariants** / **When changing this**.
**Cross-cutting** sections swap **Used by** for **Writers** / **Readers**.
**Pattern** sections name the canonical file and the conventions to match — copy the
canonical's shape rather than inventing a parallel one.

> Code references are `path/file.ts → symbolName()` — never line numbers, they drift.
> Grep the symbol name to locate it. A field reading `TODO: populate when <X>` is a known gap,
> not an all-clear.

## Cross-cutting concerns (one file each, under references/cross-cutting/)

| Concern | Read when |
|---|---|
| [fortinet-ownership](references/cross-cutting/fortinet-ownership.md) | naming or writing any Fortinet object; anything in the enforcement path (rules 1, 2) |
| [leader-and-roles](references/cross-cutting/leader-and-roles.md) | adding a scheduler, a pg-boss consumer, a listener; gating code on the process role (rules 5, 6) |
| [crypto-secrets](references/cross-cutting/crypto-secrets.md) | a secret field, a token, a hash, `CHARON_DATA_KEY`, TLS / PQC transport (rule 3) |
| [schema-change](references/cross-cutting/schema-change.md) | editing `prisma/schema.prisma` or writing a migration |

## Per-service entries (grouped, under references/services/)

| Group file | Services |
|---|---|
| [tags-enforcement](references/services/tags-enforcement.md) | tagService, tagReconciler, customGroupService, policyService, postureService, fortinetEnforcementService |
| [integrations](references/services/integrations.md) | integrationService, integrationConfig, discovery/directoryDiscovery, discoveryRunState, integrationHealthService, httpClient, fortimanagerService, fmgWorker, fmgActivityService, fortigateService, activeDirectoryService, ldapClient, entraIdService, directoryTypes, sshHostKeyService, tlsCertPinService |
| [agent-trust](references/services/agent-trust.md) | agentEnrollmentService, agentTokenService, invitationCodeService, certPinService, certInfo, agentDistService |
| [identity-audit](references/services/identity-audit.md) | authService, apiTokenService, verificationService, eventService |
| [platform-ops](references/services/platform-ops.md) | leaderElection, nginxRenderer, nginxApplyService, backupService, updateService, capacityService |
| [server-settings](references/services/server-settings.md) | the Server Settings tab backends: webServerService, proxyConfigService, trustedCaService, webAccessSettingsService, ntpService, brandingService, rebootSettingsService, assetTagService, assetTypeService, deviceIconService, dnsService, ouiService, backupScheduleService, capacityAdvisorService, pgTuningService, dbSizeService, platformLifecycleService, sampleRetentionService, agentEventLogService, apiDocsAccessService, haService, haEnrollmentService, firmwareRepositoryService, and the `services/credentials/` folder |

The RBAC middleware (`src/api/middleware/permissions.ts`) is not a service; its touches entry
lives in `charon-api-rbac` → auth-rbac.md.

## Canonical backend patterns (under references/patterns/)

- [backend-patterns](references/patterns/backend-patterns.md) — permission-gated route,
  integration type, setting-backed config with masked secrets, Prometheus instrumentation,
  queue-on-failure / retry, managed-tag namespace, tag source + effective tags, reconcile →
  enqueue, enforcement writeback, leader-gated scheduler, crypto-agile at-rest secret, nginx
  render → stage → apply. Agent enrollment and dual-pin rotation are in `charon-agent`; UI
  patterns are in `charon-ui-canon`.

## File map (under references/file-map/)

- [src](references/file-map/src.md) — every file under `src/`, plus `prisma/`, `public/`,
  `agent/`, `deploy/`, `scripts/`, `tests/` at directory level.

Related: `charon-domain-model` (the entities these services write), `charon-business-rules`
(the invariants by number), `charon-enforcement` (the pipeline end to end).
