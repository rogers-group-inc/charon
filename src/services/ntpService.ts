/**
 * src/services/ntpService.ts — Server Settings → Time & NTP.
 *
 * Ported from polaris src/services/serverSettingsService.ts (NTP section).
 * Single Setting row (`ntp`): { enabled, mode, servers[], timezoneOverride }.
 * `timezoneOverride` is DISPLAY-only (the UI formats timestamps in it); the
 * host clock's zone is never changed.
 *
 * Charon additions vs polaris (polaris only stored the row and its "Test Sync"
 * returned a canned success):
 *   - testNtpSync performs a real query: an SNTP client request (RFC 4330) on
 *     UDP 123 for ntp/sntp, an NTS-KE TLS 1.3 handshake (RFC 8915, TCP 4460,
 *     ALPN "ntske/1") for nts.
 *   - applyNtpToHost renders chrony sources and hands them to the privileged
 *     wrapper deploy/scripts/charon-chrony-apply.sh via a scoped sudoers rule —
 *     the same stage → sudo-apply pattern as nginxApplyService. Where the
 *     wrapper is absent (dev, Docker) the settings are stored and the result
 *     says the host clock is managed elsewhere.
 */

import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { existsSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { prisma } from "../db.js";
import { STATE_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export type NtpMode = "ntp" | "sntp" | "nts";

export interface NtpSettings {
  enabled: boolean;
  mode: NtpMode;
  servers: string[];
  timezoneOverride: string | null;
}

export const NTP_KEY = "ntp";
export const NTP_MAX_SERVERS = 20;

const DEFAULT_NTP: NtpSettings = {
  enabled: false,
  mode: "ntp",
  servers: [],
  timezoneOverride: null,
};

const WRAPPER = process.env.CHARON_CHRONY_APPLY_SCRIPT || "/opt/charon/deploy/scripts/charon-chrony-apply.sh";

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

const HOSTNAME_RE = /^(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

/** A server entry is a bare hostname or IPv4/IPv6 literal — nothing else reaches chrony. */
export function isValidNtpServer(s: string): boolean {
  return isIP(s) !== 0 || HOSTNAME_RE.test(s);
}

/** IANA timezone check via Intl (throws RangeError on an unknown zone). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Merge a stored row over the defaults, dropping anything malformed. */
export function parseNtpSettings(raw: unknown): NtpSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = r.mode === "sntp" || r.mode === "nts" ? r.mode : "ntp";
  const servers = Array.isArray(r.servers)
    ? r.servers.filter((s): s is string => typeof s === "string" && isValidNtpServer(s)).slice(0, NTP_MAX_SERVERS)
    : [];
  const tz = typeof r.timezoneOverride === "string" && r.timezoneOverride && isValidTimezone(r.timezoneOverride)
    ? r.timezoneOverride : null;
  return { enabled: r.enabled === true, mode, servers, timezoneOverride: tz };
}

/**
 * chrony `.sources` file (sourcedir format — server directives only). SNTP has
 * no chrony equivalent; chrony speaks full NTP to the same servers, which an
 * SNTP server answers identically.
 */
export function renderChronySources(s: Pick<NtpSettings, "mode" | "servers">): string {
  const lines = [
    "# Managed by Charon (Server Settings -> Time & NTP). Changes here are overwritten.",
    ...s.servers.map((srv) => `server ${srv} iburst${s.mode === "nts" ? " nts" : ""}`),
  ];
  return lines.join("\n") + "\n";
}

/** NTP 64-bit timestamp (seconds since 1900) at `offset` → Unix ms. */
export function readNtpTimestamp(buf: Buffer, offset: number): number {
  const secs = buf.readUInt32BE(offset);
  const frac = buf.readUInt32BE(offset + 4);
  return (secs - 2_208_988_800) * 1000 + (frac * 1000) / 0x1_0000_0000;
}

/**
 * Validate an SNTP reply and compute the clock offset (ms, server − local)
 * from t1 (request sent) and t4 (reply received), both local Unix ms.
 */
export function parseSntpReply(buf: Buffer, t1: number, t4: number): { offsetMs: number; stratum: number } {
  if (buf.length < 48) throw new Error("short reply");
  const mode = buf[0] & 0x07;
  if (mode !== 4) throw new Error(`unexpected mode ${mode}`);
  const stratum = buf[1];
  if (stratum === 0) throw new Error(`kiss-of-death (${buf.subarray(12, 16).toString("ascii").replace(/\0/g, "")})`);
  const t2 = readNtpTimestamp(buf, 32);
  const t3 = readNtpTimestamp(buf, 40);
  return { offsetMs: ((t2 - t1) + (t3 - t4)) / 2, stratum };
}

export function formatOffset(ms: number): string {
  const s = ms / 1000;
  return `${s >= 0 ? "+" : ""}${s.toFixed(3)}s`;
}

// ─── Settings row ─────────────────────────────────────────────────────────────

export async function getNtpSettings(): Promise<NtpSettings> {
  const row = await prisma.setting.findUnique({ where: { key: NTP_KEY } });
  return row ? parseNtpSettings(row.value) : { ...DEFAULT_NTP };
}

export async function updateNtpSettings(patch: Partial<NtpSettings>): Promise<NtpSettings> {
  const current = await getNtpSettings();
  const merged: NtpSettings = parseNtpSettings({ ...current, ...patch });
  await prisma.setting.upsert({
    where: { key: NTP_KEY },
    create: { key: NTP_KEY, value: merged as any },
    update: { value: merged as any },
  });
  return merged;
}

// ─── Host apply (chrony) ──────────────────────────────────────────────────────

export interface NtpApplyResult {
  applied: boolean;
  skipped?: boolean;
  message: string;
}

export async function applyNtpToHost(s: NtpSettings): Promise<NtpApplyResult> {
  if (!existsSync(WRAPPER)) {
    return {
      applied: false, skipped: true,
      message: "Saved. The host clock is not managed from this deployment (no chrony apply wrapper — e.g. a container); configure time sync on the host.",
    };
  }
  try {
    let args: string[];
    if (s.enabled && s.servers.length > 0) {
      const staged = resolve(STATE_DIR, "charon-chrony.sources.staged");
      writeFileSync(staged, renderChronySources(s), "utf-8");
      args = ["-n", WRAPPER, "apply", staged];
    } else {
      args = ["-n", WRAPPER, "disable"];
    }
    const { stdout } = await execFileAsync("sudo", args, { timeout: 30_000 });
    logger.info({ stdout: stdout.trim() }, "chrony config applied");
    return { applied: true, message: stdout.trim() || "Applied to chronyd" };
  } catch (err: any) {
    logger.error({ err: err?.stderr || err?.message }, "chrony apply failed");
    return { applied: false, message: `Saved, but applying to chronyd failed: ${String(err?.stderr || err?.message).trim()}` };
  }
}

// ─── Test Sync ────────────────────────────────────────────────────────────────

const TEST_TIMEOUT_MS = 4000;

async function sntpQuery(server: string): Promise<{ offsetMs: number; stratum: number }> {
  const addr = isIP(server) ? { address: server, family: isIP(server) } : await lookup(server);
  return new Promise((resolveP, rejectP) => {
    const sock = createSocket(addr.family === 6 ? "udp6" : "udp4");
    const done = (fn: () => void) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } fn(); };
    const timer = setTimeout(() => done(() => rejectP(new Error("no reply (timeout)"))), TEST_TIMEOUT_MS);
    const req = Buffer.alloc(48);
    req[0] = 0x23; // LI 0, VN 4, mode 3 (client)
    let t1 = 0;
    sock.on("error", (e) => done(() => rejectP(e)));
    sock.on("message", (msg) => {
      const t4 = Date.now();
      try { const r = parseSntpReply(msg, t1, t4); done(() => resolveP(r)); }
      catch (e) { done(() => rejectP(e)); }
    });
    t1 = Date.now();
    sock.send(req, 123, addr.address);
  });
}

async function ntsKeProbe(server: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const sock = tlsConnect({
      host: server, port: 4460, ALPNProtocols: ["ntske/1"], minVersion: "TLSv1.3",
      servername: isIP(server) ? undefined : server,
    });
    const timer = setTimeout(() => { sock.destroy(); rejectP(new Error("no reply (timeout)")); }, TEST_TIMEOUT_MS);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const alpn = sock.alpnProtocol;
      const proto = sock.getProtocol();
      sock.end();
      if (alpn !== "ntske/1") rejectP(new Error("server did not negotiate NTS-KE (ALPN ntske/1)"));
      else resolveP(proto || "TLSv1.3");
    });
    sock.once("error", (e) => { clearTimeout(timer); rejectP(e); });
  });
}

/**
 * Probe every listed server (polaris probed — nominally — only the first).
 * Reports the first success in polaris's message shape, plus how many failed.
 */
export async function testNtpSync(settings: { mode: string; servers: string[] }): Promise<{ ok: boolean; message: string }> {
  const servers = (settings.servers || []).filter(isValidNtpServer).slice(0, NTP_MAX_SERVERS);
  if (servers.length === 0) return { ok: false, message: "No NTP servers configured" };
  const mode = settings.mode === "nts" ? "nts" : settings.mode === "sntp" ? "sntp" : "ntp";

  const results = await Promise.allSettled(servers.map(async (srv) => {
    if (mode === "nts") return `NTS-KE handshake OK with ${srv} (${await ntsKeProbe(srv)})`;
    const r = await sntpQuery(srv);
    return `Synchronized with ${srv} (offset: ${formatOffset(r.offsetMs)}, stratum ${r.stratum}, ${mode.toUpperCase()})`;
  }));
  const okIdx = results.findIndex((r) => r.status === "fulfilled");
  const failures = results
    .map((r, i) => (r.status === "rejected" ? `${servers[i]}: ${(r.reason as Error)?.message || r.reason}` : null))
    .filter((x): x is string => x !== null);
  if (okIdx === -1) return { ok: false, message: `NTP sync failed — ${failures.join("; ")}` };
  const first = (results[okIdx] as PromiseFulfilledResult<string>).value;
  return { ok: true, message: failures.length ? `${first}; ${failures.length} of ${servers.length} unreachable (${failures.join("; ")})` : first };
}
