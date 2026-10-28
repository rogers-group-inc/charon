# Domain model — settings and the audit log

## Definitions and invariants

- **Setting** — a key → JSON value row; the server-wide configuration store. Keys in use are
  listed under Notes. A new key needs a row there.
- **Event** — the audit log. Every meaningful state change (enrollment, login, tag reconcile,
  enforcement apply, integration edit) records one via
  `src/services/eventService.ts → logEvent()`. Best-effort: a failed write never breaks the
  underlying operation. `levelRank` (0 info, 1 warning, 2 error) is the sortable form of
  `level`. Trimmed by `src/jobs/retentionPrune.ts` to the `sampleRetention` Setting's `events` window
  (default 90 days; never 0).

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
| `cert.leaf` | `{ pem, certPath, keyPath }` — the served leaf certificate (the key stays on disk, 0600) | `src/services/webServerService.ts → rotateCertAndKey()` | `webServerService.ts` (HTTPS facts, rotate) |
| `auth.mode` | `{ mode }` — the endpoint agent's sign-in mode (local / saml / oidc) | `src/services/authService.ts → setAgentAuthMode()` (`PUT /auth/agent-mode`) | `authService.ts → getActiveAuthMode()` (`GET /agent/auth-config`, `/agents/login`) |
| `passwordPolicyConfig` | `{ minLength (8–128), requireLowercase/Uppercase/Number/Special, forceChangeOnLogin }` | `src/services/passwordPolicyService.ts` | every password write, the login re-check |
| `sessionConfig` | `{ autoLogoutMinutes (0–1440, 0 = off), skipLoginPage }` | `src/services/sessionSettingsService.ts` | `src/app.ts` idle timeout, `/auth/me`, the login-page redirect |
| `identification.name` | the server's display name | TODO: populate when a writer exists | `serverSettings.ts` (`GET /identification`) |
| `posture.policy` | the operator-configured posture policy | `src/services/postureService.ts → setPosturePolicy()` | `postureService.ts → evaluatePosture()` |
| `retention.eventDays` | LEGACY audit-log window; only seeds `sampleRetention.events` when that row is absent | none | `src/services/sampleRetentionService.ts` |
| `sampleRetention` | `{ events, verificationSessions }` day windows (-1 = forever; events never 0) | `src/services/sampleRetentionService.ts` (Retention tab) | `src/jobs/retentionPrune.ts`, `src/services/capacityService.ts` |
| `agentEventLog` | agent OS event-log switch + filter (persist-only; no agent consumer yet) | `src/services/agentEventLogService.ts` | Retention tab |
| `backupSchedule` | scheduled-backup cadence, retain count, optional passphrase (envelope), off-host dir | `src/services/backupScheduleService.ts` | `src/jobs/scheduledBackup.ts` |
| `backup_history` | backup records, newest last, capped at 50 | `src/services/backupService.ts` | Maintenance tab |
| `update.train` / `update.skip_backup` | updater channel / skip the pre-update backup | `src/services/updateService.ts` | `updateService.ts` |
| `ntp` | `{ enabled, mode, servers[], timezoneOverride }` (timezone is display-only) | `src/services/ntpService.ts` | Time & NTP tab, chrony apply |
| `branding` | app name / subtitle / logo URL + placement flags | `src/services/brandingService.ts` | `public/js/app.js` sidebar (`GET /server-settings/branding`) |
| `rebootConfig` | reboot-reason requirement (persist-only; no consumer yet) | `src/services/rebootSettingsService.ts` | Customization tab |
| `proxyConfig` | nginx controls (TLS 1.3 only, HSTS, HTTP/3, metrics allow-list, managed mode) | `src/services/proxyConfigService.ts` | `src/services/nginxRenderer.ts`, `src/services/webServerService.ts` |
| `trustedCertificates` | operator-uploaded trusted CA records (CA certs only, private keys refused) | `src/services/trustedCaService.ts` | `src/services/httpClient.ts` (outbound TLS verify) |
| `loginAccessConfig` | `{ enabled, ipScope, allowedCidrs }` for the local credential paths (password, TOTP, forced change) | `src/services/webAccessSettingsService.ts` | `src/api/routes/auth.ts` |
| `ipv6Config` | IPv6 switch (persist-only) | `src/services/webAccessSettingsService.ts` | Web Server tab |
| `apiDocsConfig` | API-docs page source-IP scope (loopback / rfc1918 / custom; never public) | `src/services/apiDocsAccessService.ts` | API Tokens tab (no docs page is served yet) |
| `ha.config` | HA nodes, load-balancer figures, replication password (envelope; never in a response) | `src/services/haService.ts` | `haService.ts`, `src/services/haEnrollmentService.ts` |
| `dnsSettings` | resolver mode (standard / DoT / DoH) + servers | `src/services/dnsService.ts` | Identification tab |
| `oui_database` / `oui_overrides` | IEEE OUI prefix → vendor map / operator overrides | `src/services/ouiService.ts` (+ `src/jobs/ouiRefresh.ts`) | `ouiService.ts` lookups |
| `tagSettings` | asset-tag registry options | `src/services/assetTagService.ts` | Identification tab |

#### Event action names

Dotted `<resource>.<verb>` (`auth.login`, `agent.login`, `cert.pin.staged`, `auth.mode.changed`,
…). Grep `logEvent(` for the current set rather than trusting a list here.
