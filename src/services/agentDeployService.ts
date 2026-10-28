/**
 * src/services/agentDeployService.ts — push-deploy the Charon agent to hosts.
 *
 * Ported from polaris's agentInstallService orchestration (install / retry /
 * upgrade / upgrade-all / uninstall / bulk, over SSH or WinRM with a
 * Credentials-tab credential), keyed to an AgentDeployment target instead of a
 * polaris Asset, and installing Charon's Tauri packages
 * (services/agentInstallScripts.ts) instead of a Go binary.
 *
 * Lifecycle (AgentDeployment.status):
 *   pending → uploading → enrolling → active      (install / retry / reinstall)
 *   active  → upgrading → active | upgrade_failed (upgrade; the agent keeps its bearer)
 *   *       → uninstalling → uninstalled          (uninstall; the bearer is revoked)
 *   any step can end in failed with `lastError`.
 * `enrolling → active` happens in agentEnrollmentService when the agent
 * enrolls with the single-use code this run minted (`markDeploymentEnrolled`).
 *
 * Trust on the way (business rules 11, 12): the SSH host key and the WinRM TLS
 * certificate are pinned on first use and a changed one is refused BEFORE the
 * credential is sent (utils/remoteExec, utils/winrm); the installer's SHA-256
 * is checked on the host before it runs; Windows pulls it from this server
 * pinning the agent certificate pins; the enrollment preseed is root / SYSTEM
 * only. Every run is audited.
 *
 * Runs are detached (the route answers 202) and bounded: a bulk deploy runs
 * BULK_POOL hosts at a time, so 2000 targets never open 2000 SSH sessions.
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { truncate } from "../utils/text.js";
import { AGENT_DIST_DIR } from "../utils/paths.js";
import { normalizeAgentServerUrl } from "../utils/agentServerUrl.js";
import { withSshClient, sshExec, sftpPut, winrmRunPowershell } from "../utils/remoteExec.js";
import {
  makeUnixStageDir, unixStagedCommand, removeUnixStageDir,
  makeWindowsStageDir, windowsStagedSftpPath, removeWindowsStageDir,
} from "../utils/remoteStaging.js";
import type { WinRmConnection } from "../utils/winrm.js";
import { getCredential } from "./credentials/credentialService.js";
import { getManifest } from "./agentDistService.js";
import { getAgentCertPins } from "./certPinService.js";
import { issueCode } from "./invitationCodeService.js";
import { revokeBearer } from "./agentTokenService.js";
import { logEvent } from "./eventService.js";
import {
  type AgentOsPlatform, type AgentTransport, type ManifestFile, AGENT_OS_PLATFORMS,
  selectInstaller, installerKindOf, stagedInstallerName, renderEnrollmentPreseed,
  unixInstallScript, unixUninstallScript, UNIX_PROBE_COMMAND, parseUnixProbe,
  WINDOWS_PROBE_PS, windowsInstallPs, windowsUninstallPs, normalizeArch, assertSha256,
} from "./agentInstallScripts.js";

/** Hosts worked on at once by a bulk deploy / upgrade-all (polaris BULK_INSTALL_POOL). */
export const BULK_POOL = 5;
/** Lifetime of the single-use invitation code a push install mints. */
export const DEPLOY_CODE_TTL_MINUTES = 10;
/** Setting holding the operator's agent server-URL override. */
export const AGENT_SERVER_URL_SETTING_KEY = "agent.serverUrlOverride";

const INSTALL_TIMEOUT_MS = 180_000;
const SHORT_TIMEOUT_MS = 30_000;

export const UPGRADEABLE_STATUSES = ["active", "upgrade_failed"] as const;
const BUSY_STATUSES = ["uploading", "enrolling", "upgrading", "uninstalling"] as const;

// ─── Server URL ─────────────────────────────────────────────────────────────

/**
 * The URL an installed agent calls back to (polaris inferOwnServerUrl, Charon
 * sources): 1. the `agent.serverUrlOverride` Setting (Server Settings →
 * Agents), 2. CHARON_PUBLIC_URL, 3. the served certificate's first DNS SAN /
 * CN / IP SAN on the public HTTPS port. Every candidate passes the script-safe
 * allowlist (utils/agentServerUrl, polaris rule 107) or is skipped.
 */
export async function inferAgentServerUrl(): Promise<string | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
    const v = (row?.value as { url?: unknown } | null)?.url;
    const ok = normalizeAgentServerUrl(v);
    if (ok) return ok;
    if (typeof v === "string" && v.trim()) logger.warn("Ignoring the stored agent server-URL override: it is not a plain http(s) URL");
  } catch { /* fall through to the derived URL */ }
  const fromEnv = normalizeAgentServerUrl(process.env.CHARON_PUBLIC_URL);
  if (fromEnv) return fromEnv;
  try {
    const { getHttpsInfo } = await import("./webServerService.js");
    const info = await getHttpsInfo();
    const host = info.dnsSans[0] || info.cn || info.ipSans[0] || null;
    if (host) {
      const port = info.port && info.port !== 443 ? `:${info.port}` : "";
      return normalizeAgentServerUrl(`https://${host}${port}`);
    }
  } catch { /* no readable cert */ }
  return null;
}

export async function setAgentServerUrlOverride(url: string | null, actor: string): Promise<string | null> {
  if (url === null || url.trim() === "") {
    await prisma.setting.deleteMany({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
  } else {
    const ok = normalizeAgentServerUrl(url);
    if (!ok) throw new AppError(400, "The agent server URL must be a plain http(s) URL: host, optional port and path — no query, fragment, credentials or quotes");
    await prisma.setting.upsert({
      where: { key: AGENT_SERVER_URL_SETTING_KEY },
      create: { key: AGENT_SERVER_URL_SETTING_KEY, value: { url: ok } },
      update: { value: { url: ok } },
    });
  }
  await logEvent({ action: "agent.server_url.changed", resourceType: "setting", resourceName: AGENT_SERVER_URL_SETTING_KEY, actor, message: url ? `Agent server URL override set to ${normalizeAgentServerUrl(url)}` : "Agent server URL override cleared" });
  return inferAgentServerUrl();
}

// ─── Transports (a seam for tests) ──────────────────────────────────────────

export interface HostFacts { os: AgentOsPlatform; arch: string | null; dpkg: boolean; rpm: boolean }

export interface DeployTransports {
  probe(target: { host: string; os: AgentOsPlatform; transport: AgentTransport; cred: Record<string, unknown> }): Promise<HostFacts>;
  unixRun(host: string, cred: Record<string, unknown>, files: Array<{ name: string; body: Buffer; mode: number }>, script: string, sha256?: string): Promise<void>;
  windowsRun(host: string, transport: AgentTransport, cred: Record<string, unknown>, ps: string, scriptName: string): Promise<void>;
}

const realTransports: DeployTransports = {
  async probe({ host, os, transport, cred }) {
    if (os === "windows") {
      const out = transport === "winrm"
        ? await winrmRunPowershell(winrmConnectionFromCred(host, cred), WINDOWS_PROBE_PS)
        : await withSshClient(host, cred, (c) => sshExec(c, `powershell.exe -NoProfile -NonInteractive -Command "${WINDOWS_PROBE_PS.replace(/"/g, '\\"')}"`, SHORT_TIMEOUT_MS));
      if (out.exitCode !== 0) throw new AppError(502, `Host probe failed: ${truncate(out.stderr || out.stdout, 200)}`);
      return { os, arch: normalizeArch(out.stdout), dpkg: false, rpm: false };
    }
    const out = await withSshClient(host, cred, (c) => sshExec(c, UNIX_PROBE_COMMAND, SHORT_TIMEOUT_MS));
    if (out.exitCode !== 0) throw new AppError(502, `Host probe failed: ${truncate(out.stderr || out.stdout, 200)}`);
    const p = parseUnixProbe(out.stdout);
    if (p.os && p.os !== os) throw new AppError(409, `The host reports ${p.os}, not ${os} — fix the deployment's OS`);
    return { os, arch: p.arch, dpkg: p.dpkg, rpm: p.rpm };
  },
  async unixRun(host, cred, files, script, sha256) {
    await withSshClient(host, cred, async (client) => {
      const dir = await makeUnixStageDir(client);
      let ran = false;
      try {
        for (const f of files) await sftpPut(client, `${dir}/${f.name}`, f.body, f.mode);
        ran = true;
        const out = await sshExec(client, unixStagedCommand(dir, script, sha256), INSTALL_TIMEOUT_MS);
        if (out.exitCode !== 0) throw new AppError(502, `${script} exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
      } finally {
        if (!ran) await removeUnixStageDir(client, dir);
      }
    });
  },
  async windowsRun(host, transport, cred, ps, scriptName) {
    if (transport === "winrm") {
      const out = await winrmRunPowershell(winrmConnectionFromCred(host, cred), ps);
      if (out.exitCode !== 0) throw new AppError(502, `PowerShell exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
      return;
    }
    // SSH: stage the script as a UTF-8-with-BOM file in the SSH user's own temp
    // folder (polaris rule 119) — -EncodedCommand overflows cmd.exe's 8191-char
    // limit on OpenSSH-for-Windows.
    const body = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ps, "utf8")]);
    await withSshClient(host, cred, async (client) => {
      const dir = await makeWindowsStageDir(client);
      try {
        await sftpPut(client, windowsStagedSftpPath(dir, scriptName), body, 0o600);
        const out = await sshExec(client, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${dir}\\${scriptName}"`, INSTALL_TIMEOUT_MS);
        if (out.exitCode !== 0) throw new AppError(502, `PowerShell exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
      } finally {
        await removeWindowsStageDir(client, dir);
      }
    });
  },
};

let transports: DeployTransports = realTransports;

/** Tests swap the host transports; pass null to restore the real ones. */
export function __setDeployTransportsForTests(t: DeployTransports | null): void {
  transports = t ?? realTransports;
}

function winrmConnectionFromCred(host: string, config: Record<string, unknown>): WinRmConnection {
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) throw new AppError(400, "WinRM credential is missing username or password");
  return {
    host,
    port: typeof config.port === "number" ? config.port : undefined,
    useHttps: config.useHttps !== false,
    // Unverified HTTPS is TLS-pinned on first use (utils/winrm → pinnedAgentFor).
    verifyTls: config.verifyTls === true,
    username,
    password,
    timeoutMs: INSTALL_TIMEOUT_MS,
  };
}

// ─── Credential + target validation ─────────────────────────────────────────

async function loadCredential(credentialId: string | null, transport: AgentTransport): Promise<Record<string, unknown>> {
  if (!credentialId) throw new AppError(400, "The deployment has no credential — pick one and retry");
  const cred = await getCredential(credentialId, { revealSecrets: true });
  if (cred.type !== transport) {
    throw new AppError(400, `A ${transport.toUpperCase()} deployment needs a ${transport} credential; "${cred.name}" is ${cred.type}`);
  }
  return (cred.config as Record<string, unknown>) || {};
}

function assertTarget(os: string, transport: string): { os: AgentOsPlatform; transport: AgentTransport } {
  if (!(AGENT_OS_PLATFORMS as readonly string[]).includes(os)) throw new AppError(400, `Unsupported OS "${os}"`);
  if (transport !== "ssh" && transport !== "winrm") throw new AppError(400, `Unsupported transport "${transport}"`);
  if (transport === "winrm" && os !== "windows") throw new AppError(400, "WinRM deploys Windows hosts only — use SSH for Linux and macOS");
  return { os: os as AgentOsPlatform, transport };
}

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$/;

function assertHost(host: string): string {
  const h = host.trim();
  if (!HOST_RE.test(h)) throw new AppError(400, `"${host}" is not a host name or IP address`);
  return h;
}

// ─── Create / list ──────────────────────────────────────────────────────────

export interface DeployTarget {
  host: string;
  osPlatform: string;
  directoryObjectId?: string | null;
}

export interface CreateDeploymentsInput {
  targets: DeployTarget[];
  transport: string;
  credentialId: string;
}

/**
 * Create one deployment per target and start the installs (detached, BULK_POOL
 * at a time). A target already holding a live deployment for the same host is
 * skipped rather than duplicated.
 */
export async function createDeployments(input: CreateDeploymentsInput, actor: string): Promise<{ created: string[]; skipped: Array<{ host: string; reason: string }> }> {
  if (input.targets.length === 0) throw new AppError(400, "No targets");
  // Validate the credential once, up front (fast 400 instead of N failed runs).
  const firstOs = input.targets[0].osPlatform;
  const { transport } = assertTarget(firstOs, input.transport);
  await loadCredential(input.credentialId, transport);

  const created: string[] = [];
  const skipped: Array<{ host: string; reason: string }> = [];
  const hosts = input.targets.map((t) => t.host.trim());
  const live = await prisma.agentDeployment.findMany({
    where: { host: { in: hosts }, status: { notIn: ["failed", "uninstalled"] } },
    select: { host: true },
  });
  const liveHosts = new Set(live.map((l) => l.host.toLowerCase()));
  for (const t of input.targets) {
    try {
      const host = assertHost(t.host);
      assertTarget(t.osPlatform, transport);
      if (liveHosts.has(host.toLowerCase())) { skipped.push({ host, reason: "already has a live deployment" }); continue; }
      const row = await prisma.agentDeployment.create({
        data: { host, osPlatform: t.osPlatform, transport, credentialId: input.credentialId, directoryObjectId: t.directoryObjectId ?? null, createdBy: actor },
      });
      liveHosts.add(host.toLowerCase());
      created.push(row.id);
    } catch (err: any) {
      skipped.push({ host: t.host, reason: err?.message ?? String(err) });
    }
  }
  await logEvent({ action: "agent.deploy.started", resourceType: "agent-deployment", actor, message: `Started agent deployment to ${created.length} host(s)${skipped.length ? `, skipped ${skipped.length}` : ""}`, details: { created: created.length, skipped } });
  void runPool(created, (id) => runInstall(id, actor));
  return { created, skipped };
}

export async function listDeployments() {
  const rows = await prisma.agentDeployment.findMany({
    orderBy: [{ status: "asc" }, { host: "asc" }],
    include: {
      credential: { select: { id: true, name: true, type: true } },
      endpoint: { select: { id: true, hostname: true, status: true, agentVersion: true, lastSeenAt: true } },
    },
  });
  // invitationCodeId is internal plumbing; never return it.
  return rows.map(({ invitationCodeId: _code, ...r }) => r);
}

export async function getDeployment(id: string) {
  const row = await prisma.agentDeployment.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Agent deployment not found");
  return row;
}

// ─── Install ────────────────────────────────────────────────────────────────

/** Re-run the install of a failed / uninstalled / active deployment (reinstall), optionally with another credential. */
export async function retryDeployment(id: string, actor: string, credentialId?: string): Promise<void> {
  const row = await getDeployment(id);
  // `enrolling` is not busy: it waits on the agent, possibly indefinitely, so a
  // reinstall (fresh code; the old one is revoked below) must stay possible.
  if ((BUSY_STATUSES as readonly string[]).includes(row.status) && row.status !== "enrolling") {
    throw new AppError(409, `The deployment is ${row.status} — wait for it to finish`);
  }
  if (row.invitationCodeId) {
    await prisma.invitationCode.updateMany({ where: { id: row.invitationCodeId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  if (credentialId) {
    await loadCredential(credentialId, row.transport as AgentTransport);
    await prisma.agentDeployment.update({ where: { id }, data: { credentialId } });
  }
  await prisma.agentDeployment.update({ where: { id }, data: { status: "pending", lastError: null } });
  void runInstall(id, actor);
}

async function runInstall(id: string, actor: string): Promise<void> {
  const row = await prisma.agentDeployment.findUnique({ where: { id } });
  if (!row) return;
  try {
    const { os, transport } = assertTarget(row.osPlatform, row.transport);
    const cred = await loadCredential(row.credentialId, transport);
    await prisma.agentDeployment.update({ where: { id }, data: { lastAttemptAt: new Date(), lastError: null } });

    const serverUrl = await inferAgentServerUrl();
    if (!serverUrl) throw new AppError(409, "No agent server URL — set CHARON_PUBLIC_URL or the override under Server Settings → Agents");
    const pins = await getAgentCertPins();

    const facts = await transports.probe({ host: row.host, os, transport, cred });
    const { file, sha256, version } = pickInstaller(facts);

    // A fresh single-use code per run: the clock starts when the install fires.
    const code = await issueCode({ label: `Push deploy: ${row.host}`, maxUses: 1, expiresInMinutes: DEPLOY_CODE_TTL_MINUTES }, `deploy:${actor}`);
    await prisma.agentDeployment.update({
      where: { id },
      data: { status: "uploading", arch: facts.arch, installerFilename: file.filename, agentVersion: version, invitationCodeId: code.id },
    });
    const preseed = renderEnrollmentPreseed({ serverUrl, pins, code: code.plaintext });

    if (os === "windows") {
      await transports.windowsRun(row.host, transport, cred, windowsInstallPs({ serverUrl, pins, filename: file.filename, sha256, preseed }), "charon-agent-install.ps1");
    } else {
      const kind = installerKindOf(file.filename)!;
      const bytes = await readInstaller(version, file.filename);
      await transports.unixRun(row.host, cred, [
        { name: stagedInstallerName(kind), body: bytes, mode: 0o644 },
        { name: "install.sh", body: Buffer.from(unixInstallScript(os, kind), "utf8"), mode: 0o700 },
        { name: "enroll.json", body: Buffer.from(preseed, "utf8"), mode: 0o600 },
      ], "install.sh", sha256);
    }

    await prisma.agentDeployment.update({ where: { id }, data: { status: "enrolling" } });
    await logEvent({ action: "agent.installed", resourceType: "agent-deployment", resourceId: id, resourceName: row.host, actor, message: `Charon Agent ${version} installed on ${row.host} — awaiting enrollment`, details: { installer: file.filename, arch: facts.arch } });
  } catch (err: any) {
    await fail(id, row.host, "failed", "agent.install_failed", err, actor);
  }
}

function pickInstaller(facts: HostFacts): { file: ManifestFile; sha256: string; version: string } {
  const manifest = getManifest();
  if (!manifest) throw new AppError(409, "No agent installers available — drop a manifest.json and the installers under data/agents/<version>/");
  const file = selectInstaller(manifest.files, { os: facts.os, arch: facts.arch, packageManagers: { dpkg: facts.dpkg, rpm: facts.rpm } });
  if (!file) {
    throw new AppError(409, `No ${facts.os}${facts.arch ? `/${facts.arch}` : ""} installer with a SHA-256 in the agent manifest${facts.os === "linux" ? ` (host has ${[facts.dpkg && "dpkg", facts.rpm && "rpm"].filter(Boolean).join(" + ") || "no dpkg / rpm"})` : ""}`);
  }
  return { file, sha256: assertSha256(file.sha256!), version: manifest.version };
}

async function readInstaller(version: string, filename: string): Promise<Buffer> {
  const { resolveInstaller } = await import("./agentDistService.js");
  const p = resolveInstaller(filename) ?? resolvePath(AGENT_DIST_DIR, version, filename);
  try {
    return await readFile(p);
  } catch (err: any) {
    throw new AppError(409, `The installer ${filename} is listed in the manifest but could not be read: ${err?.message ?? err}`);
  }
}

// ─── Upgrade ────────────────────────────────────────────────────────────────

/**
 * Install the manifest's current version over an enrolled agent. No preseed —
 * the agent keeps its bearer and pins. Uses the deployment's own credential
 * unless another is given (polaris rule 49: an upgrade resolves its own
 * credential rather than borrowing whatever the caller holds).
 */
export async function startUpgrade(id: string, actor: string, credentialId?: string): Promise<void> {
  const row = await getDeployment(id);
  if (!(UPGRADEABLE_STATUSES as readonly string[]).includes(row.status)) {
    throw new AppError(409, `Only an active agent can be upgraded (this one is ${row.status})`);
  }
  if (credentialId) {
    await loadCredential(credentialId, row.transport as AgentTransport);
    await prisma.agentDeployment.update({ where: { id }, data: { credentialId } });
  }
  await prisma.agentDeployment.update({ where: { id }, data: { status: "upgrading", lastError: null } });
  void runUpgrade(id, actor);
}

async function runUpgrade(id: string, actor: string): Promise<void> {
  const row = await prisma.agentDeployment.findUnique({ where: { id } });
  if (!row) return;
  try {
    const { os, transport } = assertTarget(row.osPlatform, row.transport);
    const cred = await loadCredential(row.credentialId, transport);
    const facts = await transports.probe({ host: row.host, os, transport, cred });
    const { file, sha256, version } = pickInstaller(facts);
    if (os === "windows") {
      const serverUrl = await inferAgentServerUrl();
      if (!serverUrl) throw new AppError(409, "No agent server URL — set CHARON_PUBLIC_URL or the override under Server Settings → Agents");
      await transports.windowsRun(row.host, transport, cred, windowsInstallPs({ serverUrl, pins: await getAgentCertPins(), filename: file.filename, sha256 }), "charon-agent-upgrade.ps1");
    } else {
      const kind = installerKindOf(file.filename)!;
      await transports.unixRun(row.host, cred, [
        { name: stagedInstallerName(kind), body: await readInstaller(version, file.filename), mode: 0o644 },
        { name: "install.sh", body: Buffer.from(unixInstallScript(os, kind), "utf8"), mode: 0o700 },
      ], "install.sh", sha256);
    }
    await prisma.agentDeployment.update({ where: { id }, data: { status: "active", installerFilename: file.filename, agentVersion: version, lastAttemptAt: new Date() } });
    await logEvent({ action: "agent.upgraded", resourceType: "agent-deployment", resourceId: id, resourceName: row.host, actor, message: `Charon Agent on ${row.host} upgraded to ${version}` });
  } catch (err: any) {
    await fail(id, row.host, "upgrade_failed", "agent.upgrade_failed", err, actor);
  }
}

/** Upgrade every active deployment whose agentVersion differs from the manifest's (BULK_POOL at a time). */
export async function upgradeAllOutdated(actor: string): Promise<{ started: number; current: number; targetVersion: string }> {
  const manifest = getManifest();
  if (!manifest) throw new AppError(409, "No agent installers available");
  const rows = await prisma.agentDeployment.findMany({ where: { status: { in: [...UPGRADEABLE_STATUSES] } }, select: { id: true, agentVersion: true } });
  const outdated = rows.filter((r) => r.agentVersion !== manifest.version).map((r) => r.id);
  if (outdated.length) {
    await prisma.agentDeployment.updateMany({ where: { id: { in: outdated } }, data: { status: "upgrading", lastError: null } });
  }
  await logEvent({ action: "agent.upgrade_all", resourceType: "agent-deployment", actor, message: `Upgrade-all to ${manifest.version}: ${outdated.length} agent(s) started` });
  void runPool(outdated, (id) => runUpgrade(id, actor));
  return { started: outdated.length, current: rows.length - outdated.length, targetVersion: manifest.version };
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

/** Remove the agent from the host and revoke its endpoint's bearer. */
export async function startUninstall(id: string, actor: string): Promise<void> {
  const row = await getDeployment(id);
  if ((BUSY_STATUSES as readonly string[]).includes(row.status) && row.status !== "enrolling") {
    throw new AppError(409, `The deployment is ${row.status} — wait for it to finish`);
  }
  await prisma.agentDeployment.update({ where: { id }, data: { status: "uninstalling", lastError: null } });
  void runUninstall(id, actor);
}

async function runUninstall(id: string, actor: string): Promise<void> {
  const row = await prisma.agentDeployment.findUnique({ where: { id } });
  if (!row) return;
  try {
    const { os, transport } = assertTarget(row.osPlatform, row.transport);
    const cred = await loadCredential(row.credentialId, transport);
    if (os === "windows") {
      await transports.windowsRun(row.host, transport, cred, windowsUninstallPs(), "charon-agent-uninstall.ps1");
    } else {
      await transports.unixRun(row.host, cred, [
        { name: "uninstall.sh", body: Buffer.from(unixUninstallScript(os), "utf8"), mode: 0o700 },
      ], "uninstall.sh");
    }
    // An uninstalled agent must not keep a working bearer (rule 4).
    if (row.endpointId) await revokeBearer(row.endpointId).catch(() => {});
    if (row.invitationCodeId) await prisma.invitationCode.updateMany({ where: { id: row.invitationCodeId, revokedAt: null }, data: { revokedAt: new Date() } });
    await prisma.agentDeployment.update({ where: { id }, data: { status: "uninstalled", lastAttemptAt: new Date() } });
    await logEvent({ action: "agent.uninstalled", resourceType: "agent-deployment", resourceId: id, resourceName: row.host, actor, message: `Charon Agent removed from ${row.host}${row.endpointId ? " and its bearer revoked" : ""}` });
  } catch (err: any) {
    await fail(id, row.host, "failed", "agent.uninstall_failed", err, actor);
  }
}

/** Forget a deployment record (not the host's agent). Refused while a run is in flight. */
export async function deleteDeployment(id: string, actor: string): Promise<void> {
  const row = await getDeployment(id);
  if ((BUSY_STATUSES as readonly string[]).includes(row.status) && row.status !== "enrolling") {
    throw new AppError(409, `The deployment is ${row.status} — wait for it to finish`);
  }
  if (row.invitationCodeId) await prisma.invitationCode.updateMany({ where: { id: row.invitationCodeId, revokedAt: null }, data: { revokedAt: new Date() } });
  await prisma.agentDeployment.delete({ where: { id } });
  await logEvent({ action: "agent.deployment.deleted", resourceType: "agent-deployment", resourceId: id, resourceName: row.host, actor, message: `Deleted the agent deployment record for ${row.host}` });
}

// ─── Enrollment hook ────────────────────────────────────────────────────────

/**
 * Called by agentEnrollmentService after a code is consumed: if the code was
 * minted by a deployment, link the new Endpoint and mark the deployment active.
 */
export async function markDeploymentEnrolled(invitationCodeId: string, endpointId: string, agentVersion?: string | null): Promise<void> {
  const res = await prisma.agentDeployment.updateMany({
    where: { invitationCodeId },
    data: { status: "active", endpointId, lastError: null, ...(agentVersion ? { agentVersion } : {}) },
  });
  if (res.count > 0) {
    await logEvent({ action: "agent.deployment.enrolled", resourceType: "endpoint", resourceId: endpointId, message: "A push-deployed agent enrolled" });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fail(id: string, host: string, status: string, action: string, err: unknown, actor: string): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  await prisma.agentDeployment.update({ where: { id }, data: { status, lastError: truncate(reason, 1000) } }).catch(() => {});
  await logEvent({ level: "error", action, resourceType: "agent-deployment", resourceId: id, resourceName: host, actor, message: `${action.replace("agent.", "Agent ").replace(/_/g, " ")} on ${host}: ${reason}` });
}

/** Run `fn` over `ids`, BULK_POOL at a time. Never throws. */
async function runPool(ids: string[], fn: (id: string) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      await fn(id).catch((err) => logger.error({ err, id }, "agent deployment run failed"));
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_POOL, ids.length) }, worker));
}
