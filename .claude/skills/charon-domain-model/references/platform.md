# Domain model — settings and the audit log

## Definitions and invariants

- **Setting** — a key → JSON value row; the server-wide configuration store. Keys in use are
  listed under Notes. A new key needs a row there.
- **Event** — the audit log. Every meaningful state change (enrollment, login, tag reconcile,
  enforcement apply, integration edit) records one via
  `src/services/eventService.ts → logEvent()`. Best-effort: a failed write never breaks the
  underlying operation. `levelRank` (0 info, 1 warning, 2 error) is the sortable form of
  `level`. Trimmed by `src/jobs/retentionPrune.ts` to `retention.eventDays` (default 90).

## Schema

```prisma
model Setting {
  key       String   @id
  value     Json     @default("{}")
  updatedAt DateTime @updatedAt

  @@map("settings")
}

model Event {
  id           String   @id @default(uuid())
  timestamp    DateTime @default(now())
  level        String   @default("info") // info, warning, error
  levelRank    Int      @default(0) // 0=info 1=warning 2=error
  action       String // e.g. "endpoint.enrolled", "tag.reconciled", "enforcement.applied"
  resourceType String?
  resourceId   String?
  resourceName String?
  actor        String?
  message      String   @db.Text
  details      Json?

  @@index([timestamp])
  @@index([action])
  @@index([resourceType])
  @@index([level])
  @@index([levelRank, timestamp])
  @@index([actor, timestamp])
  @@map("events")
}
```

## Notes

#### Setting keys in use

| Key | Shape / meaning | Written by | Read by |
|---|---|---|---|
| `agent.cert_pins` | `{ canonical, staged[] }` — leaf-cert SHA-256 pins handed to agents | `src/services/certPinService.ts` | enrollment, `GET /agents/config` |
| `cert.leaf` | the uploaded server leaf certificate | `src/api/routes/serverSettings.ts` (certificates) | `serverSettings.ts`, nginx render |
| `auth.mode` | the active AuthMode (operators and the agent login GUI) | `serverSettings.ts` (`PUT /auth-mode`) | `src/services/authService.ts → getActiveAuthMode()` |
| `identification.name` | the server's display name | TODO: populate when a writer exists | `serverSettings.ts` (`GET /identification`) |
| `posture.policy` | the operator-configured posture policy | `src/services/postureService.ts → setPosturePolicy()` | `postureService.ts → evaluatePosture()` |
| `retention.eventDays` | audit-log retention window in days (default 90) | TODO: populate when a writer exists | `src/jobs/retentionPrune.ts` |

#### Event action names

Dotted `<resource>.<verb>` (`auth.login`, `agent.login`, `cert.pin.staged`, `auth.mode.changed`,
…). Grep `logEvent(` for the current set rather than trusting a list here.
