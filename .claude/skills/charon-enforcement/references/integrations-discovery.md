# Integration discovery

Moved verbatim from ARCHITECTURE.md § 8.

`testConnection(config) → {ok,message,version?}` stereotype per type.
Directory sources (AD/Entra) also `discover() → DiscoveredDirectoryObject[]`,
upserted into DirectoryObject. A 10-minute health-check job re-tests every
enabled integration. FortiManager/FortiGate are enforcement targets (test only).

## Types

| Type | Role | Client |
|---|---|---|
| `fortimanager` | enforcement target (dry-run only today) | `src/services/fortimanagerService.ts` (JSON-RPC) |
| `fortigate` | enforcement target | `src/services/fortigateService.ts` (REST `/api/v2`) |
| `activedirectory` | directory source | `src/services/activeDirectoryService.ts` (+ `ldapClient.ts`) |
| `entraid` | directory source | `src/services/entraIdService.ts` (Graph) |
| `intune` | connection test today; posture source planned | `src/services/entraIdService.ts` |

The authoritative list is `src/services/integrationService.ts → INTEGRATION_TYPES`. Adding a
type: `INTEGRATION_TYPES` + the test / discover dispatch switches + `SECRET_FIELDS` + the
configure-modal field map in `public/js/integrations.js` (`charon-change-impact` →
patterns/backend-patterns.md → Integration type).

## Health check

`src/jobs/integrationHealthCheck.ts`: the leader schedules a job every 10 minutes
(`scheduleHealthChecks()`); the worker consumes it (`registerHealthCheckConsumer()`) and runs
`integrationService → runHealthChecks()`, stamping `lastTestAt` / `lastTestOk`.

After a directory discovery, `integrationService` triggers a fleet-wide `reconcileAll()`.
