<a id="rule-12"></a>
## Rule 12 — A push deploy runs as root only behind fullwrite, a pinned transport, a verified installer and a sealed single-use code

### What happened

Polaris's agent push-deploy stack (install / retry / upgrade / uninstall over SSH or WinRM with a
stored credential, plus the SSH-onboarding scripts and Intune publishing) was ported into
Charon (2026-10-28, branch `worktree-polaris-integrations-agent`). It is keyed to an
`AgentDeployment` target and installs Charon's Tauri packages (deb / rpm / AppImage / dmg / msi /
NSIS) instead of polaris's Go binary. An install has to deliver an enrollment credential to the
host, so it mints a single-use invitation code and writes it into a preseed file the agent
consumes.

### Why it happened

Every step runs as root / Administrator on a machine the operator does not sit at, with a
credential that reaches the whole fleet. Polaris learned each guard from an incident or scan
finding:
- rule 119 (F63 / F64 / F67): scripts uploaded to fixed names in world-writable temp
  directories could be pre-created and edited by a local user;
- rule 117: the config holding the enrollment secret was readable by every local user on
  Windows;
- rule 107 (F163): a server URL with a quote broke out of the generated PowerShell;
- rule 43a: deploy rights rode the generic asset key.

### The decision

- Every host action needs `endpoints` fullwrite. `endpoints write` already revokes bearers, and
  installing software fleet-wide is a larger blast radius. Upgrade-all chains
  `serverSettingsSystem` write as well.
- The transport is rule 11's: the SSH host key and the WinRM certificate are pinned before the
  credential is sent.
- The installer must have a SHA-256 in the manifest. `selectInstaller()` never picks one without,
  and the host verifies it before running anything: Unix through `STAGED_SCRIPT_PRELUDE`'s
  `verify_sha256`, Windows through `Get-FileHash`. Windows fetches the installer from this
  server with `Invoke-CharonPinnedDownload`, accepting only a leaf whose SHA-256 is one of the
  agent pins — never the system roots.
- Unix runs stage in a `mktemp -d` directory (mode 0700) removed afterwards; Windows over SSH
  stages in the SSH user's own temp folder, never `C:\Windows\Temp`.
- Each install mints its OWN code: `maxUses: 1`, 10-minute TTL, revoked on uninstall or delete.
  It lands in a preseed readable by root / SYSTEM + Administrators only: Linux
  `/etc/charon-agent` (0700 directory, 0600 file), macOS root:wheel, Windows an ACL set by SID
  before the file is written. Enrolling with it links the Endpoint and flips the deployment
  `active` (`markDeploymentEnrolled()`).
- Every value substituted into a script is allowlisted: the URL (`assertScriptSafeServerUrl`),
  pins, file name, digest and base64.
- Uninstall revokes the endpoint's bearer (rule 4).

Consequence, stated plainly: the preseed is only readable by a privileged process, so a
push-deployed agent enrolls on its own once the agent runs as a root / SYSTEM service. Until
then an operator enrolls it with an invitation code by hand. Rejected: a user-readable preseed —
any local user could take the code and enroll a rogue device in the deployment's name.

### Tests

`tests/unit/agentInstallScripts.test.ts` covers the allowlists, digest-before-install, preseed
permissions, pinned download and installer selection. `tests/integration/agentDeploy.test.ts`
covers the lifecycle with fake transports: single-use code, `enrolling → active` on enrollment,
failure capture, and uninstall revoking the bearer. `tests/unit/remoteStaging.test.ts`,
`tests/unit/agentServerUrl.test.ts`. The install and onboarding scripts run as root on customer
hosts — they need human and security review before production.
