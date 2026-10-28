/**
 * src/services/agentInstallScripts.ts — what a push deployment runs on a host.
 *
 * Ported from polaris's agentInstallService script bodies and rewritten for
 * Charon's Tauri installers (polaris installs a bare Go binary + a service
 * unit; Charon installs the platform package `tauri build` produces):
 *
 *   Linux   .deb (dpkg) / .rpm (dnf or rpm) / .AppImage (copied to /opt)
 *   macOS   .dmg (mounted, the .app copied to /Applications)
 *   Windows .msi (msiexec /qn) / NSIS -setup.exe (/S)
 *
 * Every script also drops the ENROLLMENT PRESEED (when given): a small JSON
 * file holding the server URL, the server's certificate pins and a
 * single-use, short-lived invitation code, readable by root / SYSTEM and
 * Administrators only (business rule 12, and polaris rule 117's ACL
 * treatment). An upgrade passes no preseed — the agent keeps its bearer.
 *
 * Unix scripts run from this run's private staging directory (polaris rule
 * 119, utils/remoteStaging.ts): $1 is the directory, $2 the installer's
 * SHA-256, checked before anything is installed. Windows downloads the
 * installer from this server over HTTPS, accepting ONLY a certificate whose
 * leaf SHA-256 is one of the agent pins (never the system roots), then checks
 * its SHA-256 against the manifest before running it.
 *
 * Every value substituted into a script is allowlisted here (URL, pins, file
 * name, digest, base64) — a script is never built from an unchecked string.
 * Pure: no I/O.
 */

import { AppError } from "../utils/errors.js";
import { STAGED_SCRIPT_PRELUDE } from "../utils/remoteStaging.js";
import { assertScriptSafeServerUrl } from "../utils/agentServerUrl.js";

export type AgentOsPlatform = "windows" | "linux" | "darwin";
export type AgentTransport = "ssh" | "winrm";
export type InstallerKind = "msi" | "nsis" | "deb" | "rpm" | "appimage" | "dmg";

export const AGENT_OS_PLATFORMS: readonly AgentOsPlatform[] = ["windows", "linux", "darwin"];

/** The package / product names `tauri build` derives from agent/src-tauri/tauri.conf.json. */
export const AGENT_PACKAGE_NAME = "charon-agent";
export const AGENT_PRODUCT_NAME = "Charon Agent";

/** Where the enrollment preseed lands, per OS (root / SYSTEM + Administrators only). */
export const PRESEED_PATHS: Record<AgentOsPlatform, string> = {
  linux: "/etc/charon-agent/enroll.json",
  darwin: "/Library/Application Support/Charon/enroll.json",
  windows: "%ProgramData%\\Charon\\agent\\enroll.json",
};

/** The installer kind of a manifest file name, from its extension. */
export function installerKindOf(filename: string): InstallerKind | null {
  const f = filename.toLowerCase();
  if (f.endsWith(".msi")) return "msi";
  if (f.endsWith(".exe")) return "nsis";
  if (f.endsWith(".deb")) return "deb";
  if (f.endsWith(".rpm")) return "rpm";
  if (f.endsWith(".appimage")) return "appimage";
  if (f.endsWith(".dmg")) return "dmg";
  return null;
}

/** The OS an installer kind installs on. */
export function platformOfKind(kind: InstallerKind): AgentOsPlatform {
  if (kind === "msi" || kind === "nsis") return "windows";
  if (kind === "dmg") return "darwin";
  return "linux";
}

/** Normalize an `uname -m` / PROCESSOR_ARCHITECTURE answer to the manifest's arch names. */
export function normalizeArch(raw: string | null | undefined): string | null {
  const a = String(raw ?? "").trim().toLowerCase();
  if (!a) return null;
  if (a === "x86_64" || a === "amd64" || a === "x64") return "x64";
  if (a === "aarch64" || a === "arm64") return "arm64";
  if (a === "i386" || a === "i686" || a === "x86") return "x86";
  return a.replace(/[^a-z0-9_]/g, "") || null;
}

export interface ManifestFile {
  platform: string;
  arch: string;
  filename: string;
  sha256?: string;
}

/**
 * Pick the installer for a host. Linux prefers the host's package manager
 * (deb for dpkg hosts, rpm for rpm hosts), falling back to the AppImage;
 * Windows prefers the MSI over the NSIS installer. Push deploy REQUIRES a
 * SHA-256 in the manifest — an installer without one is never selected.
 */
export function selectInstaller(
  files: readonly ManifestFile[],
  host: { os: AgentOsPlatform; arch: string | null; packageManagers?: { dpkg?: boolean; rpm?: boolean } },
): ManifestFile | null {
  const archOk = (f: ManifestFile) => !host.arch || normalizeArch(f.arch) === host.arch;
  const usable = files.filter((f) => {
    const kind = installerKindOf(f.filename);
    return kind !== null && platformOfKind(kind) === host.os && archOk(f) && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/i.test(f.sha256);
  });
  const byKind = (k: InstallerKind) => usable.find((f) => installerKindOf(f.filename) === k) ?? null;
  if (host.os === "windows") return byKind("msi") ?? byKind("nsis");
  if (host.os === "darwin") return byKind("dmg");
  const pm = host.packageManagers ?? {};
  if (pm.dpkg && byKind("deb")) return byKind("deb");
  if (pm.rpm && byKind("rpm")) return byKind("rpm");
  return byKind("appimage");
}

// ─── Allowlists for script substitutions ────────────────────────────────────

const PIN_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Tauri names carry spaces ("Charon Agent_0.1.1_x64-setup.exe"); never quotes or shell metacharacters. */
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,200}$/;
const B64_RE = /^[A-Za-z0-9+/=]*$/;

export function assertPins(pins: readonly string[]): string[] {
  const out = pins.map((p) => String(p).trim().toLowerCase());
  if (out.length === 0) throw new AppError(409, "No agent certificate pin is set — set one under Server Settings → Web Server before deploying agents");
  for (const p of out) if (!PIN_RE.test(p)) throw new AppError(500, "Invalid agent certificate pin");
  return out;
}

export function assertInstallerFilename(name: string): string {
  if (!FILENAME_RE.test(name)) throw new AppError(500, `Installer file name "${name}" contains characters not allowed in a generated script`);
  return name;
}

export function assertSha256(digest: string): string {
  const d = String(digest).toLowerCase();
  if (!SHA256_RE.test(d)) throw new AppError(500, "Invalid installer SHA-256");
  return d;
}

// ─── Enrollment preseed ─────────────────────────────────────────────────────

export interface EnrollmentPreseed {
  serverUrl: string;
  /** Server leaf-certificate SHA-256 pins (canonical first, then staged). */
  pins: string[];
  /** The single-use invitation code this run minted. */
  code: string;
}

/**
 * The preseed file body. The agent reads it once at startup (when it runs
 * with the privilege to), enrolls with `code` pinning `pins` from the first
 * request, and deletes it.
 */
export function renderEnrollmentPreseed(p: EnrollmentPreseed): string {
  return JSON.stringify({
    version: 1,
    serverUrl: assertScriptSafeServerUrl(p.serverUrl),
    pins: assertPins(p.pins),
    code: p.code,
  }, null, 2) + "\n";
}

// ─── Linux / macOS (staged, run as root via sudo -n) ────────────────────────

/** Staged file name of the installer for a kind (dnf needs the .rpm extension). */
export function stagedInstallerName(kind: InstallerKind): string {
  return `agent-installer.${kind === "nsis" ? "exe" : kind}`;
}

/**
 * The Linux / macOS install-or-upgrade script. Files staged next to it:
 * the installer (`stagedInstallerName(kind)`) and, for an install,
 * `enroll.json`. An upgrade stages no preseed and keeps the existing one.
 */
export function unixInstallScript(os: "linux" | "darwin", kind: InstallerKind): string {
  if (platformOfKind(kind) !== os) throw new AppError(500, `A ${kind} installer cannot install on ${os}`);
  const inst = stagedInstallerName(kind);
  const preseedDir = os === "linux" ? "/etc/charon-agent" : "/Library/Application Support/Charon";
  const group = os === "linux" ? "root" : "wheel";
  let installStep: string;
  switch (kind) {
    case "deb":
      installStep = `DEBIAN_FRONTEND=noninteractive dpkg -i "\${INST}" || { DEBIAN_FRONTEND=noninteractive apt-get -f install -y && DEBIAN_FRONTEND=noninteractive dpkg -i "\${INST}"; }`;
      break;
    case "rpm":
      installStep = `if command -v dnf >/dev/null 2>&1; then dnf install -y "\${INST}"; else rpm -U --replacepkgs "\${INST}"; fi`;
      break;
    case "appimage":
      installStep = `install -d -m 0755 /opt/${AGENT_PACKAGE_NAME}\ninstall -m 0755 "\${INST}" /opt/${AGENT_PACKAGE_NAME}/${AGENT_PACKAGE_NAME}.AppImage`;
      break;
    case "dmg":
      installStep = [
        `MNT="\${STAGE_DIR}/mnt"`,
        `mkdir -m 0700 "\${MNT}"`,
        `hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "\${MNT}" "\${INST}" >/dev/null`,
        `trap 'hdiutil detach "\${MNT}" -quiet >/dev/null 2>&1 || true' EXIT`,
        `[ -d "\${MNT}/${AGENT_PRODUCT_NAME}.app" ] || { echo "${AGENT_PRODUCT_NAME}.app not found in the disk image" >&2; exit 1; }`,
        `rm -rf "/Applications/${AGENT_PRODUCT_NAME}.app"`,
        `ditto "\${MNT}/${AGENT_PRODUCT_NAME}.app" "/Applications/${AGENT_PRODUCT_NAME}.app"`,
      ].join("\n");
      break;
    default:
      throw new AppError(500, `No ${os} install step for ${kind}`);
  }
  return `#!/usr/bin/env bash
set -euo pipefail
${STAGED_SCRIPT_PRELUDE}
SHA="\${2:?usage: script <staging-dir> <sha256>}"
INST="\${STAGE_DIR}/${inst}"
verify_sha256 "\${INST}" "\${SHA}"

# Enrollment preseed (business rule 12): a root-only directory, the file 0600.
# Written BEFORE the package so the agent's first privileged start can enroll.
if [ -f "\${STAGE_DIR}/enroll.json" ]; then
  if [ -L "${preseedDir}" ]; then echo "${preseedDir} is a link — refusing" >&2; exit 1; fi
  install -d -m 0700 -o root -g ${group} "${preseedDir}"
  install -m 0600 -o root -g ${group} "\${STAGE_DIR}/enroll.json" "${preseedDir}/enroll.json"
fi

${installStep}

echo "${AGENT_PRODUCT_NAME} installed"
`;
}

/** The Linux / macOS uninstall script (no staged files besides itself). */
export function unixUninstallScript(os: "linux" | "darwin"): string {
  const body = os === "linux"
    ? `if command -v dpkg >/dev/null 2>&1 && dpkg -s ${AGENT_PACKAGE_NAME} >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive dpkg -r ${AGENT_PACKAGE_NAME}
fi
if command -v rpm >/dev/null 2>&1 && rpm -q ${AGENT_PACKAGE_NAME} >/dev/null 2>&1; then
  rpm -e ${AGENT_PACKAGE_NAME}
fi
rm -rf /opt/${AGENT_PACKAGE_NAME} /etc/charon-agent`
    : `rm -rf "/Applications/${AGENT_PRODUCT_NAME}.app" "/Library/Application Support/Charon"`;
  return `#!/usr/bin/env bash
set -euo pipefail
${STAGED_SCRIPT_PRELUDE}
${body}
echo "${AGENT_PRODUCT_NAME} removed"
`;
}

/** The read-only probe run before an install: OS, machine arch, package managers. */
export const UNIX_PROBE_COMMAND =
  "uname -s; uname -m; command -v dpkg >/dev/null 2>&1 && echo has-dpkg; command -v rpm >/dev/null 2>&1 && echo has-rpm; true";

export interface UnixProbe {
  os: "linux" | "darwin" | null;
  arch: string | null;
  dpkg: boolean;
  rpm: boolean;
}

export function parseUnixProbe(stdout: string): UnixProbe {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const kernel = (lines[0] ?? "").toLowerCase();
  return {
    os: kernel === "linux" ? "linux" : kernel === "darwin" ? "darwin" : null,
    arch: normalizeArch(lines[1]),
    dpkg: lines.includes("has-dpkg"),
    rpm: lines.includes("has-rpm"),
  };
}

// ─── Windows (PowerShell, over WinRM -EncodedCommand or SSH -File) ──────────

/** The probe for a Windows host: machine architecture. */
export const WINDOWS_PROBE_PS = "$a = $env:PROCESSOR_ARCHITEW6432; if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }; Write-Output $a";

// Cert-pinned HTTPS download via a raw SslStream + HTTP/1.1, ported from
// polaris's Invoke-PolarisPinnedDownload (Invoke-WebRequest under Windows
// PowerShell 5.1 couples pin validation to a process-global callback and
// misbehaves when launched non-interactively over OpenSSH). Charon: the pin is
// the bare lowercase-hex SHA-256 of the leaf DER, and ANY of the agent pins
// (canonical or staged) is accepted, so a deploy during a rotation works.
const PS_PINNED_DOWNLOAD_FN = `
function Invoke-CharonPinnedDownload {
  param([string]$Url, [string]$OutFile, [string[]]$ExpectedPins)

  $uri = [System.Uri]$Url
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 443 }
  $script:_CharonPinObserved = ''
  $script:_CharonPinMatches  = $false

  $tcp = New-Object System.Net.Sockets.TcpClient
  $tcp.Connect($uri.Host, $port)
  try {
    $callback = {
      param($snd, $cert, $chain, $errors)
      $der = $cert.GetRawCertData()
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hash = $sha.ComputeHash($der)
        $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
        $script:_CharonPinObserved = $hex
        $script:_CharonPinMatches  = ($ExpectedPins -contains $hex)
        return $script:_CharonPinMatches
      } finally { $sha.Dispose() }
    }

    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $callback)
    try {
      $protocols = [System.Security.Authentication.SslProtocols]::Tls12
      try { $protocols = $protocols -bor [System.Security.Authentication.SslProtocols]::Tls13 } catch {}
      try {
        $ssl.AuthenticateAsClient($uri.Host, $null, $protocols, $false)
      } catch {
        if ($script:_CharonPinObserved -ne '' -and -not $script:_CharonPinMatches) {
          throw "Certificate pin mismatch: the server presented $script:_CharonPinObserved"
        }
        throw
      }
      if (-not $script:_CharonPinMatches) {
        throw "Certificate pin mismatch: the server presented $script:_CharonPinObserved"
      }

      $req = "GET $($uri.PathAndQuery) HTTP/1.1\`r\`nHost: $($uri.Host)\`r\`nUser-Agent: charon-agent-install\`r\`nAccept: */*\`r\`nConnection: close\`r\`n\`r\`n"
      $reqBytes = [System.Text.Encoding]::ASCII.GetBytes($req)
      $ssl.Write($reqBytes, 0, $reqBytes.Length)
      $ssl.Flush()

      # Read headers byte-by-byte until CRLF CRLF — a StreamReader would buffer
      # past the header/body boundary and eat binary body bytes.
      $hdr = New-Object System.Collections.ArrayList
      $state = 0
      while ($true) {
        $b = $ssl.ReadByte()
        if ($b -lt 0) { throw "Connection closed before headers complete" }
        [void]$hdr.Add([byte]$b)
        if     ($state -eq 0 -and $b -eq 13) { $state = 1 }
        elseif ($state -eq 1 -and $b -eq 10) { $state = 2 }
        elseif ($state -eq 2 -and $b -eq 13) { $state = 3 }
        elseif ($state -eq 3 -and $b -eq 10) { break }
        else { $state = 0 }
      }
      $headers = [System.Text.Encoding]::ASCII.GetString($hdr.ToArray())

      if ($headers -notmatch '^HTTP/1\\.\\d\\s+(\\d{3})\\s') {
        $preview = $headers.Substring(0, [Math]::Min(200, $headers.Length))
        throw "Bad HTTP response from $Url : $preview"
      }
      $status = [int]$Matches[1]
      if ($status -ne 200) { throw "HTTP $status fetching $Url" }

      $contentLength = $null
      foreach ($line in ($headers -split "\`r\`n")) {
        if ($line -match '^Content-Length:\\s*(\\d+)\\s*$') {
          $contentLength = [int64]$Matches[1]
        }
      }
      if ($null -eq $contentLength) { throw "Server omitted Content-Length on $Url" }

      $fs = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
      try {
        $buf = New-Object byte[] 65536
        $remaining = $contentLength
        while ($remaining -gt 0) {
          $toRead = [int][Math]::Min($buf.Length, $remaining)
          $n = $ssl.Read($buf, 0, $toRead)
          if ($n -le 0) { throw "Connection closed before body complete ($remaining bytes missing)" }
          $fs.Write($buf, 0, $n)
          $remaining -= $n
        }
      } finally { $fs.Close() }
    } finally { $ssl.Dispose() }
  } finally { $tcp.Close() }
}
`;

// Lock %ProgramData%\\Charon and \\agent to SYSTEM + Administrators BEFORE the
// preseed lands (polaris rule 117): ProgramData lets every local user create
// folders, so a pre-created directory owned by that user — or a window between
// writing the file and fixing its ACL — would hand them the invitation code.
// SIDs, not names: the names are localized.
const PS_LOCK_CONF_DIR = `
$confDir = Join-Path $env:ProgramData 'Charon\\agent'
New-Item -ItemType Directory -Force -Path $confDir | Out-Null
foreach ($d in @((Split-Path -Parent $confDir), $confDir)) {
  & icacls.exe $d /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  & icacls.exe $d /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not restrict the ACL on $d" }
  & icacls.exe (Join-Path $d '*') /reset /T /C /Q 2>$null | Out-Null
}
`;

export interface WindowsInstallParams {
  serverUrl: string;
  pins: readonly string[];
  filename: string;
  sha256: string;
  /** The rendered preseed (install) — omitted for an upgrade. */
  preseed?: string;
}

/** The Windows install-or-upgrade PowerShell. Every substitution is allowlisted. */
export function windowsInstallPs(p: WindowsInstallParams): string {
  const serverUrl = assertScriptSafeServerUrl(p.serverUrl);
  const pins = assertPins(p.pins).join(",");
  const filename = assertInstallerFilename(p.filename);
  const sha = assertSha256(p.sha256);
  const preseedB64 = p.preseed ? Buffer.from(p.preseed, "utf8").toString("base64") : "";
  if (!B64_RE.test(preseedB64)) throw new AppError(500, "Invalid preseed encoding");
  const isMsi = installerKindOf(filename) === "msi";
  return `$ErrorActionPreference = 'Stop'
${PS_PINNED_DOWNLOAD_FN}
$serverUrl  = '${serverUrl}'
$pins       = '${pins}'.Split(',')
$file       = '${filename}'
$sha        = '${sha}'
$preseedB64 = '${preseedB64}'
${PS_LOCK_CONF_DIR}
if ($preseedB64 -ne '') {
  $preseedPath = Join-Path $confDir 'enroll.json'
  $tmpPreseed  = "$preseedPath.tmp"
  Remove-Item -Force -LiteralPath $tmpPreseed -ErrorAction SilentlyContinue
  [IO.File]::WriteAllBytes($tmpPreseed, [Convert]::FromBase64String($preseedB64))
  Move-Item -Force -LiteralPath $tmpPreseed -Destination $preseedPath
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('charon-agent-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
try {
  $inst = Join-Path $work 'agent-installer${isMsi ? ".msi" : ".exe"}'
  Invoke-CharonPinnedDownload -Url ($serverUrl + '/api/v1/agents/binary/' + [Uri]::EscapeDataString($file)) -OutFile $inst -ExpectedPins $pins
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $inst).Hash.ToLower()
  if ($got -ne $sha) { throw "Installer SHA-256 mismatch (expected $sha, got $got) - refusing to install" }
${isMsi
    ? `  $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $inst + '"'), '/qn', '/norestart') -Wait -PassThru`
    : `  $proc = Start-Process -FilePath $inst -ArgumentList '/S' -Wait -PassThru`}
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "The installer exited $($proc.ExitCode)" }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '${AGENT_PRODUCT_NAME} installed'
`;
}

/** The Windows uninstall PowerShell: the product's own uninstaller, silently, then the config. */
export function windowsUninstallPs(): string {
  return `$ErrorActionPreference = 'Stop'
$roots = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
$entries = foreach ($r in $roots) {
  if (Test-Path $r) { Get-ChildItem $r | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like '${AGENT_PRODUCT_NAME}*' } }
}
foreach ($e in $entries) {
  if ($e.WindowsInstaller -eq 1 -or $e.UninstallString -match '(?i)msiexec') {
    $code = $e.PSChildName
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $code, '/qn', '/norestart') -Wait -PassThru
  } else {
    $cmd = ($e.UninstallString -replace '"', '')
    $proc = Start-Process -FilePath $cmd -ArgumentList '/S' -Wait -PassThru
  }
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "The uninstaller exited $($proc.ExitCode)" }
}
$conf = Join-Path $env:ProgramData 'Charon'
if (Test-Path $conf) { Remove-Item -Recurse -Force -LiteralPath $conf }
Write-Host '${AGENT_PRODUCT_NAME} removed'
`;
}
