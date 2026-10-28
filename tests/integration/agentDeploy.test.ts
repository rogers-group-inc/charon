/**
 * tests/integration/agentDeploy.test.ts — the push-deployment lifecycle
 * (services/agentDeployService.ts) against a real database with FAKE host
 * transports (no SSH / WinRM is opened).
 *
 * Pins: an install mints a single-use, short-lived invitation code into the
 * preseed and the deployment waits in `enrolling`; enrolling with that code
 * links the Endpoint and flips the deployment `active`; the code cannot be
 * reused; a transport failure lands as `failed` with the reason; uninstall
 * revokes the bearer.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dbDescribe, dbReachable } from "./_helpers.js";

// The installer directory must be set before paths.ts is loaded.
const STATE = mkdtempSync(join(tmpdir(), "charon-deploy-test-"));
process.env.CHARON_STATE_DIR = STATE;
process.env.CHARON_DATA_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.CHARON_PUBLIC_URL = "https://charon.example.com";

const { prisma } = await import("../../src/db.js");
const deploy = await import("../../src/services/agentDeployService.js");
const { createCredential } = await import("../../src/services/credentials/credentialService.js");
const { enroll } = await import("../../src/services/agentEnrollmentService.js");
const { setCanonicalPin } = await import("../../src/services/certPinService.js");
const { AGENT_DIST_DIR } = await import("../../src/utils/paths.js");

const PIN = "c".repeat(64);
const DEB = Buffer.from("fake deb bytes");
const calls: Array<{ kind: string; files?: string[]; script?: string; preseed?: any }> = [];
let failNext: string | null = null;

async function waitFor(id: string, statuses: string[]): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const row = await prisma.agentDeployment.findUnique({ where: { id } });
    if (row && statuses.includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`deployment ${id} never reached ${statuses.join("|")}`);
}

let credentialId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  mkdirSync(join(AGENT_DIST_DIR, "0.2.0"), { recursive: true });
  writeFileSync(join(AGENT_DIST_DIR, "0.2.0", "charon-agent_0.2.0_amd64.deb"), DEB);
  writeFileSync(join(AGENT_DIST_DIR, "manifest.json"), JSON.stringify({
    version: "0.2.0",
    files: [{ platform: "linux", arch: "amd64", filename: "charon-agent_0.2.0_amd64.deb", sha256: createHash("sha256").update(DEB).digest("hex") }],
  }));
  await setCanonicalPin(PIN);
  const cred = await createCredential({ name: `deploy-test-${Date.now()}`, type: "ssh", config: { username: "deployer", password: "pw" } });
  credentialId = cred.id;
  deploy.__setDeployTransportsForTests({
    async probe({ os }) { return { os, arch: "x64", dpkg: true, rpm: false }; },
    async unixRun(_host, _cred, files, script) {
      if (failNext) { const m = failNext; failNext = null; throw new Error(m); }
      const pre = files.find((f) => f.name === "enroll.json");
      calls.push({ kind: "unix", files: files.map((f) => f.name), script, preseed: pre ? JSON.parse(pre.body.toString("utf8")) : undefined });
    },
    async windowsRun() { calls.push({ kind: "windows" }); },
  });
});

afterAll(async () => {
  deploy.__setDeployTransportsForTests(null);
  rmSync(STATE, { recursive: true, force: true });
  if (!dbReachable) return;
  await prisma.agentDeployment.deleteMany({ where: { credentialId } });
  await prisma.credential.deleteMany({ where: { id: credentialId } });
});

beforeEach(() => { calls.length = 0; failNext = null; });

dbDescribe("agent push deployment", () => {
  it("installs, waits for enrollment, and goes active when the agent enrolls with the minted code", async () => {
    const { created } = await deploy.createDeployments({ targets: [{ host: "pc-01.corp.example", osPlatform: "linux" }], transport: "ssh", credentialId }, "tester");
    expect(created).toHaveLength(1);
    const row = await waitFor(created[0], ["enrolling", "failed"]);
    expect(row.lastError).toBeNull();
    expect(row.status).toBe("enrolling");
    expect(row.installerFilename).toBe("charon-agent_0.2.0_amd64.deb");

    expect(calls[0].files).toEqual(["agent-installer.deb", "install.sh", "enroll.json"]);
    const pre = calls[0].preseed;
    expect(pre.serverUrl).toBe("https://charon.example.com");
    expect(pre.pins).toEqual([PIN]);

    const code = await prisma.invitationCode.findUnique({ where: { id: row.invitationCodeId! } });
    expect(code!.maxUses).toBe(1);
    expect(code!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);

    const result = await enroll({ code: pre.code, hostname: "pc-01", osPlatform: "linux", agentVersion: "0.2.0" }, "10.0.0.5");
    const after = await prisma.agentDeployment.findUnique({ where: { id: row.id } });
    expect(after!.status).toBe("active");
    expect(after!.endpointId).toBe(result.endpointId);

    // Single use.
    await expect(enroll({ code: pre.code, hostname: "rogue" }, "10.0.0.66")).rejects.toThrow(/no remaining uses/);
  });

  it("records a transport failure as failed with the reason", async () => {
    failNext = "Installer exited 1: dpkg: error";
    const { created } = await deploy.createDeployments({ targets: [{ host: "pc-02.corp.example", osPlatform: "linux" }], transport: "ssh", credentialId }, "tester");
    const row = await waitFor(created[0], ["failed", "enrolling"]);
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/dpkg: error/);
  });

  it("skips a host that already has a live deployment, and refuses WinRM for Linux", async () => {
    const res = await deploy.createDeployments({ targets: [{ host: "pc-01.corp.example", osPlatform: "linux" }], transport: "ssh", credentialId }, "tester");
    expect(res.created).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/live deployment/);
    await expect(deploy.createDeployments({ targets: [{ host: "pc-03", osPlatform: "linux" }], transport: "winrm", credentialId }, "tester")).rejects.toThrow(/WinRM deploys Windows/);
  });

  it("refuses an enrollment whose observed certificate is not an agent pin, and burns the code", async () => {
    const { issueCode } = await import("../../src/services/invitationCodeService.js");
    const code = await issueCode({ maxUses: 1, expiresInMinutes: 10 }, "tester");
    await expect(enroll({ code: code.plaintext, hostname: "mitm", observedFingerprint: "d".repeat(64) }, "10.0.0.7")).rejects.toThrow(/not one of the server's agent pins/);
    await expect(enroll({ code: code.plaintext, hostname: "retry", observedFingerprint: PIN }, "10.0.0.7")).rejects.toThrow(/no remaining uses/);
    // The right pin enrolls.
    const ok = await issueCode({ maxUses: 1, expiresInMinutes: 10 }, "tester");
    await expect(enroll({ code: ok.plaintext, hostname: "good", observedFingerprint: PIN.toUpperCase() }, "10.0.0.8")).resolves.toMatchObject({ serverCertPins: [PIN] });
  });

  it("uninstall revokes the endpoint's bearer", async () => {
    const row = await prisma.agentDeployment.findFirst({ where: { host: "pc-01.corp.example", status: "active" } });
    await deploy.startUninstall(row!.id, "tester");
    const done = await waitFor(row!.id, ["uninstalled", "failed"]);
    expect(done.status).toBe("uninstalled");
    expect(calls.some((c) => c.script === "uninstall.sh")).toBe(true);
    const ep = await prisma.endpoint.findUnique({ where: { id: row!.endpointId! } });
    expect(ep!.bearerRevokedAt).not.toBeNull();
  });
});
