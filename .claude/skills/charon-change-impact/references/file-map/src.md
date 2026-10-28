# File map — src/ and the top-level directories

The file-by-file map (from ARCHITECTURE.md § 2, corrected: `crypto.ts` and `password.ts` live in
`utils/`, not `services/`; `setup/`, `cli/` and `types/` added). Per-file behaviour is in the
per-service entries under `references/services/`.

```
src/
├── index.ts                  # entry: resolve role + setup state; migrate one-shot; wizard or startApp()
├── app.ts                    # Express app; roleConfig() branches; leader election; consumers; agent WS attach; /health, /metrics
├── db.ts                     # Prisma client singleton (@prisma/adapter-pg)
├── jobs.ts                   # pg-boss bootstrap + QUEUES + publish()
├── metrics.ts                # prom-client registry + typed helpers
├── api/
│   ├── router.ts             # aggregate /api/v1; public mounts before requireAuth; per-mount requirePermission
│   ├── middleware/
│   │   ├── auth.ts           # session + API bearer + agent bearer (requireAuth, attachApiToken → 403 untrusted host)
│   │   ├── csrf.ts           # synchronizer token; agent paths, exactly /ha/enroll, session-less bearers exempt
│   │   ├── permissions.ts    # dynamic-role matrix: FUNCTION_KEYS, requirePermission, session / API-token role snapshot
│   │   ├── rateLimits.ts     # login, enroll, agent-login, admin-action limiters + makeRateLimiter
│   │   └── errorHandler.ts   # AppError → JSON
│   └── routes/
│       ├── auth.ts           # login, login/totp (Local Login Access IP gate), logout, me
│       ├── agent.ts          # GET /agent/auth-config (public)
│       ├── agents.ts         # agentsEnrollRouter (POST /agents/enroll) + agentsRouter (heartbeat, posture, config [records delivered pins], login, logout)
│       ├── agentsWs.ts       # telemetry WebSocket (/agents/ws)
│       ├── endpoints.ts      # endpoints + /invitations + revoke
│       ├── integrations.ts   # CRUD, test, discover, enforcement toggle + state
│       ├── directory.ts      # read-only DirectoryObject listing
│       ├── groups.ts         # custom groups + members
│       ├── tags.ts           # tags + sources + reconcile
│       ├── policies.ts       # Charon-managed policies
│       ├── serverSettings.ts # ha (summary), auth-mode, identification
│       ├── maintenance.ts    # agent installers only (/server-settings/maintenance/agents)
│       ├── agentDeploy.ts    # /agent-deployments: list (endpoints read); deploy / retry / upgrade / uninstall / delete (endpoints FULLWRITE)
│       ├── agentBinary.ts    # PUBLIC GET /agents/binary/:file — manifest installers only, rate-limited (Windows pinned download)
│       ├── events.ts         # audit log
│       └── settings/         # Server Settings tabs ported from polaris; each route declares its own requirePermission
│           ├── ntp.ts            # /server-settings/ntp (+test)
│           ├── identification.ts # tags (asset), dns, oui; deviceIconsRouter (/device-icons), assetTypesRouter (/asset-types)
│           ├── webServer.ts      # trusted CAs, https, proxy (+apply), cert preflight/rotate, agent cert-pins, ipv6, login-access
│           ├── maintenance.ts    # database/backups/restore/schedule, capacity-advisor, pg-tuning, platform-lifecycle, updates, restart, retention, agent-event-log
│           ├── customization.ts  # branding (+logo), reboot
│           ├── credentials.ts    # credentialsRouter (/credentials); mibs, manufacturer-aliases, manufacturer-profiles
│           ├── apiTokens.ts      # api-docs; apiTokensRouter (/api-tokens)
│           ├── ha.ts             # haRouter (/ha); haEnrollRouter (/ha/enroll, PUBLIC)
│           ├── firmware.ts       # /server-settings/firmware/* (Repository)
│           └── agents.ts         # /server-settings/agents/*: SSH Deployment (windows-ssh), Intune publish, pinned SSH keys / TLS certs, server URL, installed, upgrade-all
├── services/                 # see references/services/*.md — one entry per file
│   ├── crypto/identity:      apiTokenService, agentTokenService, authService, verificationService, eventService
│   ├── integrations:         httpClient, integrationConfig, integrationService, integrationHealthService,
│   │                         fortimanagerService, fmgWorker, fmgActivityService, fortigateService,
│   │                         activeDirectoryService, ldapClient, entraIdService, directoryTypes,
│   │                         discoveryRunState (DiscoveryRun live state)
│   ├── discovery/            directoryDiscovery (trigger / runDiscovery / mirror write / guarded sweep)
│   ├── outbound trust:       sshHostKeyService (SshHostKey TOFU), tlsCertPinService (TlsCertPin TOFU)
│   ├── tags/enforcement:     customGroupService, tagService, tagReconciler, policyService, fortinetEnforcementService
│   ├── agent/posture:        invitationCodeService, agentEnrollmentService, postureService, certPinService
│   ├── agent deploy:         agentDeployService (push install / upgrade / uninstall lifecycle), agentInstallScripts
│   │                         (the scripts + preseed, pure), windowsSshOnboardingService + sshOnboardingScript
│   │                         (SSH Deployment card: deployment keypair, onboarding scripts), intunePublishService
│   │                         (publish the onboarding pair to Intune, unassigned), settingsStore (typed Setting row),
│   │                         agentChannelService (agent WS sessions, refresh-config / revoke over NOTIFY)
│   ├── infra:                leaderElection, certInfo, nginxRenderer, nginxApplyService, backupService, capacityService,
│   │                         updateService, agentDistService
│   ├── settings (web):       webServerService, proxyConfigService, trustedCaService, webAccessSettingsService
│   ├── settings (system):    ntpService, brandingService, rebootSettingsService, apiDocsAccessService
│   ├── settings (ident):     assetTagService, assetTypeService, deviceIconService, dnsService, ouiService
│   ├── settings (maint):     backupScheduleService, capacityAdvisorService, pgTuningService, dbSizeService,
│   │                         platformLifecycleService, sampleRetentionService, agentEventLogService
│   ├── settings (ha/fw):     haService, haEnrollmentService, firmwareRepositoryService
│   └── credentials/          credentialService, credentialProbeService, mibService, oidRegistry, stdMibLibrary (+ stdMibs/*.txt),
│                             manufacturerAliasService, manufacturerProfileService, manufacturerProfilePortabilityService,
│                             regexSafety + pure helpers (see services/server-settings.md)
├── jobs/
│   ├── integrationHealthCheck.ts  # leader schedules every 10 min; worker consumes
│   ├── directoryDiscoveryJob.ts   # leader: 15-min due-check scheduler + 60-s stale-run reaper; worker: charon.directory-sync consumer
│   ├── tagReconcileJob.ts         # enqueueReconcile(); worker consumer
│   ├── enforcementSyncJob.ts      # enforcer consumer for tag-change deltas
│   ├── retentionPrune.ts          # leader-scheduled (6 h) audit-log + VerificationSession pruning to Setting sampleRetention
│   ├── ouiRefresh.ts              # leader-scheduled weekly IEEE OUI database refresh (fetches on first run if missing/stale)
│   ├── scheduledBackup.ts         # leader-scheduled automatic backups (5-min tick, default off), prune + off-host copy
│   └── endpointSilenceJob.ts      # leader 60-s tick: online endpoints silent for 2 heartbeat intervals → offline (fleet-dark guard)
├── utils/
│   ├── role.ts               # CHARON_ROLE → roleConfig() flags
│   ├── logger.ts             # Pino logger
│   ├── errors.ts             # AppError (httpStatus)
│   ├── crypto.ts             # AES-256-GCM envelopes, SHA-384/512, tokens, constant-time compare, mask sentinel
│   ├── password.ts           # argon2id hash/verify
│   ├── version.ts            # major.minor + git commit count (CHARON_BUILD_COMMIT_COUNT)
│   ├── paths.ts              # STATE_DIR, ENV_FILE, SETUP_COMPLETE_MARKER, BACKUP_DIR, UPLOADS_DIR, AGENT_DIST_DIR, FIRMWARE_DIR(+_INCOMING_DIR)
│   ├── metricsServer.ts      # metrics-only listener for enforcer/worker
│   ├── envFile.ts            # set/replace one key in the runtime .env (token generate, advisor stage)
│   ├── deploymentContext.ts  # runtimeIsContainer(), hasSystemd(), DB connection mode — cached heuristics
│   ├── pgClientTools.ts      # pick pg_dump/psql by server MAJOR, never by bare name
│   ├── pgEnv.ts              # DATABASE_URL → libpq PG* env (password never on argv)
│   ├── privateFiles.ts       # owner-only modes for backups / restore temp files
│   ├── backupPassword.ts     # strength floor for backup passphrases
│   ├── imageRegistry.ts      # read a published image's build facts from its OCI registry (Docker update check)
│   ├── ipAllowlist.ts        # IP / CIDR validation + matching (API token trusted hosts, API-docs scope)
│   ├── ipScope.ts            # source-IP scope matching (Local Login Access)
│   ├── haAdvisories.ts       # HA guidance arithmetic (RTT bands, WAL rate, RPO/RTO, install shape)
│   ├── firmwareVersion.ts    # firmware version + image identity parsing (pure)
│   ├── assetTypeMatch.ts     # device-type inference rules (pure; AssetTypeDef.matchRules)
│   ├── deviceFilterCondition.ts # asset-tag auto-assign filter vocabulary + zod schema + guards
│   │   ── ported from polaris: outbound trust + integration plumbing ──
│   ├── tlsDispatcher.ts      # tlsFetch(): per-request undici dispatcher; verify off ⇒ TlsCertPin TOFU dispatcher
│   ├── pinnedTlsAgent.ts     # node:https Agent that checks the leaf against TlsCertPin after handshake, before the request
│   ├── remoteExec.ts         # withSshClient / sshExec / sftpPut / buildHostVerifier (SshHostKey TOFU, fails closed)
│   ├── remoteStaging.ts      # per-run mktemp -d staging dir on a remote host
│   ├── winrm.ts              # WinRS client (pinned TLS when unverified)
│   ├── sshKeygen.ts          # ed25519 keypair generation with retry
│   ├── netGuard.ts           # SSRF guard for operator-supplied outbound hosts (moved from services/credentials/)
│   ├── guardedFetch.ts       # fetch whose DNS lookup goes through netGuard
│   ├── secretMask.ts         # the mask sentinel + isMaskedSecret (moved from services/credentials/)
│   ├── secretDestination.ts  # a stored secret follows its destination (restoreStoredSecrets)
│   ├── configSecretFields.ts # which config keys are secrets, anywhere in a JSON tree
│   ├── integrationFilter.ts  # include/exclude wildcard filtering for discovery
│   ├── wildcard.ts           # compileWildcard / compilePattern (regex mode on RE2)
│   ├── safeRegex.ts          # operator regexes on re2js (moved from services/credentials/)
│   ├── fortiosRequestGate.ts # per-FortiGate request pacing + 401 pause (FortiOS API-key lockout)
│   ├── fortiosEnvelope.ts    # FortiOS response envelope parsing (system status, HA peers)
│   ├── entraClientCredentials.ts # the client-credentials token request shape (Graph)
│   ├── graphThrottle.ts      # throttleDelayMs(): Retry-After / quota-reset → backoff ms (polaris azureArcService)
│   ├── mac.ts                # MAC normalization (polaris)
│   ├── agentServerUrl.ts     # the script-safe agent server URL allowlist (polaris)
│   ├── agentSilence.ts       # silence window + cutoff with the listening-since / fleet-dark guards (polaris)
│   ├── cidr.ts               # urlHost / bareHost / isIpv6Address (moved from services/credentials/)
│   ├── trimTrailing.ts       # regex-free trailing trim (moved from services/credentials/)
│   ├── text.ts               # truncate()
│   └── sleep.ts              # promise sleep
├── setup/
│   ├── detectSetup.ts        # getSetupState(), markSetupComplete()
│   ├── setupServer.ts        # first-run wizard server
│   └── setupRoutes.ts        # wizard API (unauthenticated, first-run only)
├── cli/
│   └── seed.ts               # seedDatabase(): built-in roles + optional first admin (dev + container)
├── types/
│   └── express-session.d.ts  # session field typings
└── generated/                # Prisma client (gitignored, regenerated by postinstall)

prisma/      schema.prisma, migrations/, seed.ts (dev entry → src/cli/seed.ts)
public/      vanilla JS + HTML, no build step (see charon-ui-canon)
agent/       Tauri endpoint agent: src-tauri/ (Rust core), ui/ (web GUI) (see charon-agent)
deploy/      install-rhel.sh, setup-ha.sh, HA.md, systemd/, nginx/, scripts/ (see charon-deploy)
scripts/     check-docs.mjs, check-versions.mjs, next-rule-number.mjs, copy-build-assets.mjs
tests/       setup.ts (dotenv), unit/, integration/ (DB-backed; _helpers.ts skips unless DATABASE_URL names a *_test DB), helpers/ (tlsFixtures.ts: throwaway self-signed TLS certs minted in memory — no key is ever committed)
```
